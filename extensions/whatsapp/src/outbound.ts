import {
  loadConfig,
  resolveMarkdownTableMode,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { generateSecureUuid } from "openclaw/plugin-sdk/core";
import { normalizePollInput, type PollInput } from "openclaw/plugin-sdk/media-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  convertMarkdownTables,
  getChildLogger,
  markdownToWhatsApp,
  redactIdentifier,
  toWhatsappJid,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveWhatsAppAccount, resolveWhatsAppMediaMaxBytes } from "./accounts.js";
import { type ActiveWebSendOptions, requireActiveWebListener } from "./active-listener.js";
import { loadOutboundMediaFromUrl } from "./runtime-api.js";

const outboundLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound");

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: {
    verbose: boolean;
    cfg?: OpenClawConfig;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    gifPlayback?: boolean;
    accountId?: string;
  },
): Promise<{ messageId: string; toJid: string }> {
  let text = body;
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const { listener: active, accountId: resolvedAccountId } = requireActiveWebListener(
    options.accountId,
  );
  const cfg = options.cfg ?? loadConfig();
  const account = resolveWhatsAppAccount({
    cfg,
    accountId: resolvedAccountId ?? options.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "whatsapp",
    accountId: resolvedAccountId ?? options.accountId,
  });
  text = convertMarkdownTables(text ?? "", tableMode);
  text = markdownToWhatsApp(text);
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  try {
    const jid = toWhatsappJid(to);
    const redactedJid = redactIdentifier(jid);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    let documentFileName: string | undefined;
    if (options.mediaUrl) {
      const media = await loadOutboundMediaFromUrl(options.mediaUrl, {
        maxBytes: resolveWhatsAppMediaMaxBytes(account),
        mediaLocalRoots: options.mediaLocalRoots,
      });
      const caption = text || undefined;
      mediaBuffer = media.buffer;
      mediaType = media.contentType;
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        mediaType =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : (media.contentType ?? "application/octet-stream");
      } else if (media.kind === "video") {
        text = caption ?? "";
      } else if (media.kind === "image") {
        text = caption ?? "";
      } else {
        text = caption ?? "";
        documentFileName = media.fileName;
      }
    }
    outboundLog.info(`Sending message -> ${redactedJid}${options.mediaUrl ? " (media)" : ""}`);
    logger.info({ jid: redactedJid, hasMedia: Boolean(options.mediaUrl) }, "sending message");
    await active.sendComposingTo(to);
    const hasExplicitAccountId = Boolean(options.accountId?.trim());
    const accountId = hasExplicitAccountId ? resolvedAccountId : undefined;
    const sendOptions: ActiveWebSendOptions | undefined =
      options.gifPlayback || accountId || documentFileName
        ? {
            ...(options.gifPlayback ? { gifPlayback: true } : {}),
            ...(documentFileName ? { fileName: documentFileName } : {}),
            accountId,
          }
        : undefined;
    const result = sendOptions
      ? await active.sendMessage(to, text, mediaBuffer, mediaType, sendOptions)
      : await active.sendMessage(to, text, mediaBuffer, mediaType);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(
      `Sent message ${messageId} -> ${redactedJid}${options.mediaUrl ? " (media)" : ""} (${durationMs}ms)`,
    );
    logger.info({ jid: redactedJid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to: redactedTo, hasMedia: Boolean(options.mediaUrl) },
      "failed to send via web session",
    );
    throw err;
  }
}

export async function sendReactionWhatsApp(
  chatJid: string,
  messageId: string,
  emoji: string,
  options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
  },
): Promise<void> {
  const correlationId = generateSecureUuid();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const redactedChatJid = redactIdentifier(chatJid);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    chatJid: redactedChatJid,
    messageId,
  });
  try {
    const jid = toWhatsappJid(chatJid);
    const redactedJid = redactIdentifier(jid);
    outboundLog.info(`Sending reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sending reaction");
    await active.sendReaction(
      chatJid,
      messageId,
      emoji,
      options.fromMe ?? false,
      options.participant,
    );
    outboundLog.info(`Sent reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sent reaction");
  } catch (err) {
    logger.error(
      { err: String(err), chatJid: redactedChatJid, messageId, emoji },
      "failed to send reaction via web session",
    );
    throw err;
  }
}

export async function sendPollWhatsApp(
  to: string,
  poll: PollInput,
  options: { verbose: boolean; accountId?: string; cfg?: OpenClawConfig },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  try {
    const jid = toWhatsappJid(to);
    const redactedJid = redactIdentifier(jid);
    const normalized = normalizePollInput(poll, { maxOptions: 12 });
    outboundLog.info(`Sending poll -> ${redactedJid}`);
    logger.info(
      {
        jid: redactedJid,
        optionCount: normalized.options.length,
        maxSelections: normalized.maxSelections,
      },
      "sending poll",
    );
    const result = await active.sendPoll(to, normalized);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent poll ${messageId} -> ${redactedJid} (${durationMs}ms)`);
    logger.info({ jid: redactedJid, messageId }, "sent poll");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error({ err: String(err), to: redactedTo }, "failed to send poll via web session");
    throw err;
  }
}

export async function addChatLabelWhatsApp(
  chatJid: string,
  labelId: string,
  options: { accountId?: string } = {},
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  await active.addChatLabel(chatJid, labelId);
}

export async function removeChatLabelWhatsApp(
  chatJid: string,
  labelId: string,
  options: { accountId?: string } = {},
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  await active.removeChatLabel(chatJid, labelId);
}

export async function getLabelsWhatsApp(options: { accountId?: string } = {}) {
  const { listener: active } = requireActiveWebListener(options.accountId);
  return (await active.getLabels?.()) ?? [];
}

export async function createLabelWhatsApp(
  name: string,
  color: number,
  options: { accountId?: string } = {},
) {
  const { listener: active } = requireActiveWebListener(options.accountId);
  return await active.createLabel?.(name, color);
}

export async function addLabelWhatsApp(
  chatJid: string,
  labels: { id: string; name?: string; color?: number; deleted?: boolean; predefinedId?: number },
  options: { accountId?: string } = {},
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  await active.addLabel!(chatJid, labels);
}

export async function addMessageLabelWhatsApp(
  chatJid: string,
  messageId: string,
  labelId: string,
  options: { accountId?: string } = {},
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  await active.addMessageLabel!(chatJid, messageId, labelId);
}

export async function removeMessageLabelWhatsApp(
  chatJid: string,
  messageId: string,
  labelId: string,
  options: { accountId?: string } = {},
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  await active.removeMessageLabel!(chatJid, messageId, labelId);
}

export async function onWhatsApp(
  ...phoneNumbers: string[]
): Promise<{ jid: string; exists: boolean }[] | undefined> {
  // accountId not supported for this method — uses default listener
  const { listener: active } = requireActiveWebListener();
  return await active.onWhatsApp!(...phoneNumbers);
}

export async function getBusinessProfileWhatsApp(
  jid: string,
  options: { accountId?: string } = {},
): Promise<unknown> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  return await active.getBusinessProfile!(jid);
}

export async function chatModifyWhatsApp(
  mod: unknown,
  jid: string,
  options: { accountId?: string } = {},
): Promise<void> {
  const { listener: active } = requireActiveWebListener(options.accountId);
  await active.chatModify!(mod, jid);
}
