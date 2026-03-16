import { loadMatrixSdk } from "../sdk-runtime.js";

let matrixSdkLoggingConfigured = false;
let matrixSdkBaseLogger:
  | {
      trace: (module: string, ...messageOrObject: unknown[]) => void;
      debug: (module: string, ...messageOrObject: unknown[]) => void;
      info: (module: string, ...messageOrObject: unknown[]) => void;
      warn: (module: string, ...messageOrObject: unknown[]) => void;
      error: (module: string, ...messageOrObject: unknown[]) => void;
    }
  | undefined;

function shouldSuppressMatrixHttpNotFound(module: string, messageOrObject: unknown[]): boolean {
  if (module !== "MatrixHttpClient") {
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
  if (matrixSdkLoggingConfigured) {
    return;
  }
  const { ConsoleLogger, LogService } = loadMatrixSdk();
  matrixSdkBaseLogger = new ConsoleLogger();
  matrixSdkLoggingConfigured = true;

  LogService.setLogger({
    trace: (module, ...messageOrObject) => matrixSdkBaseLogger?.trace(module, ...messageOrObject),
    debug: (module, ...messageOrObject) => matrixSdkBaseLogger?.debug(module, ...messageOrObject),
    info: (module, ...messageOrObject) => matrixSdkBaseLogger?.info(module, ...messageOrObject),
    warn: (module, ...messageOrObject) => matrixSdkBaseLogger?.warn(module, ...messageOrObject),
    error: (module, ...messageOrObject) => {
      if (shouldSuppressMatrixHttpNotFound(module, messageOrObject)) {
        return;
      }
      matrixSdkBaseLogger?.error(module, ...messageOrObject);
    },
  });
}
