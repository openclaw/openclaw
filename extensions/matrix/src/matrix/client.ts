// Matrix plugin module implements client behavior.
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

export type { MatrixAuth } from "./client/types.js";
export { getMatrixScopedEnvVarNames } from "../env-vars.js";
export {
  backfillMatrixAuthDeviceIdAfterStartup,
  hasReadyMatrixEnvAuth,
  resolveMatrixEnvAuthReadiness,
  resolveMatrixConfigForAccount,
  resolveScopedMatrixEnvConfig,
  resolveMatrixAuth,
  resolveMatrixAuthContext,
  resolveValidatedMatrixHomeserverUrl,
  validateMatrixHomeserverUrl,
} from "./client/config.js";
const loadMatrixClientRuntime = createLazyRuntimeModule(() => import("./client/create-client.js"));

export const createMatrixClient = createLazyRuntimeMethod(
  loadMatrixClientRuntime,
  (runtime) => runtime.createMatrixClient,
);
export { acquireSharedMatrixClient, stopSharedClientForAccount } from "./client/shared.js";
export type {
  MatrixClientLeaseRole,
  MatrixClientReleaseMode,
  MatrixMonitorRetirement,
  SharedMatrixClientLease,
} from "./client/shared.js";
