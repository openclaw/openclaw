import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { PluginCommandContext } from "openclaw/plugin-sdk/core";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { resolveYuanbaoAccount } from "../../../accounts.js";
import { sanitize, createLog } from "../../../logger.js";
import { uploadToCos } from "./cos-upload.js";
import { extractAndFilterLogs } from "./extractor.js";
import type { ExtractResult, ParsedCommandArgs, CosUploadResult } from "./types.js";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;
const DASH_VARIANTS_RE = /[‐‑‒–—―－]/g;

function toInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function normalizeOptionToken(token: string): string {
  const normalized = token.replace(DASH_VARIANTS_RE, "-");
  if (/^-[A-Za-z]/.test(normalized) && !normalized.startsWith("--")) {
    return `-${normalized}`;
  }
  return normalized;
}

/**
 * Clamp input values to safe ranges, avoiding out-of-bounds reads or exception branches.
 *
 * Unifying boundary convergence at the entry layer ensures that subsequent extraction, packaging, and upload branches all share the same constraints,
 * reducing the risk of duplicate validation and branch inconsistency.
 *
 * @param value - 原始数值。
 * @param min - 允许的最小值（含边界）。
 * @param max - 允许的最大值（含边界）。
 * @returns 位于 `[min, max]` 区间内的安全值。
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse and normalize log export command parameters, generating stable internal execution config.
 *
 * 该函数专门承担“边界层”职责：把文本参数转为结构化对象并补Default值，
 * 让后续业务流程仅处理已验证的数据，降低Runtime分支复杂度。
 *
 * @param rawArgs - 命令名后的原始参数字符串。
 * @returns 归一化后的参数对象，包含 `limit`、时间过滤与 `--all` 开关。
 * @example
 * ```typescript
 * const args = parseCommandArgs('--limit 1000 --d 3 --all');
 * // args.limit === 1000
 * // args.recentDays === 3
 * // args.all === true
 * ```
 */
export function parseCommandArgs(rawArgs: string | undefined): ParsedCommandArgs {
  const tokens = (rawArgs ?? "").trim().split(/\s+/).map(normalizeOptionToken).filter(Boolean);
  const parsed: ParsedCommandArgs = {
    limit: DEFAULT_LIMIT,
    uploadCos: true,
    all: false,
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t === "--limit") {
      const n = toInt(next);
      if (n !== undefined) {
        parsed.limit = clamp(n, 1, MAX_LIMIT);
      }
      i += 1;
      continue;
    }
    if (t === "--start-time") {
      const n = toInt(next);
      if (n !== undefined && n > 0) {
        parsed.startTime = n;
      }
      i += 1;
      continue;
    }
    if (t === "--h") {
      const n = toInt(next);
      if (n !== undefined && n > 0) {
        parsed.recentHours = n;
      }
      i += 1;
      continue;
    }
    if (t === "--d") {
      const n = toInt(next);
      if (n !== undefined && n > 0) {
        parsed.recentDays = n;
      }
      i += 1;
      continue;
    }
    if (t === "--end-time") {
      const n = toInt(next);
      if (n !== undefined && n > 0) {
        parsed.endTime = n;
      }
      i += 1;
      continue;
    }
    if (t === "--all") {
      parsed.all = true;
    }
  }

  return parsed;
}

function sanitizeLine(rawLine: string): string {
  const safe = sanitize(rawLine);
  return safe.replace(/\r?\n/g, " ");
}

function resolveBotIdFromConfig(ctx: PluginCommandContext): string | undefined {
  const cfg = ctx.config as {
    channels?: {
      yuanbao?: {
        botId?: string;
        identifier?: string;
        accounts?: Record<string, { botId?: string; identifier?: string }>;
      };
    };
  };
  const yuanbao = cfg.channels?.yuanbao;
  if (!yuanbao) {
    return undefined;
  }
  const accountCfg = ctx.accountId ? yuanbao.accounts?.[ctx.accountId] : undefined;
  return accountCfg?.botId || accountCfg?.identifier || yuanbao.botId || yuanbao.identifier;
}

function buildTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function persistTempBundle(
  lines: string[],
): Promise<{ dir: string; jsonlPath: string; gzipPath: string; gzipBytes: number }> {
  const baseDir = join(resolvePreferredOpenClawTmpDir(), "openclaw-log-export-");
  const dir = await mkdtemp(baseDir);
  const ts = buildTimestamp();
  const jsonlPath = join(dir, `openclaw-log-${ts}.jsonl`);
  const gzipPath = join(dir, `openclaw-log-${ts}.jsonl.gz`);
  const jsonl = lines.map(sanitizeLine).join("\n");
  await writeFile(jsonlPath, jsonl, "utf8");
  const gz = gzipSync(Buffer.from(jsonl, "utf8"));
  await writeFile(gzipPath, gz);
  return { dir, jsonlPath, gzipPath, gzipBytes: gz.byteLength };
}

async function cleanupTempBundle(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function renderReply(params: {
  extract: ExtractResult;
  output: { dir: string; jsonlPath: string; gzipPath: string; gzipBytes: number };
  cosUpload: CosUploadResult;
}): string {
  const { extract, output, cosUpload } = params;
  let result = "导出成功";
  if (cosUpload.enabled) {
    result = cosUpload.recordLogOk === false ? "上传成功，记录失败" : "上传成功";
  }
  const lines = [
    `结果: ${result}`,
    `日志ID: ${cosUpload.logId || "N/A"}`,
    `日志行数: ${extract.lines.length}`,
    `日志大小: ${output.gzipBytes} bytes`,
  ];

  return lines.join("\n");
}

/**
 * 执行日志导出主流程：解析参数、Extract过滤、打包压缩、上传 COS，并生成用户回复。
 *
 * 该编排函数将清理逻辑放在 `finally`，确保无论上传/记录成功与否都回收临时Directory，
 * 避免高频导出时在本地持续堆积临时文件。
 *
 * @param ctx - OpenClaw 命令上下文，包含参数、账号与配置。
 * @returns 供命令层直接回复给用户的结果文本。
 * @throws 当Extract、打包或上传主链路失败时抛出异常，由上层统一包装错误文案。
 * @example
 * ```typescript
 * const text = await performLogExport(ctx);
 * // 结果: 上传成功
 * // 日志ID: 20260320123000-abcd1234-openclaw-plugin
 * ```
 */
export async function performLogExport(ctx: PluginCommandContext): Promise<string> {
  const log = createLog("log-upload");
  const args = parseCommandArgs(ctx.args);
  if (!args.uin) {
    args.uin = resolveBotIdFromConfig(ctx) || ctx.senderId || ctx.accountId || "unknown";
  }

  const account = resolveYuanbaoAccount({ cfg: ctx.config, accountId: ctx.accountId });
  args.appKey = account.appKey;
  args.appSecret = account.appSecret;
  args.apiDomain = account.apiDomain;
  args.routeEnv = account.config?.routeEnv;

  log.info("starting log export command", { args });

  const { extract, filteredLines } = await extractAndFilterLogs(args);
  const output = await persistTempBundle(filteredLines);
  try {
    const cosUpload = await uploadToCos(output.gzipPath, args, account);
    log.info("log export complete", {
      source: extract.source,
      rawLineCount: extract.lines.length,
      finalLineCount: filteredLines.length,
      gzipPath: output.gzipPath,
      gzipBytes: output.gzipBytes,
      cosUploadEnabled: cosUpload.enabled,
      cosPath: cosUpload.cosPath,
    });

    return renderReply({
      extract: {
        ...extract,
        lines: filteredLines,
      },
      output,
      cosUpload,
    });
  } catch (err) {
    log.error("log export/upload failed", { dir: output.dir, error: String(err) });
    throw err;
  } finally {
    try {
      await cleanupTempBundle(output.dir);
      log.info("temp directory cleaned up", { dir: output.dir });
    } catch (cleanupErr) {
      log.warn("failed to clean temp directory", { dir: output.dir, error: String(cleanupErr) });
    }
  }
}
