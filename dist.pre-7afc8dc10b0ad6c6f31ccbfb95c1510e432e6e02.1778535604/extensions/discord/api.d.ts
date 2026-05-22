import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { Dn as GroupToolPolicyConfig, bt as DiscordExecApprovalConfig } from "../../types.channels-CZZMDOR0.js";
import { s as ChannelOutboundPayloadHint } from "../../outbound.types-IRn7e6X5.js";
import { F as ChannelStatusIssue, b as ChannelMessageActionContext, m as ChannelGroupContext, r as ChannelAccountSnapshot } from "../../types.core-gexONR-2.js";
import { r as ReplyPayload } from "../../reply-payload-lhKzevm6.js";
import { g as OpenClawPluginApi } from "../../types-DaukV8xd.js";
import { t as RetryConfig } from "../../retry-CRVVYwqK.js";
import { i as resolveOpenProviderRuntimeGroupPolicy } from "../../runtime-group-policy-CFR3xeVt.js";
import { n as DiscordTokenResolution, t as DiscordCredentialStatus } from "../../token-DgfbgC0L.js";
import { n as inspectDiscordAccount, t as InspectedDiscordAccount } from "../../account-inspect-BWcgJI7Y.js";
import { a as mergeDiscordAccountConfig, c as resolveDiscordAccountConfig, i as listEnabledDiscordAccounts, l as resolveDiscordMaxLinesPerMessage, n as createDiscordActionGate, o as resolveDefaultDiscordAccountId, r as listDiscordAccountIds, s as resolveDiscordAccount, t as ResolvedDiscordAccount } from "../../accounts-B53HetUr.js";
import { a as fetchDiscordApplicationId, c as probeDiscord, i as DiscordProbe, l as resolveDiscordPrivilegedIntentsFromFlags, n as DiscordPrivilegedIntentStatus, o as fetchDiscordApplicationSummary, r as DiscordPrivilegedIntentsSummary, s as parseApplicationIdFromToken, t as DiscordApplicationSummary } from "../../probe-BzpjNouL.js";
import { t as discordPlugin } from "../../channel-i-3Dd808.js";
import { t as discordSetupPlugin } from "../../channel.setup-dugL02Iy.js";
import { f as ThreadBindingTargetKind } from "../../thread-bindings.manager-uCsxgl6y.js";
import { a as ComponentData } from "../../components.modal-CjDP_Lp2.js";
import { A as parseDiscordComponentCustomIdForInteraction, C as DiscordModalFieldSpec, D as buildDiscordComponentCustomId, E as DISCORD_MODAL_CUSTOM_ID_KEY, M as parseDiscordModalCustomIdForInteraction, O as buildDiscordModalCustomId, S as DiscordModalFieldDefinition, T as DISCORD_COMPONENT_CUSTOM_ID_KEY, _ as DiscordComponentSectionAccessory, a as DISCORD_COMPONENT_ATTACHMENT_PREFIX, b as DiscordComponentSelectType, c as buildDiscordComponentMessage, d as DiscordComponentBuildResult, f as DiscordComponentButtonSpec, g as DiscordComponentModalFieldType, h as DiscordComponentMessageSpec, i as createDiscordFormModal, j as parseDiscordModalCustomId, k as parseDiscordComponentCustomId, l as buildDiscordComponentMessageFlags, m as DiscordComponentEntry, n as buildDiscordInteractiveComponents, o as readDiscordComponentSpec, p as DiscordComponentButtonStyle, r as DiscordFormModal, s as resolveDiscordComponentAttachmentName, t as formatDiscordComponentEventText, u as DiscordComponentBlock, v as DiscordComponentSelectOption, w as DiscordModalSpec, x as DiscordModalEntry, y as DiscordComponentSelectSpec } from "../../components-DvnXecPG.js";
import { t as DirectoryConfigParams } from "../../directory-types-DSp6QOT3.js";
import { n as listDiscordDirectoryPeersFromConfig, t as listDiscordDirectoryGroupsFromConfig } from "../../directory-config-C_Elwfrq.js";
import { n as DiscordInteractiveHandlerRegistration, t as DiscordInteractiveHandlerContext } from "../../interactive-dispatch-CSg44IFe.js";
import { a as fetchPluralKitMessageInfo, i as PluralKitSystemInfo, n as PluralKitMemberInfo, r as PluralKitMessageInfo, t as DiscordPluralKitConfig } from "../../pluralkit-C9pFjtGg.js";
import { t as normalizeExplicitDiscordSessionKey } from "../../session-key-normalization-DLosb4Cy.js";
import { n as MessagingTargetKind, r as MessagingTargetParseOptions, t as MessagingTarget } from "../../targets-II75qVFB.js";
import { t as collectDiscordSecurityAuditFindings } from "../../security-audit-D4ewWzTV.js";
import { a as mergeAbortSignals, i as DISCORD_DEFAULT_LISTENER_TIMEOUT_MS, n as DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS, r as DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS, t as DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS } from "../../timeouts-DUI2m6F5.js";
import { v as DiscordSendResult } from "../../send.types-DulMXH4e.js";
import { n as DiscordSendEmbeds, t as DiscordSendComponents } from "../../send.shared-CUkgZmaf.js";
import { AgentToolResult } from "@mariozechner/pi-agent-core";

