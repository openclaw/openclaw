import {
  buildMentionRegexes,
  classifyChannelInboundEvent,
  formatMediaPlaceholderText,
  formatLocationText,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
  resolveGroupThreadMentionFacts,
  resolveUnmentionedGroupInboundPolicy,
  type BuildChannelInboundEventContextParams,
  type BuildMentionRegexesOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type {
  OpenClawConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import {
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageReceivedContext,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { formatAudioTranscriptForAgent } from "openclaw/plugin-sdk/media-understanding-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { NormalizedAllowFrom } from "./bot-access.js";
import type {
  TelegramLogger,
  TelegramMediaRef,
  TelegramMessageContextOptions,
} from "./bot-message-context.types.js";
import {
  buildSenderName,
  extractTelegramDice,
  extractTelegramLocation,
  formatTelegramDiceText,
  getTelegramTextParts,
  hasLeadingBotCommandAddressedToOtherBot,
  hasBotMentionInText,
  hasBotMention,
  resolveTelegramPrimaryMedia,
  resolveTelegramRichMessagePlaceholder,
  resolveTelegramRichMessageText,
} from "./bot/body-helpers.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramInboundOriginTarget,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import { renderTelegramTextEntities } from "./bot/inbound-text-entities.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramDirectPeerId } from "./dm-session-key.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";
import { resolveTelegramGroupIngestEnabled } from "./group-config-helpers.js";
import {
  resolveTelegramCommandIngressAuthorization,
  resolveTelegramNativeCommandBody,
} from "./ingress.js";
import { resolveStickerVisionSupport } from "./sticker-vision.js";
type TelegramMentionFacts = NonNullable<
  NonNullable<BuildChannelInboundEventContextParams["access"]>["mentions"]
>;

const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/media-runtime"),
);

export async function resolveTelegramInboundBody(params: {
  nativeCommandNames?: ReadonlyMap<string, string>;
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  isGroup: boolean;
  chatId: number | string;
  accountId?: string;
  senderId: string;
  senderUsername: string;
  sessionKey?: string;
  acpBinding?: boolean;
  resolvedThreadId?: number;
  threadSpec: TelegramThreadSpec;
  routeAgentId?: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  providerMentionPatterns?: BuildMentionRegexesOptions["providerPolicy"];
  requireMention?: boolean;
  isBotOwnedThread?: boolean;
  requireMentionInBotThreads?: boolean;
  options?: TelegramMessageContextOptions;
  logger: TelegramLogger;
}) {
  const {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    isGroup,
    chatId,
    accountId,
    senderId,
    senderUsername,
    sessionKey,
    resolvedThreadId,
    threadSpec,
    routeAgentId,
    effectiveGroupAllow,
    effectiveDmAllow,
    groupConfig,
    topicConfig,
    providerMentionPatterns,
    requireMention,
    options,
    logger,
  } = params;
  const originatingTo = buildTelegramInboundOriginTarget(chatId, threadSpec);
  const replyThreadId = threadSpec.id;
  const botUsername = normalizeOptionalLowercaseString(primaryCtx.me?.username);
  const mentionRegexes = buildMentionRegexes(cfg, routeAgentId, {
    provider: "telegram",
    conversationId: isGroup ? buildTelegramGroupPeerId(chatId, threadSpec) : String(chatId),
    providerPolicy: providerMentionPatterns,
  });
  const messageTextParts = getTelegramTextParts(msg);
  if (botUsername && hasLeadingBotCommandAddressedToOtherBot(msg, botUsername)) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "command addressed to another bot",
      target: senderId ?? "unknown",
    });
    return null;
  }
  const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
  const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, cfg, {
    botUsername,
  });
  const commandGate = await resolveTelegramCommandIngressAuthorization({
    accountId: accountId ?? "default",
    cfg,
    dmPolicy: "pairing",
    isGroup,
    chatId,
    resolvedThreadId,
    senderId,
    effectiveDmAllow,
    effectiveGroupAllow,
    eventKind: "message",
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
    modeWhenAccessGroupsOff: "allow",
    includeDmAllowForGroupCommands: false,
  });
  const commandAuthorized = commandGate.authorized;
  const nativeCommandBody = resolveTelegramNativeCommandBody({
    msg,
    nativeCommandNames: params.nativeCommandNames,
    botUsername,
  });
  const commandSource =
    options?.commandSource ??
    (nativeCommandBody !== undefined
      ? "native"
      : commandAuthorized && hasControlCommandInMessage
        ? "text"
        : undefined);
  const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, threadSpec) : undefined;
  const primaryMedia = resolveTelegramPrimaryMedia(msg);
  const nativeMediaFacts =
    allMedia.length > 0 ? allMedia : primaryMedia ? [{ kind: primaryMedia.kind }] : [];
  const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
  const stickerHasMedia =
    Boolean(msg.sticker) && allMedia.some((media) => media.kind === "sticker" && media.path);
  const stickerSupportsVision = stickerHasMedia
    ? await resolveStickerVisionSupport({ cfg, agentId: routeAgentId })
    : false;
  const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
  let formattedStickerDescription: string | undefined;
  if (stickerCacheHit) {
    const emoji = allMedia[0]?.stickerMetadata?.emoji;
    const setName = allMedia[0]?.stickerMetadata?.setName;
    const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
    formattedStickerDescription = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
  }

  const locationData = extractTelegramLocation(msg);
  const locationText = locationData ? formatLocationText(locationData) : undefined;
  const diceData = extractTelegramDice(msg);
  const diceText = diceData ? formatTelegramDiceText(diceData) : undefined;
  const rawText = renderTelegramTextEntities(
    messageTextParts.text,
    messageTextParts.entities,
  ).trim();
  const richText = resolveTelegramRichMessageText(msg);
  // Dice stays out of this flag on purpose: its only consumer is the audio preflight
  // below, and a Bot API message carries either `dice` or `voice`/`audio`, never both,
  // so adding it here could not change any decision.
  const hasUserText = Boolean(rawText || locationText);
  let rawBody = [rawText, locationText, diceText].filter(Boolean).join("\n").trim();
  if (!rawBody) {
    rawBody = richText ?? resolveTelegramRichMessagePlaceholder(msg) ?? "";
  }
  if (!rawBody && msg.sticker && !stickerHasMedia && !formattedStickerDescription) {
    rawBody = msg.sticker.emoji?.trim() || formatMediaPlaceholderText(nativeMediaFacts);
  }
  if (!rawBody && nativeMediaFacts.length === 0) {
    return null;
  }

  let bodyText = formattedStickerDescription
    ? [formattedStickerDescription, rawBody].filter(Boolean).join("\n")
    : rawBody;
  const isAudioMedia = (media: TelegramMediaRef) =>
    media.kind === "audio" || media.contentType?.startsWith("audio/") === true;
  const materializedMedia = allMedia.filter((media) => Boolean(media.path));
  const materializedAudioIndex = allMedia.findIndex(
    (media) => Boolean(media.path) && isAudioMedia(media),
  );
  const disableAudioPreflight =
    (topicConfig?.disableAudioPreflight ??
      (groupConfig as TelegramGroupConfig | undefined)?.disableAudioPreflight) === true;
  const senderAllowedForAudioPreflight = !allowForCommands.hasEntries || commandAuthorized;

  let preflightTranscript: string | undefined;
  const needsPreflightTranscription =
    materializedAudioIndex >= 0 &&
    !hasUserText &&
    (!isGroup ||
      (requireMention &&
        mentionRegexes.length > 0 &&
        !disableAudioPreflight &&
        senderAllowedForAudioPreflight));

  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await loadMediaUnderstandingRuntime();
      const tempCtx: MsgContext = {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: originatingTo,
        AccountId: accountId,
        MessageThreadId: replyThreadId,
        media: materializedMedia,
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
  const audioTranscribedMediaIndex =
    preflightTranscript === undefined ? undefined : materializedAudioIndex;

  if (!rawBody && preflightTranscript) {
    bodyText = formatAudioTranscriptForAgent(preflightTranscript);
  }
  const historyBody =
    rawBody || formattedStickerDescription || formatMediaPlaceholderText(nativeMediaFacts);

  const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
  const explicitlyMentioned = botUsername
    ? hasBotMention(msg, botUsername, primaryCtx.me?.id) ||
      (richText ? hasBotMentionInText(richText, botUsername) : false)
    : false;
  const groupThread = resolveGroupThreadMentionFacts({
    cfg,
    channel: "telegram",
    peerId: isGroup ? String(chatId) : resolveTelegramDirectPeerId({ chatId, senderId }),
    text: [messageTextParts.text, richText, preflightTranscript].filter(Boolean).join("\n"),
    sessionKey: params.sessionKey,
    acpBinding: params.acpBinding,
  });
  const computedWasMentioned =
    Boolean(groupThread?.mentionedAgentIds.length) ||
    matchesMentionWithExplicit({
      text: messageTextParts.text || richText || "",
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: explicitlyMentioned,
        canResolveExplicit: Boolean(botUsername),
      },
      transcript: preflightTranscript,
    });
  const wasMentioned =
    options?.forceWasMentioned === true ||
    (commandSource === "native" && commandAuthorized) ||
    computedWasMentioned;

  if (
    isGroup &&
    (commandGate.shouldBlockControlCommand || (commandSource === "native" && !commandAuthorized))
  ) {
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
  const { implicitMentionKinds } = resolveBotThreadMentionPolicy({
    isBotOwnedThread: params.isBotOwnedThread === true,
    requireMentionInBotThreads: params.requireMentionInBotThreads,
    requireMention: Boolean(requireMention),
    implicitMentionKinds: implicitMentionKindWhen(
      "reply_to_bot",
      replyToBotMessage && !isTelegramForumServiceMessage(msg.reply_to_message),
    ),
  });
  const canDetectMention =
    Boolean(groupThread) || Boolean(botUsername) || mentionRegexes.length > 0;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention,
      implicitMentionKinds: isGroup ? implicitMentionKinds : [],
    },
    policy: {
      isGroup,
      requireMention: Boolean(requireMention),
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    },
  });
  const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
  const inboundEventKind = classifyChannelInboundEvent({
    conversation: { kind: isGroup ? "group" : "direct" },
    unmentionedGroupPolicy: resolveUnmentionedGroupInboundPolicy({
      cfg,
      agentId: routeAgentId,
    }),
    wasMentioned: effectiveWasMentioned,
    hasControlCommand: hasControlCommandInMessage,
    hasAbortRequest: isAbortRequestText(rawBody, { botUsername }),
    commandSource,
  });
  if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
    logger.info({ chatId, reason: "no-mention" }, "skipping group message");
    if (sessionKey && resolveTelegramGroupIngestEnabled({ cfg, chatId, accountId, topicConfig })) {
      fireAndForgetHook(
        triggerInternalHook(
          createInternalHookEvent(
            "message",
            "received",
            sessionKey,
            toInternalMessageReceivedContext({
              from: `telegram:group:${historyKey ?? chatId}`,
              to: originatingTo,
              content: historyBody,
              timestamp: msg.date ? msg.date * 1000 : undefined,
              channelId: "telegram",
              accountId,
              conversationId: originatingTo,
              messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
              senderId: senderId || undefined,
              senderName: buildSenderName(msg),
              senderUsername: senderUsername || undefined,
              provider: "telegram",
              surface: "telegram",
              threadId: resolvedThreadId,
              originatingChannel: "telegram",
              originatingTo,
              isGroup: true,
              groupId: `telegram:${chatId}`,
              media: materializedMedia.map(({ path, contentType, kind, sourceMessageId }) => ({
                path,
                contentType,
                kind,
                messageId: sourceMessageId ?? String(msg.message_id),
              })),
            }),
          ),
        ),
        "telegram: mention-skip message hook failed",
      );
    }
    return null;
  }

  return {
    originatingTo,
    bodyText,
    rawBody,
    historyKey,
    commandAuthorized,
    effectiveWasMentioned,
    inboundEventKind,
    groupThread,
    mentionFacts: {
      canDetectMention,
      wasMentioned: effectiveWasMentioned,
      explicitlyMentionedBot: explicitlyMentioned,
      mentionSource: explicitlyMentioned
        ? "explicit_bot"
        : computedWasMentioned
          ? "mention_pattern"
          : implicitMentionKinds && implicitMentionKinds.length > 0
            ? "implicit_thread"
            : mentionDecision.shouldBypassMention
              ? "command_bypass"
              : undefined,
      implicitMentionKinds,
      effectiveWasMentioned,
      requireMention: Boolean(requireMention),
    } satisfies TelegramMentionFacts,
    canDetectMention,
    shouldBypassMention: mentionDecision.shouldBypassMention,
    commandSource,
    nativeCommandBody,
    ...(audioTranscribedMediaIndex !== undefined ? { audioTranscribedMediaIndex } : {}),
    stickerCacheHit,
    locationData: locationData ?? undefined,
  };
}
