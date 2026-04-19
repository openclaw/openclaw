import { dirname } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/matrix";
import { createLog } from "../../../logger.js";

const log = createLog("upgrade");

export const PLUGIN_ID = "openclaw-plugin-yuanbao";

/** Default timeout for shell commands (3 minutes) */
const EXEC_TIMEOUT_MS = 3 * 60 * 1000;

/** Max retry attempts for plugin commands (5 times) */
const PLUGIN_CMD_RETRY_MAX_ATTEMPTS = 5;

/** Retry interval for plugin commands (3 seconds) */
const PLUGIN_CMD_RETRY_DELAY_MS = 3000;

/**
 * Resolve npm executable path co-located with the current Node.js process.
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
    // Fallback when which fails
  }
  return "npm";
}

/**
 * Resolve openclaw executable absolute path via `which openclaw`.
 * Falls back to 'openclaw' (relies on PATH) if which fails.
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
    // Fallback when which fails
  }
  return "openclaw";
}

/**
 * Build child process env: prepend Node.js bin directory to PATH.
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
 * Compare two release version numbers.
 * @returns positive: a > b; negative: a < b; 0: equal
 */
function compareStableVersions(a: string, b: string): number {
  const [aMaj, aMin, aPatch] = a.split(".").map(Number);
  const [bMaj, bMin, bPatch] = b.split(".").map(Number);
  return aMaj - bMaj || aMin - bMin || aPatch - bPatch;
}

/** Check if version is a stable release (pure MAJOR.MINOR.PATCH, no pre-release tag) */
function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/**
 * Validate version number format; accepts release and pre-release versions.
 */
export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version);
}

/** Simple sleep for retry backoff */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the latest stable release version of yuanbao from npm.
 * Only considers MAJOR.MINOR.PATCH versions, excludes pre-release tags.
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
 * Verify whether a specified version actually exists on npm.
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
 * Parse `openclaw plugins list` output and return the installed version of the specified plugin.
 * Returns null if plugin is not installed or parsing fails.
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
 * Snapshot `channels.yuanbao` config, outputting a JSON string usable with `config set ... --strict-json`.
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

/** Check if a failed result is a retriable rate-limit error (429 / Rate limit exceeded) */
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

/** Extract first line error summary from Error or unknown */
function firstLine(e: unknown): string {
  if (e instanceof Error) {
    return e.message.split("\n")[0] ?? String(e);
  }
  return String(e).split("\n")[0];
}

/** Execute openclaw command and return unified result */
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
 * Execute openclaw plugin command with incremental-interval retry on rate-limit errors.
 * Returns immediately on non-rate-limit errors or when max retries exhausted.
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

    // Check if rate-limit error (retriable)
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
