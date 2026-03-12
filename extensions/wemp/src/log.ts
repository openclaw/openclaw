export type LogLevel = "debug" | "info" | "warn" | "error";
export type OpenClawLogBridge = Partial<Record<LogLevel, (line: string) => void>>;

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const SENSITIVE_FIELD_RE =
  /(token|secret|password|authorization|cookie|api[-_]?key|access[-_]?token|encodingaeskey|appsecret)/i;
const ACCOUNT_ID_PREFIX_RE = /^\[wemp:([^\]]+)\]/;
const bridgeByAccountId = new Map<string, OpenClawLogBridge>();

let currentLevel: LogLevel = normalizeLevel(process.env.WEMP_LOG_LEVEL) || "info";

function normalizeLevel(raw: unknown): LogLevel | null {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return null;
}

function shouldLog(level: LogLevel): boolean {
  return levelWeight[level] >= levelWeight[currentLevel];
}

function maskSecretValue(value: unknown): string {
  const text = String(value || "");
  if (!text) return "***";
  if (text.length <= 6) return "***";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function redactForLog(value: unknown, depth = 0, visited?: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth > 6) return "[max-depth]";
  const tracker = visited || new WeakSet<object>();
  if (tracker.has(value as object)) return "[circular]";
  tracker.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, depth + 1, tracker));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_RE.test(key)) {
      output[key] = maskSecretValue(item);
      continue;
    }
    output[key] = redactForLog(item, depth + 1, tracker);
  }
  return output;
}

function normalizeLogPayload(args: unknown[]): { event: string; data?: Record<string, unknown> } {
  if (!args.length) return { event: "log" };
  if (typeof args[0] === "string") {
    const event = args[0];
    const payload = args[1];
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return { event, data: redactForLog(payload) as Record<string, unknown> };
    }
    if (args.length > 1) {
      return { event, data: { args: redactForLog(args.slice(1)) as unknown[] } };
    }
    return { event };
  }
  return {
    event: "log",
    data: { args: redactForLog(args) as unknown[] },
  };
}

function resolveBridgeAccountId(event: string, data?: Record<string, unknown>): string | null {
  const fromData = data?.accountId;
  if (typeof fromData === "string" && fromData.trim()) return fromData.trim();
  const matched = ACCOUNT_ID_PREFIX_RE.exec(event);
  if (matched?.[1]) return matched[1];
  if (bridgeByAccountId.size === 1) return Array.from(bridgeByAccountId.keys())[0] || null;
  return null;
}

function emitToOpenClawBridge(
  level: LogLevel,
  line: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  const accountId = resolveBridgeAccountId(event, data);
  if (!accountId) return;
  const bridge = bridgeByAccountId.get(accountId);
  if (!bridge) return;
  const method = bridge[level] || (level === "debug" ? bridge.info : undefined);
  if (!method) return;
  try {
    method(line);
  } catch {
    // Do not break core logging path.
  }
}

function emit(level: LogLevel, ...args: unknown[]): void {
  if (!shouldLog(level)) return;
  const { event, data } = normalizeLogPayload(args);
  const record = {
    ts: new Date().toISOString(),
    scope: "wemp",
    level,
    event,
    ...(data ? { data } : {}),
  };
  const line = JSON.stringify(record);
  emitToOpenClawBridge(level, line, event, data);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function attachOpenClawLogBridge(
  accountId: string,
  bridge: OpenClawLogBridge | null | undefined,
): void {
  const normalized = String(accountId || "").trim();
  if (!normalized) return;
  if (!bridge) {
    bridgeByAccountId.delete(normalized);
    return;
  }
  bridgeByAccountId.set(normalized, bridge);
}

export function detachOpenClawLogBridge(accountId: string): void {
  const normalized = String(accountId || "").trim();
  if (!normalized) return;
  bridgeByAccountId.delete(normalized);
}

export function logDebug(...args: unknown[]): void {
  emit("debug", ...args);
}

export function logInfo(...args: unknown[]): void {
  emit("info", ...args);
}

export function logWarn(...args: unknown[]): void {
  emit("warn", ...args);
}

export function logError(...args: unknown[]): void {
  emit("error", ...args);
}