//#region extensions/discord/src/actions/handle-action.d.ts
declare function handleDiscordMessageAction$1(ctx: Pick<ChannelMessageActionContext, "action" | "params" | "cfg" | "accountId" | "requesterSenderId" | "toolContext" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile">): Promise<AgentToolResult<unknown>>;
//#endregion
//#region extensions/discord/src/subagent-hooks.d.ts
type DiscordSubagentSpawningEvent = {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId: string;
  label?: string;
};
type DiscordSubagentEndedEvent = {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
};
type DiscordSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    threadId?: string | number;
  };
};
type DiscordSubagentSpawningResult = {
  status: "ok";
  threadBindingReady?: boolean;
} | {
  status: "error";
  error: string;
} | undefined;
type DiscordSubagentDeliveryTargetResult = {
  origin: {
    channel: "discord";
    accountId?: string;
    to: string;
    threadId?: string | number;
  };
} | undefined;
declare function handleDiscordSubagentSpawning(api: OpenClawPluginApi, event: DiscordSubagentSpawningEvent): Promise<DiscordSubagentSpawningResult>;
declare function handleDiscordSubagentEnded(event: DiscordSubagentEndedEvent): void;
declare function handleDiscordSubagentDeliveryTarget(event: DiscordSubagentDeliveryTargetEvent): DiscordSubagentDeliveryTargetResult;
//#endregion
//#region extensions/discord/src/actions/handle-action.guild-admin.d.ts
type Ctx = Pick<ChannelMessageActionContext, "action" | "params" | "cfg" | "accountId" | "requesterSenderId" | "mediaLocalRoots" | "mediaReadFile">;
declare function tryHandleDiscordMessageActionGuildAdmin(params: {
  ctx: Ctx;
  resolveChannelId: () => string;
}): Promise<AgentToolResult<unknown> | undefined>;
//#endregion
//#region extensions/discord/src/api.d.ts
declare class DiscordApiError extends Error {
  status: number;
  retryAfter?: number;
  constructor(message: string, status: number, retryAfter?: number);
}
type DiscordFetchOptions = {
  retry?: RetryConfig;
  label?: string;
};
type DiscordApiRequestOptions = DiscordFetchOptions & {
  body?: unknown;
  fetcher?: typeof fetch;
  headers?: Record<string, string>;
  method?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};
declare function requestDiscord<T>(path: string, token: string, options?: DiscordApiRequestOptions): Promise<T>;
declare function fetchDiscord<T>(path: string, token: string, fetcher?: typeof fetch, options?: DiscordFetchOptions): Promise<T>;
//#endregion
//#region extensions/discord/src/group-policy.d.ts
declare function resolveDiscordGroupRequireMention(params: ChannelGroupContext): boolean;
declare function resolveDiscordGroupToolPolicy(params: ChannelGroupContext): GroupToolPolicyConfig | undefined;
//#endregion
//#region extensions/discord/src/normalize.d.ts
declare function normalizeDiscordMessagingTarget(raw: string): string | undefined;
/**
 * Normalize a Discord outbound target for delivery. Bare numeric IDs are
 * prefixed with "channel:" to avoid the ambiguous-target error in
 * parseDiscordTarget, unless the ID is explicitly configured as an allowed DM
 * sender. All other formats pass through unchanged.
 */
declare function normalizeDiscordOutboundTarget(to?: string, allowFrom?: readonly string[]): {
  ok: true;
  to: string;
} | {
  ok: false;
  error: Error;
};
declare function looksLikeDiscordTargetId(raw: string): boolean;
//#endregion
//#region extensions/discord/src/status-issues.d.ts
declare function collectDiscordStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[];
//#endregion
//#region extensions/discord/src/exec-approvals.d.ts
declare function getDiscordExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): string[];
declare function isDiscordExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean;
declare function isDiscordExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean;
declare function shouldSuppressLocalDiscordExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean;
//#endregion
//#region extensions/discord/src/target-parsing.d.ts
type DiscordTargetKind = MessagingTargetKind;
type DiscordTarget = MessagingTarget;
type DiscordTargetParseOptions = MessagingTargetParseOptions;
declare function parseDiscordTarget(raw: string, options?: DiscordTargetParseOptions): DiscordTarget | undefined;
declare function resolveDiscordChannelId(raw: string): string;
//#endregion
//#region extensions/discord/src/send-target-parsing.d.ts
type SendDiscordTarget = DiscordTarget;
type SendDiscordTargetParseOptions = DiscordTargetParseOptions;
declare const parseDiscordSendTarget: (raw: string, options?: SendDiscordTargetParseOptions) => SendDiscordTarget | undefined;
//#endregion
//#region extensions/discord/src/target-resolver.d.ts
/**
 * Resolve a Discord username to user ID using the directory lookup.
 * This enables sending DMs by username instead of requiring explicit user IDs.
 */
