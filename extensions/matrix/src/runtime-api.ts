export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createActionGate,
  getChatChannelMeta,
  jsonResult,
  normalizeAccountId,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
  type PollInput,
  type ReplyPayload,
} from "openclaw/plugin-sdk/core";
export type {
  ChannelPlugin,
  NormalizedLocation,
  PluginRuntime,
  RuntimeLogger,
} from "openclaw/plugin-sdk/core";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelToolSend,
} from "openclaw/plugin-sdk/channel-contract";
export { formatZonedTimestamp } from "openclaw/plugin-sdk/core";
export { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
export type { ChannelSetupInput } from "openclaw/plugin-sdk/core";
export type {
  OpenClawConfig,
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
} from "openclaw/plugin-sdk/config-runtime";
export type { GroupToolPolicyConfig } from "openclaw/plugin-sdk/config-runtime";
export type { WizardPrompter } from "openclaw/plugin-sdk/core";
export type { SecretInput } from "openclaw/plugin-sdk/secret-input";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/config-runtime";
export {
  addWildcardAllowFrom,
  formatDocsLink,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  moveSingleAccountChannelSectionToDefaultAccount,
  promptAccountId,
  promptChannelAccessConfig,
} from "openclaw/plugin-sdk/setup";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export {
  assertHttpUrlTargetsPrivateNetwork,
  closeDispatcher,
  createPinnedDispatcher,
  isPrivateOrLoopbackHost,
  resolvePinnedHostnameWithPolicy,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  ssrfPolicyFromAllowPrivateNetwork,
  type LookupFn,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
export { dispatchReplyFromConfigWithSettledDispatcher } from "openclaw/plugin-sdk/inbound-reply-dispatch";
export {
  ensureConfiguredAcpBindingReady,
  resolveConfiguredAcpBindingRecord,
} from "openclaw/plugin-sdk/core";
export {
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk/channel-status";
export {
  getSessionBindingService,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "openclaw/plugin-sdk/conversation-runtime";
export { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
export { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
export { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
export { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
export { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
export { normalizePollInput } from "openclaw/plugin-sdk/media-runtime";
export { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
// resolveMatrixAccountStringValues already comes from plugin-sdk/matrix.
// Re-exporting auth-precedence here makes Jiti try to define the same export twice.

export function buildTimeoutAbortSignal(params: { timeoutMs?: number; signal?: AbortSignal }): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const { timeoutMs, signal } = params;
  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup: () => {} };
  }
  if (!timeoutMs) {
    return { signal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}
