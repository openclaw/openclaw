// Telegram plugin module implements outbound adapter behavior.
import type { OutboundDeliveryFormattingOptions } from "openclaw/plugin-sdk/channel-outbound";
import {
  resolveOutboundSendDep,
  sanitizeForPlainText,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  ChannelOutboundAdapter,
  OutboundDeliveryResult,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  resolveSendableOutboundReplyParts,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { splitTelegramHtmlChunks } from "./format.js";
import {
  canonicalizeTelegramPresentationPayload,
  resolveTelegramInteractiveTextFallback,
  TELEGRAM_PRESENTATION_CAPABILITIES,
} from "./interactive-fallback.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import {
  createTelegramPromptContextProjectionCursor,
  resolveTelegramPromptContextSource,
} from "./prompt-context-projection.js";
import { loadTelegramSendModule, type TelegramSendModule } from "./send-runtime.js";
import {
  normalizeTelegramChatId,
  normalizeTelegramOutboundTarget,
  parseTelegramTarget,
} from "./targets.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;
const TELEGRAM_POLL_OPTION_LIMIT = 12;

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];
type TelegramSendResult = Awaited<ReturnType<TelegramSendFn>>;
type TelegramReactionFn = typeof import("./send.js").reactMessageTelegram;
type TelegramLocationFn = typeof import("./send.js").sendLocationTelegram;
type ResolveTelegramSendFn = (deps?: OutboundSendDeps) => Promise<TelegramSendFn>;
type LoadTelegramSendModuleFn = () => Promise<TelegramSendModule>;
type TelegramPayloadChannelData = {
  buttons?: TelegramInlineButtons;
  quoteText?: string;
  reaction?: { emoji?: unknown; replyToId?: unknown; replyToCurrent?: unknown };
};

async function resolveDefaultTelegramSend(deps?: OutboundSendDeps): Promise<TelegramSendFn> {
  return (
    resolveOutboundSendDep<TelegramSendFn>(deps, "telegram") ??
    (await loadTelegramSendModule()).sendMessageTelegram
  );
}

function chunkTelegramOutboundText(
  text: string,
  limit: number,
  ctx?: { formatting?: OutboundDeliveryFormattingOptions },
): string[] {
  return ctx?.formatting?.parseMode === "HTML"
    ? splitTelegramHtmlChunks(text, limit)
    : chunkMarkdownTextWithMode(text, limit, ctx?.formatting?.chunkMode ?? "length");
}

type TelegramDeliveryProof = {
  messageId: string;
  chatId?: string;
  messageThreadId?: number;
  requestedMessageThreadId?: number;
};

function normalizeTelegramProofText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function normalizeTelegramProofThreadId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readTelegramDeliveryProofs(result: { meta?: unknown }): TelegramDeliveryProof[] {
  const meta = result.meta as
    | {
        telegram?: {
          messages?: unknown;
        };
      }
    | undefined;
  if (!Array.isArray(meta?.telegram?.messages)) {
    return [];
  }
  const proofs: TelegramDeliveryProof[] = [];
  for (const message of meta.telegram.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const proof = message as Record<string, unknown>;
    const messageId = normalizeTelegramProofText(proof.messageId);
    if (!messageId) {
      continue;
    }
    const chatId = normalizeTelegramProofText(proof.chatId);
    const messageThreadId = normalizeTelegramProofThreadId(proof.messageThreadId);
    const requestedMessageThreadId = normalizeTelegramProofThreadId(proof.requestedMessageThreadId);
    proofs.push({
      messageId,
      ...(chatId !== undefined ? { chatId } : {}),
      ...(messageThreadId !== undefined ? { messageThreadId } : {}),
      ...(requestedMessageThreadId !== undefined ? { requestedMessageThreadId } : {}),
    });
  }
  return proofs;
}

