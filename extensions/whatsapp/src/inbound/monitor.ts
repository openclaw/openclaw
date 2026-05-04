import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  proto,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/text-runtime";
import { readWebSelfIdentityForDecision, WhatsAppAuthUnstableError } from "../auth-store.js";
import {
  getMentionIdentities,
  getPrimaryIdentityId,
  getReplyContext,
  getSelfIdentity,
  identitiesOverlap,
  resolveComparableIdentity,
  type WhatsAppReplyContext,
} from "../identity.js";
import { cacheInboundMessageMeta, lookupInboundMessageMeta } from "../quoted-message.js";
import { DEFAULT_RECONNECT_POLICY, computeBackoff, sleepWithAbort } from "../reconnect.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { createWaSocket, formatError, getStatusCode, waitForWaConnection } from "../session.js";
import { resolveWhatsAppSocketTiming } from "../socket-timing.js";
import { resolveJidToE164 } from "../text-runtime.js";
import { checkInboundAccessControl } from "./access-control.js";
import {
  claimRecentInboundMessage,
  commitRecentInboundMessage,
  isRecentOutboundMessage,
  releaseRecentInboundMessage,
  rememberRecentOutboundMessage,
  WhatsAppRetryableInboundError,
} from "./dedupe.js";
import {
  describeReplyContext,
  describeReplyContextKey,
  extractLocationData,
  extractContactContext,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { attachEmitterListener, closeInboundMonitorSocket } from "./lifecycle.js";
import { downloadInboundMedia } from "./media.js";
import { DisconnectReason, isJidGroup, saveMediaBuffer } from "./runtime-api.js";
import { createWebSendApi } from "./send-api.js";
import type {
  WebInboundMessage,
  WebListenerCloseReason,
  WhatsAppPendingAmbientEntry,
  WhatsAppQueueLaneDecision,
  WhatsAppQueueLaneId,
} from "./types.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";

function logWhatsAppVerbose(enabled: boolean | undefined, message: string) {
  if (!enabled) {
    return;
  }
  defaultRuntime.log(message);
}

function isGroupJid(jid: string): boolean {
  return (typeof isJidGroup === "function" ? isJidGroup(jid) : jid.endsWith("@g.us")) === true;
}

function isRetryableSendDisconnectError(err: unknown): boolean {
  return /closed|reset|timed\s*out|disconnect|no active socket/i.test(formatError(err));
}

function shouldClearSocketRefAfterSendFailure(err: unknown): boolean {
  return /closed|reset|disconnect|no active socket/i.test(formatError(err));
}

function isNonEmptyString(value: string | undefined): value is string {
  return Boolean(value);
}

export type MonitorWebInboxOptions = {
  cfg: OpenClawConfig;
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Keep the global presence unavailable so self-chat sessions do not mute phone pushes. */
  selfChatMode?: boolean;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
  /** Optional shared socket reference so reply closures can follow reconnects. */
  socketRef?: { current: WASocket | null };
  /** Whether send retries should wait for a reconnect. */
  shouldRetryDisconnect?: () => boolean;
  /** Reconnect timing for waiting through transient socket replacement gaps. */
  disconnectRetryPolicy?: {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
    maxAttempts: number;
  };
  /** Abort in-flight reconnect waits when shutdown becomes terminal. */
  disconnectRetryAbortSignal?: AbortSignal;
};

type WhatsAppGroupDebounceScope = "sender" | "conversation";
type WhatsAppGroupDebounceConfig = {
  scope: WhatsAppGroupDebounceScope;
  debounceMs?: number;
  selfAddressedDebounceMs?: number;
  debounceMaxWaitMs?: number;
  debounceMaxBatchItems?: number;
  lane?: WhatsAppQueueLaneDecision;
};
type WhatsAppPriorityLaneConfigLike = {
  debounceMs?: unknown;
  maxWaitMs?: unknown;
  maxBatchItems?: unknown;
  humanLatencyMs?: unknown;
};
type WhatsAppPriorityLanesConfigLike = {
  enabled?: unknown;
  directOwnerPull?: WhatsAppPriorityLaneConfigLike | null;
  inlineReplyToSelf?: WhatsAppPriorityLaneConfigLike | null;
  bothBotAsk?: WhatsAppPriorityLaneConfigLike | null;
  ambientRoomBurst?: WhatsAppPriorityLaneConfigLike | null;
  otherTargetAmbient?: WhatsAppPriorityLaneConfigLike | null;
};
type WhatsAppGroupConfigLike = {
  debounceScope?: unknown;
  debounceMs?: unknown;
  selfAddressedDebounceMs?: unknown;
  debounceMaxWaitMs?: unknown;
  debounceMaxBatchItems?: unknown;
  priorityLanes?: WhatsAppPriorityLanesConfigLike | null;
};
type WhatsAppGroupsConfigLike = Record<string, WhatsAppGroupConfigLike | null | undefined>;
type AgentConfigLike = {
  id?: unknown;
  name?: unknown;
  default?: unknown;
  aliases?: unknown;
  identity?: {
    name?: unknown;
    aliases?: unknown;
  } | null;
};

function normalizeAccountId(value: string | undefined | null): string {
  return value?.trim() || "default";
}

function normalizeDebounceMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.trunc(value));
}

type ResolvedPriorityLaneConfig = {
  enabled: boolean;
  lanes: Record<WhatsAppQueueLaneId, WhatsAppPriorityLaneConfigLike>;
};

const DEFAULT_PRIORITY_LANES: Record<
  WhatsAppQueueLaneId,
  Required<WhatsAppPriorityLaneConfigLike>
> = {
  direct_owner_pull: {
    debounceMs: 1200,
    maxWaitMs: 3500,
    maxBatchItems: 5,
    humanLatencyMs: 600,
  },
  inline_reply_to_self: {
    debounceMs: 2000,
    maxWaitMs: 5000,
    maxBatchItems: 5,
    humanLatencyMs: 600,
  },
  both_bot_ask: {
    debounceMs: 2500,
    maxWaitMs: 6000,
    maxBatchItems: 6,
    humanLatencyMs: 600,
  },
  ambient_room_burst: {
    debounceMs: 4500,
    maxWaitMs: 9000,
    maxBatchItems: 12,
    humanLatencyMs: 0,
  },
  other_target_ambient: {
    debounceMs: 4500,
    maxWaitMs: 9000,
    maxBatchItems: 12,
    humanLatencyMs: 0,
  },
};

