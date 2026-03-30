export { getMatrixScopedEnvVarNames } from "../env-vars.js";
export {
	hasReadyMatrixEnvAuth,
	resolveMatrixAuth,
	resolveMatrixAuthContext,
	resolveMatrixConfigForAccount,
	resolveMatrixEnvAuthReadiness,
	resolveScopedMatrixEnvConfig,
	resolveValidatedMatrixHomeserverUrl,
	validateMatrixHomeserverUrl,
} from "./client/config.js";
export { createMatrixClient } from "./client/create-client.js";
export { isBunRuntime } from "./client/runtime.js";
export {
	acquireSharedMatrixClient,
	releaseSharedClientInstance,
	removeSharedClientInstance,
	resolveSharedMatrixClient,
	stopSharedClientForAccount,
	stopSharedClientInstance,
} from "./client/shared.js";
export type { MatrixAuth } from "./client/types.js";
