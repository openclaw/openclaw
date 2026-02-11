import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  normalizeZulipBaseUrl,
  sendZulipPrivateMessage,
  sendZulipStreamMessage,
  uploadZulipFile,
} from "./client.js";

export type ZulipSendOpts = {
  apiKey?: string;
  email?: string;
  baseUrl?: string;
  accountId?: string;
  mediaUrl?: string;
  topic?: string;
};

export type ZulipSendResult = {
  messageId: string;
  channelId: string;
};

type ZulipTarget =
  | { kind: "stream"; stream: string; topic?: string }
  | { kind: "user"; email: string };

const DEFAULT_TOPIC = "general";

const getCore = () => getZulipRuntime();

function normalizeMessage(text: string, mediaUrl?: string): string {
  const trimmed = text.trim();
  const media = mediaUrl?.trim();
  return [trimmed, media].filter(Boolean).join("\n");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveZulipLocalPath(value: string): string | null {
  if (value.startsWith("file://")) {
    return fileURLToPath(value);
  }
  if (!isHttpUrl(value)) {
    return value;
  }
  return null;
}

async function writeTempFile(buffer: Buffer, filename: string): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "zulip-upload-"));
  const filePath = path.join(dir, filename);
  await fsPromises.writeFile(filePath, buffer);
  return filePath;
}

function parseZulipTarget(raw: string): ZulipTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Zulip sends");
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("stream:")) {
    const rest = trimmed.slice("stream:".length).trim();
    if (!rest) {
      throw new Error("Stream name is required for Zulip sends");
    }
    const [stream, topic] = rest.split(/[:#/]/);
    return { kind: "stream", stream: stream.trim(), topic: topic?.trim() };
  }
  if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    const email = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    return { kind: "user", email };
  }
  if (lower.startsWith("zulip:")) {
    const email = trimmed.slice("zulip:".length).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    return { kind: "user", email };
  }
  if (trimmed.startsWith("@")) {
    const email = trimmed.slice(1).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    return { kind: "user", email };
  }
  if (trimmed.startsWith("#")) {
    const rest = trimmed.slice(1).trim();
    const [stream, topic] = rest.split(/[:#/]/);
    if (!stream) {
      throw new Error("Stream name is required for Zulip sends");
    }
    return { kind: "stream", stream: stream.trim(), topic: topic?.trim() };
  }
  if (trimmed.includes("@")) {
    return { kind: "user", email: trimmed };
  }
  return { kind: "stream", stream: trimmed };
}

export async function sendMessageZulip(
  to: string,
  text: string,
  opts: ZulipSendOpts = {},
): Promise<ZulipSendResult> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "zulip" });
  const cfg = core.config.loadConfig();
  const account = resolveZulipAccount({
    cfg,
    accountId: opts.accountId,
  });
  const apiKey = opts.apiKey?.trim() || account.apiKey?.trim();
  const email = opts.email?.trim() || account.email?.trim();
  if (!apiKey || !email) {
    throw new Error(
      `Zulip apiKey/email missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.apiKey/email or ZULIP_API_KEY/ZULIP_EMAIL for default).`,
    );
  }
  const baseUrl = normalizeZulipBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Zulip url missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.url or ZULIP_URL for default).`,
    );
  }

  const client = createZulipClient({ baseUrl, email, apiKey });
  const target = parseZulipTarget(to);
  let message = text?.trim() ?? "";
  const rawMediaUrl = opts.mediaUrl?.trim();
  let mediaUrl = rawMediaUrl;
  let tempFilePath: string | undefined;
  let tempFileCleanup = false;

  if (mediaUrl) {
    const localPath = resolveZulipLocalPath(mediaUrl);
    const isZulipHosted = isHttpUrl(mediaUrl) && mediaUrl.startsWith(baseUrl);
    if (localPath && fs.existsSync(localPath)) {
      const upload = await uploadZulipFile(client, localPath);
      mediaUrl = upload.url;
    } else if (isHttpUrl(mediaUrl) && !isZulipHosted) {
      const maxBytes = (cfg.agents?.defaults?.mediaMaxMb ?? 5) * 1024 * 1024;
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: mediaUrl,
        maxBytes,
      });
      const filename = (() => {
        try {
          return path.basename(new URL(mediaUrl).pathname) || "upload.bin";
        } catch {
          return "upload.bin";
        }
      })();
      if (core.channel.media?.saveMediaBuffer) {
        const saved = await core.channel.media.saveMediaBuffer(
          fetched.buffer,
          fetched.contentType ?? "application/octet-stream",
          "outbound",
          maxBytes,
          filename,
        );
        tempFilePath = saved.path;
      } else {
        tempFilePath = await writeTempFile(fetched.buffer, filename);
        tempFileCleanup = true;
      }
      const upload = await uploadZulipFile(client, tempFilePath);
      mediaUrl = upload.url;
      if (tempFileCleanup && tempFilePath) {
        await fsPromises.unlink(tempFilePath).catch(() => undefined);
      }
    }
    message = normalizeMessage(message, mediaUrl);
  }

  if (message) {
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
    });
    message = core.channel.text.convertMarkdownTables(message, tableMode);
  }

  if (!message) {
    throw new Error("Zulip message is empty");
  }

  let messageId = "unknown";
  if (target.kind === "user") {
    const response = await sendZulipPrivateMessage(client, {
      to: target.email,
      content: message,
    });
    messageId = response.id ? String(response.id) : "unknown";
  } else {
    const topic = target.topic || opts.topic || DEFAULT_TOPIC;
    if (!topic) {
      logger.debug?.("zulip send: missing topic for stream message");
    }
    const response = await sendZulipStreamMessage(client, {
      stream: target.stream,
      topic: topic || DEFAULT_TOPIC,
      content: message,
    });
    messageId = response.id ? String(response.id) : "unknown";
  }

  core.channel.activity.record({
    channel: "zulip",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId,
    channelId: target.kind === "stream" ? target.stream : target.email,
  };
}