function normalizePhoneDigits(value: string | number | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 6 ? digits : null;
}

function collectOwnerPhones(cfg: OpenClawConfig): Set<string> {
  const owners = new Set<string>();
  const whatsapp = cfg.channels?.whatsapp as
    | {
        allowFrom?: unknown;
        ownerAllowFrom?: unknown;
        accounts?: Record<string, { allowFrom?: unknown; ownerAllowFrom?: unknown } | null>;
      }
    | undefined;
  const addPhones = (values: unknown) => {
    if (!Array.isArray(values)) {
      return;
    }
    for (const value of values) {
      if (typeof value !== "string" && typeof value !== "number") {
        continue;
      }
      const normalized = normalizePhoneDigits(value);
      if (normalized) {
        owners.add(normalized);
      }
    }
  };
  addPhones(whatsapp?.allowFrom);
  addPhones(whatsapp?.ownerAllowFrom);
  for (const account of Object.values(whatsapp?.accounts ?? {})) {
    addPhones(account?.allowFrom);
    addPhones(account?.ownerAllowFrom);
  }
  return owners;
}

function isOwnerSenderForQueueLane(params: { cfg: OpenClawConfig; msg: WebInboundMessage }) {
  const senderPhone =
    normalizePhoneDigits(params.msg.sender?.e164) ?? normalizePhoneDigits(params.msg.senderE164);
  if (!senderPhone) {
    return false;
  }
  return collectOwnerPhones(params.cfg).has(senderPhone);
}

function resolvePriorityLaneEntry(
  lanes: WhatsAppPriorityLanesConfigLike | null | undefined,
  laneId: WhatsAppQueueLaneId,
): WhatsAppPriorityLaneConfigLike {
  const configured =
    laneId === "direct_owner_pull"
      ? lanes?.directOwnerPull
      : laneId === "inline_reply_to_self"
        ? lanes?.inlineReplyToSelf
        : laneId === "both_bot_ask"
          ? lanes?.bothBotAsk
          : laneId === "ambient_room_burst"
            ? lanes?.ambientRoomBurst
            : lanes?.otherTargetAmbient;
  return {
    ...DEFAULT_PRIORITY_LANES[laneId],
    ...(configured ?? {}),
  };
}

function resolvePriorityLanesConfig(entry?: WhatsAppGroupConfigLike): ResolvedPriorityLaneConfig {
  const lanes = entry?.priorityLanes;
  const enabled = lanes?.enabled === true;
  return {
    enabled,
    lanes: {
      direct_owner_pull: resolvePriorityLaneEntry(lanes, "direct_owner_pull"),
      inline_reply_to_self: resolvePriorityLaneEntry(lanes, "inline_reply_to_self"),
      both_bot_ask: resolvePriorityLaneEntry(lanes, "both_bot_ask"),
      ambient_room_burst: resolvePriorityLaneEntry(lanes, "ambient_room_burst"),
      other_target_ambient: resolvePriorityLaneEntry(lanes, "other_target_ambient"),
    },
  };
}

function lanePriority(id: WhatsAppQueueLaneId): number {
  switch (id) {
    case "direct_owner_pull":
      return 1;
    case "inline_reply_to_self":
      return 2;
    case "both_bot_ask":
      return 3;
    case "ambient_room_burst":
      return 4;
    case "other_target_ambient":
      return 5;
  }
}

function isInlineReplyToSelf(msg: WebInboundMessage): boolean {
  return identitiesOverlap(getSelfIdentity(msg), getReplyContext(msg)?.sender);
}

function hasBothBotAskShape(text: string): boolean {
  return /\b(?:you both|both of you|both bots|shoar\s+(?:and|&)\s+brodie|brodie\s+(?:and|&)\s+shoar|compare|comparison|your take|independent take)\b/i.test(
    text,
  );
}

function hasOwnerShoarBehaviorPullShape(text: string): boolean {
  return /\b(?:no[_\s-]?reply|silenc(?:e|ed|ing)|su[p]?press(?:ion|ed|ing)?|disappear(?:ed|ing)?|typing|ambient\s+noise|not\s+respond(?:ing)?|stopped\s+responding|hold\s+convos?|visibility|can\s+(?:you|u)\s+(?:see|hear)|talking\s+to\s+(?:you|u)|inline(?:\s+reply)?|quoted?\s+(?:message|reply|text)|reply\s+(?:target|metadata|context)|thing\s+(?:isnt|isn't|is\s+not|not)\s+working)\b/i.test(
    text,
  );
}

function hasOwnerMultiAgentPullShape(text: string): boolean {
  return /\b(?:why\s+(?:did\s+)?(?:none|nobody|no\s+one)|none\s+of\s+(?:you|u)|(?:you|u)\s+(?:both|all)|both\s+bots?|bots?\s+(?:can|should|need|gotta|simplif|explain|answer|respond|reply)|agents?\s+(?:can|should|need|gotta|simplif|explain|answer|respond|reply))\b/i.test(
    text,
  );
}

function hasOwnerSecondPersonPullShape(text: string): boolean {
  return /\b(?:(?:do|did|are|were|was|can|could|would|will|should|have|has)\s+(?:you|u)|(?:you|u)\s+(?:still|pay|have|use|got|getting|want|think|mean|know|remember)|your|ur|you're|youre)\b/i.test(
    text,
  );
}

function hasOtherTargetAmbientShape(text: string): boolean {
  return /\b(?:brodie|abhay's\s+bot|abhays\s+bot|abhay\s+bot|abhay's\s+agent|abhays\s+agent|abhay\s+agent|brocode)\b/i.test(
    text,
  );
}

function buildQueueLaneDecision(
  id: WhatsAppQueueLaneId,
  reason: string,
  lanes: ResolvedPriorityLaneConfig,
): WhatsAppQueueLaneDecision {
  const lane = lanes.lanes[id];
  return {
    id,
    priority: lanePriority(id),
    reason,
    ...(normalizeDebounceMs(lane.debounceMs) === undefined
      ? {}
      : { debounceMs: normalizeDebounceMs(lane.debounceMs) }),
    ...(normalizeDebounceMs(lane.maxWaitMs) === undefined
      ? {}
      : { maxWaitMs: normalizeDebounceMs(lane.maxWaitMs) }),
    ...(normalizePositiveInt(lane.maxBatchItems) === undefined
      ? {}
      : { maxBatchItems: normalizePositiveInt(lane.maxBatchItems) }),
    ...(normalizeDebounceMs(lane.humanLatencyMs) === undefined
      ? {}
      : { humanLatencyMs: normalizeDebounceMs(lane.humanLatencyMs) }),
  };
}

function cleanDebounceText(value: string | undefined | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, "")
    .trim();
}

