import { dirname } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/matrix";
import { createLog } from "../../../logger.js";

const log = createLog("upgrade");

export const PLUGIN_ID = "openclaw-plugin-yuanbao";

/** 执行 shell 命令时的Default超时（3 分钟） */
const EXEC_TIMEOUT_MS = 3 * 60 * 1000;

/** 插件命令重试最大次数（5 次） */
const PLUGIN_CMD_RETRY_MAX_ATTEMPTS = 5;

/** 插件命令重试间隔（3 秒） */
const PLUGIN_CMD_RETRY_DELAY_MS = 3000;

/**
 * 返回与当前 Node.js 进程同Directory的 npm 可执行文件路径。
 */
async function resolveNpmBin(): Promise<string> {
  try {
    const result = await runPluginCommandWithTimeout({
      argv: ["which", "npm"],
      timeoutMs: 5000,
      env: makeEnv(),
    });
    const resolved = result.stdout.trim();
    if (result.code === 0 && resolved) {
      return resolved;
    }
  } catch {
    // which 失败时降级
  }
  return "npm";
}

/**
 * 通过 `which openclaw` 获取 openclaw 可执行文件的绝对路径。
 * 若 which 失败则降级返回 'openclaw'（依赖 PATH）。
 */
async function resolveOpenClawBin(): Promise<string> {
  try {
    const result = await runPluginCommandWithTimeout({
      argv: ["which", "openclaw"],
      timeoutMs: 5000,
      env: makeEnv(),
    });
    const resolved = result.stdout.trim();
    if (result.code === 0 && resolved) {
      return resolved;
    }
  } catch {
    // which 失败时降级
  }
  return "openclaw";
}

/**
 * 构造子进程执行环境：将 Node.js 所在 bin Directory前置到 PATH。
 */
function makeEnv(): NodeJS.ProcessEnv {
  const nodeBinDir = dirname(process.execPath);
  const currentPath = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: currentPath.includes(nodeBinDir) ? currentPath : `${nodeBinDir}:${currentPath}`,
  };
}

/**
 * Compare two release version numbers
 * @returns 正数：a > b；负数：a < b；0：相等
 */
function compareStableVersions(a: string, b: string): number {
  const [aMaj, aMin, aPatch] = a.split(".").map(Number);
  const [bMaj, bMin, bPatch] = b.split(".").map(Number);
  return aMaj - bMaj || aMin - bMin || aPatch - bPatch;
}

/** 判断版本号是否为正式发布版本（纯 MAJOR.MINOR.PATCH，无预发布标识） */
function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/**
 * Validate version number format; accepts release and pre-release versions.
 *
 * @param version - 待校验的版本号字符串（如 `1.2.3` 或 `2.7.0-beta.4ff40c41`）
 * @returns `true` 表示格式合法，`false` 表示格式不符合预期
 */
export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version);
}

/** 简单 sleep，给重试退避使用 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从 npm 获取 yuanbao 的最新正式发布版本。
 * 仅考虑符合 MAJOR.MINOR.PATCH 格式的版本，排除含预发布标识的版本。
 *
 * @returns 最新正式版本号；若查询失败或没有可用正式版则返回 `null`
 */
export async function fetchLatestStableVersion(): Promise<string | null> {
  const npmBin = await resolveNpmBin();
  log.debug("npm 路径", { npmBin, nodeExecPath: process.execPath });

  try {
    const regResult = await runPluginCommandWithTimeout({
      argv: [npmBin, "config", "get", "registry"],
      timeoutMs: 5000,
      env: makeEnv(),
    });
    if (regResult.code === 0) {
      log.info("当前 npm registry", { registry: regResult.stdout.trim() });
    } else {
      log.warn("无法读取 npm registry 配置");
    }
  } catch {
    log.warn("无法读取 npm registry 配置");
  }

  log.info("查询 npm 最新正式版本", { package: PLUGIN_ID });
  try {
    const result = await runPluginCommandWithTimeout({
      argv: [npmBin, "view", PLUGIN_ID, "versions", "--json"],
      timeoutMs: EXEC_TIMEOUT_MS,
      env: makeEnv(),
    });
    if (result.code !== 0) {
      const stderr = result.stderr.trim() || undefined;
      log.error("npm view 执行失败", {
        summary: stderr?.split("\n")[0] ?? `exit code ${result.code}`,
        ...(stderr ? { stderr } : {}),
      });
      return null;
    }
    const raw = result.stdout;
    log.debug("npm view 输出", { raw });
    const parsed: unknown = JSON.parse(raw.trim());
    const allVersions: string[] = Array.isArray(parsed) ? parsed : [parsed as string];
    const stable = allVersions.filter(isStableVersion);
    log.info("npm 版本列表", { total: allVersions.length, stable: stable.length });
    if (stable.length === 0) {
      log.warn("npm 上未找到任何正式发布版本");
      return null;
    }
    const latest = stable.toSorted(compareStableVersions).at(-1) ?? null;
    log.info("获取到最新正式版本", { latestVersion: latest });
    return latest;
  } catch (e: unknown) {
    log.error("npm view 执行失败", { summary: firstLine(e) });
    return null;
  }
}

/**
 * 校验指定版本是否真实存在于 npm 仓库中。
 *
 * @param version - 待校验的目标版本号（如 `1.2.3`）
 * @returns `true` 表示版本存在，`false` 表示版本不存在或无法确认
 */
