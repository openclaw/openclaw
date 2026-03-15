import { type Block, type KnownBlock, type WebClient } from "@slack/web-api";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../../src/auto-reply/chunk.js";
import { isSilentReplyText } from "../../../src/auto-reply/tokens.js";
import { loadConfig, type OpenClawConfig } from "../../../src/config/config.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import { logVerbose } from "../../../src/globals.js";
import {
  fetchWithSsrFGuard,
  withTrustedEnvProxyGuardedFetchMode,
} from "../../../src/infra/net/fetch-guard.js";
import { loadWebMedia } from "../../whatsapp/src/media.js";
import type { SlackTokenSource } from "./accounts.js";
import { resolveSlackAccount } from "./accounts.js";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
import { validateSlackBlocksArray } from "./blocks-input.js";
import { createSlackWebClient } from "./client.js";
import { markdownToSlackMrkdwnChunks, markdownToSlackMrkdwnWithTables } from "./format.js";
import { markdownTablesToBlockKitAttachment } from "./block-kit-tables.js";
import { parseSlackTarget } from "./targets.js";
import { resolveSlackBotToken } from "./token.js";

const SLACK_TEXT_LIMIT = 4000;
const SLACK_UPLOAD_SSRF_POLICY = {
  allowedHostnames: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  allowRfc2544BenchmarkRange: true,
};

type SlackRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

export type SlackSendIdentity = {
  username?: string;
  iconUrl?: string;
  iconEmoji?: string;
};

type SlackSendOpts = {
  cfg?: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  client?: WebClient;
  threadTs?: string;
  identity?: SlackSendIdentity;
  blocks?: (Block | KnownBlock)[];
};

function hasCustomIdentity(identity?: SlackSendIdentity): boolean {
  return Boolean(identity?.username || identity?.iconUrl || identity?.iconEmoji);
}

function isSlackCustomizeScopeError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const maybeData = err as Error & {
    data?: {
      error?: string;
      needed?: string;
      response_metadata?: { scopes?: string[]; acceptedScopes?: string[] };
    };
  };
  const code = maybeData.data?.error?.toLowerCase();
  if (code !== "missing_scope") {
    return false;
  }
  const needed = maybeData.data?.needed?.toLowerCase();
  if (needed?.includes("chat:write.customize")) {
    return true;
  }
  const scopes = [
    ...(maybeData.data?.response_metadata?.scopes ?? []),
    ...(maybeData.data?.response_metadata?.acceptedScopes ?? []),
  ].map((scope) => scope.toLowerCase());
  return scopes.includes("chat:write.customize");
}

async function postSlackMessageBestEffort(params: {
  client: WebClient;
  channelId: string;
  text: string;
  threadTs?: string;
  identity?: SlackSendIdentity;
  blocks?: (Block | KnownBlock)[];
  attachments?: Record<string, unknown>[];
}) {
  const basePayload = {
    channel: params.channelId,
    text: params.text,
    thread_ts: params.threadTs,
    ...(params.blocks?.length ? { blocks: params.blocks } : {}),
    ...(params.attachments?.length ? { attachments: params.attachments } : {}),
  };
  try {
    // Slack Web API types model icon_url and icon_emoji as mutually exclusive.
    // Build payloads in explicit branches so TS and runtime stay aligned.
    if (params.identity?.iconUrl) {
      return await params.client.chat.postMessage({
        ...basePayload,
        ...(params.identity.username ? { username: params.identity.username } : {}),
        icon_url: params.identity.iconUrl,
      });
    }
    if (params.identity?.iconEmoji) {
      return await params.client.chat.postMessage({
        ...basePayload,
        ...(params.identity.username ? { username: params.identity.username } : {}),
        icon_emoji: params.identity.iconEmoji,
      });
    }
    return await params.client.chat.postMessage({
      ...basePayload,
      ...(params.identity?.username ? { username: params.identity.username } : {}),
    });
  } catch (err) {
    if (!hasCustomIdentity(params.identity) || !isSlackCustomizeScopeError(err)) {
      throw err;
    }
    logVerbose("slack send: missing chat:write.customize, retrying without custom identity");
    return params.client.chat.postMessage(basePayload);
  }
}

export type SlackSendResult = {
  messageId: string;
  channelId: string;
};