function normalizeDebounceText(value: string | undefined | null): string {
  return cleanDebounceText(value).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactAlphaNumeric(value: string): string {
  return normalizeDebounceText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function pushDebounceAlias(target: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = normalizeDebounceText(value);
  if (normalized.length >= 2) {
    target.add(normalized);
  }
}

function pushDebounceAliases(target: Set<string>, values: unknown): void {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    pushDebounceAlias(target, value);
  }
}

function resolveConfiguredAgentAliases(cfg: OpenClawConfig): string[] {
  const aliases = new Set<string>();
  const agents = (Array.isArray(cfg.agents?.list) ? cfg.agents.list : []) as AgentConfigLike[];
  for (const agent of agents) {
    if (!agent) {
      continue;
    }
    if (agent.id !== "main") {
      pushDebounceAlias(aliases, agent.id);
    }
    pushDebounceAlias(aliases, agent.name);
    pushDebounceAlias(aliases, agent.identity?.name);
    pushDebounceAliases(aliases, agent.aliases);
    pushDebounceAliases(aliases, agent.identity?.aliases);
  }
  return Array.from(aliases);
}

function hasDirectAlias(text: string, alias: string): boolean {
  const normalizedAlias = normalizeDebounceText(alias);
  if (!normalizedAlias) {
    return false;
  }
  const escaped = escapeRegExp(normalizedAlias).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function hasLooseSpelledAlias(text: string, alias: string): boolean {
  const compact = compactAlphaNumeric(alias);
  if (compact.length < 3 || compact.length > 16) {
    return false;
  }
  const spelled = Array.from(compact)
    .map((char) => escapeRegExp(char))
    .join("[\\s._-]+");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${spelled}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function isOneSubstitutionOrAdjacentSwap(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 4 || a === b) {
    return false;
  }
  const diffs: number[] = [];
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      diffs.push(index);
      if (diffs.length > 2) {
        return false;
      }
    }
  }
  if (diffs.length === 1) {
    return true;
  }
  return (
    diffs.length === 2 &&
    diffs[1] === diffs[0] + 1 &&
    a[diffs[0]] === b[diffs[1]] &&
    a[diffs[1]] === b[diffs[0]]
  );
}

function hasNearSingleWordAlias(text: string, alias: string): boolean {
  const compact = compactAlphaNumeric(alias);
  if (compact.length < 4 || compact.length > 12 || compact !== normalizeDebounceText(alias)) {
    return false;
  }
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.some((token) =>
    isOneSubstitutionOrAdjacentSwap(compactAlphaNumeric(token), compact),
  );
}

function textMentionsSelfIdentityForDebounce(text: string, msg: WebInboundMessage): boolean {
  const self = getSelfIdentity(msg);
  const candidates = [
    self.jid,
    self.lid,
    self.e164,
    self.jid?.split("@")[0]?.split(":")[0],
    self.lid?.split("@")[0]?.split(":")[0],
    self.e164?.replace(/\D/g, ""),
  ].filter((entry): entry is string => Boolean(entry));
  for (const raw of candidates) {
    const value = raw.toLowerCase().replace(/[^\dA-Za-z@.]/g, "");
    if (!value) {
      continue;
    }
    if (value.includes("@") && text.includes(value)) {
      return true;
    }
    if (/^\d{5,}$/.test(value) && new RegExp(`(^|\\D)@?${escapeRegExp(value)}($|\\D)`).test(text)) {
      return true;
    }
  }
  return false;
}

function isSelfAddressedForDebounce(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
}): boolean {
  if (params.msg.chatType !== "group") {
    return false;
  }
  const self = getSelfIdentity(params.msg);
  if (getMentionIdentities(params.msg).some((mention) => identitiesOverlap(self, mention))) {
    return true;
  }
  if (identitiesOverlap(self, getReplyContext(params.msg)?.sender)) {
    return true;
  }
  const text = normalizeDebounceText(params.msg.body);
  if (textMentionsSelfIdentityForDebounce(text, params.msg)) {
    return true;
  }
  return resolveConfiguredAgentAliases(params.cfg).some(
    (alias) =>
      hasDirectAlias(text, alias) ||
      hasLooseSpelledAlias(text, alias) ||
      hasNearSingleWordAlias(text, alias),
  );
}

function isOwnerDirectPullForDebounce(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
}): boolean {
  if (!isOwnerSenderForQueueLane(params)) {
    return false;
  }
  if (isSelfAddressedForDebounce(params) || isInlineReplyToSelf(params.msg)) {
    return true;
  }
  const text = normalizeDebounceText(params.msg.body);
  if (hasOtherTargetAmbientShape(text)) {
    return false;
  }
  return hasOwnerShoarBehaviorPullShape(text) || hasOwnerSecondPersonPullShape(text);
}

function isOwnerMultiAgentPullForDebounce(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
}): boolean {
  if (!isOwnerSenderForQueueLane(params)) {
    return false;
  }
  const text = normalizeDebounceText(params.msg.body);
  return hasBothBotAskShape(text) || hasOwnerMultiAgentPullShape(text);
}

function resolveConversationGroupId(
  msg: Pick<WebInboundMessage, "chatId" | "conversationId" | "from">,
) {
  return msg.chatId || msg.conversationId || msg.from;
}

function resolveWhatsAppGroupConfigEntry(params: {
  cfg: OpenClawConfig;
  accountId: string;
  groupId: string;
}): WhatsAppGroupConfigLike | undefined {
  const whatsapp = params.cfg.channels?.whatsapp as
    | {
        groups?: WhatsAppGroupsConfigLike;
        accounts?: Record<string, { groups?: WhatsAppGroupsConfigLike } | null | undefined>;
      }
    | undefined;
  const accountId = normalizeAccountId(params.accountId);
  const accountGroups = whatsapp?.accounts?.[accountId]?.groups;
  const defaultAccountGroups =
    accountId === "default" ? undefined : whatsapp?.accounts?.default?.groups;
  for (const groups of [accountGroups, defaultAccountGroups, whatsapp?.groups]) {
    const exact = groups?.[params.groupId];
    if (exact) {
      return exact;
    }
    const wildcard = groups?.["*"];
    if (wildcard) {
      return wildcard;
    }
  }
  return undefined;
}

export function resolveWhatsAppGroupDebounceConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: Pick<WebInboundMessage, "accountId" | "chatType" | "chatId" | "conversationId" | "from">;
}): WhatsAppGroupDebounceConfig {
  if (params.msg.chatType !== "group") {
    return { scope: "sender" };
  }
  const groupId = resolveConversationGroupId(params.msg);
  const entry = resolveWhatsAppGroupConfigEntry({
    cfg: params.cfg,
    accountId: params.msg.accountId || params.accountId,
    groupId,
  });
  const scope = entry?.debounceScope === "conversation" ? "conversation" : "sender";
  const debounceMs = normalizeDebounceMs(entry?.debounceMs);
  return {
    scope,
    ...(debounceMs === undefined ? {} : { debounceMs }),
    ...(normalizeDebounceMs(entry?.selfAddressedDebounceMs) === undefined
      ? {}
      : { selfAddressedDebounceMs: normalizeDebounceMs(entry?.selfAddressedDebounceMs) }),
    ...(normalizeDebounceMs(entry?.debounceMaxWaitMs) === undefined
      ? {}
      : { debounceMaxWaitMs: normalizeDebounceMs(entry?.debounceMaxWaitMs) }),
    ...(normalizePositiveInt(entry?.debounceMaxBatchItems) === undefined
      ? {}
      : { debounceMaxBatchItems: normalizePositiveInt(entry?.debounceMaxBatchItems) }),
  };
}

export function resolveWhatsAppInboundQueueLaneDecision(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: WebInboundMessage;
}): WhatsAppQueueLaneDecision | undefined {
  if (params.msg.chatType !== "group") {
    return undefined;
  }
  const groupId = resolveConversationGroupId(params.msg);
  const entry = resolveWhatsAppGroupConfigEntry({
    cfg: params.cfg,
    accountId: params.msg.accountId || params.accountId,
    groupId,
  });
  const lanes = resolvePriorityLanesConfig(entry);
  if (!lanes.enabled) {
    return undefined;
  }
  const text = normalizeDebounceText(params.msg.body);
  const selfAddressed = isSelfAddressedForDebounce({ cfg: params.cfg, msg: params.msg });
  const replyToSelf = isInlineReplyToSelf(params.msg);
  const ownerSender = isOwnerSenderForQueueLane(params);
  const ownerDirectPull = isOwnerDirectPullForDebounce({ cfg: params.cfg, msg: params.msg });
  const ownerMultiAgentPull = isOwnerMultiAgentPullForDebounce({
    cfg: params.cfg,
    msg: params.msg,
  });
  if ((ownerSender && hasBothBotAskShape(text)) || ownerMultiAgentPull) {
    return buildQueueLaneDecision("both_bot_ask", "both_bot_or_comparison_pull", lanes);
  }
  if (ownerDirectPull) {
    return buildQueueLaneDecision("direct_owner_pull", "owner_direct_pull", lanes);
  }
  if (replyToSelf) {
    return buildQueueLaneDecision("inline_reply_to_self", "reply_to_self", lanes);
  }
  if (selfAddressed && hasBothBotAskShape(text)) {
    return buildQueueLaneDecision("both_bot_ask", "both_bot_or_comparison_pull", lanes);
  }
  if (selfAddressed) {
    return buildQueueLaneDecision("inline_reply_to_self", "self_addressed_non_owner", lanes);
  }
  if (hasOtherTargetAmbientShape(text)) {
    return buildQueueLaneDecision("other_target_ambient", "other_target_group_burst", lanes);
  }
  return buildQueueLaneDecision("ambient_room_burst", "ambient_group_burst", lanes);
}

export function resolveWhatsAppInboundDebounceConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: WebInboundMessage;
}): WhatsAppGroupDebounceConfig {
  const base = resolveWhatsAppGroupDebounceConfig(params);
  const lane = resolveWhatsAppInboundQueueLaneDecision(params);
  if (lane) {
    return {
      ...base,
      lane,
      debounceMs: lane.debounceMs ?? base.debounceMs,
      debounceMaxWaitMs: lane.maxWaitMs ?? base.debounceMaxWaitMs,
      debounceMaxBatchItems: lane.maxBatchItems ?? base.debounceMaxBatchItems,
    };
  }
  if (params.msg.chatType !== "group") {
    return base;
  }
  if (
    base.selfAddressedDebounceMs !== undefined &&
    isSelfAddressedForDebounce({ cfg: params.cfg, msg: params.msg })
  ) {
    return { ...base, debounceMs: base.selfAddressedDebounceMs };
  }
  return base;
}

function buildWhatsAppInboundDebounceKeyForLane(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: WebInboundMessage;
  laneId: WhatsAppQueueLaneId;
}): string {
  const accountId = normalizeAccountId(params.msg.accountId || params.accountId);
  const conversationKey = resolveConversationGroupId(params.msg);
  return `${accountId}:${conversationKey}:lane:${params.laneId}`;
}

export function buildWhatsAppInboundDebounceKey(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: WebInboundMessage;
}): string | null {
  const accountId = normalizeAccountId(params.msg.accountId || params.accountId);
  const conversationKey =
    params.msg.chatType === "group" ? resolveConversationGroupId(params.msg) : params.msg.from;

  if (params.msg.chatType === "group") {
    const lane = resolveWhatsAppInboundQueueLaneDecision(params);
    if (lane) {
      return buildWhatsAppInboundDebounceKeyForLane({ ...params, laneId: lane.id });
    }
    const groupDebounce = resolveWhatsAppGroupDebounceConfig(params);
    if (
      groupDebounce.scope === "conversation" &&
      !isSelfAddressedForDebounce({ cfg: params.cfg, msg: params.msg })
    ) {
      return `${accountId}:${conversationKey}:conversation`;
    }
  }

  const sender = params.msg.sender;
  const senderKey =
    params.msg.chatType === "group"
      ? (getPrimaryIdentityId(sender ?? null) ??
        params.msg.senderJid ??
        params.msg.senderE164 ??
        params.msg.senderName ??
        params.msg.from)
      : params.msg.from;
  if (!senderKey) {
    return null;
  }
  return `${accountId}:${conversationKey}:${senderKey}`;
}

