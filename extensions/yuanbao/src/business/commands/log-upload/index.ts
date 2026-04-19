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
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse and normalize log export command parameters, generating stable internal execution config.
 *
 * Handles "boundary layer" responsibility: converts text params to structured object with defaults,
 * so subsequent business flow only processes validated data, reducing runtime branch complexity.
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
 * Execute log export main flow: parse args, extract & filter, package & compress, upload to COS, and generate user reply.
 *
 * Cleanup logic is in `finally` to ensure temp directory is reclaimed regardless of upload/record success,
 * avoiding temp file accumulation during frequent exports.
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
