// Narrow Matrix monitor helper seam.
// Keep monitor internals off the broad package runtime-api barrel so monitor
// tests and shared workers do not pull unrelated Matrix helper surfaces.

export {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  buildChannelKeyCandidates,
  canonicalizeAllowlistWithResolvedIds,
  createReplyPrefixOptions,
  createTypingCallbacks,
  formatAllowlistMatchMeta,
  formatLocationText,
  getAgentScopedMediaLocalRoots,
  logInboundDrop,
  logTypingFailure,
  patchAllowlistUsersInConfigEntries,
  resolveAckReaction,
  resolveChannelEntryMatch,
  summarizeMapping,
  toLocationContext,
  type MarkdownTableMode,
  type NormalizedLocation,
  type OpenClawConfig,
  type PluginRuntime,
  type ReplyPayload,
  type RuntimeEnv,
  type RuntimeLogger,
} from "openclaw/plugin-sdk/matrix";
export { ensureConfiguredAcpBindingReady } from "openclaw/plugin-sdk/matrix-runtime-heavy";
