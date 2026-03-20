// Re-export helper-api symbols from their local source to break the circular
// re-export path: openclaw/plugin-sdk/matrix re-exports from
// extensions/matrix/helper-api.js, so importing plugin-sdk/matrix here would
// cause Jiti to define these properties twice (once via the local module graph
// and once via the alias round-trip), triggering "Cannot redefine property".
export {
  findMatrixAccountEntry,
  requiresExplicitMatrixDefaultAccount,
  resolveConfiguredMatrixAccountIds,
  resolveMatrixChannelConfig,
  resolveMatrixDefaultOrOnlyAccountId,
} from "./account-selection.js";
export {
  getMatrixScopedEnvVarNames,
  listMatrixEnvAccountIds,
  resolveMatrixEnvAccountToken,
} from "./env-vars.js";
export {
  hashMatrixAccessToken,
  resolveMatrixAccountStorageRoot,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsFilename,
  resolveMatrixCredentialsPath,
  resolveMatrixHomeserverKey,
  resolveMatrixLegacyFlatStoragePaths,
  resolveMatrixLegacyFlatStoreRoot,
  sanitizeMatrixPathSegment,
} from "./storage-paths.js";
// Thread-binding helpers that plugin-sdk/matrix re-exports from extensions/matrix.
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
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  ssrfPolicyFromAllowPrivateNetwork,
  type LookupFn,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/infra-runtime";
export * from "./auth-precedence.js";
