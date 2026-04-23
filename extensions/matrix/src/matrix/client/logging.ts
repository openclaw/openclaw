import { logger as matrixJsSdkLogger } from "matrix-js-sdk/lib/logger.js";
import { ConsoleLogger, LogService, setMatrixConsoleLogging } from "../sdk/logger.js";

let matrixSdkLoggingConfigured = false;
let matrixSdkLogMode: "default" | "quiet" = "default";
const matrixSdkBaseLogger = new ConsoleLogger();

type MatrixLogMethod = "trace" | "debug" | "info" | "warn" | "error";

type MatrixJsSdkLogger = {
  trace: (...messageOrObject: unknown[]) => void;
  debug: (...messageOrObject: unknown[]) => void;
  info: (...messageOrObject: unknown[]) => void;
  warn: (...messageOrObject: unknown[]) => void;
  error: (...messageOrObject: unknown[]) => void;
  getChild: (namespace: string) => MatrixJsSdkLogger;
};

type MatrixJsSdkLoglevelLogger = MatrixJsSdkLogger & {
  levels?: { DEBUG?: number; ERROR?: number; INFO?: number };
  methodFactory?: (
    methodName: string,
    logLevel: number,
    loggerName: string | symbol,
  ) => (...args: unknown[]) => void;
  rebuild?: () => void;
  setLevel?: (level: number | string, persist?: boolean) => void;
};

const quietMatrixSdkLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function ensureMatrixSdkLoggingConfigured(): void {
  if (!matrixSdkLoggingConfigured) {
    matrixSdkLoggingConfigured = true;
  }
  applyMatrixSdkLogger();
}

export function setMatrixSdkLogMode(mode: "default" | "quiet"): void {
  matrixSdkLogMode = mode;
  if (!matrixSdkLoggingConfigured) {
    return;
  }
  applyMatrixSdkLogger();
}

export function setMatrixSdkConsoleLogging(enabled: boolean): void {
  setMatrixConsoleLogging(enabled);
}

export function createMatrixJsSdkClientLogger(prefix = "matrix"): MatrixJsSdkLogger {
  return createMatrixJsSdkLoggerInstance(prefix);
}

function shouldSuppressMatrixHttpNotFound(module: string, messageOrObject: unknown[]): boolean {
  if (!module.includes("MatrixHttpClient")) {
    return false;
  }
  return messageOrObject.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return (entry as { errcode?: string }).errcode === "M_NOT_FOUND";
  });
}

function writeMatrixSdkLog(
  method: MatrixLogMethod,
  module: string,
  messageOrObject: unknown[],
): void {
  matrixSdkBaseLogger[method](module, ...messageOrObject);
}

function applyMatrixSdkLogger(): void {
  if (matrixSdkLogMode === "quiet") {
    LogService.setLogger(quietMatrixSdkLogger);
    applyMatrixJsSdkLogger();
    return;
  }

  LogService.setLogger({
    trace: (module, ...messageOrObject) => writeMatrixSdkLog("trace", module, messageOrObject),
    debug: (module, ...messageOrObject) => writeMatrixSdkLog("debug", module, messageOrObject),
    info: (module, ...messageOrObject) => writeMatrixSdkLog("info", module, messageOrObject),
    warn: (module, ...messageOrObject) => writeMatrixSdkLog("warn", module, messageOrObject),
    error: (module, ...messageOrObject) => {
      if (shouldSuppressMatrixHttpNotFound(module, messageOrObject)) {
        return;
      }
      writeMatrixSdkLog("error", module, messageOrObject);
    },
  });
  applyMatrixJsSdkLogger();
}

function normalizeMatrixJsSdkLogMethod(methodName: string): MatrixLogMethod {
  if (methodName === "trace" || methodName === "debug" || methodName === "info") {
    return methodName;
  }
  if (methodName === "warn" || methodName === "error") {
    return methodName;
  }
  return "debug";
}

function formatMatrixJsSdkLoggerName(loggerName: string | symbol): string {
  return typeof loggerName === "symbol" ? loggerName.toString() : loggerName;
}

function applyMatrixJsSdkLogger(): void {
  const logger = matrixJsSdkLogger as MatrixJsSdkLoglevelLogger;
  logger.methodFactory = (methodName, _logLevel, loggerName) => {
    const method = normalizeMatrixJsSdkLogMethod(methodName);
    const module = formatMatrixJsSdkLoggerName(loggerName);
    return (...messageOrObject) => {
      if (matrixSdkLogMode === "quiet") {
        return;
      }
      if (method === "error" && shouldSuppressMatrixHttpNotFound(module, messageOrObject)) {
        return;
      }
      writeMatrixSdkLog(method, module, messageOrObject);
    };
  };
  logger.setLevel?.(resolveMatrixJsSdkLogLevel(logger), false);
  logger.rebuild?.();
}

function resolveMatrixJsSdkLogLevel(logger: MatrixJsSdkLoglevelLogger): number | string {
  if (matrixSdkLogMode === "quiet") {
    return logger.levels?.ERROR ?? "error";
  }
  if (process.env.OPENCLAW_MATRIX_SDK_DEBUG === "1" || process.env.MATRIX_SDK_DEBUG === "1") {
    return logger.levels?.DEBUG ?? "debug";
  }
  return logger.levels?.INFO ?? "info";
}

function createMatrixJsSdkLoggerInstance(prefix: string): MatrixJsSdkLogger {
  const log = (method: MatrixLogMethod, ...messageOrObject: unknown[]): void => {
    if (matrixSdkLogMode === "quiet") {
      return;
    }
    writeMatrixSdkLog(method, prefix, messageOrObject);
  };

  return {
    trace: (...messageOrObject) => log("trace", ...messageOrObject),
    debug: (...messageOrObject) => log("debug", ...messageOrObject),
    info: (...messageOrObject) => log("info", ...messageOrObject),
    warn: (...messageOrObject) => log("warn", ...messageOrObject),
    error: (...messageOrObject) => {
      if (shouldSuppressMatrixHttpNotFound(prefix, messageOrObject)) {
        return;
      }
      log("error", ...messageOrObject);
    },
    getChild: (namespace: string) => {
      const nextNamespace = namespace.trim();
      return createMatrixJsSdkLoggerInstance(nextNamespace ? `${prefix}.${nextNamespace}` : prefix);
    },
  };
}
