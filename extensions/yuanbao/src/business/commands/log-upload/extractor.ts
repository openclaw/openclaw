import { readFile, readdir, stat } from "node:fs/promises";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/matrix";
import { createLog } from "../../../logger.js";
import { getYuanbaoRuntime } from "../../../runtime.js";
import type {
  ExtractResult,
  LogsTailParams,
  LogsTailResponse,
  ParsedCommandArgs,
} from "./types.js";

const EXEC_TIMEOUT_MS = 10_000;
const FILTER_FETCH_LIMIT = 5000;

async function resolveOpenclawBin(): Promise<string> {
  try {
    const result = await runPluginCommandWithTimeout({
      argv: ["which", "openclaw"],
      timeoutMs: 3000,
    });
    const resolved = result.stdout.trim();
    if (result.code === 0 && resolved) {
      return resolved;
    }
  } catch {
    // ignore
  }
  return "openclaw";
}

async function readConfigValue(openclawBin: string, key: string): Promise<string | undefined> {
  try {
    const result = await runPluginCommandWithTimeout({
      argv: [openclawBin, "config", "get", key],
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      return undefined;
    }
    const raw = result.stdout.trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 在 `/tmp/openclaw` 中选择最近写入的日志文件，作为配置项缺失时的兜底输入。
 *
 * 该策略优先保证“可用性”：即使 `openclaw config get logging.file` 不存在，也能尽量命中
 * The log file currently being written to by the current session, to avoid direct export flow failure.
 *
 * @returns 最新候选日志文件绝对路径；若Directory不存在或没有匹配文件则返回 `undefined`。
 * @throws 仅在文件系统访问出现不可恢复异常时抛出。
 * @example
 * ```typescript
 * const fallbackLogFile = await resolveLatestTmpOpenclawLog();
 * if (!fallbackLogFile) {
 *   // 继续走当天Default路径兜底
 * }
 * ```
 */
async function resolveLatestTmpOpenclawLog(): Promise<string | undefined> {
  const logDir = "/tmp/openclaw";
  let files: string[] = [];
  try {
    files = await readdir(logDir);
  } catch {
    return undefined;
  }

  const candidates = files
    .filter((name) => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .map((name) => `${logDir}/${name}`);

  if (candidates.length === 0) {
    return undefined;
  }

  let latestPath: string | undefined;
  let latestMtime = -1;
  for (const filePath of candidates) {
    try {
      const fileStat = await stat(filePath);
      const mtime = fileStat.mtimeMs ?? 0;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latestPath = filePath;
      }
    } catch {
      // ignore broken candidate
    }
  }
  return latestPath;
}

function buildTodayLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `/tmp/openclaw/openclaw-${date}.log`;
}

async function readOpenclawLoggingFileFromConfig(): Promise<string> {
  const openclawBin = await resolveOpenclawBin();
  const configKeys = ["logging.file", "gateway.logging.file", "logs.file"];
  for (const key of configKeys) {
    const value = await readConfigValue(openclawBin, key);
    if (value) {
      return value;
    }
  }
  const latestTmpLog = await resolveLatestTmpOpenclawLog();
  if (latestTmpLog) {
    return latestTmpLog;
  }
  return buildTodayLogPath();
}

function needsPostFilter(args: ParsedCommandArgs): boolean {
  return !args.all || !!resolveTimeRange(args);
}

function resolveExtractLimit(args: ParsedCommandArgs): number {
  return needsPostFilter(args) ? Math.max(args.limit, FILTER_FETCH_LIMIT) : args.limit;
}

async function tailLinesFromFile(
  filePath: string,
  maxLines: number,
): Promise<{ lines: string[]; size: number }> {
  const fileStat = await stat(filePath);
  const size = fileStat.size ?? 0;
  const content = await readFile(filePath);
  const lines = content.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines);
  return { lines, size };
}

/**
 * 通过 OpenClaw Runtime 的 `logs.tail` 能力Extract日志，优先于文件直读路径。
 *
 * 选择该路径是为了减少对宿主日志文件布局的耦合：当Runtime暴露标准 RPC 时，
 * The host can uniformly handle rolling files, cursors, and truncation semantics; falls back to tail-read if capability is missing.
 *
 * @param params - 已归一化的Extract参数。
 * @param params.limit - 需要返回的最大日志行数。
 * @returns 成功时返回结构化Extract结果；Runtime不支持时返回 `null`。
 * @throws 当Runtime存在 `logs.tail` 能力但调用失败时抛出最后一次错误。
 * @example
 * ```typescript
 * const result = await extractViaLogsTail({ limit: 500, uploadCos: true, all: false });
 * if (!result) {
 *   // Runtime未提供 logs.tail，外层会自动降级
 * }
 * ```
 */
async function extractViaLogsTail(params: ParsedCommandArgs): Promise<ExtractResult | null> {
  const runtime = getYuanbaoRuntime() as {
    logs?: { tail?: (p: LogsTailParams) => Promise<LogsTailResponse> };
    gateway?: { request?: (method: string, p: LogsTailParams) => Promise<LogsTailResponse> };
  };

  const requestParams: LogsTailParams = {
    limit: resolveExtractLimit(params),
  };

  const tryFns: Array<() => Promise<LogsTailResponse>> = [];
  if (typeof runtime.logs?.tail === "function") {
    tryFns.push(() => runtime.logs!.tail!(requestParams));
  }
  if (typeof runtime.gateway?.request === "function") {
    tryFns.push(() => runtime.gateway!.request!("logs.tail", requestParams));
  }
  if (tryFns.length === 0) {
    return null;
  }

  let lastErr: unknown;
  for (const fn of tryFns) {
    try {
      const rsp = await fn();
      if (!rsp || !Array.isArray(rsp.lines)) {
        throw new Error("logs.tail 返回格式不正确");
      }
      return {
        source: "logs.tail",
        file: rsp.file ?? "(unknown)",
        lines: rsp.lines.map((line) => line),
        truncated: !!rsp.truncated,
        reset: !!rsp.reset,
        cursor: rsp.cursor ?? 0,
        size: rsp.size ?? 0,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    throw lastErr;
  }
  return null;
}

async function extractViaFileTail(params: ParsedCommandArgs): Promise<ExtractResult> {
  const filePath = await readOpenclawLoggingFileFromConfig();
  const { lines, size } = await tailLinesFromFile(filePath, resolveExtractLimit(params));
  return {
    source: "file.tail",
    file: filePath,
    lines,
    truncated: false,
    reset: false,
    cursor: size,
    size,
  };
}

async function extractLogs(params: ParsedCommandArgs): Promise<ExtractResult> {
  try {
    const logsTailResult = await extractViaLogsTail(params);
    if (logsTailResult) {
      return logsTailResult;
    }
  } catch (err) {
    createLog("log-upload").warn("logs.tail call failed, falling back to file read", {
      error: String(err),
    });
  }
  return extractViaFileTail(params);
}

function normalizeTs(ts: number): number {
  if (ts < 1_000_000_000_000) {
    return ts * 1000;
  }
  return ts;
}

function parseLogTimestamp(line: string): number | undefined {
  try {
    const obj = JSON.parse(line) as {
      ["@timestamp"]?: string;
      _meta?: { date?: string | number };
      timestamp?: string | number;
      ts?: string | number;
    };
    const candidates = [obj["@timestamp"], obj._meta?.date, obj.timestamp, obj.ts];
    for (const c of candidates) {
      if (c === undefined || c === null) {
        continue;
      }
      if (typeof c === "number") {
        return normalizeTs(c);
      }
      const num = Number(c);
      if (Number.isFinite(num) && c.trim() !== "") {
        return normalizeTs(num);
      }
      const dt = Date.parse(c);
      if (!Number.isNaN(dt)) {
        return dt;
      }
    }
  } catch {
    // plain text line; fall through
  }
  return undefined;
}

function resolveTimeRange(args: ParsedCommandArgs): { start: number; end: number } | undefined {
  if (args.startTime && args.endTime) {
    return {
      start: normalizeTs(args.startTime),
      end: normalizeTs(args.endTime),
    };
  }

  if (args.recentDays && args.recentDays > 0) {
    const end = Date.now();
    return {
      start: end - args.recentDays * 24 * 3600 * 1000,
      end,
    };
  }

  if (args.recentHours && args.recentHours > 0) {
    const end = Date.now();
    return {
      start: end - args.recentHours * 3600 * 1000,
      end,
    };
  }

  return undefined;
}

function filterLines(lines: string[], args: ParsedCommandArgs): string[] {
  let next = lines;

  if (!args.all) {
    next = next.filter((line) => /yuanbao/i.test(line));
  }

  const timeRange = resolveTimeRange(args);
  if (timeRange) {
    next = next.filter((line) => {
      const ts = parseLogTimestamp(line);
      if (!ts) {
        return false;
      }
      return ts >= timeRange.start && ts <= timeRange.end;
    });
  }

  if (next.length > args.limit) {
    next = next.slice(-args.limit);
  }
  return next;
}

export async function extractAndFilterLogs(args: ParsedCommandArgs): Promise<{
  extract: ExtractResult;
  filteredLines: string[];
}> {
  const extract = await extractLogs(args);
  const filteredLines = filterLines(extract.lines, args);
  return { extract, filteredLines };
}
