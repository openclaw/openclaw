import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MatrixSnapshotStateRuntime } from "../crypto-state-store.js";

type MatrixCryptoRuntime = typeof import("./crypto-runtime.js");

let loadedMatrixCryptoRuntime: MatrixCryptoRuntime | null = null;

const getLoadedMatrixCryptoRuntime = () => loadedMatrixCryptoRuntime;

export const loadMatrixCryptoRuntime = createLazyRuntimeModule(() =>
  import("./crypto-runtime.js").then((runtime) => {
    loadedMatrixCryptoRuntime = runtime;
    return runtime;
  }),
);

export async function getOrLoadMatrixCryptoRuntime(): Promise<MatrixCryptoRuntime> {
  return getLoadedMatrixCryptoRuntime() ?? (await loadMatrixCryptoRuntime());
}

export async function persistCryptoBeforeKeyUpload(params: {
  resource: RequestInfo | URL;
  init?: RequestInit;
  encryptionEnabled: boolean;
  snapshotPath?: string;
  databasePrefix?: string;
  stateRuntime?: MatrixSnapshotStateRuntime;
}): Promise<void> {
  const runtime = await loadMatrixCryptoRuntime();
  await runtime.persistCryptoBeforeKeyUpload(params);
}
