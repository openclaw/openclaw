import { logger as matrixJsSdkLogger } from "matrix-js-sdk/lib/logger.js";
import { ConsoleLogger, LogService, setMatrixConsoleLogging } from "../sdk/logger.js";

let matrixSdkLoggingConfigured = false;
const matrixSdkBaseLogger = new ConsoleLogger();

type MatrixJsSdkLogger = {
  trace: (...messageOrObject: unknown[]) => void;
  debug: (...messageOrObject: unknown[]) => void;
  info: (...messageOrObject: unknown[]) => void;
  warn: (...messageOrObject: unknown[]) => void;
  error: (...messageOrObject: unknown[]) => void;
  getChild: (namespace: string) => MatrixJsSdkLogger;
};

type MatrixJsSdkLoglevelLogger = MatrixJsSdkLogger & {
  levels?: { DEBUG?: number };
  methodFactory?: (
    methodName: string,
    logLevel: number,
    loggerName: string | symbol,
  ) => (...args: unknown[]) => void;
  rebuild?: () => void;
  setLevel?: (level: number | string, persist?: boolean) => void;
};

export function ensureMatrixSdkLoggingConfigured(): void {
  if (!matrixSdkLoggingConfigured) {
    matrixSdkLoggingConfigured = true;
  }
  applyMatrixSdkLogger();
}

export function setMatrixSdkLogMode(mode: "default" | "quiet"): void {
  void mode;
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

function applyMatrixSdkLogger(): void {
  LogService.setLogger({
    trace: (module, ...messageOrObject) => matrixSdkBaseLogger.trace(module, ...messageOrObject),
    debug: (module, ...messageOrObject) => matrixSdkBaseLogger.debug(module, ...messageOrObject),
    info: (module, ...messageOrObject) => matrixSdkBaseLogger.info(module, ...messageOrObject),
    warn: (module, ...messageOrObject) => matrixSdkBaseLogger.warn(module, ...messageOrObject),
    error: (module, ...messageOrObject) => matrixSdkBaseLogger.error(module, ...messageOrObject),
  });
  applyMatrixJsSdkLogger();
}

function normalizeMatrixJsSdkLogMethod(methodName: string): keyof ConsoleLogger {
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
      (matrixSdkBaseLogger[method] as (module: string, ...args: unknown[]) => void)(
        module,
        ...messageOrObject,
      );
    };
  };
  logger.setLevel?.(logger.levels?.DEBUG ?? "debug", false);
  logger.rebuild?.();
}

function createMatrixJsSdkLoggerInstance(prefix: string): MatrixJsSdkLogger {
  const log = (method: keyof ConsoleLogger, ...messageOrObject: unknown[]): void => {
    (matrixSdkBaseLogger[method] as (module: string, ...args: unknown[]) => void)(
      prefix,
      ...messageOrObject,
    );
  };

  return {
    trace: (...messageOrObject) => log("trace", ...messageOrObject),
    debug: (...messageOrObject) => log("debug", ...messageOrObject),
    info: (...messageOrObject) => log("info", ...messageOrObject),
    warn: (...messageOrObject) => log("warn", ...messageOrObject),
    error: (...messageOrObject) => log("error", ...messageOrObject),
    getChild: (namespace: string) => {
      const nextNamespace = namespace.trim();
      return createMatrixJsSdkLoggerInstance(nextNamespace ? `${prefix}.${nextNamespace}` : prefix);
    },
  };
}
