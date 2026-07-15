// Line plugin module implements bot handlers behavior.
import type { webhook } from "@line/bot-sdk";
import { buildMentionRegexes, matchesMentionPatterns } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-auth-native";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readChannelAllowFromStore,
  resolvePairingIdLabel,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { firstDefined, normalizeLineAllowEntry } from "./bot-access.js";
import {
  buildLineMessageContext,
  buildLinePostbackContext,
  getLineSourceInfo,
  type LineInboundContext,
} from "./bot-message-context.js";
import { downloadLineMedia } from "./download.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import { pushMessageLine, replyMessageLine } from "./send.js";
import type { LineGroupConfig, ResolvedLineAccount } from "./types.js";

type FollowEvent = webhook.FollowEvent;
type JoinEvent = webhook.JoinEvent;
type LeaveEvent = webhook.LeaveEvent;
type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;
type UnfollowEvent = webhook.UnfollowEvent;
type WebhookEvent = webhook.Event;

interface MediaRef {
  path: string;
  contentType?: string;
}

const LINE_DOWNLOADABLE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "file",
]);

function isDownloadableLineMessageType(
  messageType: MessageEvent["message"]["type"],
): messageType is "image" | "video" | "audio" | "file" {
  return LINE_DOWNLOADABLE_MESSAGE_TYPES.has(messageType);
}

function isLineMediaSizeLimitError(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return message.includes("exceeds") && message.includes("limit");
}

function isPermanentLineMediaDownloadError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("status" in err)) {
    return false;
  }
  // @line/bot-sdk exposes HTTPFetchError.status. Retrying non-timeout/non-rate-limit
  // 4xx responses cannot recover this event's media, so keep its text path usable.
  const status = (err as { status?: unknown }).status;
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

interface LineHandlerContext {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  runtime: RuntimeEnv;
  mediaMaxBytes: number;
  processMessage: (ctx: LineInboundContext) => Promise<void>;
  onEventAccepted?: (event: WebhookEvent, finalizeAcceptance?: () => void) => void | Promise<void>;
  abortSignal?: AbortSignal;
  replayCache?: LineWebhookReplayCache;
  groupHistories?: Map<string, HistoryEntry[]>;
  conversationAcceptanceTails?: Map<string, Promise<void>>;
  historyLimit?: number;
}

const LINE_WEBHOOK_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const LINE_WEBHOOK_REPLAY_MAX_ENTRIES = 4096;
type LineWebhookReplayCache = ClaimableDedupe;

function normalizeLineIngressEntry(value: string): string | null {
  return normalizeLineAllowEntry(value) || null;
}

export function createLineWebhookReplayCache(): LineWebhookReplayCache {
  return createClaimableDedupe({
    ttlMs: LINE_WEBHOOK_REPLAY_WINDOW_MS,
    memoryMaxSize: LINE_WEBHOOK_REPLAY_MAX_ENTRIES,
  });
}

function buildLineWebhookReplayKey(
  event: WebhookEvent,
  accountId: string,
): { key: string; eventId: string } | null {
  if (event.type === "message") {
    const messageId = event.message?.id?.trim();
    if (messageId) {
      return {
        key: `${accountId}|message:${messageId}`,
        eventId: `message:${messageId}`,
      };
    }
  }
  const eventId = (event as { webhookEventId?: string }).webhookEventId?.trim();
  if (!eventId) {
    return null;
  }

  const source = (
    event as {
      source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
    }
  ).source;
  const sourceId =
    source?.type === "group"
      ? `group:${source.groupId ?? ""}`
      : source?.type === "room"
        ? `room:${source.roomId ?? ""}`
        : `user:${source?.userId ?? ""}`;
  return { key: `${accountId}|${event.type}|${sourceId}|${eventId}`, eventId: `event:${eventId}` };
}

type LineReplayCandidate = {
  key: string;
  eventId: string;
  cache: LineWebhookReplayCache;
};

function getLineReplayCandidate(
  event: WebhookEvent,
  context: LineHandlerContext,
): LineReplayCandidate | null {
  const replay = buildLineWebhookReplayKey(event, context.account.accountId);
  const cache = context.replayCache;
  if (!replay || !cache) {
    return null;
  }
  return { key: replay.key, eventId: replay.eventId, cache };
}

