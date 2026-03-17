import {
  DM_GROUP_ACCESS_REASON,
  createScopedPairingAccess,
  createReplyPrefixOptions,
  evictOldHistoryKeys,
  issuePairingChallenge,
  logAckFailure,
  logInboundDrop,
  logTypingFailure,
  mapAllowFromEntries,
  readStoreAllowFromForDmPolicy,
  recordPendingHistoryEntryIfEnabled,
  resolveAckReaction,
  resolveDmGroupAccessWithLists,
  resolveControlCommandGate,
  stripMarkdown
} from "openclaw/plugin-sdk/bluebubbles";
import { downloadBlueBubblesAttachment } from "./attachments.js";
import { markBlueBubblesChatRead, sendBlueBubblesTyping } from "./chat.js";
import { fetchBlueBubblesHistory } from "./history.js";
import { sendBlueBubblesMedia } from "./media-send.js";
import {
  buildMessagePlaceholder,
  formatGroupAllowlistEntry,
  formatGroupMembers,
  formatReplyTag,
  parseTapbackText,
  resolveGroupFlagFromChatGuid,
  resolveTapbackContext
} from "./monitor-normalize.js";
import {
  getShortIdForUuid,
  rememberBlueBubblesReplyCache,
  resolveBlueBubblesMessageId,
  resolveReplyContextFromCache
} from "./monitor-reply-cache.js";
import {
  hasBlueBubblesSelfChatCopy,
  rememberBlueBubblesSelfChatCopy
} from "./monitor-self-chat-cache.js";
import { isBlueBubblesPrivateApiEnabled } from "./probe.js";
import { normalizeBlueBubblesReactionInput, sendBlueBubblesReaction } from "./reactions.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { resolveChatGuidForTarget, sendMessageBlueBubbles } from "./send.js";
import {
  extractHandleFromChatGuid,
  formatBlueBubblesChatTarget,
  isAllowedBlueBubblesSender,
  normalizeBlueBubblesHandle
} from "./targets.js";
const DEFAULT_TEXT_LIMIT = 4e3;
const invalidAckReactions = /* @__PURE__ */ new Set();
const REPLY_DIRECTIVE_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;
const PENDING_OUTBOUND_MESSAGE_ID_TTL_MS = 2 * 60 * 1e3;
const pendingOutboundMessageIds = [];
let pendingOutboundMessageIdCounter = 0;
function trimOrUndefined(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
function normalizeSnippet(value) {
  return stripMarkdown(value).replace(/\s+/g, " ").trim().toLowerCase();
}
function isBlueBubblesSelfChatMessage(message, isGroup) {
  if (isGroup || !message.senderIdExplicit) {
    return false;
  }
  const chatHandle = (message.chatGuid ? extractHandleFromChatGuid(message.chatGuid) : null) ?? normalizeBlueBubblesHandle(message.chatIdentifier ?? "");
  return Boolean(chatHandle) && chatHandle === message.senderId;
}
function prunePendingOutboundMessageIds(now = Date.now()) {
  const cutoff = now - PENDING_OUTBOUND_MESSAGE_ID_TTL_MS;
  for (let i = pendingOutboundMessageIds.length - 1; i >= 0; i--) {
    if (pendingOutboundMessageIds[i].createdAt < cutoff) {
      pendingOutboundMessageIds.splice(i, 1);
    }
  }
}
function rememberPendingOutboundMessageId(entry) {
  prunePendingOutboundMessageIds();
  pendingOutboundMessageIdCounter += 1;
  const snippetRaw = entry.snippet.trim();
  const snippetNorm = normalizeSnippet(snippetRaw);
  pendingOutboundMessageIds.push({
    id: pendingOutboundMessageIdCounter,
    accountId: entry.accountId,
    sessionKey: entry.sessionKey,
    outboundTarget: entry.outboundTarget,
    chatGuid: trimOrUndefined(entry.chatGuid),
    chatIdentifier: trimOrUndefined(entry.chatIdentifier),
    chatId: typeof entry.chatId === "number" ? entry.chatId : void 0,
    snippetRaw,
    snippetNorm,
    isMediaSnippet: snippetRaw.toLowerCase().startsWith("<media:"),
    createdAt: Date.now()
  });
  return pendingOutboundMessageIdCounter;
}
function forgetPendingOutboundMessageId(id) {
  const index = pendingOutboundMessageIds.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    pendingOutboundMessageIds.splice(index, 1);
  }
}
function chatsMatch(left, right) {
  const leftGuid = trimOrUndefined(left.chatGuid);
  const rightGuid = trimOrUndefined(right.chatGuid);
  if (leftGuid && rightGuid) {
    return leftGuid === rightGuid;
  }
  const leftIdentifier = trimOrUndefined(left.chatIdentifier);
  const rightIdentifier = trimOrUndefined(right.chatIdentifier);
  if (leftIdentifier && rightIdentifier) {
    return leftIdentifier === rightIdentifier;
  }
  const leftChatId = typeof left.chatId === "number" ? left.chatId : void 0;
  const rightChatId = typeof right.chatId === "number" ? right.chatId : void 0;
  if (leftChatId !== void 0 && rightChatId !== void 0) {
    return leftChatId === rightChatId;
  }
  return false;
}
function consumePendingOutboundMessageId(params) {
  prunePendingOutboundMessageIds();
  const bodyNorm = normalizeSnippet(params.body);
  const isMediaBody = params.body.trim().toLowerCase().startsWith("<media:");
  for (let i = 0; i < pendingOutboundMessageIds.length; i++) {
    const entry = pendingOutboundMessageIds[i];
    if (entry.accountId !== params.accountId) {
      continue;
    }
    if (!chatsMatch(entry, params)) {
      continue;
    }
    if (entry.snippetNorm && entry.snippetNorm === bodyNorm) {
      pendingOutboundMessageIds.splice(i, 1);
      return entry;
    }
    if (entry.isMediaSnippet && isMediaBody) {
      pendingOutboundMessageIds.splice(i, 1);
      return entry;
    }
  }
  return null;
}
function logVerbose(core, runtime, message) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[bluebubbles] ${message}`);
  }
}
function logGroupAllowlistHint(params) {
  const log = params.runtime.log ?? console.log;
  const nameHint = params.chatName ? ` (group name: ${params.chatName})` : "";
  const accountHint = params.accountId ? ` (or channels.bluebubbles.accounts.${params.accountId}.groupAllowFrom)` : "";
  if (params.entry) {
    log(
      `[bluebubbles] group message blocked (${params.reason}). Allow this group by adding "${params.entry}" to channels.bluebubbles.groupAllowFrom${nameHint}.`
    );
    log(
      `[bluebubbles] add to config: channels.bluebubbles.groupAllowFrom=["${params.entry}"]${accountHint}.`
    );
    return;
  }
  log(
    `[bluebubbles] group message blocked (${params.reason}). Allow groups by setting channels.bluebubbles.groupPolicy="open" or adding a group id to channels.bluebubbles.groupAllowFrom${accountHint}${nameHint}.`
  );
}
function resolveBlueBubblesAckReaction(params) {
  const raw = resolveAckReaction(params.cfg, params.agentId).trim();
  if (!raw) {
    return null;
  }
  try {
    normalizeBlueBubblesReactionInput(raw);
    return raw;
  } catch {
    const key = raw.toLowerCase();
    if (!invalidAckReactions.has(key)) {
      invalidAckReactions.add(key);
      logVerbose(
        params.core,
        params.runtime,
        `ack reaction skipped (unsupported for BlueBubbles): ${raw}`
      );
    }
    return null;
  }
}
const chatHistories = /* @__PURE__ */ new Map();
const historyBackfills = /* @__PURE__ */ new Map();
const HISTORY_BACKFILL_BASE_DELAY_MS = 5e3;
const HISTORY_BACKFILL_MAX_DELAY_MS = 2 * 60 * 1e3;
const HISTORY_BACKFILL_MAX_ATTEMPTS = 6;
const HISTORY_BACKFILL_RETRY_WINDOW_MS = 30 * 60 * 1e3;
const MAX_STORED_HISTORY_ENTRY_CHARS = 2e3;
const MAX_INBOUND_HISTORY_ENTRY_CHARS = 1200;
const MAX_INBOUND_HISTORY_TOTAL_CHARS = 12e3;
function buildAccountScopedHistoryKey(accountId, historyIdentifier) {
  return `${accountId}\0${historyIdentifier}`;
}
function historyDedupKey(entry) {
  const messageId = entry.messageId?.trim();
  if (messageId) {
    return `id:${messageId}`;
  }
  return `fallback:${entry.sender}\0${entry.body}\0${entry.timestamp ?? ""}`;
}
function truncateHistoryBody(body, maxChars) {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}
function mergeHistoryEntries(params) {
  if (params.limit <= 0) {
    return [];
  }
  const merged = [];
  const seen = /* @__PURE__ */ new Set();
  const appendUnique = (entry) => {
    const key = historyDedupKey(entry);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(entry);
  };
  for (const entry of params.apiEntries) {
    appendUnique(entry);
  }
  for (const entry of params.currentEntries) {
    appendUnique(entry);
  }
  if (merged.length <= params.limit) {
    return merged;
  }
  return merged.slice(merged.length - params.limit);
}
function pruneHistoryBackfillState() {
  for (const key of historyBackfills.keys()) {
    if (!chatHistories.has(key)) {
      historyBackfills.delete(key);
    }
  }
}
function markHistoryBackfillResolved(historyKey) {
  const state = historyBackfills.get(historyKey);
  if (state) {
    state.resolved = true;
    historyBackfills.set(historyKey, state);
    return;
  }
  historyBackfills.set(historyKey, {
    attempts: 0,
    firstAttemptAt: Date.now(),
    nextAttemptAt: Number.POSITIVE_INFINITY,
    resolved: true
  });
}
function planHistoryBackfillAttempt(historyKey, now) {
  const existing = historyBackfills.get(historyKey);
  if (existing?.resolved) {
    return null;
  }
  if (existing && now - existing.firstAttemptAt > HISTORY_BACKFILL_RETRY_WINDOW_MS) {
    markHistoryBackfillResolved(historyKey);
    return null;
  }
  if (existing && existing.attempts >= HISTORY_BACKFILL_MAX_ATTEMPTS) {
    markHistoryBackfillResolved(historyKey);
    return null;
  }
  if (existing && now < existing.nextAttemptAt) {
    return null;
  }
  const attempts = (existing?.attempts ?? 0) + 1;
  const firstAttemptAt = existing?.firstAttemptAt ?? now;
  const backoffDelay = Math.min(
    HISTORY_BACKFILL_BASE_DELAY_MS * 2 ** (attempts - 1),
    HISTORY_BACKFILL_MAX_DELAY_MS
  );
  const state = {
    attempts,
    firstAttemptAt,
    nextAttemptAt: now + backoffDelay,
    resolved: false
  };
  historyBackfills.set(historyKey, state);
  return state;
}
function buildInboundHistorySnapshot(params) {
  if (params.limit <= 0 || params.entries.length === 0) {
    return void 0;
  }
  const recent = params.entries.slice(-params.limit);
  const selected = [];
  let remainingChars = MAX_INBOUND_HISTORY_TOTAL_CHARS;
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const body = truncateHistoryBody(entry.body, MAX_INBOUND_HISTORY_ENTRY_CHARS);
    if (!body) {
      continue;
    }
    if (selected.length > 0 && body.length > remainingChars) {
      break;
    }
    selected.push({
      sender: entry.sender,
      body,
      timestamp: entry.timestamp
    });
    remainingChars -= body.length;
    if (remainingChars <= 0) {
      break;
    }
  }
  if (selected.length === 0) {
    return void 0;
  }
  selected.reverse();
  return selected;
}
async function processMessage(message, target) {
  const { account, config, runtime, core, statusSink } = target;
  const pairing = createScopedPairingAccess({
    core,
    channel: "bluebubbles",
    accountId: account.accountId
  });
  const privateApiEnabled = isBlueBubblesPrivateApiEnabled(account.accountId);
  const groupFlag = resolveGroupFlagFromChatGuid(message.chatGuid);
  const isGroup = typeof groupFlag === "boolean" ? groupFlag : message.isGroup;
  const text = message.text.trim();
  const attachments = message.attachments ?? [];
  const placeholder = buildMessagePlaceholder(message);
  const tapbackContext = resolveTapbackContext(message);
  const tapbackParsed = parseTapbackText({
    text,
    emojiHint: tapbackContext?.emojiHint,
    actionHint: tapbackContext?.actionHint,
    requireQuoted: !tapbackContext
  });
  const isTapbackMessage = Boolean(tapbackParsed);
  const rawBody = tapbackParsed ? tapbackParsed.action === "removed" ? `removed ${tapbackParsed.emoji} reaction` : `reacted with ${tapbackParsed.emoji}` : text || placeholder;
  const isSelfChatMessage = isBlueBubblesSelfChatMessage(message, isGroup);
  const selfChatLookup = {
    accountId: account.accountId,
    chatGuid: message.chatGuid,
    chatIdentifier: message.chatIdentifier,
    chatId: message.chatId,
    senderId: message.senderId,
    body: rawBody,
    timestamp: message.timestamp
  };
  const cacheMessageId = message.messageId?.trim();
  const confirmedOutboundCacheEntry = cacheMessageId ? resolveReplyContextFromCache({
    accountId: account.accountId,
    replyToId: cacheMessageId,
    chatGuid: message.chatGuid,
    chatIdentifier: message.chatIdentifier,
    chatId: message.chatId
  }) : null;
  let messageShortId;
  const cacheInboundMessage = () => {
    if (!cacheMessageId) {
      return;
    }
    const cacheEntry = rememberBlueBubblesReplyCache({
      accountId: account.accountId,
      messageId: cacheMessageId,
      chatGuid: message.chatGuid,
      chatIdentifier: message.chatIdentifier,
      chatId: message.chatId,
      senderLabel: message.fromMe ? "me" : message.senderId,
      body: rawBody,
      timestamp: message.timestamp ?? Date.now()
    });
    messageShortId = cacheEntry.shortId;
  };
  if (message.fromMe) {
    cacheInboundMessage();
    const confirmedAssistantOutbound = confirmedOutboundCacheEntry?.senderLabel === "me" && normalizeSnippet(confirmedOutboundCacheEntry.body ?? "") === normalizeSnippet(rawBody);
    if (isSelfChatMessage && confirmedAssistantOutbound) {
      rememberBlueBubblesSelfChatCopy(selfChatLookup);
    }
    if (cacheMessageId) {
      const pending = consumePendingOutboundMessageId({
        accountId: account.accountId,
        chatGuid: message.chatGuid,
        chatIdentifier: message.chatIdentifier,
        chatId: message.chatId,
        body: rawBody
      });
      if (pending) {
        const displayId = getShortIdForUuid(cacheMessageId) || cacheMessageId;
        const previewSource = pending.snippetRaw || rawBody;
        const preview = previewSource ? ` "${previewSource.slice(0, 12)}${previewSource.length > 12 ? "\u2026" : ""}"` : "";
        core.system.enqueueSystemEvent(`Assistant sent${preview} [message_id:${displayId}]`, {
          sessionKey: pending.sessionKey,
          contextKey: `bluebubbles:outbound:${pending.outboundTarget}:${cacheMessageId}`
        });
      }
    }
    return;
  }
  if (isSelfChatMessage && hasBlueBubblesSelfChatCopy(selfChatLookup)) {
    logVerbose(core, runtime, `drop: reflected self-chat duplicate sender=${message.senderId}`);
    return;
  }
  if (!rawBody) {
    logVerbose(core, runtime, `drop: empty text sender=${message.senderId}`);
    return;
  }
  logVerbose(
    core,
    runtime,
    `msg sender=${message.senderId} group=${isGroup} textLen=${text.length} attachments=${attachments.length} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`
  );
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "allowlist";
  const configuredAllowFrom = mapAllowFromEntries(account.config.allowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "bluebubbles",
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy
  });
  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configuredAllowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowFrom) => isAllowedBlueBubblesSender({
      allowFrom,
      sender: message.senderId,
      chatId: message.chatId ?? void 0,
      chatGuid: message.chatGuid ?? void 0,
      chatIdentifier: message.chatIdentifier ?? void 0
    })
  });
  const effectiveAllowFrom = accessDecision.effectiveAllowFrom;
  const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
  const groupAllowEntry = formatGroupAllowlistEntry({
    chatGuid: message.chatGuid,
    chatId: message.chatId ?? void 0,
    chatIdentifier: message.chatIdentifier ?? void 0
  });
  const groupName = message.chatName?.trim() || void 0;
  if (accessDecision.decision !== "allow") {
    if (isGroup) {
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
        logVerbose(core, runtime, "Blocked BlueBubbles group message (groupPolicy=disabled)");
        logGroupAllowlistHint({
          runtime,
          reason: "groupPolicy=disabled",
          entry: groupAllowEntry,
          chatName: groupName,
          accountId: account.accountId
        });
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
        logVerbose(core, runtime, "Blocked BlueBubbles group message (no allowlist)");
        logGroupAllowlistHint({
          runtime,
          reason: "groupPolicy=allowlist (empty allowlist)",
          entry: groupAllowEntry,
          chatName: groupName,
          accountId: account.accountId
        });
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
        logVerbose(
          core,
          runtime,
          `Blocked BlueBubbles sender ${message.senderId} (not in groupAllowFrom)`
        );
        logVerbose(
          core,
          runtime,
          `drop: group sender not allowed sender=${message.senderId} allowFrom=${effectiveGroupAllowFrom.join(",")}`
        );
        logGroupAllowlistHint({
          runtime,
          reason: "groupPolicy=allowlist (not allowlisted)",
          entry: groupAllowEntry,
          chatName: groupName,
          accountId: account.accountId
        });
        return;
      }
      return;
    }
    if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
      logVerbose(core, runtime, `Blocked BlueBubbles DM from ${message.senderId}`);
      logVerbose(core, runtime, `drop: dmPolicy disabled sender=${message.senderId}`);
      return;
    }
    if (accessDecision.decision === "pairing") {
      await issuePairingChallenge({
        channel: "bluebubbles",
        senderId: message.senderId,
        senderIdLine: `Your BlueBubbles sender id: ${message.senderId}`,
        meta: { name: message.senderName },
        upsertPairingRequest: pairing.upsertPairingRequest,
        onCreated: () => {
          runtime.log?.(`[bluebubbles] pairing request sender=${message.senderId} created=true`);
          logVerbose(core, runtime, `bluebubbles pairing request sender=${message.senderId}`);
        },
        sendPairingReply: async (text2) => {
          await sendMessageBlueBubbles(message.senderId, text2, {
            cfg: config,
            accountId: account.accountId
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        },
        onReplyError: (err) => {
          logVerbose(
            core,
            runtime,
            `bluebubbles pairing reply failed for ${message.senderId}: ${String(err)}`
          );
          runtime.error?.(
            `[bluebubbles] pairing reply failed sender=${message.senderId}: ${String(err)}`
          );
        }
      });
      return;
    }
    logVerbose(
      core,
      runtime,
      `Blocked unauthorized BlueBubbles sender ${message.senderId} (dmPolicy=${dmPolicy})`
    );
    logVerbose(
      core,
      runtime,
      `drop: dm sender not allowed sender=${message.senderId} allowFrom=${effectiveAllowFrom.join(",")}`
    );
    return;
  }
  const chatId = message.chatId ?? void 0;
  const chatGuid = message.chatGuid ?? void 0;
  const chatIdentifier = message.chatIdentifier ?? void 0;
  const peerId = isGroup ? chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group") : message.senderId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "bluebubbles",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId
    }
  });
  const messageText = text;
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
  const wasMentioned = isGroup ? core.channel.mentions.matchesMentionPatterns(messageText, mentionRegexes) : true;
  const canDetectMention = mentionRegexes.length > 0;
  const requireMention = core.channel.groups.resolveRequireMention({
    cfg: config,
    channel: "bluebubbles",
    groupId: peerId,
    accountId: account.accountId
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const hasControlCmd = core.channel.text.hasControlCommand(messageText, config);
  const commandDmAllowFrom = isGroup ? configuredAllowFrom : effectiveAllowFrom;
  const ownerAllowedForCommands = commandDmAllowFrom.length > 0 ? isAllowedBlueBubblesSender({
    allowFrom: commandDmAllowFrom,
    sender: message.senderId,
    chatId: message.chatId ?? void 0,
    chatGuid: message.chatGuid ?? void 0,
    chatIdentifier: message.chatIdentifier ?? void 0
  }) : false;
  const groupAllowedForCommands = effectiveGroupAllowFrom.length > 0 ? isAllowedBlueBubblesSender({
    allowFrom: effectiveGroupAllowFrom,
    sender: message.senderId,
    chatId: message.chatId ?? void 0,
    chatGuid: message.chatGuid ?? void 0,
    chatIdentifier: message.chatIdentifier ?? void 0
  }) : false;
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      { configured: commandDmAllowFrom.length > 0, allowed: ownerAllowedForCommands },
      { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands }
    ],
    allowTextCommands: true,
    hasControlCommand: hasControlCmd
  });
  const commandAuthorized = commandGate.commandAuthorized;
  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (msg) => logVerbose(core, runtime, msg),
      channel: "bluebubbles",
      reason: "control command (unauthorized)",
      target: message.senderId
    });
    return;
  }
  const shouldBypassMention = isGroup && requireMention && !wasMentioned && commandAuthorized && hasControlCmd;
  const effectiveWasMentioned = wasMentioned || shouldBypassMention;
  if (isGroup && requireMention && canDetectMention && !wasMentioned && !shouldBypassMention) {
    logVerbose(core, runtime, `bluebubbles: skipping group message (no mention)`);
    return;
  }
  cacheInboundMessage();
  const baseUrl = normalizeSecretInputString(account.config.serverUrl);
  const password = normalizeSecretInputString(account.config.password);
  const maxBytes = account.config.mediaMaxMb && account.config.mediaMaxMb > 0 ? account.config.mediaMaxMb * 1024 * 1024 : 8 * 1024 * 1024;
  let mediaUrls = [];
  let mediaPaths = [];
  let mediaTypes = [];
  if (attachments.length > 0) {
    if (!baseUrl || !password) {
      logVerbose(core, runtime, "attachment download skipped (missing serverUrl/password)");
    } else {
      for (const attachment of attachments) {
        if (!attachment.guid) {
          continue;
        }
        if (attachment.totalBytes && attachment.totalBytes > maxBytes) {
          logVerbose(
            core,
            runtime,
            `attachment too large guid=${attachment.guid} bytes=${attachment.totalBytes}`
          );
          continue;
        }
        try {
          const downloaded = await downloadBlueBubblesAttachment(attachment, {
            cfg: config,
            accountId: account.accountId,
            maxBytes
          });
          const saved = await core.channel.media.saveMediaBuffer(
            Buffer.from(downloaded.buffer),
            downloaded.contentType,
            "inbound",
            maxBytes
          );
          mediaPaths.push(saved.path);
          mediaUrls.push(saved.path);
          if (saved.contentType) {
            mediaTypes.push(saved.contentType);
          }
        } catch (err) {
          logVerbose(
            core,
            runtime,
            `attachment download failed guid=${attachment.guid} err=${String(err)}`
          );
        }
      }
    }
  }
  let replyToId = message.replyToId;
  let replyToBody = message.replyToBody;
  let replyToSender = message.replyToSender;
  let replyToShortId;
  if (isTapbackMessage && tapbackContext?.replyToId) {
    replyToId = tapbackContext.replyToId;
  }
  if (replyToId) {
    const cached = resolveReplyContextFromCache({
      accountId: account.accountId,
      replyToId,
      chatGuid: message.chatGuid,
      chatIdentifier: message.chatIdentifier,
      chatId: message.chatId
    });
    if (cached) {
      if (!replyToBody && cached.body) {
        replyToBody = cached.body;
      }
      if (!replyToSender && cached.senderLabel) {
        replyToSender = cached.senderLabel;
      }
      replyToShortId = cached.shortId;
      if (core.logging.shouldLogVerbose()) {
        const preview = (cached.body ?? "").replace(/\s+/g, " ").slice(0, 120);
        logVerbose(
          core,
          runtime,
          `reply-context cache hit replyToId=${replyToId} sender=${replyToSender ?? ""} body="${preview}"`
        );
      }
    }
  }
  if (replyToId && !replyToShortId) {
    replyToShortId = getShortIdForUuid(replyToId);
  }
  const replyTag = formatReplyTag({ replyToId, replyToShortId });
  const baseBody = replyTag ? isTapbackMessage ? `${rawBody} ${replyTag}` : `${replyTag} ${rawBody}` : rawBody;
  const senderLabel = message.senderName || `user:${message.senderId}`;
  const fromLabel = isGroup ? `${message.chatName?.trim() || "Group"} id:${peerId}` : senderLabel !== message.senderId ? `${senderLabel} id:${message.senderId}` : senderLabel;
  const groupSubject = isGroup ? message.chatName?.trim() || void 0 : void 0;
  const groupMembers = isGroup ? formatGroupMembers({
    participants: message.participants,
    fallback: message.senderId ? { id: message.senderId, name: message.senderName } : void 0
  }) : void 0;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey
  });
  const body = core.channel.reply.formatInboundEnvelope({
    channel: "BlueBubbles",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: baseBody,
    chatType: isGroup ? "group" : "direct",
    sender: { name: message.senderName || void 0, id: message.senderId }
  });
  let chatGuidForActions = chatGuid;
  if (!chatGuidForActions && baseUrl && password) {
    const resolveTarget = isGroup && (chatId || chatIdentifier) ? chatId ? { kind: "chat_id", chatId } : { kind: "chat_identifier", chatIdentifier: chatIdentifier ?? "" } : { kind: "handle", address: message.senderId };
    if (resolveTarget.kind !== "chat_identifier" || resolveTarget.chatIdentifier) {
      chatGuidForActions = await resolveChatGuidForTarget({
        baseUrl,
        password,
        target: resolveTarget
      }) ?? void 0;
    }
  }
  const ackReactionScope = config.messages?.ackReactionScope ?? "group-mentions";
  const removeAckAfterReply = config.messages?.removeAckAfterReply ?? false;
  const ackReactionValue = resolveBlueBubblesAckReaction({
    cfg: config,
    agentId: route.agentId,
    core,
    runtime
  });
  const shouldAckReaction = () => Boolean(
    ackReactionValue && core.channel.reactions.shouldAckReaction({
      scope: ackReactionScope,
      isDirect: !isGroup,
      isGroup,
      isMentionableGroup: isGroup,
      requireMention: Boolean(requireMention),
      canDetectMention,
      effectiveWasMentioned,
      shouldBypassMention
    })
  );
  const ackMessageId = message.messageId?.trim() || "";
  const ackReactionPromise = shouldAckReaction() && ackMessageId && chatGuidForActions && ackReactionValue ? sendBlueBubblesReaction({
    chatGuid: chatGuidForActions,
    messageGuid: ackMessageId,
    emoji: ackReactionValue,
    opts: { cfg: config, accountId: account.accountId }
  }).then(
    () => true,
    (err) => {
      logVerbose(
        core,
        runtime,
        `ack reaction failed chatGuid=${chatGuidForActions} msg=${ackMessageId}: ${String(err)}`
      );
      return false;
    }
  ) : null;
  const sendReadReceipts = account.config.sendReadReceipts !== false;
  if (chatGuidForActions && baseUrl && password && sendReadReceipts) {
    try {
      await markBlueBubblesChatRead(chatGuidForActions, {
        cfg: config,
        accountId: account.accountId
      });
      logVerbose(core, runtime, `marked read chatGuid=${chatGuidForActions}`);
    } catch (err) {
      runtime.error?.(`[bluebubbles] mark read failed: ${String(err)}`);
    }
  } else if (!sendReadReceipts) {
    logVerbose(core, runtime, "mark read skipped (sendReadReceipts=false)");
  } else {
    logVerbose(core, runtime, "mark read skipped (missing chatGuid or credentials)");
  }
  const outboundTarget = isGroup ? formatBlueBubblesChatTarget({
    chatId,
    chatGuid: chatGuidForActions ?? chatGuid,
    chatIdentifier
  }) || peerId : chatGuidForActions ? formatBlueBubblesChatTarget({ chatGuid: chatGuidForActions }) : message.senderId;
  const maybeEnqueueOutboundMessageId = (messageId, snippet) => {
    const trimmed = messageId?.trim();
    if (!trimmed || trimmed === "ok" || trimmed === "unknown") {
      return false;
    }
    const cacheEntry = rememberBlueBubblesReplyCache({
      accountId: account.accountId,
      messageId: trimmed,
      chatGuid: chatGuidForActions ?? chatGuid,
      chatIdentifier,
      chatId,
      senderLabel: "me",
      body: snippet ?? "",
      timestamp: Date.now()
    });
    const displayId = cacheEntry.shortId || trimmed;
    const preview = snippet ? ` "${snippet.slice(0, 12)}${snippet.length > 12 ? "\u2026" : ""}"` : "";
    core.system.enqueueSystemEvent(`Assistant sent${preview} [message_id:${displayId}]`, {
      sessionKey: route.sessionKey,
      contextKey: `bluebubbles:outbound:${outboundTarget}:${trimmed}`
    });
    return true;
  };
  const sanitizeReplyDirectiveText = (value) => {
    if (privateApiEnabled) {
      return value;
    }
    return value.replace(REPLY_DIRECTIVE_TAG_RE, " ").replace(/[ \t]+/g, " ").trim();
  };
  const historyLimit = isGroup ? account.config.historyLimit ?? 0 : account.config.dmHistoryLimit ?? 0;
  const historyIdentifier = chatGuid || chatIdentifier || (chatId ? String(chatId) : null) || (isGroup ? null : message.senderId) || "";
  const historyKey = historyIdentifier ? buildAccountScopedHistoryKey(account.accountId, historyIdentifier) : "";
  if (historyKey && historyLimit > 0) {
    const nowMs = Date.now();
    const senderLabel2 = message.fromMe ? "me" : message.senderName || message.senderId;
    const normalizedHistoryBody = truncateHistoryBody(text, MAX_STORED_HISTORY_ENTRY_CHARS);
    const currentEntries = recordPendingHistoryEntryIfEnabled({
      historyMap: chatHistories,
      limit: historyLimit,
      historyKey,
      entry: normalizedHistoryBody ? {
        sender: senderLabel2,
        body: normalizedHistoryBody,
        timestamp: message.timestamp ?? nowMs,
        messageId: message.messageId ?? void 0
      } : null
    });
    pruneHistoryBackfillState();
    const backfillAttempt = planHistoryBackfillAttempt(historyKey, nowMs);
    if (backfillAttempt) {
      try {
        const backfillResult = await fetchBlueBubblesHistory(historyIdentifier, historyLimit, {
          cfg: config,
          accountId: account.accountId
        });
        if (backfillResult.resolved) {
          markHistoryBackfillResolved(historyKey);
        }
        if (backfillResult.entries.length > 0) {
          const apiEntries = [];
          for (const entry of backfillResult.entries) {
            const body2 = truncateHistoryBody(entry.body, MAX_STORED_HISTORY_ENTRY_CHARS);
            if (!body2) {
              continue;
            }
            apiEntries.push({
              sender: entry.sender,
              body: body2,
              timestamp: entry.timestamp,
              messageId: entry.messageId
            });
          }
          const merged = mergeHistoryEntries({
            apiEntries,
            currentEntries: currentEntries.length > 0 ? currentEntries : chatHistories.get(historyKey) ?? [],
            limit: historyLimit
          });
          if (chatHistories.has(historyKey)) {
            chatHistories.delete(historyKey);
          }
          chatHistories.set(historyKey, merged);
          evictOldHistoryKeys(chatHistories);
          logVerbose(
            core,
            runtime,
            `backfilled ${backfillResult.entries.length} history messages for ${isGroup ? "group" : "DM"}: ${historyIdentifier}`
          );
        } else if (!backfillResult.resolved) {
          const remainingAttempts = HISTORY_BACKFILL_MAX_ATTEMPTS - backfillAttempt.attempts;
          const nextBackoffMs = Math.max(backfillAttempt.nextAttemptAt - nowMs, 0);
          logVerbose(
            core,
            runtime,
            `history backfill unresolved for ${historyIdentifier}; retries left=${Math.max(remainingAttempts, 0)} next_in_ms=${nextBackoffMs}`
          );
        }
      } catch (err) {
        const remainingAttempts = HISTORY_BACKFILL_MAX_ATTEMPTS - backfillAttempt.attempts;
        const nextBackoffMs = Math.max(backfillAttempt.nextAttemptAt - nowMs, 0);
        logVerbose(
          core,
          runtime,
          `history backfill failed for ${historyIdentifier}: ${String(err)} (retries left=${Math.max(remainingAttempts, 0)} next_in_ms=${nextBackoffMs})`
        );
      }
    }
  }
  let inboundHistory;
  if (historyKey && historyLimit > 0) {
    const entries = chatHistories.get(historyKey);
    if (entries && entries.length > 0) {
      inboundHistory = buildInboundHistorySnapshot({
        entries,
        limit: historyLimit
      });
    }
  }
  const commandBody = messageText.trim();
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    MediaUrl: mediaUrls[0],
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : void 0,
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : void 0,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : void 0,
    From: isGroup ? `group:${peerId}` : `bluebubbles:${message.senderId}`,
    To: `bluebubbles:${outboundTarget}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    // Use short ID for token savings (agent can use this to reference the message)
    ReplyToId: replyToShortId || replyToId,
    ReplyToIdFull: replyToId,
    ReplyToBody: replyToBody,
    ReplyToSender: replyToSender,
    GroupSubject: groupSubject,
    GroupMembers: groupMembers,
    SenderName: message.senderName || void 0,
    SenderId: message.senderId,
    Provider: "bluebubbles",
    Surface: "bluebubbles",
    // Use short ID for token savings (agent can use this to reference the message)
    MessageSid: messageShortId || message.messageId,
    MessageSidFull: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: "bluebubbles",
    OriginatingTo: `bluebubbles:${outboundTarget}`,
    WasMentioned: effectiveWasMentioned,
    CommandAuthorized: commandAuthorized
  });
  let sentMessage = false;
  let streamingActive = false;
  let typingRestartTimer;
  const typingRestartDelayMs = 150;
  const clearTypingRestartTimer = () => {
    if (typingRestartTimer) {
      clearTimeout(typingRestartTimer);
      typingRestartTimer = void 0;
    }
  };
  const restartTypingSoon = () => {
    if (!streamingActive || !chatGuidForActions || !baseUrl || !password) {
      return;
    }
    clearTypingRestartTimer();
    typingRestartTimer = setTimeout(() => {
      typingRestartTimer = void 0;
      if (!streamingActive) {
        return;
      }
      sendBlueBubblesTyping(chatGuidForActions, true, {
        cfg: config,
        accountId: account.accountId
      }).catch((err) => {
        runtime.error?.(`[bluebubbles] typing restart failed: ${String(err)}`);
      });
    }, typingRestartDelayMs);
  };
  try {
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg: config,
      agentId: route.agentId,
      channel: "bluebubbles",
      accountId: account.accountId
    });
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload, info) => {
          const rawReplyToId = privateApiEnabled && typeof payload.replyToId === "string" ? payload.replyToId.trim() : "";
          const replyToMessageGuid = rawReplyToId ? resolveBlueBubblesMessageId(rawReplyToId, { requireKnownShortId: true }) : "";
          const mediaList = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
          if (mediaList.length > 0) {
            const tableMode2 = core.channel.text.resolveMarkdownTableMode({
              cfg: config,
              channel: "bluebubbles",
              accountId: account.accountId
            });
            const text3 = sanitizeReplyDirectiveText(
              core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode2)
            );
            let first = true;
            for (const mediaUrl of mediaList) {
              const caption = first ? text3 : void 0;
              first = false;
              const cachedBody = (caption ?? "").trim() || "<media:attachment>";
              const pendingId = rememberPendingOutboundMessageId({
                accountId: account.accountId,
                sessionKey: route.sessionKey,
                outboundTarget,
                chatGuid: chatGuidForActions ?? chatGuid,
                chatIdentifier,
                chatId,
                snippet: cachedBody
              });
              let result;
              try {
                result = await sendBlueBubblesMedia({
                  cfg: config,
                  to: outboundTarget,
                  mediaUrl,
                  caption: caption ?? void 0,
                  replyToId: replyToMessageGuid || null,
                  accountId: account.accountId
                });
              } catch (err) {
                forgetPendingOutboundMessageId(pendingId);
                throw err;
              }
              if (maybeEnqueueOutboundMessageId(result.messageId, cachedBody)) {
                forgetPendingOutboundMessageId(pendingId);
              }
              sentMessage = true;
              statusSink?.({ lastOutboundAt: Date.now() });
              if (info.kind === "block") {
                restartTypingSoon();
              }
            }
            return;
          }
          const textLimit = account.config.textChunkLimit && account.config.textChunkLimit > 0 ? account.config.textChunkLimit : DEFAULT_TEXT_LIMIT;
          const chunkMode = account.config.chunkMode ?? "length";
          const tableMode = core.channel.text.resolveMarkdownTableMode({
            cfg: config,
            channel: "bluebubbles",
            accountId: account.accountId
          });
          const text2 = sanitizeReplyDirectiveText(
            core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode)
          );
          const chunks = chunkMode === "newline" ? core.channel.text.chunkTextWithMode(text2, textLimit, chunkMode) : core.channel.text.chunkMarkdownText(text2, textLimit);
          if (!chunks.length && text2) {
            chunks.push(text2);
          }
          if (!chunks.length) {
            return;
          }
          for (const chunk of chunks) {
            const pendingId = rememberPendingOutboundMessageId({
              accountId: account.accountId,
              sessionKey: route.sessionKey,
              outboundTarget,
              chatGuid: chatGuidForActions ?? chatGuid,
              chatIdentifier,
              chatId,
              snippet: chunk
            });
            let result;
            try {
              result = await sendMessageBlueBubbles(outboundTarget, chunk, {
                cfg: config,
                accountId: account.accountId,
                replyToMessageGuid: replyToMessageGuid || void 0
              });
            } catch (err) {
              forgetPendingOutboundMessageId(pendingId);
              throw err;
            }
            if (maybeEnqueueOutboundMessageId(result.messageId, chunk)) {
              forgetPendingOutboundMessageId(pendingId);
            }
            sentMessage = true;
            statusSink?.({ lastOutboundAt: Date.now() });
            if (info.kind === "block") {
              restartTypingSoon();
            }
          }
        },
        onReplyStart: async () => {
          if (!chatGuidForActions) {
            return;
          }
          if (!baseUrl || !password) {
            return;
          }
          streamingActive = true;
          clearTypingRestartTimer();
          try {
            await sendBlueBubblesTyping(chatGuidForActions, true, {
              cfg: config,
              accountId: account.accountId
            });
          } catch (err) {
            runtime.error?.(`[bluebubbles] typing start failed: ${String(err)}`);
          }
        },
        onIdle: async () => {
          if (!chatGuidForActions) {
            return;
          }
          if (!baseUrl || !password) {
            return;
          }
        },
        onError: (err, info) => {
          runtime.error?.(`BlueBubbles ${info.kind} reply failed: ${String(err)}`);
        }
      },
      replyOptions: {
        onModelSelected,
        disableBlockStreaming: typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0
      }
    });
  } finally {
    const shouldStopTyping = Boolean(chatGuidForActions && baseUrl && password) && (streamingActive || !sentMessage);
    streamingActive = false;
    clearTypingRestartTimer();
    if (sentMessage && chatGuidForActions && ackMessageId) {
      core.channel.reactions.removeAckReactionAfterReply({
        removeAfterReply: removeAckAfterReply,
        ackReactionPromise,
        ackReactionValue: ackReactionValue ?? null,
        remove: () => sendBlueBubblesReaction({
          chatGuid: chatGuidForActions,
          messageGuid: ackMessageId,
          emoji: ackReactionValue ?? "",
          remove: true,
          opts: { cfg: config, accountId: account.accountId }
        }),
        onError: (err) => {
          logAckFailure({
            log: (msg) => logVerbose(core, runtime, msg),
            channel: "bluebubbles",
            target: `${chatGuidForActions}/${ackMessageId}`,
            error: err
          });
        }
      });
    }
    if (shouldStopTyping && chatGuidForActions) {
      sendBlueBubblesTyping(chatGuidForActions, false, {
        cfg: config,
        accountId: account.accountId
      }).catch((err) => {
        logTypingFailure({
          log: (msg) => logVerbose(core, runtime, msg),
          channel: "bluebubbles",
          action: "stop",
          target: chatGuidForActions,
          error: err
        });
      });
    }
  }
}
async function processReaction(reaction, target) {
  const { account, config, runtime, core } = target;
  const pairing = createScopedPairingAccess({
    core,
    channel: "bluebubbles",
    accountId: account.accountId
  });
  if (reaction.fromMe) {
    return;
  }
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "allowlist";
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "bluebubbles",
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy
  });
  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup: reaction.isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: account.config.allowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowFrom) => isAllowedBlueBubblesSender({
      allowFrom,
      sender: reaction.senderId,
      chatId: reaction.chatId ?? void 0,
      chatGuid: reaction.chatGuid ?? void 0,
      chatIdentifier: reaction.chatIdentifier ?? void 0
    })
  });
  if (accessDecision.decision !== "allow") {
    return;
  }
  const chatId = reaction.chatId ?? void 0;
  const chatGuid = reaction.chatGuid ?? void 0;
  const chatIdentifier = reaction.chatIdentifier ?? void 0;
  const peerId = reaction.isGroup ? chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group") : reaction.senderId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "bluebubbles",
    accountId: account.accountId,
    peer: {
      kind: reaction.isGroup ? "group" : "direct",
      id: peerId
    }
  });
  const senderLabel = reaction.senderName || reaction.senderId;
  const chatLabel = reaction.isGroup ? ` in group:${peerId}` : "";
  const messageDisplayId = getShortIdForUuid(reaction.messageId) || reaction.messageId;
  const text = reaction.action === "removed" ? `${senderLabel} removed ${reaction.emoji} reaction [[reply_to:${messageDisplayId}]]${chatLabel}` : `${senderLabel} reacted with ${reaction.emoji} [[reply_to:${messageDisplayId}]]${chatLabel}`;
  core.system.enqueueSystemEvent(text, {
    sessionKey: route.sessionKey,
    contextKey: `bluebubbles:reaction:${reaction.action}:${peerId}:${reaction.messageId}:${reaction.senderId}:${reaction.emoji}`
  });
  logVerbose(core, runtime, `reaction event enqueued: ${text}`);
}
export {
  logVerbose,
  processMessage,
  processReaction
};