function resolveToken(params: {
  explicit?: string;
  accountId: string;
  fallbackToken?: string;
  fallbackSource?: SlackTokenSource;
}) {
  const explicit = resolveSlackBotToken(params.explicit);
  if (explicit) {
    return explicit;
  }
  const fallback = resolveSlackBotToken(params.fallbackToken);
  if (!fallback) {
    logVerbose(
      `slack send: missing bot token for account=${params.accountId} explicit=${Boolean(
        params.explicit,
      )} source=${params.fallbackSource ?? "unknown"}`,
    );
    throw new Error(
      `Slack bot token missing for account "${params.accountId}" (set channels.slack.accounts.${params.accountId}.botToken or SLACK_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

function parseRecipient(raw: string): SlackRecipient {
  const target = parseSlackTarget(raw);
  if (!target) {
    throw new Error("Recipient is required for Slack sends");
  }
  return { kind: target.kind, id: target.id };
}

async function resolveChannelId(
  client: WebClient,
  recipient: SlackRecipient,
): Promise<{ channelId: string; isDm?: boolean }> {
  // Bare Slack user IDs (U-prefix) may arrive with kind="channel" when the
  // target string had no explicit prefix (parseSlackTarget defaults bare IDs
  // to "channel"). chat.postMessage tolerates user IDs directly, but
  // files.uploadV2 → completeUploadExternal validates channel_id against
  // ^[CGDZ][A-Z0-9]{8,}$ and rejects U-prefixed IDs.  Always resolve user
  // IDs via conversations.open to obtain the DM channel ID.
  const isUserId = recipient.kind === "user" || /^U[A-Z0-9]+$/i.test(recipient.id);
  if (!isUserId) {
    return { channelId: recipient.id };
  }
  const response = await client.conversations.open({ users: recipient.id });
  const channelId = response.channel?.id;
  if (!channelId) {
    throw new Error("Failed to open Slack DM channel");
  }
  return { channelId, isDm: true };
}

async function uploadSlackFile(params: {
  client: WebClient;
  channelId: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  caption?: string;
  threadTs?: string;
  maxBytes?: number;
}): Promise<string> {
  const { buffer, contentType, fileName } = await loadWebMedia(params.mediaUrl, {
    maxBytes: params.maxBytes,
    localRoots: params.mediaLocalRoots,
  });
  // Use the 3-step upload flow (getUploadURLExternal -> POST -> completeUploadExternal)
  // instead of files.uploadV2 which relies on the deprecated files.upload endpoint
  // and can fail with missing_scope even when files:write is granted.
  const uploadUrlResp = await params.client.files.getUploadURLExternal({
    filename: fileName ?? "upload",
    length: buffer.length,
  });
  if (!uploadUrlResp.ok || !uploadUrlResp.upload_url || !uploadUrlResp.file_id) {
    throw new Error(`Failed to get upload URL: ${uploadUrlResp.error ?? "unknown error"}`);
  }

  // Upload the file content to the presigned URL
  const uploadBody = new Uint8Array(buffer) as BodyInit;
  const { response: uploadResp, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
      url: uploadUrlResp.upload_url,
      init: {
        method: "POST",
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
        body: uploadBody,
      },
      policy: SLACK_UPLOAD_SSRF_POLICY,
      auditContext: "slack-upload-file",
    }),
  );
  try {
    if (!uploadResp.ok) {
      throw new Error(`Failed to upload file: HTTP ${uploadResp.status}`);
    }
  } finally {
    await release();
  }

  // Complete the upload and share to channel/thread
  const completeResp = await params.client.files.completeUploadExternal({
    files: [{ id: uploadUrlResp.file_id, title: fileName ?? "upload" }],
    channel_id: params.channelId,
    ...(params.caption ? { initial_comment: params.caption } : {}),
    ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
  });
  if (!completeResp.ok) {
    throw new Error(`Failed to complete upload: ${completeResp.error ?? "unknown error"}`);
  }

  return uploadUrlResp.file_id;
}

export async function sendMessageSlack(
  to: string,
  message: string,
  opts: SlackSendOpts = {},
): Promise<SlackSendResult> {
  const trimmedMessage = message?.trim() ?? "";
  if (isSilentReplyText(trimmedMessage) && !opts.mediaUrl && !opts.blocks) {
    logVerbose("slack send: suppressed NO_REPLY token before API call");
    return { messageId: "suppressed", channelId: "" };
  }
  const blocks = opts.blocks == null ? undefined : validateSlackBlocksArray(opts.blocks);
  if (!trimmedMessage && !opts.mediaUrl && !blocks) {
    throw new Error("Slack send requires text, blocks, or media");
  }
  const cfg = opts.cfg ?? loadConfig();
  const account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken({
    explicit: opts.token,
    accountId: account.accountId,
    fallbackToken: account.botToken,
    fallbackSource: account.botTokenSource,
  });
  const client = opts.client ?? createSlackWebClient(token);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(client, recipient);
  if (blocks) {
    if (opts.mediaUrl) {
      throw new Error("Slack send does not support blocks with mediaUrl");
    }
    const fallbackText = trimmedMessage || buildSlackBlocksFallbackText(blocks);
    const response = await postSlackMessageBestEffort({
      client,
      channelId,
      text: fallbackText,
      threadTs: opts.threadTs,
      identity: opts.identity,
      blocks,
    });
    return {
      messageId: response.ts ?? "unknown",
      channelId,
    };
  }
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId);
  const chunkLimit = Math.min(textLimit, SLACK_TEXT_LIMIT);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "slack",
    accountId: account.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "slack", account.accountId);
  const markdownChunks =
    chunkMode === "newline"
      ? chunkMarkdownTextWithMode(trimmedMessage, chunkLimit, chunkMode)
      : [trimmedMessage];

  // When tableMode is "block", extract table data alongside text chunks
  // so we can send Block Kit table blocks as attachments.
  let tableAttachments: Record<string, unknown>[] | undefined;
  const chunks: string[] = [];

  if (tableMode === "block") {
    const allTables: import("../../../src/markdown/ir.js").MarkdownTableData[] = [];
    for (const markdown of markdownChunks) {
      const result = markdownToSlackMrkdwnWithTables(markdown, chunkLimit, { tableMode });
      chunks.push(...result.chunks);
      allTables.push(...result.tables);
    }
    if (allTables.length > 0) {
      tableAttachments = markdownTablesToBlockKitAttachment(allTables);
    }
  } else {
    chunks.push(
      ...markdownChunks.flatMap((markdown) =>
        markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode }),
      ),
    );
  }

  if (!chunks.length && trimmedMessage) {
    // When block-mode tables consumed all content, don't fall back to raw
    // pipe-delimited markdown — the tables will render via attachments.
    if (!(tableMode === "block" && tableAttachments?.length)) {
      chunks.push(trimmedMessage);
    }
  }
  const mediaMaxBytes =
    typeof account.config.mediaMaxMb === "number"
      ? account.config.mediaMaxMb * 1024 * 1024
      : undefined;

  let lastMessageId = "";
  if (opts.mediaUrl) {
    const [firstChunk, ...rest] = chunks;
    lastMessageId = await uploadSlackFile({
      client,
      channelId,
      mediaUrl: opts.mediaUrl,
      mediaLocalRoots: opts.mediaLocalRoots,
      caption: firstChunk,
      threadTs: opts.threadTs,
      maxBytes: mediaMaxBytes,
    });
    for (let i = 0; i < rest.length; i++) {
      const isLastChunk = i === rest.length - 1;
      const response = await postSlackMessageBestEffort({
        client,
        channelId,
        text: rest[i] ?? "",
        threadTs: opts.threadTs,
        identity: opts.identity,
        ...(isLastChunk && tableAttachments ? { attachments: tableAttachments } : {}),
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
    // If there were no follow-up chunks but we have table attachments,
    // send them as a separate message.
    if (rest.length === 0 && tableAttachments) {
      const response = await postSlackMessageBestEffort({
        client,
        channelId,
        text: "",
        threadTs: opts.threadTs,
        identity: opts.identity,
        attachments: tableAttachments,
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  } else {
    // Send text chunks. Attach Block Kit tables to the last chunk
    // so the table renders at the end of the message.
    const allChunks = chunks.length ? chunks : [""];
    for (let i = 0; i < allChunks.length; i++) {
      const isLastChunk = i === allChunks.length - 1;
      const response = await postSlackMessageBestEffort({
        client,
        channelId,
        text: allChunks[i] ?? "",
        threadTs: opts.threadTs,
        identity: opts.identity,
        ...(isLastChunk && tableAttachments ? { attachments: tableAttachments } : {}),
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  }

  return {
    messageId: lastMessageId || "unknown",
    channelId,
  };
}
