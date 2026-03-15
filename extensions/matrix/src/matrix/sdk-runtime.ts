import { createRequire } from "node:module";

type MatrixSdkRuntime = typeof import("@vector-im/matrix-bot-sdk");

let cachedMatrixSdkRuntime: MatrixSdkRuntime | null = null;

export function loadMatrixSdk(): MatrixSdkRuntime {
  if (cachedMatrixSdkRuntime) {
    return cachedMatrixSdkRuntime;
  }
  const req = createRequire(import.meta.url);
  cachedMatrixSdkRuntime = req("@vector-im/matrix-bot-sdk") as MatrixSdkRuntime;
  return cachedMatrixSdkRuntime;
}

export function getMatrixLogService() {
  return loadMatrixSdk().LogService;
}
