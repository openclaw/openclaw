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
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
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
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
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

export interface MediaRef {
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

interface LineHandlerContext {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  runtime: RuntimeEnv;
  mediaMaxBytes: number;
  processMessage: (ctx: LineInboundContext) => Promise<void>;
  replayCache?: LineWebhookReplayCache;
  groupHistories?: Map<string, HistoryEntry[]>;
  historyLimit?: number;
  pendingMediaQueues?: Map<string, MediaRef[]>;
}

const DEFAULT_LINE_PENDING_MEDIA_LIMIT = 3;

/**
 * Push a media ref onto a group's pending queue, capped at `limit`, dropping
 * the oldest entries when over the cap so the N most recent are kept.
 */
export function pushBoundedPendingMedia(params: {
  queues: Map<string, MediaRef[]>;
  key: string;
  media: MediaRef;
  limit: number;
}): MediaRef[] {
  const { queues, key, media, limit } = params;
  const queue = queues.get(key) ?? [];
  queue.push(media);
  if (queue.length > limit) {
    queue.splice(0, queue.length - limit);
  }
  queues.set(key, queue);
  return queue;
}

const LINE_WEBHOOK_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const LINE_WEBHOOK_REPLAY_MAX_ENTRIES = 4096;
type LineWebhookReplayCache = ClaimableDedupe;

function normalizeLineIngressEntry(value: string): string | null {
  return normalizeLineAllowEntry(value) || null;
}

export class LineRetryableWebhookError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LineRetryableWebhookError";
  }
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
  const groupAllowFrom = normalizeStringEntries(
    firstDefined(
      groupConfig?.allowFrom,
      account.config.groupAllowFrom,
      account.config.allowFrom?.length ? account.config.allowFrom : undefined,
    ),
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
      canDetectMention:
        event.message.type === "text" || groupConfig?.requireMentionForNonText === true,
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

// Serializes read-modify-write access to a group's pending-media queue by
// the queue Map's own identity, so overlapping webhook deliveries for the
// same LINE group cannot race on the same queue snapshot. LINE launches
// `handleWebhook` per HTTP request (see bot.ts's `createLineBot`), so two
// nearly-simultaneous requests for the same group can otherwise both read
// the queue before either has cleared/updated it, or a concurrent "write"
// (queueing a skipped message's media) can be clobbered by a concurrent
// "read+clear" (a mentioned message flushing and then deleting the queue).
// Keying the lock off the queue Map's identity (rather than a separate
// context field) means locking is automatically active whenever a
// `pendingMediaQueues` map is supplied, with no separate wiring to forget.
// Different groups (different Map keys) still run fully in parallel; only
// same-group callers queue behind each other. See PR #103761 review:
// "Concurrent webhook entry" / "Non-atomic pending-media consumption".
const pendingMediaLocksByQueueMap = new WeakMap<Map<string, MediaRef[]>, KeyedAsyncQueue>();

function getPendingMediaLock(queues: Map<string, MediaRef[]>): KeyedAsyncQueue {
  let lock = pendingMediaLocksByQueueMap.get(queues);
  if (!lock) {
    lock = new KeyedAsyncQueue();
    pendingMediaLocksByQueueMap.set(queues, lock);
  }
  return lock;
}

async function handleMessageEvent(event: MessageEvent, context: LineHandlerContext): Promise<void> {
  const { cfg, account, runtime, mediaMaxBytes, processMessage } = context;
  const message = event.message;

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision) {
    return;
  }

  const { isGroup, groupId, roomId } = getLineSourceInfo(event.source);
  const groupQueueKey = isGroup ? (groupId ?? roomId) : undefined;

  // Resolve the group's config up front (same pattern as
  // `shouldProcessLineEvent`) so the lock only engages for groups that
  // actually use the pending-media feature. Without this, every LINE group
  // -- including ones that never opted into `requireMentionForNonText` /
  // `pendingMediaLimit` -- would be routed through the per-group keyed lock,
  // serializing all webhook deliveries for that group by default. See PR
  // #103761 review (confidence 0.98): "pendingMediaQueues always constructed
  // + lock guard doesn't check whether the feature is enabled",
  // extensions/line/src/bot-handlers.ts:507-509.
  const groupConfig = groupQueueKey
    ? resolveLineGroupConfig({ config: account.config, groupId, roomId })
    : undefined;
  const pendingMediaFeatureActive = Boolean(
    groupConfig?.requireMentionForNonText === true ||
    (groupQueueKey && (context.pendingMediaQueues?.get(groupQueueKey)?.length ?? 0) > 0),
  );

  // Runs `fn` serialized behind this group's pending-media lock only when
  // the pending-media feature is actually active for this group (opted in
  // via `requireMentionForNonText`, or the group already has media queued
  // from before); runs it directly (no serialization) for DMs, or for
  // default/unconfigured groups, so unrelated traffic never pays for a lock
  // it doesn't need.
  const runPendingMediaGuarded = <T>(fn: () => Promise<T>): Promise<T> => {
    if (groupQueueKey && context.pendingMediaQueues && pendingMediaFeatureActive) {
      return getPendingMediaLock(context.pendingMediaQueues).enqueue(groupQueueKey, fn);
    }
    return fn();
  };

  if (isGroup && decision.activationAccess.shouldSkip) {
    const rawText = message.type === "text" ? message.text : "";
    const sourceInfo = getLineSourceInfo(event.source);
    logVerbose(`line: skipping group message (requireMention, not mentioned)`);
    const historyKey = groupId ?? roomId;
    const senderId = sourceInfo.userId ?? "unknown";
    // Guarded: recording this skipped message into group history and (when
    // applicable) queuing its media must be serialized with any other
    // concurrent handler for this same group -- in particular the
    // mentioned-turn flush below, which clears both the pending-media queue
    // and group history once `processMessage` succeeds. Recording the
    // history entry outside this lock let a just-recorded `<image>`
    // placeholder be wiped by a concurrent flush's history clear while its
    // media was still sitting in the (separately locked) pending-media
    // queue, leaving media queued with no corresponding history entry.
    // See PR #103761 review (confidence 0.97): "pending history and pending
    // media queue not sharing the same per-group lock".
    await runPendingMediaGuarded(async () => {
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
      if (
        !historyKey ||
        !context.pendingMediaQueues ||
        !isDownloadableLineMessageType(message.type)
      ) {
        return;
      }
      const pendingMediaQueues = context.pendingMediaQueues;
      try {
        const originalFilename =
          message.type === "file" ? normalizeOptionalString(message.fileName) : undefined;
        const media = await downloadLineMedia(
          message.id,
          account.channelAccessToken,
          mediaMaxBytes,
          { originalFilename },
        );
        pushBoundedPendingMedia({
          queues: pendingMediaQueues,
          key: historyKey,
          media: { path: media.path, contentType: media.contentType },
          limit: groupConfig?.pendingMediaLimit ?? DEFAULT_LINE_PENDING_MEDIA_LIMIT,
        });
      } catch (err) {
        const errMsg = String(err);
        if (errMsg.includes("exceeds") && errMsg.includes("limit")) {
          logVerbose(`line: pending media exceeds size limit for message ${message.id}`);
        } else {
          runtime.error?.(danger(`line: failed to download pending media: ${errMsg}`));
        }
      }
    });
    return;
  }

  // Guarded: reading the queue snapshot, awaiting `processMessage`, and
  // clearing the queue afterward must all happen atomically with respect to
  // any other concurrent handler for this same group (whether that handler
  // is also flushing the queue, or is writing new pending media into it).
  // See PR #103761 review.
  await runPendingMediaGuarded(async () => {
    const allMedia: MediaRef[] = [];
    let mediaUnavailable = false;
    // Only clear the pending-media queue once processMessage has completed
    // successfully; keeping the key around until then means a webhook retry
    // (or any failure before dispatch) can still recover the queued media
    // instead of losing it. See PR #103761 review Bug 1.
    let pendingMediaKeyToClear: string | undefined;

    if (
      isGroup &&
      context.pendingMediaQueues &&
      // Only flush queued media when this event was actually triggered by a
      // real @mention. A control-command that merely bypassed requireMention
      // (shouldBypassMention === true) must not pull in media someone else
      // posted earlier for this group. See PR #103761 review Bug 2.
      decision.activationAccess.shouldBypassMention !== true
    ) {
      const pendingKey = groupId ?? roomId;
      if (pendingKey) {
        const pending = context.pendingMediaQueues.get(pendingKey);
        if (pending && pending.length > 0) {
          // A queued media path can go stale between being downloaded and
          // being flushed here: the gateway's independent media.ttlHours
          // cleanup sweep doesn't know about this queue and can delete the
          // underlying file first. Verify each queued entry still exists on
          // disk before surfacing it into context, and silently drop (never
          // throw on) any entry whose file is already gone so the flush of
          // the remaining valid entries still proceeds. See PR #103761
          // review: stale media path after media.ttlHours cleanup,
          // extensions/line/src/bot-handlers.ts:578-583.
          const validPending: MediaRef[] = [];
          for (const media of pending) {
            if (await pathExists(media.path)) {
              validPending.push(media);
            } else {
              logVerbose(
                `line: dropping stale pending media path (file no longer exists): ${media.path}`,
              );
            }
          }
          if (validPending.length !== pending.length) {
            // Prune stale entries from the queue immediately so they are not
            // re-surfaced (or indefinitely retried) on a later flush attempt,
            // even if this turn's processMessage subsequently fails and the
            // remaining valid entries are preserved for retry.
            if (validPending.length > 0) {
              context.pendingMediaQueues.set(pendingKey, validPending);
            } else {
              context.pendingMediaQueues.delete(pendingKey);
            }
          }
          if (validPending.length > 0) {
            allMedia.push(...validPending);
            pendingMediaKeyToClear = pendingKey;
          }
        }
      }
    }

    if (isDownloadableLineMessageType(message.type)) {
      try {
        const originalFilename =
          message.type === "file" ? normalizeOptionalString(message.fileName) : undefined;
        const media = await downloadLineMedia(
          message.id,
          account.channelAccessToken,
          mediaMaxBytes,
          {
            originalFilename,
          },
        );
        allMedia.push({
          path: media.path,
          contentType: media.contentType,
        });
      } catch (err) {
        mediaUnavailable = true;
        const errMsg = String(err);
        if (errMsg.includes("exceeds") && errMsg.includes("limit")) {
          logVerbose(`line: media exceeds size limit for message ${message.id}`);
        } else {
          runtime.error?.(danger(`line: failed to download media: ${errMsg}`));
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

    await processMessage(messageContext);

    // Only clear the pending-media queue after processMessage has resolved
    // successfully (an exception above skips this and preserves the queue for
    // retry). See PR #103761 review Bug 1.
    if (pendingMediaKeyToClear && context.pendingMediaQueues) {
      context.pendingMediaQueues.delete(pendingMediaKeyToClear);
    }

    // Clearing group history must happen inside the same guarded section as
    // the pending-media queue clear above: both are shared per-group state,
    // and clearing history outside this lock let it race with a concurrent
    // skipped-message handler recording a new placeholder entry for the
    // same group. See PR #103761 review (confidence 0.97).
    if (isGroup && context.groupHistories) {
      const historyKey = groupId ?? roomId;
      if (historyKey && context.groupHistories.has(historyKey)) {
        createChannelHistoryWindow({ historyMap: context.groupHistories }).clear({
          historyKey,
          limit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
        });
      }
    }
  });
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

  await context.processMessage(postbackContext);
}

export async function handleLineWebhookEvents(
  events: WebhookEvent[],
  context: LineHandlerContext,
): Promise<void> {
  let firstError: unknown;
  for (const event of events) {
    const replayCandidate = getLineReplayCandidate(event, context);
    const replaySkip = replayCandidate ? await claimLineReplayEvent(replayCandidate) : null;
    if (replaySkip?.skip) {
      if (replaySkip.inFlightResult) {
        try {
          await replaySkip.inFlightResult;
        } catch (err) {
          context.runtime.error?.(danger(`line: replayed in-flight event failed: ${String(err)}`));
          firstError ??= err;
        }
      }
      continue;
    }
    try {
      switch (event.type) {
        case "message":
          await handleMessageEvent(event, context);
          break;
        case "follow":
          await handleFollowEvent(event, context);
          break;
        case "unfollow":
          await handleUnfollowEvent(event, context);
          break;
        case "join":
          await handleJoinEvent(event, context);
          break;
        case "leave":
          await handleLeaveEvent(event, context);
          break;
        case "postback":
          await handlePostbackEvent(event, context);
          break;
        default:
          logVerbose(`line: unhandled event type: ${(event as WebhookEvent).type}`);
      }
      if (replayCandidate) {
        await replayCandidate.cache.commit(replayCandidate.key);
      }
    } catch (err) {
      if (replayCandidate) {
        if (err instanceof LineRetryableWebhookError) {
          replayCandidate.cache.release(replayCandidate.key, { error: err });
        } else {
          await replayCandidate.cache.commit(replayCandidate.key);
        }
      }
      context.runtime.error?.(danger(`line: event handler failed: ${String(err)}`));
      firstError ??= err;
    }
  }
  if (firstError) {
    throw toLintErrorObject(firstError, "Non-Error thrown");
  }
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