async function claimLineReplayEvent(
  candidate: LineReplayCandidate,
): Promise<{ skip: true; inFlightResult?: Promise<void> } | { skip: false }> {
  const claim = await candidate.cache.claim(candidate.key);
  if (claim.kind === "claimed") {
    return { skip: false };
  }
  if (claim.kind === "inflight") {
    logVerbose(`line: skipped in-flight replayed webhook event ${candidate.eventId}`);
    return { skip: true, inFlightResult: claim.pending.then(() => undefined) };
  }
  logVerbose(`line: skipped replayed webhook event ${candidate.eventId}`);
  return { skip: true };
}

function resolveLineGroupConfig(params: {
  config: ResolvedLineAccount["config"];
  groupId?: string;
  roomId?: string;
}): LineGroupConfig | undefined {
  return resolveLineGroupConfigEntry(params.config.groups, {
    groupId: params.groupId,
    roomId: params.roomId,
  });
}

async function sendLinePairingReply(params: {
  senderId: string;
  replyToken?: string;
  context: LineHandlerContext;
}): Promise<void> {
  const { senderId, replyToken, context } = params;
  const idLabel = (() => {
    try {
      return resolvePairingIdLabel("line");
    } catch {
      return "lineUserId";
    }
  })();
  await createChannelPairingChallengeIssuer({
    channel: "line",
    accountId: context.account.accountId,
    upsertPairingRequest: async ({ id, meta }) =>
      await upsertChannelPairingRequest({
        channel: "line",
        id,
        accountId: context.account.accountId,
        meta,
      }),
  })({
    senderId,
    senderIdLine: `Your ${idLabel}: ${senderId}`,
    onCreated: () => {
      logVerbose(`line pairing request sender=${senderId}`);
    },
    sendPairingReply: async (text) => {
      if (replyToken) {
        try {
          await replyMessageLine(replyToken, [{ type: "text", text }], {
            cfg: context.cfg,
            accountId: context.account.accountId,
            channelAccessToken: context.account.channelAccessToken,
          });
          return;
        } catch (err) {
          logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
        }
      }
      try {
        await pushMessageLine(`line:${senderId}`, text, {
          cfg: context.cfg,
          accountId: context.account.accountId,
          channelAccessToken: context.account.channelAccessToken,
        });
      } catch (err) {
        logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
      }
    },
  });
}

