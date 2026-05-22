export { collectConditionalChannelFieldAssignments, collectNestedChannelFieldAssignments, collectSimpleChannelFieldAssignments, getChannelRecord, getChannelSurface, hasConfiguredSecretInputValue, isBaseFieldActiveForChannelSurface, normalizeSecretStringValue, resolveChannelAccountSurface, } from "../secrets/channel-secret-basic-runtime.js";
export type { ChannelAccountEntry, ChannelAccountPredicate, ChannelAccountSurface, } from "../secrets/channel-secret-basic-runtime.js";
export { collectSecretInputAssignment, hasOwnProperty, isEnabledFlag, pushAssignment, pushInactiveSurfaceWarning, pushWarning, } from "../secrets/runtime-shared.js";
export type { ResolverContext, SecretDefaults } from "../secrets/runtime-shared.js";
export { isRecord } from "../secrets/shared.js";
export type { SecretTargetRegistryEntry } from "../secrets/target-registry-types.js";
