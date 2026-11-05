import {
  logger as matrixJsSdkRootLogger,
  type Logger as MatrixJsSdkLogger,
} from "matrix-js-sdk/lib/logger.js";
import { emitMatrixLog, setMatrixLogServiceQuiet } from "../sdk/logger.js";

let matrixSdkLoggingConfigured = false;
let matrixSdkLogMode: "default" | "quiet" = "default";
let matrixJsSdkRootLoggerSnapshot: MatrixJsSdkRootLoggerSnapshot | null = null;

type MatrixJsSdkLogMethod = (this: unknown, ...args: unknown[]) => void;
type MatrixJsSdkLogMethodFactory = (
  this: unknown,
  methodName: string,
  level: number,
  loggerName: string | symbol,
) => MatrixJsSdkLogMethod;

type MatrixJsSdkLoglevelLogger = {
  getLevel?: () => number | string;
  methodFactory: MatrixJsSdkLogMethodFactory;
  rebuild?: () => void;
  setLevel?: (level: number | string, persist?: boolean) => void;
};

type MatrixJsSdkRootLoggerSnapshot = {
  level?: number | string;
  methodFactory: MatrixJsSdkLogMethodFactory;
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
  configureMatrixJsSdkRootLogger();
  setMatrixLogServiceQuiet(matrixSdkLogMode === "quiet");
}

function configureMatrixJsSdkRootLogger(): void {
  const logger = matrixJsSdkRootLogger as unknown as MatrixJsSdkLoglevelLogger;
  if (!matrixJsSdkRootLoggerSnapshot) {
    const methodFactory = logger.methodFactory;
    matrixJsSdkRootLoggerSnapshot = {
      level: logger.getLevel?.(),
      methodFactory(methodName, logLevel, loggerName) {
        const log = methodFactory.call(this, methodName, logLevel, loggerName);
        return function (this: unknown, ...args: unknown[]) {
          // SDK children copy this factory, so quiet must be checked at emission.
          if (matrixSdkLogMode === "quiet") {
            return;
          }
          const label = args[0];
          // These matrix-js-sdk 43 global producers include profile/event content.
          if (
            methodName === "info" &&
            typeof label === "string" &&
            label.startsWith("Storing user profile ")
          ) {
            return;
          }
          if (
            methodName === "trace" &&
            (label === "membership event with membership undefined (forwardLooking: true)!" ||
              label === "membership event with membership undefined (forwardLooking: false)!")
          ) {
            log.call(this, "membership event with membership undefined");
          } else {
            log.apply(this, args);
          }
        };
      },
    };
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
    // matrix-js-sdk 43 includes caller-supplied reason/code in this lifecycle log.
    emitMatrixLog(
      method,
      prefix,
      messageOrObject[0] === "Cancelling verification request with params:"
        ? ["Cancelling verification request"]
        : messageOrObject,
    );
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
