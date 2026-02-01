export type { MatrixAuth, MatrixResolvedConfig } from "./client/types.js";
export { isBunRuntime } from "./client/runtime.js";
export { resolveMatrixConfig, resolveMatrixAuth } from "./client/config.js";
export { createMatrixClient } from "./client/create-client.js";
export { resolveSharedMatrixClient, waitForMatrixSync, stopSharedClient } from "./client/shared.js";
