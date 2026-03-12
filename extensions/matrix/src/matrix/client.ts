export type { MatrixAuth } from "./client/types.js";
export { isBunRuntime } from "./client/runtime.js";
export {
  getMatrixScopedEnvVarNames,
  hasReadyMatrixEnvAuth,
  resolveMatrixConfigForAccount,
  resolveScopedMatrixEnvConfig,
  resolveMatrixAuth,
  resolveMatrixAuthContext,
  validateMatrixHomeserverUrl,
} from "./client/config.js";
export { createMatrixClient } from "./client/create-client.js";
export { resolveSharedMatrixClient, stopSharedClientForAccount } from "./client/shared.js";
