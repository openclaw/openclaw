import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

type MatrixCryptoRuntime = typeof import("./crypto-runtime.js");

let loadedMatrixCryptoRuntime: MatrixCryptoRuntime | null = null;

export const getLoadedMatrixCryptoRuntime = () => loadedMatrixCryptoRuntime;

export const loadMatrixCryptoRuntime = createLazyRuntimeModule(() =>
  import("./crypto-runtime.js").then((runtime) => {
    loadedMatrixCryptoRuntime = runtime;
    return runtime;
  }),
);
