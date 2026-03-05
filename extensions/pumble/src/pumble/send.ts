import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { V1 } from "pumble-sdk";
import { getPumbleRuntime } from "../runtime.js";
import { resolvePumbleAccount } from "./accounts.js";
import { getActivePumbleAddon } from "./active-addon.js";
import { createPumbleClient, postPumbleDm, postPumbleMessage } from "./client.js";
import { resolveBotUserIdFromJwt } from "./jwt.js";

export type PumbleSendOpts = {
  botToken?: string;
  accountId?: string;
  mediaUrl?: string;
  replyToId?: string;
};

export type PumbleSendResult = {
  messageId: string;
  channelId: string;
};

type PumbleTarget = { kind: "channel"; id: string } | { kind: "user"; id?: string; email?: string };

function parsePumbleTarget(raw: string): PumbleTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Pumble sends");
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    if (!id) {
      throw new Error("Channel id is required for Pumble sends");
    }
    return { kind: "channel", id };
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    if (!id) {
      throw new Error("User id is required for Pumble sends");
    }
    return { kind: "user", id };
  }
  if (lower.startsWith("pumble:")) {
    const id = trimmed.slice("pumble:".length).trim();
    if (!id) {
      throw new Error("User id is required for Pumble sends");
    }
    return { kind: "user", id };
  }
  if (trimmed.includes("@")) {
    return { kind: "user", email: trimmed };
  }
  return { kind: "channel", id: trimmed };
}

export async function sendMessagePumble(
  to: string,
  text: string,
  opts: PumbleSendOpts = {},
): Promise<PumbleSendResult> {
  const core = getPumbleRuntime();
  const cfg = core.config.loadConfig();
  const account = resolvePumbleAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = opts.botToken?.trim() || account.botToken?.trim();
  if (!token) {
    throw new Error(
      `Pumble bot token missing for account "${account.accountId}" (set channels.pumble.accounts.${account.accountId}.botToken or PUMBLE_BOT_TOKEN for default).`,
    );
  }

  const target = parsePumbleTarget(to);
  const client = createPumbleClient({
    botToken: token,
    appKey: account.appKey?.trim(),
    botUserId: account.config.botUserId?.trim() || resolveBotUserIdFromJwt(token),
  });

  let message = text.trim();
  const mediaUrl = opts.mediaUrl?.trim();
  let sdkFiles: V1.FileToUpload[] | undefined;
  if (mediaUrl) {
    const isHttpUrl = /^https?:\/\//i.test(mediaUrl);
    const isLocalFile = !isHttpUrl && mediaUrl.startsWith("/");
    if (isHttpUrl || isLocalFile) {
      // Build SDK file payload for the bot client upload.
      let buffer: Buffer;
      let fileName: string;
      let contentType: string;
      if (isLocalFile) {
        buffer = Buffer.from(await readFile(mediaUrl));
        fileName = basename(mediaUrl);
        const ext = fileName.split(".").pop()?.toLowerCase();
        // Common MIME types for Pumble file uploads. Unlisted extensions
        // fall back to application/octet-stream (Pumble renders them as
        // generic file attachments).
        const mimeMap: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          pdf: "application/pdf",
          mp4: "video/mp4",
        };
        contentType = (ext ? mimeMap[ext] : undefined) ?? "application/octet-stream";
      } else {
        const media = await core.media.loadWebMedia(mediaUrl);
        buffer = Buffer.from(media.buffer);
        fileName = media.fileName ?? "upload";
        contentType = media.contentType ?? "application/octet-stream";
      }
      sdkFiles = [{ input: buffer, options: { name: fileName, mimeType: contentType } }];
    }
  }

  if (message) {
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "pumble",
      accountId: account.accountId,
    });
    message = core.channel.text.convertMarkdownTables(message, tableMode);
  }

  if (!message && !sdkFiles?.length) {
    throw new Error("Pumble message is empty");
  }

  let result: PumbleSendResult;
  if (sdkFiles?.length) {
    // Use the SDK bot client for file uploads — handles the 3-step upload internally.
    const active = getActivePumbleAddon(account.accountId);
    if (!active) {
      throw new Error(
        `Pumble SDK addon not running for account "${account.accountId}" — cannot upload media. ` +
          `Ensure the Pumble monitor is active with full SDK credentials.`,
      );
    }
    const botClient = await active.addon.getBotClient(active.workspaceId);
    if (!botClient) {
      throw new Error(
        `Pumble bot client unavailable for workspace "${active.workspaceId}" — cannot upload media.`,
      );
    }
    const payload: V1.SendMessagePayload = { text: message || "", files: sdkFiles };
    if (target.kind === "user") {
      const userId = target.id ?? target.email ?? "";
      if (!userId) {
        throw new Error("Pumble DM requires a user ID or email");
      }
      // pumble-sdk dmUser() does not return the created message — messageId
      // is unavailable, which prevents threading/ack on DM media sends.
      await botClient.v1.messages.dmUser(userId, payload);
      result = { messageId: "unknown", channelId: userId };
    } else if (opts.replyToId) {
      const msg = await botClient.v1.messages.reply(opts.replyToId, target.id, payload);
      result = { messageId: msg.id ?? "unknown", channelId: target.id };
    } else {
      const msg = await botClient.v1.messages.postMessageToChannel(target.id, payload);
      result = { messageId: msg.id ?? "unknown", channelId: target.id };
    }
  } else if (target.kind === "user") {
    const userId = target.id ?? target.email ?? "";
    if (!userId) {
      throw new Error("Pumble DM requires a user ID or email");
    }
    const msg = await postPumbleDm(client, { userId, text: message });
    result = {
      messageId: msg.id ?? "unknown",
      channelId: msg.channelId ?? userId,
    };
  } else {
    const msg = await postPumbleMessage(client, {
      channelId: target.id,
      text: message,
      threadRootId: opts.replyToId,
    });
    result = {
      messageId: msg.id ?? "unknown",
      channelId: target.id,
    };
  }

  core.channel.activity.record({
    channel: "pumble",
    accountId: account.accountId,
    direction: "outbound",
  });

  return result;
}
