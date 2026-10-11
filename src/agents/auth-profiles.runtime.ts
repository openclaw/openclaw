/** Runtime auth-profile facade for lazy model selection and fallback paths. */
export { resolveAuthProfileEligibility, resolveAuthProfileOrder } from "./auth-profiles/order.js";
export {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  loadAuthProfileStoreForRuntime,
  prepareAuthProfileProvider,
} from "./auth-profiles/store-runtime.js";
export {
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  maybeReprobeWhamBlockedProfiles,
  resolveProfilesUnavailableReason,
} from "./auth-profiles/usage.js";