function resolveExpectedTelegramTopicProof(params: {
  to: string;
  threadId?: string | number | null;
}):
  | {
      chatId?: string;
      threadId: number;
      failures: string[];
    }
  | undefined {
  const outboundTo = normalizeTelegramOutboundTarget(params.to);
  const target = parseTelegramTarget(outboundTo);
  const expectedThreadIdFromTarget = target.messageThreadId;
  const expectedThreadIdFromField = parseTelegramThreadId(params.threadId);
  const expectedThreadId = expectedThreadIdFromField ?? expectedThreadIdFromTarget;
  const failures: string[] = [];
  if (
    expectedThreadIdFromField !== undefined &&
    expectedThreadIdFromTarget !== undefined &&
    expectedThreadIdFromField !== expectedThreadIdFromTarget
  ) {
    failures.push(
      `delivery threadId=${expectedThreadIdFromField} conflicts with target topic ${expectedThreadIdFromTarget}`,
    );
  }
  if (expectedThreadId === undefined || (expectedThreadId === 1 && failures.length === 0)) {
    return undefined;
  }
  return {
    chatId: normalizeTelegramChatId(target.chatId),
    threadId: expectedThreadId,
    failures,
  };
}

function assertTelegramTopicDeliveryProof(params: {
  target: { to: string; threadId?: string | number | null };
  results: readonly OutboundDeliveryResult[];
}) {
  const expected = resolveExpectedTelegramTopicProof(params.target);
  if (!expected) {
    return;
  }
  const failures = [...expected.failures];
  for (const [index, result] of params.results.entries()) {
    const label = `result ${index + 1}${result.messageId ? ` messageId=${result.messageId}` : ""}`;
    const proofs = readTelegramDeliveryProofs(result);
    if (proofs.length === 0) {
      failures.push(`${label} missing Telegram provider proof`);
      continue;
    }
    const resultMessageId = normalizeTelegramProofText(result.messageId);
    if (
      resultMessageId &&
      !proofs.some((proof) => normalizeTelegramProofText(proof.messageId) === resultMessageId)
    ) {
      failures.push(`${label} missing provider proof for result messageId ${resultMessageId}`);
    }
    for (const [proofIndex, proof] of proofs.entries()) {
      const proofLabel = `${label} provider message ${proofIndex + 1}`;
      const actualMessageId = normalizeTelegramProofText(proof.messageId);
      if (!actualMessageId) {
        failures.push(`${proofLabel} missing messageId`);
      }
      const actualChatId = normalizeTelegramProofText(proof.chatId);
      if (expected.chatId && actualChatId !== expected.chatId) {
        failures.push(
          `${proofLabel} chatId=${actualChatId ?? "missing"} expected ${expected.chatId}`,
        );
      }
      const actualThreadId = normalizeTelegramProofThreadId(proof.messageThreadId);
      if (actualThreadId !== expected.threadId) {
        failures.push(
          `${proofLabel} message_thread_id=${actualThreadId ?? "missing"} expected ${expected.threadId}`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Telegram delivery proof mismatch: ${failures.join("; ")}`);
  }
}

function mergeTelegramPayloadDeliveryProofs(
  finalResult: TelegramSendResult,
  sendResults: readonly TelegramSendResult[],
): TelegramSendResult {
  const proofBatches = sendResults.map((result) => readTelegramDeliveryProofs(result));
  if (!proofBatches.some((proofs) => proofs.length > 0)) {
    return finalResult;
  }
  const messages = sendResults.flatMap((result, index) => {
    const proofs = proofBatches[index] ?? [];
    if (proofs.length > 0) {
      return proofs;
    }
    return result.messageId ? [{ messageId: result.messageId }] : [];
  });
  if (
    finalResult.messageId &&
    !messages.some((message) => message.messageId === finalResult.messageId)
  ) {
    messages.push({ messageId: finalResult.messageId });
  }
  if (messages.length === 0) {
    return finalResult;
  }
  const finalMeta = finalResult.meta as
    | {
        telegram?: Record<string, unknown>;
      }
    | undefined;
  const lastMessage = messages.at(-1);
  return {
    ...finalResult,
    meta: {
      ...finalResult.meta,
      telegram: {
        ...finalMeta?.telegram,
        messages,
        ...(lastMessage?.chatId !== undefined ? { chatId: lastMessage.chatId } : {}),
        ...(lastMessage?.messageThreadId !== undefined
          ? { messageThreadId: lastMessage.messageThreadId }
          : {}),
        ...(lastMessage?.requestedMessageThreadId !== undefined
          ? { requestedMessageThreadId: lastMessage.requestedMessageThreadId }
          : {}),
      },
    },
  };
}

function resolveTelegramPayloadSendShape(payload: ReplyPayload) {
  const canonicalPayload = canonicalizeTelegramPresentationPayload(payload);
  const telegramData = canonicalPayload.channelData?.telegram as
    | TelegramPayloadChannelData
    | undefined;
  const text =
    resolveTelegramInteractiveTextFallback({
      text: canonicalPayload.text,
      interactive: canonicalPayload.interactive,
      presentation: canonicalPayload.presentation,
    }) ?? "";
  const mediaUrls = resolveSendableOutboundReplyParts(canonicalPayload).mediaUrls;
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation: canonicalPayload.presentation,
    interactive: canonicalPayload.interactive,
  });
  return {
    payload: canonicalPayload,
    telegramData,
    quoteText: typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined,
    reactionEmoji:
      typeof telegramData?.reaction?.emoji === "string" ? telegramData.reaction.emoji : undefined,
    text,
    mediaUrls,
    buttons,
  };
}

function isTelegramReactionOnlyPayload(payload: ReplyPayload): boolean {
  const { reactionEmoji, text, mediaUrls, buttons } = resolveTelegramPayloadSendShape(payload);
  return Boolean(reactionEmoji && !text && mediaUrls.length === 0 && !buttons?.length);
}

async function resolveTelegramSendContext(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  replyToIdSource?: TelegramSendOpts["replyToIdSource"];
  replyToMode?: TelegramSendOpts["replyToMode"];
  threadId?: string | number | null;
  formatting?: OutboundDeliveryFormattingOptions;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
  onDeliveryResult?: Parameters<
    NonNullable<ChannelOutboundAdapter["sendText"]>
  >[0]["onDeliveryResult"];
  resolveSend: ResolveTelegramSendFn;
}): Promise<{
  send: TelegramSendFn;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode?: "html";
    tableMode?: OutboundDeliveryFormattingOptions["tableMode"];
    messageThreadId?: number;
    replyToMessageId?: number;
    replyToIdSource?: TelegramSendOpts["replyToIdSource"];
    replyToMode?: TelegramSendOpts["replyToMode"];
    accountId?: string;
    silent?: boolean;
    gatewayClientScopes?: readonly string[];
    onDeliveryResult?: TelegramSendOpts["onDeliveryResult"];
  };
}> {
  const send = await params.resolveSend(params.deps);
  return {
    send,
    baseOpts: {
      verbose: false,
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      ...(params.replyToIdSource !== undefined ? { replyToIdSource: params.replyToIdSource } : {}),
      ...(params.replyToMode !== undefined ? { replyToMode: params.replyToMode } : {}),
      accountId: params.accountId ?? undefined,
      silent: params.silent,
      gatewayClientScopes: params.gatewayClientScopes,
      onDeliveryResult: params.onDeliveryResult
        ? async (result) => {
            await params.onDeliveryResult?.(attachChannelToResult("telegram", result));
          }
        : undefined,
      ...(params.formatting?.parseMode === "HTML" ? { textMode: "html" as const } : {}),
      tableMode: params.formatting?.tableMode,
    },
  };
}

async function resolveTelegramOutboundSendContext(
  params: Parameters<typeof resolveTelegramSendContext>[0] & { to: string },
) {
  const outboundTo = normalizeTelegramOutboundTarget(params.to);
  const { send, baseOpts } = await resolveTelegramSendContext(params);
  return { outboundTo, send, baseOpts };
}

type CreateTelegramOutboundAdapterOptions = {
  resolveSend?: ResolveTelegramSendFn;
  loadSendModule?: LoadTelegramSendModuleFn;
  beforeDeliverPayload?: ChannelOutboundAdapter["beforeDeliverPayload"];
  shouldSuppressLocalPayloadPrompt?: ChannelOutboundAdapter["shouldSuppressLocalPayloadPrompt"];
  shouldTreatDeliveredTextAsVisible?: ChannelOutboundAdapter["shouldTreatDeliveredTextAsVisible"];
  targetsMatchForReplySuppression?: ChannelOutboundAdapter["targetsMatchForReplySuppression"];
  preferFinalAssistantVisibleText?: boolean;
};

export async function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  sendLocation: TelegramLocationFn;
  react: TelegramReactionFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const { payload, quoteText, reactionEmoji, text, mediaUrls, buttons } =
    resolveTelegramPayloadSendShape(params.payload);
  const replyToMessageId = params.baseOpts.replyToMessageId;
  const promptContextSource = resolveTelegramPromptContextSource(params.payload);
  const projectionCursor = promptContextSource
    ? createTelegramPromptContextProjectionCursor(promptContextSource)
    : undefined;
  const projectionOptions = (finalPart: boolean) =>
    projectionCursor
      ? { promptContextProjectionPlan: { cursor: projectionCursor, finalPart } }
      : {};
  const payloadOpts = {
    ...params.baseOpts,
    quoteText,
    ...(payload.audioAsVoice === true ? { asVoice: true } : {}),
    ...(payload.videoAsNote === true ? { asVideoNote: true } : {}),
  };
  if (payload.location) {
    if (
      mediaUrls.length > 0 ||
      reactionEmoji ||
      payload.audioAsVoice === true ||
      payload.videoAsNote === true
    ) {
      throw new Error("Telegram location sends cannot be combined with media or reactions.");
    }
    if (text.trim()) {
      // Cross-context policy can add a required origin marker to an otherwise
      // standalone location. Persist it as a separate send without stealing
      // the location's native reply, quote, or buttons.
      await params.send(params.to, text, {
        ...params.baseOpts,
        replyToMessageId: undefined,
        replyToIdSource: undefined,
        replyToMode: undefined,
      });
    }
    return await params.sendLocation(params.to, payload.location, {
      ...params.baseOpts,
      ...projectionOptions(true),
      buttons,
      quoteText,
    });
  }
  if (payload.videoAsNote === true && mediaUrls.length !== 1) {
    throw new Error("Telegram video notes require exactly one media attachment.");
  }
  const shouldConsumeImplicitReplyTarget =
    payloadOpts.replyToIdSource === "implicit" &&
    payloadOpts.replyToMode !== undefined &&
    isSingleUseReplyToMode(payloadOpts.replyToMode);
  const consumedImplicitReplyPayloadOpts = shouldConsumeImplicitReplyTarget
    ? {
        ...payloadOpts,
        replyToMessageId: undefined,
        replyToIdSource: undefined,
        replyToMode: undefined,
      }
    : payloadOpts;
  let implicitReplyTargetAvailable = true;
  if (reactionEmoji) {
    if (typeof replyToMessageId !== "number") {
      throw new Error("Telegram reaction requires a reply target");
    }
    const reactionResult = await params.react(params.to, replyToMessageId, reactionEmoji, {
      cfg: params.baseOpts.cfg,
      accountId: params.baseOpts.accountId,
      gatewayClientScopes: params.baseOpts.gatewayClientScopes,
      verbose: false,
    });
    if (!reactionResult.ok) {
      throw new Error(reactionResult.warning);
    }
  }
  if (reactionEmoji && !text && mediaUrls.length === 0 && !buttons?.length) {
    return { messageId: String(replyToMessageId), chatId: params.to };
  }

  const sendResults: TelegramSendResult[] = [];
  const sendAndTrack: TelegramSendFn = async (...args) => {
    const result = await params.send(...args);
    sendResults.push(result);
    return result;
  };

  // Telegram allows reply_markup on media; attach buttons only to the first send.
  const result = await sendPayloadMediaSequenceOrFallback({
    text,
    mediaUrls,
    fallbackResult: { messageId: "unknown", chatId: params.to },
    sendNoMedia: async () =>
      await sendAndTrack(params.to, text, {
        ...payloadOpts,
        ...projectionOptions(true),
        buttons,
      }),
    send: async ({ text: textLocal, mediaUrl, index, isFirst }) => {
      const mediaPayloadOpts =
        shouldConsumeImplicitReplyTarget && !implicitReplyTargetAvailable
          ? consumedImplicitReplyPayloadOpts
          : payloadOpts;
      implicitReplyTargetAvailable = false;
      return await sendAndTrack(params.to, textLocal, {
        ...mediaPayloadOpts,
        ...projectionOptions(index === mediaUrls.length - 1),
        mediaUrl,
        ...(isFirst ? { buttons } : {}),
      });
    },
  });
  return mergeTelegramPayloadDeliveryProofs(result, sendResults);
}

export function createTelegramOutboundAdapter(
  options: CreateTelegramOutboundAdapterOptions = {},
): ChannelOutboundAdapter {
  const resolveSend = options.resolveSend ?? resolveDefaultTelegramSend;
  const loadSendModule = options.loadSendModule ?? loadTelegramSendModule;

  return {
    deliveryMode: "direct",
    chunker: chunkTelegramOutboundText,
    chunkerMode: "markdown",
    extractMarkdownImages: true,
    textChunkLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
    // Default Telegram delivery reparses this result as Markdown; use its bold and strike delimiters.
    sanitizeText: ({ text }) =>
      sanitizeForPlainText(sanitizeAssistantVisibleText(text), { style: "markdown" }),
    shouldSuppressLocalPayloadPrompt: options.shouldSuppressLocalPayloadPrompt,
    beforeDeliverPayload: options.beforeDeliverPayload,
    validateDeliveryResults: async ({ target, payload, results }) => {
      if (isTelegramReactionOnlyPayload(payload)) {
        return;
      }
      assertTelegramTopicDeliveryProof({ target, results });
    },
    shouldTreatDeliveredTextAsVisible: options.shouldTreatDeliveredTextAsVisible,
    targetsMatchForReplySuppression: options.targetsMatchForReplySuppression,
    preferFinalAssistantVisibleText: options.preferFinalAssistantVisibleText,
    presentationCapabilities: TELEGRAM_PRESENTATION_CAPABILITIES,
    deliveryCapabilities: {
      pin: true,
      durableFinal: {
        text: true,
        media: true,
        payload: true,
        silent: true,
        replyTo: true,
        thread: true,
        nativeQuote: false,
        messageSendingHooks: true,
        batch: true,
      },
    },
    renderPresentation: ({ payload, presentation }) =>
      canonicalizeTelegramPresentationPayload({ ...payload, presentation }),
    pinDeliveredMessage: async ({ cfg, target, messageId, pin, gatewayClientScopes }) => {
      const { pinMessageTelegram } = await loadSendModule();
      const outboundTo = normalizeTelegramOutboundTarget(target.to);
      const pinTarget = parseTelegramTarget(outboundTo);
      await pinMessageTelegram(pinTarget.chatId, messageId, {
        cfg,
        accountId: target.accountId ?? undefined,
        notify: pin.notify,
        verbose: false,
        gatewayClientScopes,
      });
    },
    resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
      typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
    pollMaxOptions: TELEGRAM_POLL_OPTION_LIMIT,
    supportsPollDurationSeconds: true,
    supportsAnonymousPolls: true,
    ...createAttachedChannelResultAdapter({
      channel: "telegram",
      sendText: async (params) => {
        const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
          ...params,
          resolveSend,
        });
        return await send(outboundTo, params.text, {
          ...baseOpts,
        });
      },
      sendMedia: async (params) => {
        const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
          ...params,
          resolveSend,
        });
        return await send(outboundTo, params.text, {
          ...baseOpts,
          mediaUrl: params.mediaUrl,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
          forceDocument: params.forceDocument ?? false,
        });
      },
    }),
    sendPayload: async (params) => {
      const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
        ...params,
        resolveSend,
      });
      const { reactMessageTelegram, sendLocationTelegram } = await loadSendModule();
      const result = await sendTelegramPayloadMessages({
        send,
        sendLocation: sendLocationTelegram,
        react: reactMessageTelegram,
        to: outboundTo,
        payload: params.payload,
        baseOpts: {
          ...baseOpts,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
          forceDocument: params.forceDocument ?? false,
        },
      });
      return attachChannelToResult("telegram", result);
    },
    sendPoll: async ({
      cfg,
      to,
      poll,
      accountId,
      threadId,
      silent,
      isAnonymous,
      gatewayClientScopes,
    }) => {
      const outboundTo = normalizeTelegramOutboundTarget(to);
      const { sendPollTelegram } = await loadSendModule();
      return await sendPollTelegram(outboundTo, poll, {
        cfg,
        accountId: accountId ?? undefined,
        messageThreadId: parseTelegramThreadId(threadId),
        silent: silent ?? undefined,
        isAnonymous: isAnonymous ?? undefined,
        gatewayClientScopes,
      });
    },
  };
}

export const telegramOutbound: ChannelOutboundAdapter = createTelegramOutboundAdapter();
