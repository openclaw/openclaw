// Narrow Matrix monitor helper seam.
// Keep monitor internals off the broad package runtime-api barrel so monitor
// tests and shared workers do not pull unrelated Matrix helper surfaces.

export type { NormalizedLocation, PluginRuntime, RuntimeLogger } from "mullusi/plugin-sdk/core";
export type { BlockReplyContext, ReplyPayload } from "mullusi/plugin-sdk/reply-runtime";
export type { MarkdownTableMode, MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
export type { RuntimeEnv } from "mullusi/plugin-sdk/runtime";
export { ensureConfiguredAcpBindingReady } from "mullusi/plugin-sdk/core";
export {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  formatAllowlistMatchMeta,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "mullusi/plugin-sdk/allow-from";
export { createReplyPrefixOptions } from "mullusi/plugin-sdk/channel-reply-pipeline";
export { createTypingCallbacks } from "mullusi/plugin-sdk/channel-reply-pipeline";
export {
  formatLocationText,
  logInboundDrop,
  toLocationContext,
} from "mullusi/plugin-sdk/channel-inbound";
export { getAgentScopedMediaLocalRoots } from "mullusi/plugin-sdk/agent-media-payload";
export { logTypingFailure, resolveAckReaction } from "mullusi/plugin-sdk/channel-feedback";
export {
  buildChannelKeyCandidates,
  resolveChannelEntryMatch,
} from "mullusi/plugin-sdk/channel-targets";
