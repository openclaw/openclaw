import { format } from "node:util";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
// security-runtime exports the same redaction helper without logging-core's
// diagnostic/config graph, which doctor enumeration must not cold-load.
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { getMatrixRuntime } from "../../runtime.js";

type LogLevel = "debug" | "info" | "warn" | "error";

export function noop(): void {}

let forceConsoleLogging = false;
let serviceQuiet = false;

export function setMatrixConsoleLogging(enabled: boolean): void {
  forceConsoleLogging = enabled;
}

export function setMatrixLogServiceQuiet(quiet: boolean): void {
  serviceQuiet = quiet;
}

function resolveRuntimeLogger(module: string): RuntimeLogger | null {
  if (forceConsoleLogging) {
    return null;
  }
  try {
    return getMatrixRuntime().logging.getChildLogger({ module: `matrix:${module}` });
  } catch {
    return null;
  }
}

function formatMessage(module: string, messageOrObject: unknown[]): string {
  if (messageOrObject.length === 0) {
    return `[${module}]`;
  }
  return redactSensitiveText(`[${module}] ${format(...messageOrObject)}`);
}

export function emitMatrixLog(level: LogLevel, module: string, messageOrObject: unknown[]): void {
  const runtimeLogger = resolveRuntimeLogger(module);
  const message = formatMessage(module, messageOrObject);
  if (runtimeLogger) {
    if (level === "debug") {
      runtimeLogger.debug?.(message);
    } else {
      runtimeLogger[level](message);
    }
  } else {
    console[level](message);
  }
}

function emitServiceLog(level: LogLevel, module: string, ...messageOrObject: unknown[]): void {
  if (serviceQuiet) {
    return;
  }
  emitMatrixLog(level, module, messageOrObject);
}

export const LogService = {
  debug: emitServiceLog.bind(null, "debug"),
  info: emitServiceLog.bind(null, "info"),
  warn: emitServiceLog.bind(null, "warn"),
};
