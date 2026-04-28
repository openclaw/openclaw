import fs from "node:fs/promises";
import path from "node:path";

function bounded(value, max = 1000) {
  if (typeof value !== "string") return value;
  return value.length > max
    ? `${value.slice(0, max)}…[truncated ${value.length - max} chars]`
    : value;
}

const DIAGNOSTIC_LOG_FIELDS = new Set(["code", "httpStatus", "latencyMs", "reason", "signal"]);

function sanitizeDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => DIAGNOSTIC_LOG_FIELDS.has(String(key)))
      .map(([key, item]) => [key, bounded(item)]),
  );
}

function sanitize(value) {
  if (!value || typeof value !== "object") return bounded(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitize);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (String(key) === "diagnostics") return [key, sanitizeDiagnostics(item)];
      return [key, sanitize(item)];
    }),
  );
}

/**
 * Create an allowlisted diagnostics logger with optional JSONL output.
 * @param {{logPath?: string, consoleLogger?: {info?: Function, warn?: Function}}} [options={}] Logger options.
 * @returns {{info: Function, warn: Function}} Logger facade.
 */
export function createLogger({ logPath, consoleLogger = console } = {}) {
  let warned = false;
  const filePath = logPath ? path.resolve(logPath) : null;

  async function write(level, obj) {
    const entry = sanitize({ ts: new Date().toISOString(), level, ...obj });
    if (filePath) {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
      } catch (error) {
        if (!warned) {
          warned = true;
          consoleLogger?.warn?.(
            "auto-recall: log path unwritable; continuing",
            error?.message || error,
          );
        }
      }
    }
    if (level === "warn") consoleLogger?.warn?.(entry);
    else consoleLogger?.info?.(entry);
  }

  return {
    info(obj) {
      void write("info", typeof obj === "string" ? { message: obj } : obj);
    },
    warn(obj) {
      void write("warn", typeof obj === "string" ? { message: obj } : obj);
    },
  };
}