async function shouldProcessLineEvent(
  event: MessageEvent | PostbackEvent,
  context: LineHandlerContext,
) {
  const { cfg, account } = context;
  const { userId, groupId, roomId, isGroup } = getLineSourceInfo(event.source);
  const senderId = userId ?? "";
  const groupConfig = resolveLineGroupConfig({ config: account.config, groupId, roomId });
  const rawText = resolveEventRawText(event);
  const requireMention = isGroup ? groupConfig?.requireMention !== false : false;
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const { groupPolicy: runtimeGroupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.line !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
    });
  const groupPolicy: GroupPolicy =
    runtimeGroupPolicy === "disabled"
      ? "disabled"
      : groupConfig?.allowFrom !== undefined
        ? "allowlist"
        : runtimeGroupPolicy;
  // LINE group allowlists are scoped separately from DM allowFrom.
  // The shared ingress policy below intentionally keeps fallback disabled.
  const groupAllowFrom = normalizeStringEntries(
    firstDefined(groupConfig?.allowFrom, account.config.groupAllowFrom),
  );
  const mentionFacts = (() => {
    if (!isGroup || event.type !== "message") {
      return { canDetectMention: false, wasMentioned: false, hasAnyMention: false };
    }
    const peerId = groupId ?? roomId ?? userId ?? "unknown";
    const { agentId } = resolveAgentRoute({
      cfg,
      channel: "line",
      accountId: account.accountId,
      peer: { kind: "group", id: peerId },
    });
    const mentionRegexes = buildMentionRegexes(cfg, agentId);
    const wasMentionedByNative = isLineBotMentioned(event.message);
    const wasMentionedByPattern =
      event.message.type === "text" ? matchesMentionPatterns(rawText, mentionRegexes) : false;
    return {
      canDetectMention: event.message.type === "text",
      wasMentioned: wasMentionedByNative || wasMentionedByPattern,
      hasAnyMention: hasAnyLineMention(event.message),
    };
  })();
  const access = await resolveStableChannelMessageIngress({
    channelId: "line",
    accountId: account.accountId,
    identity: {
      key: "line-user-id",
      normalize: normalizeLineIngressEntry,
      sensitivity: "pii",
      entryIdPrefix: "line-entry",
    },
    cfg,
    readStoreAllowFrom: async () =>
      await readChannelAllowFromStore("line", undefined, account.accountId),
    subject: { stableId: senderId },
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: (groupId ?? roomId ?? senderId) || "unknown",
    },
    ...(isGroup && groupConfig?.enabled === false
      ? { route: { id: "line:group-config", enabled: false } }
      : {}),
    mentionFacts:
      isGroup && event.type === "message"
        ? {
            canDetectMention: mentionFacts.canDetectMention,
            wasMentioned: mentionFacts.wasMentioned,
            hasAnyMention: mentionFacts.hasAnyMention,
            implicitMentionKinds: [],
          }
        : undefined,
    event: { kind: event.type === "postback" ? "postback" : "message" },
    dmPolicy,
    groupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      activation: {
        requireMention: isGroup && event.type === "message" && requireMention,
        allowTextCommands: true,
      },
    },
    allowFrom: normalizeStringEntries(account.config.allowFrom),
    groupAllowFrom,
    command: {
      hasControlCommand: shouldComputeCommandAuthorized(rawText, cfg),
      groupOwnerAllowFrom: "none",
    },
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "line",
    accountId: account.accountId,
    log: (message) => logVerbose(message),
  });

  if (
    access.senderAccess.decision === "allow" &&
    (access.ingress.admission === "dispatch" ||
      access.ingress.admission === "observe" ||
      access.ingress.admission === "skip")
  ) {
    return access;
  }

  if (access.senderAccess.decision === "allow") {
    logVerbose(`Blocked line event (${access.ingress.reasonCode})`);
    return null;
  }

  if (isGroup) {
    if (groupConfig?.enabled === false) {
      logVerbose(`Blocked line group ${groupId ?? roomId ?? "unknown"} (group disabled)`);
      return null;
    }
    if (groupConfig?.allowFrom !== undefined) {
      if (!senderId) {
        logVerbose("Blocked line group message (group allowFrom override, no sender ID)");
        return null;
      }
      if (access.senderAccess.reasonCode !== "group_policy_allowed") {
        logVerbose(`Blocked line group sender ${senderId} (group allowFrom override)`);
        return null;
      }
    }
    if (access.senderAccess.reasonCode === "group_policy_disabled") {
      logVerbose("Blocked line group message (groupPolicy: disabled)");
    } else if (!senderId && groupPolicy === "allowlist") {
      logVerbose("Blocked line group message (no sender ID, groupPolicy: allowlist)");
    } else if (access.senderAccess.reasonCode === "group_policy_empty_allowlist") {
      logVerbose("Blocked line group message (groupPolicy: allowlist, no groupAllowFrom)");
    } else {
      logVerbose(`Blocked line group message from ${senderId} (groupPolicy: allowlist)`);
    }
    return null;
  }

  if (access.senderAccess.reasonCode === "dm_policy_disabled") {
    logVerbose("Blocked line sender (dmPolicy: disabled)");
    return null;
  }

  if (access.senderAccess.decision === "pairing") {
    if (!senderId) {
      logVerbose("Blocked line sender (dmPolicy: pairing, no sender ID)");
      return null;
    }
    await sendLinePairingReply({
      senderId,
      replyToken: "replyToken" in event ? event.replyToken : undefined,
      context,
    });
    return null;
  }

  logVerbose(
    `Blocked line sender ${senderId || "unknown"} (dmPolicy: ${
      account.config.dmPolicy ?? "pairing"
    })`,
  );
  return null;
}

