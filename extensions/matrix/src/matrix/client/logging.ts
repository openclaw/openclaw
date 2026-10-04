import {
  logger as matrixJsSdkRootLogger,
  type Logger as MatrixJsSdkLogger,
} from "matrix-js-sdk/lib/logger.js";
import { emitMatrixLog, setMatrixLogServiceQuiet } from "../sdk/logger.js";

let matrixSdkLoggingConfigured = false;
let matrixSdkLogMode: "default" | "quiet" = "default";
let matrixJsSdkRootLoggerSnapshot: MatrixJsSdkRootLoggerSnapshot | null = null;

type MatrixJsSdkLoglevelLogger = {
  getLevel?: () => number | string;
  methodFactory?: unknown;
  rebuild?: () => void;
  setLevel?: (level: number | string, persist?: boolean) => void;
};

type MatrixJsSdkRootLoggerSnapshot = {
  level?: number | string;
  methodFactory?: unknown;
};

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

export function ensureMatrixSdkLoggingConfigured(): void {
  matrixSdkLoggingConfigured = true;
  applyMatrixSdkLogger();
}

export function setMatrixSdkLogMode(mode: "default" | "quiet"): void {
  matrixSdkLogMode = mode;
  if (!matrixSdkLoggingConfigured) {
    return;
  }
  applyMatrixSdkLogger();
}

function applyMatrixSdkLogger(): void {
  setMatrixJsSdkRootLoggerLevel(matrixSdkLogMode === "quiet" ? "silent" : "debug");
  setMatrixLogServiceQuiet(matrixSdkLogMode === "quiet");
}

function setMatrixJsSdkRootLoggerLevel(level: "debug" | "silent"): void {
  const logger = matrixJsSdkRootLogger as unknown as MatrixJsSdkLoglevelLogger;
  matrixJsSdkRootLoggerSnapshot ??= {
    level: logger.getLevel?.(),
    methodFactory: logger.methodFactory,
  };
  if (level === "silent") {
    logger.methodFactory = () => () => undefined;
    logger.setLevel?.("silent", false);
    logger.rebuild?.();
    return;
  }
  logger.methodFactory = matrixJsSdkRootLoggerSnapshot.methodFactory;
  const previousLevel = matrixJsSdkRootLoggerSnapshot.level;
  if (typeof previousLevel === "string" || typeof previousLevel === "number") {
    logger.setLevel?.(previousLevel, false);
  }
  logger.rebuild?.();
}

export function createMatrixJsSdkClientLogger(prefix = "matrix"): MatrixJsSdkLogger {
  const log = (
    method: Parameters<typeof emitMatrixLog>[0],
    ...messageOrObject: unknown[]
  ): void => {
    if (matrixSdkLogMode === "quiet") {
      return;
    }
    emitMatrixLog(method, prefix, messageOrObject);
  };

  return {
    trace: (...messageOrObject) => log("debug", ...messageOrObject),
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
      return createMatrixJsSdkClientLogger(nextNamespace ? `${prefix}.${nextNamespace}` : prefix);
    },
  };
}
