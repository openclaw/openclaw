import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEmptyChannelResult } from "openclaw/plugin-sdk/channel-send-result";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { resolveWechatLinuxAccount } from "./accounts.js";
import {
  resolveWechatLinuxBridgeTarget,
  sendWechatLinuxBridgeFile,
  sendWechatLinuxBridgeText,
} from "./bridge.js";
import { buildWechatLinuxOutboundTarget, inferWechatLinuxTargetChatType } from "./normalize.js";
import { noteRecentWechatLinuxOutbound } from "./recent-outbound.js";
import type { CoreConfig, ResolvedWechatLinuxAccount } from "./types.js";

type ResolvedOutboundTarget = {
  chatId: string;
  chatType: "direct" | "group";
  display?: string;
};

const MB = 1024 * 1024;

function resolveWechatLinuxMediaMaxBytes(cfg: CoreConfig, account: ResolvedWechatLinuxAccount) {
  const accountLimitMb =
    cfg.channels?.["wechat-linux"]?.accounts?.[account.accountId]?.mediaMaxMb ??
    account.config.mediaMaxMb;
  if (accountLimitMb) {
    return accountLimitMb * MB;
  }
  const channelLimitMb = cfg.channels?.["wechat-linux"]?.mediaMaxMb;
  if (channelLimitMb) {
    return channelLimitMb * MB;
  }
  const defaultLimitMb = cfg.agents?.defaults?.mediaMaxMb;
  return defaultLimitMb ? defaultLimitMb * MB : undefined;
}

function guessExtension(fileName?: string, contentType?: string): string {
  const directExt = path.extname(fileName ?? "").trim();
  if (directExt) {
    return directExt.toLowerCase();
  }
  const type = (contentType ?? "").toLowerCase();
  if (type === "image/jpeg") {
    return ".jpg";
  }
  if (type === "image/png") {
    return ".png";
  }
  if (type === "image/webp") {
    return ".webp";
  }
  if (type === "application/pdf") {
    return ".pdf";
  }
  return ".bin";
}

function isImageContent(fileName?: string, contentType?: string): boolean {
  const type = (contentType ?? "").toLowerCase();
  if (type.startsWith("image/")) {
    return true;
  }
  const ext = guessExtension(fileName, contentType);
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
}

async function materializeOutboundMedia(params: {
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
}) {
  const loaded = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: params.maxBytes,
    mediaLocalRoots: params.mediaLocalRoots,
  });
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-wechat-linux-"));
  const fileName =
    loaded.fileName?.trim() || `attachment${guessExtension(undefined, loaded.contentType)}`;
  const tempPath = path.join(tempDir, fileName);
  await fs.writeFile(tempPath, loaded.buffer);
  return {
    tempDir,
    tempPath,
    contentType: loaded.contentType,
    fileName,
  };
}

async function cleanupTempDir(tempDir?: string) {
  if (!tempDir) {
    return;
  }
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}

export async function resolveWechatLinuxOutboundTarget(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  target: string;
  preferredKind?: "direct" | "group";
}): Promise<ResolvedOutboundTarget> {
  const account = resolveWechatLinuxAccount({ cfg: params.cfg, accountId: params.accountId });
  const parsed = buildWechatLinuxOutboundTarget(params.target);
  if (parsed && (parsed.chatType === "group" || parsed.chatType === "direct")) {
    return {
      chatId: parsed.id,
      chatType: parsed.chatType,
    };
  }

  const preferredKind =
    params.preferredKind ?? inferWechatLinuxTargetChatType(params.target) ?? undefined;
  const resolved = await resolveWechatLinuxBridgeTarget({
    account,
    input: params.target,
    kind: preferredKind,
  });
  if (!resolved.ok || !resolved.chat_id || !resolved.chat_type) {
    throw new Error(resolved.note || `unable to resolve WeChat target: ${params.target}`);
  }
  return {
    chatId: resolved.chat_id,
    chatType: resolved.chat_type,
    display: resolved.chat_name,
  };
}

export async function sendWechatLinuxText(params: {
  cfg: CoreConfig;
  to: string;
  text: string;
  accountId?: string | null;
}): Promise<{
  messageId: string;
  chatId: string;
}> {
  const account = resolveWechatLinuxAccount({ cfg: params.cfg, accountId: params.accountId });
  const resolved = await resolveWechatLinuxOutboundTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    target: params.to,
  });
  const result = await sendWechatLinuxBridgeText({
    account,
    chatId: resolved.chatId,
    text: params.text,
  });
  noteRecentWechatLinuxOutbound(account.accountId, result.matched_local_id);
  return {
    messageId: result.matched_local_id ? String(result.matched_local_id) : "",
    chatId: resolved.chatId,
  };
}

export async function sendWechatLinuxMedia(params: {
  cfg: CoreConfig;
  to: string;
  text: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string | null;
}): Promise<{
  messageId: string;
  chatId: string;
}> {
  const account = resolveWechatLinuxAccount({ cfg: params.cfg, accountId: params.accountId });
  const resolved = await resolveWechatLinuxOutboundTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    target: params.to,
  });
  const maxBytes = resolveWechatLinuxMediaMaxBytes(params.cfg, account);

  if (params.text.trim()) {
    await sendWechatLinuxText({
      cfg: params.cfg,
      to: resolved.chatId,
      text: params.text,
      accountId: account.accountId,
    });
  }

  const materialized = await materializeOutboundMedia({
    mediaUrl: params.mediaUrl,
    mediaLocalRoots: params.mediaLocalRoots,
    maxBytes,
  });
  try {
    const result = await sendWechatLinuxBridgeFile({
      account,
      chatId: resolved.chatId,
      path: materialized.tempPath,
      image: isImageContent(materialized.fileName, materialized.contentType),
    });
    noteRecentWechatLinuxOutbound(account.accountId, result.matched_local_id);
    return {
      messageId: result.matched_local_id ? String(result.matched_local_id) : "",
      chatId: resolved.chatId,
    };
  } finally {
    await cleanupTempDir(materialized.tempDir);
  }
}

export function resolveWechatLinuxTextChunkLimit(
  cfg: CoreConfig,
  accountId?: string | null,
): number {
  return resolveTextChunkLimit(cfg, "wechat-linux", accountId ?? undefined, {
    fallbackLimit: 3500,
  });
}

export const emptyWechatLinuxResult = createEmptyChannelResult("wechat-linux");