function getLineMentionees(
  message: MessageEvent["message"],
): Array<{ type?: string; isSelf?: boolean }> {
  if (message.type !== "text") {
    return [];
  }
  const mentionees = (
    message as Record<string, unknown> & {
      mention?: { mentionees?: Array<{ type?: string; isSelf?: boolean }> };
    }
  ).mention?.mentionees;
  return Array.isArray(mentionees) ? mentionees : [];
}

function isLineBotMentioned(message: MessageEvent["message"]): boolean {
  return getLineMentionees(message).some((m) => m.isSelf === true || m.type === "all");
}

function hasAnyLineMention(message: MessageEvent["message"]): boolean {
  return getLineMentionees(message).length > 0;
}

function resolveEventRawText(event: MessageEvent | PostbackEvent): string {
  if (event.type === "message") {
    const msg = event.message;
    if (msg.type === "text") {
      return msg.text;
    }
    return "";
  }
  if (event.type === "postback") {
    return event.postback?.data?.trim() ?? "";
  }
  return "";
}

async function handleMessageEvent(
  event: MessageEvent,
  context: LineHandlerContext,
): Promise<(() => void) | undefined> {
  const { cfg, account, mediaMaxBytes, processMessage, runtime } = context;
  const message = event.message;

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision) {
    return;
  }

  const { isGroup, groupId, roomId } = getLineSourceInfo(event.source);
  if (isGroup && decision.activationAccess.shouldSkip) {
    const rawText = message.type === "text" ? message.text : "";
    const sourceInfo = getLineSourceInfo(event.source);
    logVerbose(`line: skipping group message (requireMention, not mentioned)`);
    const historyKey = groupId ?? roomId;
    const senderId = sourceInfo.userId ?? "unknown";
    if (historyKey && context.groupHistories) {
      createChannelHistoryWindow({ historyMap: context.groupHistories }).record({
        historyKey,
        limit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
        entry: {
          sender: `user:${senderId}`,
          body: rawText || `<${message.type}>`,
          timestamp: event.timestamp,
        },
      });
    }
    return;
  }

  const allMedia: MediaRef[] = [];
  let mediaUnavailable = false;

  if (isDownloadableLineMessageType(message.type)) {
    try {
      const originalFilename =
        message.type === "file" ? normalizeOptionalString(message.fileName) : undefined;
      const media = await downloadLineMedia(message.id, account.channelAccessToken, mediaMaxBytes, {
        originalFilename,
      });
      allMedia.push({
        path: media.path,
        contentType: media.contentType,
      });
    } catch (err) {
      if (isLineMediaSizeLimitError(err)) {
        mediaUnavailable = true;
        logVerbose(`line: media exceeds size limit for message ${message.id}`);
      } else if (isPermanentLineMediaDownloadError(err)) {
        mediaUnavailable = true;
        runtime.error?.(danger(`line: media is unavailable: ${String(err)}`));
      } else {
        throw new Error(`failed to download media for ${message.id}`, {
          cause: err,
        });
      }
    }
  }

  const messageContext = await buildLineMessageContext({
    event,
    allMedia,
    mediaUnavailable,
    cfg,
    account,
    commandAuthorized: decision.commandAccess.authorized,
    groupHistories: context.groupHistories,
    historyLimit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  });

  if (!messageContext) {
    logVerbose("line: skipping empty message");
    return;
  }

  let groupHistoryCleared = false;
  const clearGroupHistory = () => {
    if (groupHistoryCleared || !isGroup || !context.groupHistories) {
      return;
    }
    const historyKey = groupId ?? roomId;
    if (historyKey && context.groupHistories.has(historyKey)) {
      createChannelHistoryWindow({ historyMap: context.groupHistories }).clear({
        historyKey,
        limit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
      });
    }
    groupHistoryCleared = true;
  };

  await processMessage({
    ...messageContext,
    onEventAccepted: async () => {
      await context.onEventAccepted?.(event, clearGroupHistory);
    },
  });
  // Legacy/test handlers that do not call onEventAccepted still need the
  // original history cleanup when completion becomes acceptance.
  return clearGroupHistory;
}

