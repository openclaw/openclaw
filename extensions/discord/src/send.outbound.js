import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { serializePayload } from "@buape/carbon";
import { ChannelType, Routes } from "discord-api-types/v10";
import { resolveChunkMode } from "../../../src/auto-reply/chunk.js";
import { loadConfig } from "../../../src/config/config.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import { recordChannelActivity } from "../../../src/infra/channel-activity.js";
import { resolvePreferredOpenClawTmpDir } from "../../../src/infra/tmp-openclaw-dir.js";
import { convertMarkdownTables } from "../../../src/markdown/tables.js";
import { maxBytesForKind } from "../../../src/media/constants.js";
import { extensionForMime } from "../../../src/media/mime.js";
import { unlinkIfExists } from "../../../src/media/temp-files.js";
import { loadWebMediaRaw } from "../../whatsapp/src/media.js";
import { resolveDiscordAccount } from "./accounts.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";
import {
  buildDiscordMessagePayload,
  buildDiscordSendError,
  buildDiscordTextChunks,
  createDiscordClient,
  normalizeDiscordPollInput,
  normalizeStickerIds,
  parseAndResolveRecipient,
  resolveChannelId,
  resolveDiscordChannelType,
  resolveDiscordSendComponents,
  resolveDiscordSendEmbeds,
  sendDiscordMedia,
  sendDiscordText,
  stripUndefinedFields,
  SUPPRESS_NOTIFICATIONS_FLAG
} from "./send.shared.js";
import {
  ensureOggOpus,
  getVoiceMessageMetadata,
  sendDiscordVoiceMessage
} from "./voice-message.js";
async function sendDiscordThreadTextChunks(params) {
  for (const chunk of params.chunks) {
    await sendDiscordText(
      params.rest,
      params.threadId,
      chunk,
      void 0,
      params.request,
      params.maxLinesPerMessage,
      void 0,
      void 0,
      params.chunkMode,
      params.silent
    );
  }
}
const DISCORD_THREAD_NAME_LIMIT = 100;
function deriveForumThreadName(text) {
  const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return firstLine.slice(0, DISCORD_THREAD_NAME_LIMIT) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 16);
}
function isForumLikeType(channelType) {
  return channelType === ChannelType.GuildForum || channelType === ChannelType.GuildMedia;
}
function toDiscordSendResult(result, fallbackChannelId) {
  return {
    messageId: result.id ? String(result.id) : "unknown",
    channelId: String(result.channel_id ?? fallbackChannelId)
  };
}
async function resolveDiscordSendTarget(to, opts) {
  const cfg = opts.cfg ?? loadConfig();
  const { rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId, cfg);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  return { rest, request, channelId };
}
async function sendMessageDiscord(to, text, opts = {}) {
  const cfg = opts.cfg ?? loadConfig();
  const accountInfo = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId: accountInfo.accountId
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountInfo.accountId);
  const mediaMaxBytes = typeof accountInfo.config.mediaMaxMb === "number" ? accountInfo.config.mediaMaxMb * 1024 * 1024 : 8 * 1024 * 1024;
  const textWithTables = convertMarkdownTables(text ?? "", tableMode);
  const textWithMentions = rewriteDiscordKnownMentions(textWithTables, {
    accountId: accountInfo.accountId
  });
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId, cfg);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  const channelType = await resolveDiscordChannelType(rest, channelId);
  if (isForumLikeType(channelType)) {
    const threadName = deriveForumThreadName(textWithTables);
    const chunks = buildDiscordTextChunks(textWithMentions, {
      maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
      chunkMode
    });
    const starterContent = chunks[0]?.trim() ? chunks[0] : threadName;
    const starterComponents = resolveDiscordSendComponents({
      components: opts.components,
      text: starterContent,
      isFirst: true
    });
    const starterEmbeds = resolveDiscordSendEmbeds({ embeds: opts.embeds, isFirst: true });
    const silentFlags = opts.silent ? 1 << 12 : void 0;
    const starterPayload = buildDiscordMessagePayload({
      text: starterContent,
      components: starterComponents,
      embeds: starterEmbeds,
      flags: silentFlags
    });
    let threadRes;
    try {
      threadRes = await request(
        () => rest.post(Routes.threads(channelId), {
          body: {
            name: threadName,
            message: stripUndefinedFields(serializePayload(starterPayload))
          }
        }),
        "forum-thread"
      );
    } catch (err) {
      throw await buildDiscordSendError(err, {
        channelId,
        rest,
        token,
        hasMedia: Boolean(opts.mediaUrl)
      });
    }
    const threadId = threadRes.id;
    const messageId = threadRes.message?.id ?? threadId;
    const resultChannelId = threadRes.message?.channel_id ?? threadId;
    const remainingChunks = chunks.slice(1);
    try {
      if (opts.mediaUrl) {
        const [mediaCaption, ...afterMediaChunks] = remainingChunks;
        await sendDiscordMedia(
          rest,
          threadId,
          mediaCaption ?? "",
          opts.mediaUrl,
          opts.mediaLocalRoots,
          mediaMaxBytes,
          void 0,
          request,
          accountInfo.config.maxLinesPerMessage,
          void 0,
          void 0,
          chunkMode,
          opts.silent
        );
        await sendDiscordThreadTextChunks({
          rest,
          threadId,
          chunks: afterMediaChunks,
          request,
          maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
          chunkMode,
          silent: opts.silent
        });
      } else {
        await sendDiscordThreadTextChunks({
          rest,
          threadId,
          chunks: remainingChunks,
          request,
          maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
          chunkMode,
          silent: opts.silent
        });
      }
    } catch (err) {
      throw await buildDiscordSendError(err, {
        channelId: threadId,
        rest,
        token,
        hasMedia: Boolean(opts.mediaUrl)
      });
    }
    recordChannelActivity({
      channel: "discord",
      accountId: accountInfo.accountId,
      direction: "outbound"
    });
    return toDiscordSendResult(
      {
        id: messageId,
        channel_id: resultChannelId
      },
      channelId
    );
  }
  let result;
  try {
    if (opts.mediaUrl) {
      result = await sendDiscordMedia(
        rest,
        channelId,
        textWithMentions,
        opts.mediaUrl,
        opts.mediaLocalRoots,
        mediaMaxBytes,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.components,
        opts.embeds,
        chunkMode,
        opts.silent
      );
    } else {
      result = await sendDiscordText(
        rest,
        channelId,
        textWithMentions,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.components,
        opts.embeds,
        chunkMode,
        opts.silent
      );
    }
  } catch (err) {
    throw await buildDiscordSendError(err, {
      channelId,
      rest,
      token,
      hasMedia: Boolean(opts.mediaUrl)
    });
  }
  recordChannelActivity({
    channel: "discord",
    accountId: accountInfo.accountId,
    direction: "outbound"
  });
  return toDiscordSendResult(result, channelId);
}
function resolveWebhookExecutionUrl(params) {
  const baseUrl = new URL(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(params.webhookId)}/${encodeURIComponent(params.webhookToken)}`
  );
  baseUrl.searchParams.set("wait", params.wait === false ? "false" : "true");
  if (params.threadId !== void 0 && params.threadId !== null && params.threadId !== "") {
    baseUrl.searchParams.set("thread_id", String(params.threadId));
  }
  return baseUrl.toString();
}
async function sendWebhookMessageDiscord(text, opts) {
  const webhookId = opts.webhookId.trim();
  const webhookToken = opts.webhookToken.trim();
  if (!webhookId || !webhookToken) {
    throw new Error("Discord webhook id/token are required");
  }
  const rewrittenText = rewriteDiscordKnownMentions(text, {
    accountId: opts.accountId
  });
  const replyTo = typeof opts.replyTo === "string" ? opts.replyTo.trim() : "";
  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : void 0;
  const response = await fetch(
    resolveWebhookExecutionUrl({
      webhookId,
      webhookToken,
      threadId: opts.threadId,
      wait: opts.wait
    }),
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: rewrittenText,
        username: opts.username?.trim() || void 0,
        avatar_url: opts.avatarUrl?.trim() || void 0,
        ...messageReference ? { message_reference: messageReference } : {}
      })
    }
  );
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(
      `Discord webhook send failed (${response.status}${raw ? `: ${raw.slice(0, 200)}` : ""})`
    );
  }
  const payload = await response.json().catch(() => ({}));
  try {
    const account = resolveDiscordAccount({
      cfg: opts.cfg ?? loadConfig(),
      accountId: opts.accountId
    });
    recordChannelActivity({
      channel: "discord",
      accountId: account.accountId,
      direction: "outbound"
    });
  } catch {
  }
  return {
    messageId: payload.id ? String(payload.id) : "unknown",
    channelId: payload.channel_id ? String(payload.channel_id) : opts.threadId ? String(opts.threadId) : ""
  };
}
async function sendStickerDiscord(to, stickerIds, opts = {}) {
  const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
  const content = opts.content?.trim();
  const rewrittenContent = content ? rewriteDiscordKnownMentions(content, {
    accountId: opts.accountId
  }) : void 0;
  const stickers = normalizeStickerIds(stickerIds);
  const res = await request(
    () => rest.post(Routes.channelMessages(channelId), {
      body: {
        content: rewrittenContent || void 0,
        sticker_ids: stickers
      }
    }),
    "sticker"
  );
  return toDiscordSendResult(res, channelId);
}
async function sendPollDiscord(to, poll, opts = {}) {
  const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
  const content = opts.content?.trim();
  const rewrittenContent = content ? rewriteDiscordKnownMentions(content, {
    accountId: opts.accountId
  }) : void 0;
  if (poll.durationSeconds !== void 0) {
    throw new Error("Discord polls do not support durationSeconds; use durationHours");
  }
  const payload = normalizeDiscordPollInput(poll);
  const flags = opts.silent ? SUPPRESS_NOTIFICATIONS_FLAG : void 0;
  const res = await request(
    () => rest.post(Routes.channelMessages(channelId), {
      body: {
        content: rewrittenContent || void 0,
        poll: payload,
        ...flags ? { flags } : {}
      }
    }),
    "poll"
  );
  return toDiscordSendResult(res, channelId);
}
async function materializeVoiceMessageInput(mediaUrl) {
  const media = await loadWebMediaRaw(mediaUrl, maxBytesForKind("audio"));
  const extFromName = media.fileName ? path.extname(media.fileName) : "";
  const extFromMime = media.contentType ? extensionForMime(media.contentType) : "";
  const ext = extFromName || extFromMime || ".bin";
  const tempDir = resolvePreferredOpenClawTmpDir();
  const filePath = path.join(tempDir, `voice-src-${crypto.randomUUID()}${ext}`);
  await fs.writeFile(filePath, media.buffer, { mode: 384 });
  return { filePath };
}
async function sendVoiceMessageDiscord(to, audioPath, opts = {}) {
  const { filePath: localInputPath } = await materializeVoiceMessageInput(audioPath);
  let oggPath = null;
  let oggCleanup = false;
  let token;
  let rest;
  let channelId;
  try {
    const cfg = opts.cfg ?? loadConfig();
    const accountInfo = resolveDiscordAccount({
      cfg,
      accountId: opts.accountId
    });
    const client = createDiscordClient(opts, cfg);
    token = client.token;
    rest = client.rest;
    const request = client.request;
    const recipient = await parseAndResolveRecipient(to, opts.accountId, cfg);
    channelId = (await resolveChannelId(rest, recipient, request)).channelId;
    const ogg = await ensureOggOpus(localInputPath);
    oggPath = ogg.path;
    oggCleanup = ogg.cleanup;
    const metadata = await getVoiceMessageMetadata(oggPath);
    const audioBuffer = await fs.readFile(oggPath);
    const result = await sendDiscordVoiceMessage(
      rest,
      channelId,
      audioBuffer,
      metadata,
      opts.replyTo,
      request,
      opts.silent,
      token
    );
    recordChannelActivity({
      channel: "discord",
      accountId: accountInfo.accountId,
      direction: "outbound"
    });
    return toDiscordSendResult(result, channelId);
  } catch (err) {
    if (channelId && rest && token) {
      throw await buildDiscordSendError(err, {
        channelId,
        rest,
        token,
        hasMedia: true
      });
    }
    throw err;
  } finally {
    await unlinkIfExists(oggCleanup ? oggPath : null);
    await unlinkIfExists(localInputPath);
  }
}
export {
  sendMessageDiscord,
  sendPollDiscord,
  sendStickerDiscord,
  sendVoiceMessageDiscord,
  sendWebhookMessageDiscord
};
