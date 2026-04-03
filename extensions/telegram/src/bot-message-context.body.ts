import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../src/agents/agent-scope.js";
import {
  buildMentionRegexes,
  formatLocationText,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveMentionGatingWithBypass,
  type NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth-native";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import {
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { NormalizedAllowFrom } from "./bot-access.js";
import { isSenderAllowed } from "./bot-access.js";
import type {
  TelegramLogger,
  TelegramMediaRef,
  TelegramMessageContextOptions,
} from "./bot-message-context.types.js";
import {
  buildSenderLabel,
  expandTextLinks,
  extractTelegramLocation,
  getTelegramTextParts,
  hasBotMention,
  resolveTelegramMediaPlaceholder,
} from "./bot/body-helpers.js";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";

const MESSAGE_ARCHIVE_NON_ALNUM_RE = /[^a-z0-9._+-]+/g;

function sanitizeMessageArchiveSlug(value: string): string {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(MESSAGE_ARCHIVE_NON_ALNUM_RE, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

async function appendSkippedGroupMessageArchive(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  chatId: number | string;
  resolvedThreadId?: number;
  msg: TelegramContext["message"];
  senderId: string;
  rawBody: string;
}): Promise<void> {
  const workspaceDir =
    resolveAgentWorkspaceDir(params.cfg, params.agentId ?? "main") ??
    params.cfg.agents?.defaults?.workspace;
  if (!workspaceDir) {
    return;
  }
  const peerId = buildTelegramGroupPeerId(params.chatId, params.resolvedThreadId);
  const archiveDir = path.join(
    workspaceDir,
    "logs",
    "message-archive-raw",
    "telegram",
    "group",
    sanitizeMessageArchiveSlug(peerId),
  );
  await fs.mkdir(archiveDir, { recursive: true });
  const timestampMs =
    typeof params.msg.date === "number" && Number.isFinite(params.msg.date)
      ? params.msg.date * 1000
      : Date.now();
  const timestamp = new Date(timestampMs);
  const entry = {
    source: "mention-skip",
    timestamp_utc: timestamp.toISOString(),
    timestamp_local: timestamp.toISOString(),
    local_date: timestamp.toLocaleDateString("en-CA"),
    local_time: timestamp.toTimeString().slice(0, 8),
    workspace: workspaceDir,
    agent_id: params.agentId ?? "main",
    channel: "telegram",
    chat_type: "group",
    peer_id: peerId,
    conversation_label: params.msg.chat.title ?? peerId,
    conversation_slug: sanitizeMessageArchiveSlug(peerId),
    message_id:
      typeof params.msg.message_id === "number" ? String(params.msg.message_id) : undefined,
    role: "user",
    speaker_name: buildSenderLabel(params.msg, params.senderId || params.chatId),
    speaker_id: params.senderId || undefined,
    text: params.rawBody,
  };
  await fs.appendFile(
    path.join(archiveDir, `${entry.local_date}.jsonl`),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
}

export type TelegramInboundBodyResult = {
  bodyText: string;
  rawBody: string;
  historyKey?: string;
  commandAuthorized: boolean;
  effectiveWasMentioned: boolean;
  canDetectMention: boolean;
  shouldBypassMention: boolean;
  stickerCacheHit: boolean;
  locationData?: NormalizedLocation;
};

async function resolveStickerVisionSupport(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<boolean> {
  try {
    const { resolveStickerVisionSupportRuntime } = await import("./sticker-vision.runtime.js");
    return await resolveStickerVisionSupportRuntime(params);
  } catch {
    return false;
  }
}

export async function resolveTelegramInboundBody(params: {
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  isGroup: boolean;
  chatId: number | string;
  senderId: string;
  senderUsername: string;
  resolvedThreadId?: number;
  routeAgentId?: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  requireMention?: boolean;
  options?: TelegramMessageContextOptions;
  groupHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  logger: TelegramLogger;
}): Promise<TelegramInboundBodyResult | null> {
  const {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    isGroup,
    chatId,
    senderId,
    senderUsername,
    resolvedThreadId,
    routeAgentId,
    effectiveGroupAllow,
    effectiveDmAllow,
    groupConfig,
    topicConfig,
    requireMention,
    options,
    groupHistories,
    historyLimit,
    logger,
  } = params;
  const botUsername = primaryCtx.me?.username?.toLowerCase();
  const mentionRegexes = buildMentionRegexes(cfg, routeAgentId);
  const messageTextParts = getTelegramTextParts(msg);
  const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
  const senderAllowedForCommands = isSenderAllowed({
    allow: allowForCommands,
    senderId,
    senderUsername,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, cfg, {
    botUsername,
  });
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [{ configured: allowForCommands.hasEntries, allowed: senderAllowedForCommands }],
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = commandGate.commandAuthorized;
  const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : undefined;

  let placeholder = resolveTelegramMediaPlaceholder(msg) ?? "";
  const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
  const stickerSupportsVision = msg.sticker
    ? await resolveStickerVisionSupport({ cfg, agentId: routeAgentId })
    : false;
  const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
  if (stickerCacheHit) {
    const emoji = allMedia[0]?.stickerMetadata?.emoji;
    const setName = allMedia[0]?.stickerMetadata?.setName;
    const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
    placeholder = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
  }

  const locationData = extractTelegramLocation(msg);
  const locationText = locationData ? formatLocationText(locationData) : undefined;
  const rawText = expandTextLinks(messageTextParts.text, messageTextParts.entities).trim();
  const hasUserText = Boolean(rawText || locationText);
  let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
  if (!rawBody) {
    rawBody = placeholder;
  }
  if (!rawBody && allMedia.length === 0) {
    return null;
  }

  let bodyText = rawBody;
  const hasAudio = allMedia.some((media) => media.contentType?.startsWith("audio/"));
  const disableAudioPreflight =
    (topicConfig?.disableAudioPreflight ??
      (groupConfig as TelegramGroupConfig | undefined)?.disableAudioPreflight) === true;
  const senderAllowedForAudioPreflight =
    !useAccessGroups || !allowForCommands.hasEntries || senderAllowedForCommands;

  let preflightTranscript: string | undefined;
  const needsPreflightTranscription =
    isGroup &&
    requireMention &&
    hasAudio &&
    !hasUserText &&
    mentionRegexes.length > 0 &&
    !disableAudioPreflight &&
    senderAllowedForAudioPreflight;

  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await import("./media-understanding.runtime.js");
      const tempCtx: MsgContext = {
        MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
        MediaTypes:
          allMedia.length > 0
            ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
            : undefined,
      };
      preflightTranscript = await transcribeFirstAudio({
        ctx: tempCtx,
        cfg,
        agentDir: undefined,
      });
    } catch (err) {
      logVerbose(`telegram: audio preflight transcription failed: ${String(err)}`);
    }
  }

  if (hasAudio && bodyText === "<media:audio>" && preflightTranscript) {
    bodyText = preflightTranscript;
  }

  if (!bodyText && allMedia.length > 0) {
    if (hasAudio) {
      bodyText = preflightTranscript || "<media:audio>";
    } else {
      bodyText = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
    }
  }

  const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
  const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
  const computedWasMentioned = matchesMentionWithExplicit({
    text: messageTextParts.text,
    mentionRegexes,
    explicit: {
      hasAnyMention,
      isExplicitlyMentioned: explicitlyMentioned,
      canResolveExplicit: Boolean(botUsername),
    },
    transcript: preflightTranscript,
  });
  const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;

  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "control command (unauthorized)",
      target: senderId ?? "unknown",
    });
    return null;
  }

  const botId = primaryCtx.me?.id;
  const replyFromId = msg.reply_to_message?.from?.id;
  const replyToBotMessage = botId != null && replyFromId === botId;
  const isReplyToServiceMessage =
    replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
  const implicitMention = replyToBotMessage && !isReplyToServiceMessage;
  const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup,
    requireMention: Boolean(requireMention),
    canDetectMention,
    wasMentioned,
    implicitMention: isGroup && Boolean(requireMention) && implicitMention,
    hasAnyMention,
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
    commandAuthorized,
  });
  const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
  if (isGroup && requireMention && canDetectMention && mentionGate.shouldSkip) {
    logger.info({ chatId, reason: "no-mention" }, "skipping group message");
    await appendSkippedGroupMessageArchive({
      cfg,
      agentId: routeAgentId,
      chatId,
      resolvedThreadId,
      msg,
      senderId,
      rawBody,
    }).catch((err) => {
      logVerbose(`telegram: failed to archive skipped group message: ${String(err)}`);
    });
    recordPendingHistoryEntryIfEnabled({
      historyMap: groupHistories,
      historyKey: historyKey ?? "",
      limit: historyLimit,
      entry: historyKey
        ? {
            sender: buildSenderLabel(msg, senderId || chatId),
            body: rawBody,
            timestamp: msg.date ? msg.date * 1000 : undefined,
            messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
          }
        : null,
    });
    return null;
  }

  return {
    bodyText,
    rawBody,
    historyKey,
    commandAuthorized,
    effectiveWasMentioned,
    canDetectMention,
    shouldBypassMention: mentionGate.shouldBypassMention,
    stickerCacheHit,
    locationData: locationData ?? undefined,
  };
}
