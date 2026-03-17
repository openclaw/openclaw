import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit
} from "../../../src/auto-reply/chunk.js";
import { isSilentReplyText } from "../../../src/auto-reply/tokens.js";
import { loadConfig } from "../../../src/config/config.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import { logVerbose } from "../../../src/globals.js";
import {
  fetchWithSsrFGuard,
  withTrustedEnvProxyGuardedFetchMode
} from "../../../src/infra/net/fetch-guard.js";
import { loadWebMedia } from "../../whatsapp/src/media.js";
import { resolveSlackAccount } from "./accounts.js";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
import { validateSlackBlocksArray } from "./blocks-input.js";
import { createSlackWebClient } from "./client.js";
import { markdownToSlackMrkdwnChunks } from "./format.js";
import { parseSlackTarget } from "./targets.js";
import { resolveSlackBotToken } from "./token.js";
const SLACK_TEXT_LIMIT = 4e3;
const SLACK_UPLOAD_SSRF_POLICY = {
  allowedHostnames: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  allowRfc2544BenchmarkRange: true
};
function hasCustomIdentity(identity) {
  return Boolean(identity?.username || identity?.iconUrl || identity?.iconEmoji);
}
function isSlackCustomizeScopeError(err) {
  if (!(err instanceof Error)) {
    return false;
  }
  const maybeData = err;
  const code = maybeData.data?.error?.toLowerCase();
  if (code !== "missing_scope") {
    return false;
  }
  const needed = maybeData.data?.needed?.toLowerCase();
  if (needed?.includes("chat:write.customize")) {
    return true;
  }
  const scopes = [
    ...maybeData.data?.response_metadata?.scopes ?? [],
    ...maybeData.data?.response_metadata?.acceptedScopes ?? []
  ].map((scope) => scope.toLowerCase());
  return scopes.includes("chat:write.customize");
}
async function postSlackMessageBestEffort(params) {
  const basePayload = {
    channel: params.channelId,
    text: params.text,
    thread_ts: params.threadTs,
    ...params.blocks?.length ? { blocks: params.blocks } : {}
  };
  try {
    if (params.identity?.iconUrl) {
      return await params.client.chat.postMessage({
        ...basePayload,
        ...params.identity.username ? { username: params.identity.username } : {},
        icon_url: params.identity.iconUrl
      });
    }
    if (params.identity?.iconEmoji) {
      return await params.client.chat.postMessage({
        ...basePayload,
        ...params.identity.username ? { username: params.identity.username } : {},
        icon_emoji: params.identity.iconEmoji
      });
    }
    return await params.client.chat.postMessage({
      ...basePayload,
      ...params.identity?.username ? { username: params.identity.username } : {}
    });
  } catch (err) {
    if (!hasCustomIdentity(params.identity) || !isSlackCustomizeScopeError(err)) {
      throw err;
    }
    logVerbose("slack send: missing chat:write.customize, retrying without custom identity");
    return params.client.chat.postMessage(basePayload);
  }
}
function resolveToken(params) {
  const explicit = resolveSlackBotToken(params.explicit);
  if (explicit) {
    return explicit;
  }
  const fallback = resolveSlackBotToken(params.fallbackToken);
  if (!fallback) {
    logVerbose(
      `slack send: missing bot token for account=${params.accountId} explicit=${Boolean(
        params.explicit
      )} source=${params.fallbackSource ?? "unknown"}`
    );
    throw new Error(
      `Slack bot token missing for account "${params.accountId}" (set channels.slack.accounts.${params.accountId}.botToken or SLACK_BOT_TOKEN for default).`
    );
  }
  return fallback;
}
function parseRecipient(raw) {
  const target = parseSlackTarget(raw);
  if (!target) {
    throw new Error("Recipient is required for Slack sends");
  }
  return { kind: target.kind, id: target.id };
}
async function resolveChannelId(client, recipient) {
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
async function uploadSlackFile(params) {
  const { buffer, contentType, fileName } = await loadWebMedia(params.mediaUrl, {
    maxBytes: params.maxBytes,
    localRoots: params.mediaLocalRoots
  });
  const uploadUrlResp = await params.client.files.getUploadURLExternal({
    filename: fileName ?? "upload",
    length: buffer.length
  });
  if (!uploadUrlResp.ok || !uploadUrlResp.upload_url || !uploadUrlResp.file_id) {
    throw new Error(`Failed to get upload URL: ${uploadUrlResp.error ?? "unknown error"}`);
  }
  const uploadBody = new Uint8Array(buffer);
  const { response: uploadResp, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
      url: uploadUrlResp.upload_url,
      init: {
        method: "POST",
        ...contentType ? { headers: { "Content-Type": contentType } } : {},
        body: uploadBody
      },
      policy: SLACK_UPLOAD_SSRF_POLICY,
      auditContext: "slack-upload-file"
    })
  );
  try {
    if (!uploadResp.ok) {
      throw new Error(`Failed to upload file: HTTP ${uploadResp.status}`);
    }
  } finally {
    await release();
  }
  const completeResp = await params.client.files.completeUploadExternal({
    files: [{ id: uploadUrlResp.file_id, title: fileName ?? "upload" }],
    channel_id: params.channelId,
    ...params.caption ? { initial_comment: params.caption } : {},
    ...params.threadTs ? { thread_ts: params.threadTs } : {}
  });
  if (!completeResp.ok) {
    throw new Error(`Failed to complete upload: ${completeResp.error ?? "unknown error"}`);
  }
  return uploadUrlResp.file_id;
}
async function sendMessageSlack(to, message, opts = {}) {
  const trimmedMessage = message?.trim() ?? "";
  if (isSilentReplyText(trimmedMessage) && !opts.mediaUrl && !opts.blocks) {
    logVerbose("slack send: suppressed NO_REPLY token before API call");
    return { messageId: "suppressed", channelId: "" };
  }
  const blocks = opts.blocks == null ? void 0 : validateSlackBlocksArray(opts.blocks);
  if (!trimmedMessage && !opts.mediaUrl && !blocks) {
    throw new Error("Slack send requires text, blocks, or media");
  }
  const cfg = opts.cfg ?? loadConfig();
  const account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId
  });
  const token = resolveToken({
    explicit: opts.token,
    accountId: account.accountId,
    fallbackToken: account.botToken,
    fallbackSource: account.botTokenSource
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
      blocks
    });
    return {
      messageId: response.ts ?? "unknown",
      channelId
    };
  }
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId);
  const chunkLimit = Math.min(textLimit, SLACK_TEXT_LIMIT);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "slack",
    accountId: account.accountId
  });
  const chunkMode = resolveChunkMode(cfg, "slack", account.accountId);
  const markdownChunks = chunkMode === "newline" ? chunkMarkdownTextWithMode(trimmedMessage, chunkLimit, chunkMode) : [trimmedMessage];
  const chunks = markdownChunks.flatMap(
    (markdown) => markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode })
  );
  if (!chunks.length && trimmedMessage) {
    chunks.push(trimmedMessage);
  }
  const mediaMaxBytes = typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb * 1024 * 1024 : void 0;
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
      maxBytes: mediaMaxBytes
    });
    for (const chunk of rest) {
      const response = await postSlackMessageBestEffort({
        client,
        channelId,
        text: chunk,
        threadTs: opts.threadTs,
        identity: opts.identity
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  } else {
    for (const chunk of chunks.length ? chunks : [""]) {
      const response = await postSlackMessageBestEffort({
        client,
        channelId,
        text: chunk,
        threadTs: opts.threadTs,
        identity: opts.identity
      });
      lastMessageId = response.ts ?? lastMessageId;
    }
  }
  return {
    messageId: lastMessageId || "unknown",
    channelId
  };
}
export {
  sendMessageSlack
};