function resolveEntrySenderKey(entry: WebInboundMessage): string {
  return (
    getPrimaryIdentityId(entry.sender ?? null) ??
    entry.senderJid ??
    entry.senderE164 ??
    entry.senderName ??
    entry.from
  );
}

function sanitizeSenderLabel(value: string | undefined | null): string {
  const label = (value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label ? label.slice(0, 80) : "Unknown";
}

function resolveEntrySenderLabel(entry: WebInboundMessage): string {
  return sanitizeSenderLabel(
    entry.senderName ?? entry.sender?.name ?? entry.senderE164 ?? entry.senderJid ?? entry.from,
  );
}

function buildPendingAmbientEntry(entry: WebInboundMessage): WhatsAppPendingAmbientEntry {
  return {
    ...(entry.id ? { id: entry.id } : {}),
    sender: resolveEntrySenderLabel(entry),
    ...(entry.senderJid ? { senderJid: entry.senderJid } : {}),
    ...(entry.senderE164 ? { senderE164: entry.senderE164 } : {}),
    body: entry.body,
    ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
  };
}

function resolveQueueBurstWindowMs(entries: readonly WebInboundMessage[]): number | undefined {
  const timestamps = entries
    .map((entry) => entry.timestamp)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (timestamps.length < 2) {
    return undefined;
  }
  return Math.max(...timestamps) - Math.min(...timestamps);
}

function buildQueueBurstMetadata(params: {
  entries: readonly WebInboundMessage[];
  key: string | null;
  lane?: WhatsAppQueueLaneDecision;
}): WebInboundMessage["queueBurst"] {
  return {
    size: params.entries.length,
    ...(params.key ? { key: params.key } : {}),
    ...(resolveQueueBurstWindowMs(params.entries) === undefined
      ? {}
      : { windowMs: resolveQueueBurstWindowMs(params.entries) }),
    ...(params.lane?.debounceMs === undefined ? {} : { debounceMs: params.lane.debounceMs }),
    ...(params.lane?.maxWaitMs === undefined ? {} : { maxWaitMs: params.lane.maxWaitMs }),
    ...(params.lane?.maxBatchItems === undefined
      ? {}
      : { maxBatchItems: params.lane.maxBatchItems }),
  };
}

export function formatBatchedWhatsAppInboundBody(entries: readonly WebInboundMessage[]): string {
  const bodies = entries.map((entry) => entry.body).filter(Boolean);
  const senderKeys = new Set(entries.map(resolveEntrySenderKey).filter(Boolean));
  if (senderKeys.size <= 1) {
    return bodies.join("\n");
  }
  return entries
    .map((entry) => {
      const body = entry.body?.trim();
      return body ? `${resolveEntrySenderLabel(entry)}: ${body}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function selectBatchedWhatsAppInboundAnchor(params: {
  cfg: OpenClawConfig;
  entries: readonly WebInboundMessage[];
}): WebInboundMessage | undefined {
  let best: { entry: WebInboundMessage; index: number; priority: number } | undefined;
  params.entries.forEach((entry, index) => {
    const lane = resolveWhatsAppInboundQueueLaneDecision({
      cfg: params.cfg,
      accountId: entry.accountId,
      msg: entry,
    });
    const priority =
      lane?.priority ??
      (isOwnerDirectPullForDebounce({ cfg: params.cfg, msg: entry }) ||
      isOwnerMultiAgentPullForDebounce({ cfg: params.cfg, msg: entry }) ||
      isSelfAddressedForDebounce({ cfg: params.cfg, msg: entry })
        ? 3
        : undefined);
    if (priority === undefined) {
      return;
    }
    if (!best || priority < best.priority || (priority === best.priority && index > best.index)) {
      best = { entry, index, priority };
    }
  });
  return best?.entry ?? params.entries.at(-1);
}

export async function attachWebInboxToSocket(
  options: MonitorWebInboxOptions & {
    sock: WASocket;
  },
) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = options.sock;
  const connectedAtMs = Date.now();
  if (options.socketRef) {
    options.socketRef.current = sock;
  }
  const getCurrentSock = () => (options.socketRef ? options.socketRef.current : sock);
  const shouldRetryDisconnect = () => options.shouldRetryDisconnect?.() === true;
  const disconnectRetryPolicy = options.disconnectRetryPolicy ?? DEFAULT_RECONNECT_POLICY;
  const sendRetryMaxAttempts =
    disconnectRetryPolicy.maxAttempts > 0
      ? disconnectRetryPolicy.maxAttempts
      : DEFAULT_RECONNECT_POLICY.maxAttempts;

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };
  const presence = options.selfChatMode ? "unavailable" : "available";

  try {
    await sock.sendPresenceUpdate(presence);
    logWhatsAppVerbose(options.verbose, `Sent global '${presence}' presence on connect`);
  } catch (err) {
    logWhatsAppVerbose(
      options.verbose,
      `Failed to send '${presence}' presence on connect: ${String(err)}`,
    );
  }

  const selfIdentity = await readWebSelfIdentityForDecision(
    options.authDir,
    sock.user as { id?: string | null; lid?: string | null } | undefined,
  );
  if (selfIdentity.outcome === "unstable") {
    throw new WhatsAppAuthUnstableError(
      "WhatsApp auth state is still stabilizing; retrying inbox attach.",
    );
  }
  const self = selfIdentity.identity;
  type QueuedInboundMessage = WebInboundMessage & {
    dedupeKey?: string;
  };

  const finalizeInboundDedupe = async (
    entries: QueuedInboundMessage[],
    error?: unknown,
  ): Promise<void> => {
    const dedupeKeys = [
      ...new Set(entries.map((entry) => entry.dedupeKey).filter(isNonEmptyString)),
    ];
    if (dedupeKeys.length === 0) {
      return;
    }
    if (error instanceof WhatsAppRetryableInboundError) {
      dedupeKeys.forEach((dedupeKey) => releaseRecentInboundMessage(dedupeKey, error));
      return;
    }
    await Promise.all(dedupeKeys.map((dedupeKey) => commitRecentInboundMessage(dedupeKey)));
  };

  const debouncer = createInboundDebouncer<QueuedInboundMessage>({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) =>
      buildWhatsAppInboundDebounceKey({
        cfg: options.cfg,
        accountId: options.accountId,
        msg,
      }),
    shouldDebounce: options.shouldDebounce,
    resolveDebounceMs: (msg) =>
      resolveWhatsAppInboundDebounceConfig({
        cfg: options.cfg,
        accountId: options.accountId,
        msg,
      }).debounceMs,
    resolveMaxDebounceMs: (msg) =>
      resolveWhatsAppInboundDebounceConfig({
        cfg: options.cfg,
        accountId: options.accountId,
        msg,
      }).debounceMaxWaitMs,
    resolveMaxBatchItems: (msg) =>
      resolveWhatsAppInboundDebounceConfig({
        cfg: options.cfg,
        accountId: options.accountId,
        msg,
      }).debounceMaxBatchItems,
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      let pendingAmbientEntries: QueuedInboundMessage[] = [];
      try {
        const anchor =
          entries.length === 1
            ? last
            : selectBatchedWhatsAppInboundAnchor({
                cfg: options.cfg,
                entries,
              });
        if (!anchor) {
          await finalizeInboundDedupe(entries);
          return;
        }
        const queueLane = resolveWhatsAppInboundQueueLaneDecision({
          cfg: options.cfg,
          accountId: options.accountId,
          msg: anchor,
        });
        const flushKey = buildWhatsAppInboundDebounceKey({
          cfg: options.cfg,
          accountId: options.accountId,
          msg: anchor,
        });
        if (anchor.chatType === "group" && queueLane && queueLane.priority <= 3) {
          const ambientKey = buildWhatsAppInboundDebounceKeyForLane({
            cfg: options.cfg,
            accountId: options.accountId,
            msg: anchor,
            laneId: "ambient_room_burst",
          });
          if (ambientKey !== flushKey) {
            pendingAmbientEntries = debouncer.clearKey(ambientKey);
          }
        }
        const mentioned = new Set<string>();
        for (const entry of entries) {
          for (const jid of entry.mentions ?? entry.mentionedJids ?? []) {
            mentioned.add(jid);
          }
        }
        const combinedBody =
          entries.length === 1 ? anchor.body : formatBatchedWhatsAppInboundBody(entries);
        const combinedMessage: WebInboundMessage = {
          ...anchor,
          body: combinedBody,
          mentions: mentioned.size > 0 ? Array.from(mentioned) : undefined,
          mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
          isBatched: entries.length > 1 ? true : anchor.isBatched,
          ...(queueLane ? { queueLane } : {}),
          queueBurst: buildQueueBurstMetadata({
            entries,
            key: flushKey,
            lane: queueLane,
          }),
          ...(pendingAmbientEntries.length > 0
            ? { pendingAmbientBurst: pendingAmbientEntries.map(buildPendingAmbientEntry) }
            : {}),
        };
        await options.onMessage(combinedMessage);
        await finalizeInboundDedupe([...entries, ...pendingAmbientEntries]);
      } catch (error) {
        await finalizeInboundDedupe([...entries, ...pendingAmbientEntries], error);
        throw error;
      }
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const extractOutboundBody = (content: AnyMessageContent): string | undefined => {
    const record = content as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (text) {
      return text;
    }
    const caption = typeof record.caption === "string" ? record.caption.trim() : "";
    return caption || undefined;
  };

  const rememberOutboundMessage = (
    remoteJid: string,
    result: unknown,
    content?: AnyMessageContent,
  ) => {
    const messageId =
      typeof result === "object" && result && "key" in result
        ? ((result as { key?: { id?: string } }).key?.id ?? "")
        : "";
    if (!messageId) {
      return;
    }
    rememberRecentOutboundMessage({
      accountId: options.accountId,
      remoteJid,
      messageId,
    });
    const body = content ? extractOutboundBody(content) : undefined;
    if (body) {
      cacheInboundMessageMeta(options.accountId, remoteJid, messageId, {
        participant: self.lid ?? self.jid ?? undefined,
        participantE164: self.e164 ?? undefined,
        body,
        fromMe: true,
      });
    }
  };

  const sendTrackedMessage = async (
    jid: string,
    content: AnyMessageContent,
    sendOptions?: MiscMessageGenerationOptions,
  ) => {
    let lastErr: unknown = new Error(RECONNECT_IN_PROGRESS_ERROR);
    for (let attempt = 1; ; attempt++) {
      const currentSock = getCurrentSock();
      if (currentSock) {
        try {
          const result = sendOptions
            ? await currentSock.sendMessage(jid, content, sendOptions)
            : await currentSock.sendMessage(jid, content);
          rememberOutboundMessage(jid, result, content);
          return result;
        } catch (err) {
          if (!shouldRetryDisconnect() || !isRetryableSendDisconnectError(err)) {
            throw err;
          }
          lastErr = err;
          if (
            shouldClearSocketRefAfterSendFailure(err) &&
            options.socketRef?.current === currentSock
          ) {
            options.socketRef.current = null;
          }
        }
      } else if (!shouldRetryDisconnect()) {
        throw lastErr;
      }

      if (attempt >= sendRetryMaxAttempts) {
        throw lastErr;
      }
      const delayMs = computeBackoff(disconnectRetryPolicy, attempt);
      logWhatsAppVerbose(
        options.verbose,
        `Waiting ${delayMs}ms for WhatsApp reconnect before retrying send to ${jid}: ${formatError(lastErr)}`,
      );
      try {
        await sleepWithAbort(delayMs, options.disconnectRetryAbortSignal);
      } catch {
        throw lastErr;
      }
    }
  };

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        expires: Date.now() + GROUP_META_TTL_MS,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logWhatsAppVerbose(
        options.verbose,
        `Failed to fetch group metadata for ${jid}: ${String(err)}`,
      );
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  type NormalizedInboundMessage = {
    id?: string;
    remoteJid: string;
    group: boolean;
    participantJid?: string;
    from: string;
    senderE164: string | null;
    groupSubject?: string;
    groupParticipants?: string[];
    messageTimestampMs?: number;
    access: Awaited<ReturnType<typeof checkInboundAccessControl>>;
  };

  const normalizeInboundMessage = async (
    msg: WAMessage,
  ): Promise<NormalizedInboundMessage | null> => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      return null;
    }
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    const group = isGroupJid(remoteJid);
    // Drop echoes of messages the gateway itself sent (tracked by sendTrackedMessage).
    // Applies to both groups and DMs/self-chat. Without this, self-chat mode
    // re-processes the bot's own replies as new inbound user messages.
    if (
      Boolean(msg.key?.fromMe) &&
      id &&
      isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        messageId: id,
      })
    ) {
      logWhatsAppVerbose(
        options.verbose,
        `Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`,
      );
      return null;
    }
    const participantJid = msg.key?.participant ?? undefined;
    const from = group ? remoteJid : await resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group
      ? participantJid
        ? await resolveInboundJid(participantJid)
        : null
      : from;

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await getGroupMeta(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampMs = msg.messageTimestamp
      ? Number(msg.messageTimestamp) * 1000
      : undefined;

    const access = await checkInboundAccessControl({
      cfg: options.cfg,
      accountId: options.accountId,
      from,
      selfE164: self.e164 ?? null,
      senderE164,
      group,
      pushName: msg.pushName ?? undefined,
      isFromMe: Boolean(msg.key?.fromMe),
      messageTimestampMs,
      connectedAtMs,
      verbose: options.verbose,
      sock: {
        sendMessage: (jid: string, content: AnyMessageContent) => sendTrackedMessage(jid, content),
      },
      remoteJid,
    });
    if (!access.allowed) {
      return null;
    }

    return {
      id,
      remoteJid,
      group,
      participantJid,
      from,
      senderE164,
      groupSubject,
      groupParticipants,
      messageTimestampMs,
      access,
    };
  };

  const maybeMarkInboundAsRead = async (inbound: NormalizedInboundMessage) => {
    const { id, remoteJid, participantJid, access } = inbound;
    if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
      try {
        await sock.readMessages([{ remoteJid, id, participant: participantJid, fromMe: false }]);
        const suffix = participantJid ? ` (participant ${participantJid})` : "";
        logWhatsAppVerbose(
          options.verbose,
          `Marked message ${id} as read for ${remoteJid}${suffix}`,
        );
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Failed to mark message ${id} read: ${String(err)}`);
      }
    } else if (id && access.isSelfChat && options.verbose) {
      // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
      logWhatsAppVerbose(options.verbose, `Self-chat mode: skipping read receipt for ${id}`);
    }
  };

  type EnrichedInboundMessage = {
    body: string;
    location?: ReturnType<typeof extractLocationData>;
    contactContext?: ReturnType<typeof extractContactContext>;
    replyContext?: ReturnType<typeof describeReplyContext>;
    mediaPath?: string;
    mediaType?: string;
    mediaFileName?: string;
  };

  const enrichInboundMessage = async (msg: WAMessage): Promise<EnrichedInboundMessage | null> => {
    const location = extractLocationData(msg.message ?? undefined);
    const locationText = location ? formatLocationText(location) : undefined;
    const contactContext = extractContactContext(msg.message ?? undefined);
    let body = extractText(msg.message ?? undefined);
    if (locationText) {
      body = [body, locationText].filter(Boolean).join("\n").trim();
    }
    if (!body) {
      body = extractMediaPlaceholder(msg.message ?? undefined);
      if (!body) {
        return null;
      }
    }
    const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let mediaFileName: string | undefined;
    try {
      const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
      if (inboundMedia) {
        const maxMb =
          typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
            ? options.mediaMaxMb
            : 50;
        const maxBytes = maxMb * 1024 * 1024;
        const saved = await saveMediaBuffer(
          inboundMedia.buffer,
          inboundMedia.mimetype,
          "inbound",
          maxBytes,
          inboundMedia.fileName,
        );
        mediaPath = saved.path;
        mediaType = inboundMedia.mimetype;
        mediaFileName = inboundMedia.fileName;
      }
    } catch (err) {
      logWhatsAppVerbose(options.verbose, `Inbound media download failed: ${String(err)}`);
    }

    return {
      body,
      location: location ?? undefined,
      contactContext,
      replyContext,
      mediaPath,
      mediaType,
      mediaFileName,
    };
  };

  const resolveReplyContext = async (params: {
    msg: WAMessage;
    inbound: NormalizedInboundMessage;
    existing?: WhatsAppReplyContext | null;
  }): Promise<WhatsAppReplyContext | null> => {
    if (params.existing?.body) {
      return params.existing;
    }
    const replyKey = describeReplyContextKey(params.msg.message as proto.IMessage | undefined);
    if (!replyKey?.id) {
      return params.existing ?? null;
    }
    const cachedByResolvedAccount = lookupInboundMessageMeta(
      params.inbound.access.resolvedAccountId,
      params.inbound.remoteJid,
      replyKey.id,
    );
    const cached =
      cachedByResolvedAccount ??
      (params.inbound.access.resolvedAccountId !== options.accountId
        ? lookupInboundMessageMeta(options.accountId, params.inbound.remoteJid, replyKey.id)
        : undefined);
    const cachedBody = cached?.body?.trim();
    const senderJid = replyKey.sender?.jid ?? replyKey.sender?.lid ?? cached?.participant;
    const senderE164 =
      cached?.participantE164 ??
      (senderJid ? await resolveInboundJid(senderJid) : null) ??
      replyKey.sender?.e164 ??
      null;
    const senderLabel = senderE164 ?? replyKey.sender?.label ?? senderJid ?? "unknown sender";
    return {
      id: replyKey.id,
      body: cachedBody || "<quoted message unavailable>",
      sender: resolveComparableIdentity({
        jid: senderJid,
        e164: senderE164 ?? undefined,
        label: senderLabel,
      }),
    };
  };

  const enqueueInboundMessage = async (
    msg: WAMessage,
    inbound: NormalizedInboundMessage,
    enriched: EnrichedInboundMessage,
  ) => {
    const chatJid = inbound.remoteJid;
    const sendComposing = async () => {
      const currentSock = getCurrentSock();
      if (!currentSock) {
        return;
      }
      try {
        await currentSock.sendPresenceUpdate("composing", chatJid);
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Presence update failed: ${String(err)}`);
      }
    };
    const reply = async (text: string, options?: MiscMessageGenerationOptions) => {
      await sendTrackedMessage(chatJid, { text }, options);
    };
    const sendMedia = async (
      payload: AnyMessageContent,
      options?: MiscMessageGenerationOptions,
    ) => {
      await sendTrackedMessage(chatJid, payload, options);
    };
    const timestamp = inbound.messageTimestampMs;
    const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
    const senderName = msg.pushName ?? undefined;
    const replyContext = await resolveReplyContext({
      msg,
      inbound,
      existing: enriched.replyContext,
    });

    inboundLogger.info(
      {
        from: inbound.from,
        to: self.e164 ?? "me",
        body: enriched.body,
        mediaPath: enriched.mediaPath,
        mediaType: enriched.mediaType,
        mediaFileName: enriched.mediaFileName,
        timestamp,
      },
      "inbound message",
    );
    const inboundMessage: QueuedInboundMessage = {
      id: inbound.id,
      from: inbound.from,
      conversationId: inbound.from,
      to: self.e164 ?? "me",
      accountId: inbound.access.resolvedAccountId,
      accessControlPassed: true,
      body: enriched.body,
      pushName: senderName,
      timestamp,
      chatType: inbound.group ? "group" : "direct",
      chatId: inbound.remoteJid,
      sender: resolveComparableIdentity({
        jid: inbound.participantJid,
        e164: inbound.senderE164 ?? undefined,
        name: senderName,
      }),
      senderJid: inbound.participantJid,
      senderE164: inbound.senderE164 ?? undefined,
      senderName,
      replyTo: replyContext ?? undefined,
      replyToId: replyContext?.id,
      replyToBody: replyContext?.body,
      replyToSender: replyContext?.sender?.label ?? undefined,
      replyToSenderJid: replyContext?.sender?.jid ?? replyContext?.sender?.lid ?? undefined,
      replyToSenderE164: replyContext?.sender?.e164 ?? undefined,
      groupSubject: inbound.groupSubject,
      groupParticipants: inbound.groupParticipants,
      mentions: mentionedJids ?? undefined,
      mentionedJids: mentionedJids ?? undefined,
      self,
      selfJid: self.jid ?? undefined,
      selfLid: self.lid ?? undefined,
      selfE164: self.e164 ?? undefined,
      fromMe: Boolean(msg.key?.fromMe),
      location: enriched.location ?? undefined,
      untrustedStructuredContext: enriched.contactContext
        ? [
            {
              label: "WhatsApp contact",
              source: "whatsapp",
              type: enriched.contactContext.kind,
              payload: enriched.contactContext,
            },
          ]
        : undefined,
      sendComposing,
      reply,
      sendMedia,
      mediaPath: enriched.mediaPath,
      mediaType: enriched.mediaType,
      mediaFileName: enriched.mediaFileName,
      dedupeKey: inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : undefined,
    };
    if (inboundMessage.id) {
      cacheInboundMessageMeta(inboundMessage.accountId, inboundMessage.chatId, inboundMessage.id, {
        participant: inboundMessage.senderJid,
        participantE164:
          inboundMessage.chatType === "direct" ? inboundMessage.senderE164 : undefined,
        body: inboundMessage.body,
        fromMe: inboundMessage.fromMe,
      });
    }
    try {
      const task = Promise.resolve(debouncer.enqueue(inboundMessage));
      void task.catch((err) => {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      });
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    }
  };

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });
      const inbound = await normalizeInboundMessage(msg);
      if (!inbound) {
        continue;
      }

      await maybeMarkInboundAsRead(inbound);

      // If this is history/offline catch-up, mark read above but skip auto-reply.
      if (upsert.type === "append") {
        const APPEND_RECENT_GRACE_MS = 60_000;
        const msgTsRaw = msg.messageTimestamp;
        const msgTsNum = msgTsRaw != null ? Number(msgTsRaw) : Number.NaN;
        const msgTsMs = Number.isFinite(msgTsNum) ? msgTsNum * 1000 : 0;
        if (msgTsMs < connectedAtMs - APPEND_RECENT_GRACE_MS) {
          continue;
        }
      }

      const enriched = await enrichInboundMessage(msg);
      if (!enriched) {
        continue;
      }

      const dedupeKey = inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : "";
      if (dedupeKey && !(await claimRecentInboundMessage(dedupeKey))) {
        continue;
      }

      await enqueueInboundMessage(msg, inbound, enriched);
    }
  };
  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        if (options.socketRef?.current === sock) {
          options.socketRef.current = null;
        }
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === LOGGED_OUT_STATUS,
          error: update.lastDisconnect?.error,
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  const detachMessagesUpsert = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "messages.upsert",
    handleMessagesUpsert as unknown as (...args: unknown[]) => void,
  );
  const detachConnectionUpdate = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "connection.update",
    handleConnectionUpdate as unknown as (...args: unknown[]) => void,
  );

  void (async () => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      logWhatsAppVerbose(
        options.verbose,
        `Hydrated ${Object.keys(groups ?? {}).length} participating groups on connect`,
      );
    } catch (err) {
      const error = String(err);
      inboundLogger.warn({ error }, "failed hydrating participating groups on connect");
      inboundConsoleLog.warn(`Failed hydrating participating groups on connect: ${error}`);
      logWhatsAppVerbose(
        options.verbose,
        `Failed to hydrate participating groups on connect: ${error}`,
      );
    }
  })();

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (
        jid: string,
        content: AnyMessageContent,
        options?: MiscMessageGenerationOptions,
      ) => sendTrackedMessage(jid, content, options),
      sendPresenceUpdate: async (presence, jid?: string) => {
        const currentSock = getCurrentSock();
        if (!currentSock) {
          throw new Error(RECONNECT_IN_PROGRESS_ERROR);
        }
        return currentSock.sendPresenceUpdate(presence, jid);
      },
    },
    defaultAccountId: options.accountId,
  });

  return {
    close: async () => {
      try {
        detachMessagesUpsert();
        detachConnectionUpdate();
        closeInboundMonitorSocket(sock);
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
  } as const;
}

export async function monitorWebInbox(options: MonitorWebInboxOptions) {
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
    ...resolveWhatsAppSocketTiming(options.cfg),
  });
  await waitForWaConnection(sock);
  return attachWebInboxToSocket({
    ...options,
    sock,
  });
}
