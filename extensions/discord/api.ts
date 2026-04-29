export { discordPlugin } from "./src/channel.js";
export { discordSetupPlugin } from "./src/channel.setup.js";
export { inspectDiscordAccount } from "./src/account-inspect.js";
export {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "./src/accounts.js";
export { buildDiscordComponentMessage } from "./src/components.js";
export {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "./src/directory-config.js";
export {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./src/group-policy.js";
export {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
  normalizeDiscordOutboundTarget,
} from "./src/normalize.js";
export { resolveOpenProviderRuntimeGroupPolicy as resolveDiscordRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
export { collectDiscordStatusIssues } from "./src/status-issues.js";

// Deprecated compatibility surface for existing @openclaw/discord/api.js consumers.
type HandleDiscordMessageAction =
  typeof import("./src/actions/handle-action.js").handleDiscordMessageAction;

export const handleDiscordMessageAction: HandleDiscordMessageAction = (async (...args) => {
  const { handleDiscordMessageAction: run } = await import("./src/actions/handle-action.js");
  return run(...args);
}) as HandleDiscordMessageAction;

export {
  buildDiscordInteractiveComponents,
  buildDiscordComponentCustomId,
  buildDiscordModalCustomId,
  parseDiscordComponentCustomId,
  parseDiscordComponentCustomIdForInteraction,
  parseDiscordModalCustomId,
  parseDiscordModalCustomIdForInteraction,
  type ComponentData,
  type DiscordComponentBuildResult,
  type DiscordComponentMessageSpec,
} from "./src/components.js";
export {
  parseDiscordComponentCustomIdForInteraction as parseDiscordComponentCustomIdForCarbon,
  parseDiscordModalCustomIdForInteraction as parseDiscordModalCustomIdForCarbon,
} from "./src/component-custom-id.js";
export {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
  shouldSuppressLocalDiscordExecApprovalPrompt,
} from "./src/exec-approvals.js";
export {
  fetchDiscordApplicationId,
  fetchDiscordApplicationSummary,
  parseApplicationIdFromToken,
  probeDiscord,
  resolveDiscordPrivilegedIntentsFromFlags,
  type DiscordApplicationSummary,
  type DiscordPrivilegedIntentsSummary,
  type DiscordPrivilegedIntentStatus,
  type DiscordProbe,
} from "./src/probe.js";
export { parseDiscordSendTarget, type SendDiscordTarget } from "./src/send-target-parsing.js";
export {
  parseDiscordTarget,
  resolveDiscordChannelId,
  resolveDiscordTarget,
  type DiscordTarget,
  type DiscordTargetKind,
  type DiscordTargetParseOptions,
} from "./src/targets.js";
export {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
  DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
  DISCORD_DEFAULT_LISTENER_TIMEOUT_MS,
  mergeAbortSignals,
} from "./src/monitor/timeouts.js";