declare function resolveDiscordTarget(raw: string, options: DirectoryConfigParams, parseOptions?: DiscordTargetParseOptions): Promise<MessagingTarget | undefined>;
//#endregion
//#region extensions/discord/api.d.ts
type DiscordMessageActionHandler = typeof handleDiscordMessageAction$1;
declare const handleDiscordMessageAction: DiscordMessageActionHandler;
//#endregion
export { type ComponentData, DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS, DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS, DISCORD_COMPONENT_ATTACHMENT_PREFIX, DISCORD_COMPONENT_CUSTOM_ID_KEY, DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS, DISCORD_DEFAULT_LISTENER_TIMEOUT_MS, DISCORD_MODAL_CUSTOM_ID_KEY, DiscordApiError, type DiscordApplicationSummary, type DiscordComponentBlock, type DiscordComponentBuildResult, type DiscordComponentButtonSpec, type DiscordComponentButtonStyle, type DiscordComponentEntry, type DiscordComponentMessageSpec, type DiscordComponentModalFieldType, type DiscordComponentSectionAccessory, type DiscordComponentSelectOption, type DiscordComponentSelectSpec, type DiscordComponentSelectType, type DiscordCredentialStatus, DiscordFormModal, type DiscordInteractiveHandlerContext, type DiscordInteractiveHandlerRegistration, type DiscordModalEntry, type DiscordModalFieldDefinition, type DiscordModalFieldSpec, type DiscordModalSpec, type DiscordPluralKitConfig, type DiscordPrivilegedIntentStatus, type DiscordPrivilegedIntentsSummary, type DiscordProbe, type DiscordSendComponents, type DiscordSendEmbeds, type DiscordSendResult, type DiscordTarget, type DiscordTargetKind, type DiscordTargetParseOptions, type DiscordTokenResolution, type InspectedDiscordAccount, type PluralKitMemberInfo, type PluralKitMessageInfo, type PluralKitSystemInfo, type ResolvedDiscordAccount, type SendDiscordTarget, buildDiscordComponentCustomId, buildDiscordComponentMessage, buildDiscordComponentMessageFlags, buildDiscordInteractiveComponents, buildDiscordModalCustomId, collectDiscordSecurityAuditFindings, collectDiscordStatusIssues, createDiscordActionGate, createDiscordFormModal, discordPlugin, discordSetupPlugin, fetchDiscord, fetchDiscordApplicationId, fetchDiscordApplicationSummary, fetchPluralKitMessageInfo, formatDiscordComponentEventText, getDiscordExecApprovalApprovers, handleDiscordMessageAction, handleDiscordSubagentDeliveryTarget, handleDiscordSubagentEnded, handleDiscordSubagentSpawning, inspectDiscordAccount, isDiscordExecApprovalApprover, isDiscordExecApprovalClientEnabled, listDiscordAccountIds, listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, listEnabledDiscordAccounts, looksLikeDiscordTargetId, mergeAbortSignals, mergeDiscordAccountConfig, normalizeDiscordMessagingTarget, normalizeDiscordOutboundTarget, normalizeExplicitDiscordSessionKey, parseApplicationIdFromToken, parseDiscordComponentCustomId, parseDiscordComponentCustomIdForInteraction as parseDiscordComponentCustomIdForCarbon, parseDiscordComponentCustomIdForInteraction, parseDiscordModalCustomId, parseDiscordModalCustomIdForInteraction as parseDiscordModalCustomIdForCarbon, parseDiscordModalCustomIdForInteraction, parseDiscordSendTarget, parseDiscordTarget, probeDiscord, readDiscordComponentSpec, requestDiscord, resolveDefaultDiscordAccountId, resolveDiscordAccount, resolveDiscordAccountConfig, resolveDiscordChannelId, resolveDiscordComponentAttachmentName, resolveDiscordGroupRequireMention, resolveDiscordGroupToolPolicy, resolveDiscordMaxLinesPerMessage, resolveDiscordPrivilegedIntentsFromFlags, resolveOpenProviderRuntimeGroupPolicy as resolveDiscordRuntimeGroupPolicy, resolveDiscordTarget, shouldSuppressLocalDiscordExecApprovalPrompt, tryHandleDiscordMessageActionGuildAdmin };