export async function isPublishedVersionOnNpm(version: string): Promise<boolean> {
  const npmBin = await resolveNpmBin();
  try {
    const result = await runPluginCommandWithTimeout({
      argv: [npmBin, "view", `${PLUGIN_ID}@${version}`, "version"],
      timeoutMs: 15_000,
      env: makeEnv(),
    });
    if (result.code !== 0) {
      log.warn("指定版本 npm 查询失败", {
        version,
        code: result.code,
        stderr: result.stderr.trim() || undefined,
      });
      return false;
    }
    const publishedVersion = result.stdout.trim();
    return publishedVersion === version;
  } catch (e: unknown) {
    log.warn("指定版本 npm 查询异常", { version, summary: firstLine(e) });
    return false;
  }
}

/**
 * 解析 `openclaw plugins list` 输出，返回指定插件的已安装版本。
 * 如果插件未安装或解析失败，返回 null。
 */
export async function readInstalledVersion(pluginId: string): Promise<string | null> {
  log.info("读取已安装版本", { pluginId });
  const result = await runOpenClawCommand(["plugins", "list"]);
  if (!result.ok) {
    log.warn("openclaw plugins list 执行失败", {
      summary: result.error,
      ...(result.stderr ? { stderr: result.stderr } : {}),
    });
    return null;
  }

  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.toLowerCase().includes(pluginId.toLowerCase())) {
      const match = line.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      if (match) {
        log.info("已安装版本", { pluginId, version: match[1] });
        return match[1];
      }
    }
  }

  log.warn("未检测到已安装版本", { pluginId });
  return null;
}

/**
 * 备份 `channels.yuanbao` 配置，输出可用于 `config set ... --strict-json` 的 JSON 字符串。
 *
 * @param config - OpenClaw 当前Configuration object
 * @returns `channels.yuanbao` 的 JSON 字符串；若无可恢复配置则返回 `null`
 */
export function snapshotYuanbaoChannelConfig(config: OpenClawConfig): string | null {
  const value = config.channels?.yuanbao;
  if (!value || typeof value !== "object") {
    return null;
  }
  try {
    const snapshot = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    return JSON.stringify(snapshot);
  } catch {
    return null;
  }
}

/** 判断失败结果是否为可重试的限频错误（429 / Rate limit exceeded） */
function isRateLimitPluginCommandError(result: {
  error?: string;
  stderr?: string;
  stdout?: string;
}): boolean {
  const combined = [result.error, result.stderr, result.stdout].filter(Boolean).join("\n");
  if (!combined) {
    return false;
  }
  return /rate limit exceeded/i.test(combined) || /\(429\)/.test(combined);
}

/** 从 Error 或 unknown 中取第一行错误摘要 */
function firstLine(e: unknown): string {
  if (e instanceof Error) {
    return e.message.split("\n")[0] ?? String(e);
  }
  return String(e).split("\n")[0];
}

/** 执行 openclaw 命令并返回统一结果 */
export async function runOpenClawCommand(
  args: string[],
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }> {
  const openclawBin = await resolveOpenClawBin();
  const argv = [openclawBin, ...args];
  try {
    const result = await runPluginCommandWithTimeout({ argv, timeoutMs, env: makeEnv() });
    const stdout = result.stdout.trim() || undefined;
    const stderr = result.stderr.trim() || undefined;
    if (result.code !== 0) {
      const summary =
        stderr?.split("\n")[0] ?? stdout?.split("\n")[0] ?? `exit code ${result.code}`;
      return { ok: false, stdout, stderr, error: summary };
    }
    return { ok: true, stdout, stderr };
  } catch (e: unknown) {
    return { ok: false, error: firstLine(e) };
  }
}

/**
 * 执行 openclaw plugin 命令，并在命中限频错误时按递增间隔重试。
 * 非限频错误或达到最大重试次数后立即返回最后一次执行结果。
 *
 * @param params - 命令执行参数
 * @returns 命令最终执行结果
 */
export async function runOpenClawCommandWithRetry(params: {
  args: string[];
  timeoutMs?: number;
  commandName: string;
  onRetry?: (info: { nextAttempt: number; maxAttempts: number }) => Promise<void>;
}): Promise<Awaited<ReturnType<typeof runOpenClawCommand>> & { rateLimited?: boolean }> {
  const { args, timeoutMs = EXEC_TIMEOUT_MS, commandName, onRetry } = params;
  let lastResult: Awaited<ReturnType<typeof runOpenClawCommand>> = {
    ok: false,
    error: "unknown error",
  };

  for (let attempt = 1; attempt <= PLUGIN_CMD_RETRY_MAX_ATTEMPTS; attempt += 1) {
    lastResult = await runOpenClawCommand(args, timeoutMs);
    if (lastResult.ok) {
      return lastResult;
    }

    // 判断是否为限频错误，限频错误可以重试
    const retriable = isRateLimitPluginCommandError(lastResult);
    if (!retriable || attempt >= PLUGIN_CMD_RETRY_MAX_ATTEMPTS) {
      if (retriable) {
        return { ...lastResult, rateLimited: true };
      }
      break;
    }

    const nextAttempt = attempt + 1;
    const retryDelayMs = PLUGIN_CMD_RETRY_DELAY_MS * attempt;
    log.warn("openclaw plugin 命令触发限频，准备重试", {
      commandName,
      attempt,
      nextAttempt,
      maxAttempts: PLUGIN_CMD_RETRY_MAX_ATTEMPTS,
      retryDelayMs,
      error: lastResult.error,
    });
    await onRetry?.({ nextAttempt, maxAttempts: PLUGIN_CMD_RETRY_MAX_ATTEMPTS });
    await sleep(retryDelayMs);
  }

  return lastResult;
}
