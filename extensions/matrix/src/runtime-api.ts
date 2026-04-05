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
} from "mullusi/plugin-sdk/core";
export type {
  ChannelPlugin,
  NormalizedLocation,
  PluginRuntime,
  RuntimeLogger,
} from "mullusi/plugin-sdk/core";
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
} from "mullusi/plugin-sdk/channel-contract";
export { formatZonedTimestamp } from "mullusi/plugin-sdk/core";
export { normalizeOptionalAccountId } from "mullusi/plugin-sdk/account-id";
export type { ChannelSetupInput } from "mullusi/plugin-sdk/core";
export type {
  MullusiConfig,
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
} from "mullusi/plugin-sdk/config-runtime";
export type { GroupToolPolicyConfig } from "mullusi/plugin-sdk/config-runtime";
export type { WizardPrompter } from "mullusi/plugin-sdk/core";
export type { SecretInput } from "mullusi/plugin-sdk/secret-input";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "mullusi/plugin-sdk/config-runtime";
export {
  addWildcardAllowFrom,
  formatDocsLink,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  moveSingleAccountChannelSectionToDefaultAccount,
  promptAccountId,
  promptChannelAccessConfig,
} from "mullusi/plugin-sdk/setup";
export type { RuntimeEnv } from "mullusi/plugin-sdk/runtime";
export {
  assertHttpUrlTargetsPrivateNetwork,
  closeDispatcher,
  createPinnedDispatcher,
  isPrivateOrLoopbackHost,
  resolvePinnedHostnameWithPolicy,
  ssrfPolicyFromAllowPrivateNetwork,
  type LookupFn,
  type SsrFPolicy,
} from "mullusi/plugin-sdk/ssrf-runtime";
export { dispatchReplyFromConfigWithSettledDispatcher } from "mullusi/plugin-sdk/inbound-reply-dispatch";
export {
  ensureConfiguredAcpBindingReady,
  resolveConfiguredAcpBindingRecord,
} from "mullusi/plugin-sdk/core";
export {
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
  PAIRING_APPROVED_MESSAGE,
} from "mullusi/plugin-sdk/channel-status";
export {
  getSessionBindingService,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "mullusi/plugin-sdk/conversation-runtime";
export { resolveOutboundSendDep } from "mullusi/plugin-sdk/outbound-runtime";
export { resolveAgentIdFromSessionKey } from "mullusi/plugin-sdk/routing";
export { chunkTextForOutbound } from "mullusi/plugin-sdk/text-chunking";
export { createChannelReplyPipeline } from "mullusi/plugin-sdk/channel-reply-pipeline";
export { loadOutboundMediaFromUrl } from "mullusi/plugin-sdk/outbound-media";
export { normalizePollInput } from "mullusi/plugin-sdk/media-runtime";
export { writeJsonFileAtomically } from "mullusi/plugin-sdk/json-store";
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