async function handleFollowEvent(event: FollowEvent, _context: LineHandlerContext): Promise<void> {
  const { userId } = getLineSourceInfo(event.source);
  logVerbose(`line: user ${userId ?? "unknown"} followed`);
}

async function handleUnfollowEvent(
  event: UnfollowEvent,
  _context: LineHandlerContext,
): Promise<void> {
  const { userId } = getLineSourceInfo(event.source);
  logVerbose(`line: user ${userId ?? "unknown"} unfollowed`);
}

async function handleJoinEvent(event: JoinEvent, _context: LineHandlerContext): Promise<void> {
  const { groupId, roomId } = getLineSourceInfo(event.source);
  logVerbose(`line: bot joined ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handleLeaveEvent(event: LeaveEvent, _context: LineHandlerContext): Promise<void> {
  const { groupId, roomId } = getLineSourceInfo(event.source);
  logVerbose(`line: bot left ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handlePostbackEvent(
  event: PostbackEvent,
  context: LineHandlerContext,
): Promise<void> {
  const data = event.postback.data;
  logVerbose(`line: received postback: ${data}`);

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision) {
    return;
  }

  const postbackContext = await buildLinePostbackContext({
    event,
    cfg: context.cfg,
    account: context.account,
    commandAuthorized: decision.commandAccess.authorized,
  });
  if (!postbackContext) {
    return;
  }

  await context.processMessage({
    ...postbackContext,
    onEventAccepted: () => context.onEventAccepted?.(event),
  });
}

type LineWebhookEventTask = {
  acceptance: Promise<void>;
  completion: Promise<void>;
};

function resolveLineWebhookConversationKey(event: WebhookEvent): string | undefined {
  const { userId, groupId, roomId } = getLineSourceInfo(event.source);
  if (groupId) {
    return `group:${groupId}`;
  }
  if (roomId) {
    return `room:${roomId}`;
  }
  if (userId) {
    return `user:${userId}`;
  }
  return undefined;
}

function startLineWebhookEvent(
  event: WebhookEvent,
  context: LineHandlerContext,
): LineWebhookEventTask {
  let eventAccepted = false;
  let replayClaimOwned = false;
  let eventAcceptance: Promise<void> | undefined;
  let acceptanceSettled = false;
  let resolveAcceptance!: () => void;
  let rejectAcceptance!: (error: unknown) => void;
  const acceptance = new Promise<void>((resolve, reject) => {
    resolveAcceptance = resolve;
    rejectAcceptance = reject;
  });
  const resolveEventAcceptance = () => {
    if (acceptanceSettled) {
      return;
    }
    acceptanceSettled = true;
    resolveAcceptance();
  };
  const rejectEventAcceptance = (error: unknown) => {
    if (acceptanceSettled) {
      return;
    }
    acceptanceSettled = true;
    rejectAcceptance(error);
  };
  const replayCandidate = getLineReplayCandidate(event, context);
  const throwIfAborted = () => context.abortSignal?.throwIfAborted();
  const releaseReplayClaim = (error: unknown) => {
    if (!replayCandidate || !replayClaimOwned || eventAccepted) {
      return;
    }
    replayClaimOwned = false;
    replayCandidate.cache.release(replayCandidate.key, { error });
  };
  const abortEvent = () => {
    const error = context.abortSignal?.reason ?? new Error("LINE webhook acceptance aborted");
    releaseReplayClaim(error);
    rejectEventAcceptance(error);
  };
  if (context.abortSignal?.aborted) {
    abortEvent();
  } else {
    context.abortSignal?.addEventListener("abort", abortEvent, { once: true });
  }
  const acceptEvent = async (finalizeAcceptance?: () => void) => {
    throwIfAborted();
    if (eventAccepted) {
      finalizeAcceptance?.();
      return;
    }
    eventAcceptance ??= (async () => {
      await context.onEventAccepted?.(event);
      throwIfAborted();
      // The reply lane now owns this event durably. Resolve replay claims here,
      // rather than after the full turn, so a redelivered batch can retry its
      // other events without waiting for this turn to settle.
      if (replayCandidate && replayClaimOwned) {
        await replayCandidate.cache.commit(replayCandidate.key);
        replayClaimOwned = false;
      }
      // Finalize owner state only after upstream acceptance and replay commit,
      // but before later same-conversation events observe this acceptance.
      finalizeAcceptance?.();
      eventAccepted = true;
      resolveEventAcceptance();
    })();
    try {
      await eventAcceptance;
    } catch (error) {
      // Let a later call retry the acceptance work after the claim is released.
      eventAcceptance = undefined;
      throw error;
    }
  };
  const eventContext = {
    ...context,
    onEventAccepted: (_event: WebhookEvent, finalizeAcceptance?: () => void) =>
      acceptEvent(finalizeAcceptance),
  };
  const completion = (async () => {
    try {
      throwIfAborted();
      const replaySkip = replayCandidate ? await claimLineReplayEvent(replayCandidate) : null;
      replayClaimOwned = Boolean(replayCandidate && !replaySkip?.skip);
      throwIfAborted();
      if (replaySkip?.skip) {
        if (replaySkip.inFlightResult) {
          try {
            await replaySkip.inFlightResult;
            await acceptEvent();
          } catch (err) {
            context.runtime.error?.(
              danger(`line: replayed in-flight event failed: ${String(err)}`),
            );
            throw err;
          }
        } else {
          await acceptEvent();
        }
        return;
      }
      let finalizeAcceptance: (() => void) | undefined;
      switch (event.type) {
        case "message":
          finalizeAcceptance = await handleMessageEvent(event, eventContext);
          break;
        case "follow":
          await handleFollowEvent(event, eventContext);
          break;
        case "unfollow":
          await handleUnfollowEvent(event, eventContext);
          break;
        case "join":
          await handleJoinEvent(event, eventContext);
          break;
        case "leave":
          await handleLeaveEvent(event, eventContext);
          break;
        case "postback":
          await handlePostbackEvent(event, eventContext);
          break;
        default:
          logVerbose(`line: unhandled event type: ${(event as WebhookEvent).type}`);
      }
      await acceptEvent(finalizeAcceptance);
    } catch (err) {
      if (replayClaimOwned && !eventAccepted) {
        // Every error here propagates to the webhook response before durable
        // adoption. Leave the replay claim available so LINE can redeliver it.
        releaseReplayClaim(err);
      }
      context.runtime.error?.(danger(`line: event handler failed: ${String(err)}`));
      throw err;
    } finally {
      context.abortSignal?.removeEventListener("abort", abortEvent);
    }
  })();
  void completion.then(resolveEventAcceptance, rejectEventAcceptance);
  return { acceptance, completion };
}

export async function handleLineWebhookEvents(
  events: WebhookEvent[],
  context: LineHandlerContext,
): Promise<void> {
  const acceptances: Promise<void>[] = [];
  const completions: Promise<void>[] = [];
  const conversationAcceptances =
    context.conversationAcceptanceTails ?? new Map<string, Promise<void>>();
  for (const event of events) {
    const conversationKey = resolveLineWebhookConversationKey(event);
    const previousAcceptance = conversationKey
      ? conversationAcceptances.get(conversationKey)
      : undefined;
    const task = (async () => {
      await previousAcceptance;
      return startLineWebhookEvent(event, context);
    })();
    const acceptance = task.then(async (started) => await started.acceptance);
    const completion = task.then(async (started) => await started.completion);
    if (conversationKey) {
      let acceptanceTail: Promise<void>;
      acceptanceTail = acceptance.finally(() => {
        if (conversationAcceptances.get(conversationKey) === acceptanceTail) {
          conversationAcceptances.delete(conversationKey);
        }
      });
      conversationAcceptances.set(conversationKey, acceptanceTail);
      // Preserve rejection for the next same-conversation event so it cannot
      // overtake a failed predecessor. This observer only prevents an
      // unhandled rejection after the tail has performed its cleanup.
      void acceptanceTail.catch(() => undefined);
    }
    void completion.catch(() => {});
    acceptances.push(acceptance);
    completions.push(completion);
  }
  await Promise.all(acceptances);
  await Promise.all(completions);
}
