/** Shared model-auth facade for runtime, Plugin SDK, and test import boundaries. */

export {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  ensureAuthProfileStoreWithoutExternalProfiles,
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
export { resolveAuthProfileOrderWithMetadata } from "./auth-profiles/order.js";
export { resolveEnvApiKey } from "./model-auth-env.js";
export {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  applySecretRefHeaderSentinels,
  getApiKeyForModelCore,
  hasAvailableAuthForProvider,
  resolveModelAuthMode,
  resolveModelAuthModeAsync,
} from "./model-auth-model.js";
export type { ModelAuthMode } from "./model-auth-model.js";
export {
  getCustomProviderApiKey,
  hasSyntheticLocalProviderAuthConfig,
  hasUsableCustomProviderApiKey,
  isConfigBackedInlineProviderApiKey,
  resolveProviderEntryApiKeyBinding,
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
  shouldPreferExplicitConfigApiKeyAuth,
} from "./model-auth-provider-config.js";
export { resolveApiKeyForProviderCore } from "./model-auth-provider.js";
export {
  createRuntimeProviderAuthLookup,
  hasRuntimeAvailableProviderAuth,
  prepareRuntimeAvailableProviderAuth,
} from "./model-auth-runtime.js";
export type { RuntimeProviderAuthLookup } from "./model-auth-runtime.js";
export {
  formatMissingAuthError,
  isMissingProviderAuthError,
  isProviderAuthError,
  MissingProviderAuthError,
  ProviderAuthError,
  requireApiKey,
} from "./model-auth-runtime-shared.js";
export type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
