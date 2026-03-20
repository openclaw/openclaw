// Pre-export all 15 symbols that plugin-sdk/matrix re-exports from this
// extension via helper-api.js, thread-bindings-runtime.js, and related chunks.
// These must be defined before the star re-export so Jiti's CJS interop guard
// (hasOwnProperty check) skips the duplicate definition that would otherwise
// come through the circular alias round-trip.
export {
  findMatrixAccountEntry,
  requiresExplicitMatrixDefaultAccount,
  resolveConfiguredMatrixAccountIds,
  resolveMatrixChannelConfig,
  resolveMatrixDefaultOrOnlyAccountId,
} from "./account-selection.js";
export { resolveMatrixAccountStringValues } from "./auth-precedence.js";
export { getMatrixScopedEnvVarNames } from "./env-vars.js";
export { matrixSetupAdapter } from "./setup-core.js";
export { matrixSetupWizard } from "./setup-surface.js";
export {
  resolveMatrixAccountStorageRoot,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsPath,
  resolveMatrixLegacyFlatStoragePaths,
} from "./storage-paths.js";
export {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "./matrix/thread-bindings-shared.js";
// Star re-export for the remaining (non-extension) symbols in plugin-sdk/matrix.
// Properties already defined above are skipped by the CJS interop guard, so the
// circular helper-api path is never reached for those symbols.
export * from "openclaw/plugin-sdk/matrix";
export {
  assertHttpUrlTargetsPrivateNetwork,
  buildTimeoutAbortSignal,
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  ssrfPolicyFromAllowPrivateNetwork,
  type LookupFn,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/infra-runtime";
export {
  dispatchReplyFromConfigWithSettledDispatcher,
  ensureConfiguredAcpBindingReady,
  maybeCreateMatrixMigrationSnapshot,
  resolveConfiguredAcpBindingRecord,
} from "openclaw/plugin-sdk/matrix-runtime-heavy";
