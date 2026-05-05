import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildCanonicalSentMessageHookContext,
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  chunkMarkdownTextWithMode,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  type ChunkMode,
} from "openclaw/plugin-sdk/reply-chunking";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { buildSlackBlocksFallbackText } from "../blocks-fallback.js";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackReplyBlocks } from "../reply-blocks.js";
import { truncateSlackText } from "../truncate.js";
import { sendMessageSlack, type SlackSendIdentity } from "./send.runtime.js";

export type SlackMessageSentHookParams = {
  sessionKeyForInternalHooks?: string;
  target: string;
  accountId?: string;
  content: string;
  success: boolean;
  error?: string;
  messageId?: string;
};

export function resolveSlackSentHookContent(
  content: string,
  slackBlocks?: ReturnType<typeof readSlackReplyBlocks>,
): string {
  const fallback = slackBlocks?.length ? buildSlackBlocksFallbackText(slackBlocks) : "";
  return truncateSlackText(content || fallback, SLACK_TEXT_LIMIT);
}

export function emitSlackMessageSentHooks(params: SlackMessageSentHookParams): void {
  const hookRunner = getGlobalHookRunner();
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  if (!hasMessageSentHooks && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildCanonicalSentMessageHookContext({
    to: params.target,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "slack",
    accountId: params.accountId,
    conversationId: params.target,
    sessionKey: params.sessionKeyForInternalHooks,
    messageId: params.messageId,
  });
  if (hasMessageSentHooks) {
    fireAndForgetHook(
      Promise.resolve(
        hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "slack: message_sent plugin hook failed",
    );
  }
  if (!params.sessionKeyForInternalHooks) {
    return;
  }
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "slack: message:sent internal hook failed",
  );
}

export function readSlackReplyBlocks(payload: ReplyPayload) {
  return resolveSlackReplyBlocks(payload);
}

export function resolveDeliveredSlackReplyThreadTs(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  payloadReplyToId?: string;
  replyThreadTs?: string;
}): string | undefined {
  // Keep reply tags opt-in: when replyToMode is off, explicit reply tags
  // must not force threading.
  const inlineReplyToId = params.replyToMode === "off" ? undefined : params.payloadReplyToId;
  return inlineReplyToId ?? params.replyThreadTs;
}

export async function deliverReplies(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  runtime: RuntimeEnv;
  textLimit: number;
  replyThreadTs?: string;
  replyToMode: "off" | "first" | "all" | "batched";
  identity?: SlackSendIdentity;
}) {
  const sendWithSentHook = async (
    content: string,
    opts: Parameters<typeof sendMessageSlack>[2],
    hookContent = content,
  ) => {
    try {
      const result = await sendMessageSlack(params.target, content, opts);
      emitSlackMessageSentHooks({
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        target: params.target,
        accountId: params.accountId,
        content: hookContent,
        success: true,
        messageId: result?.messageId,
      });
      return result;
    } catch (err) {
      emitSlackMessageSentHooks({
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        target: params.target,
        accountId: params.accountId,
        content: hookContent,
        success: false,
        error: formatErrorMessage(err),
      });
      throw err;
    }
  };
  for (const payload of params.replies) {
    const threadTs = resolveDeliveredSlackReplyThreadTs({
      replyToMode: params.replyToMode,
      payloadReplyToId: payload.replyToId,
      replyThreadTs: params.replyThreadTs,
    });
    const reply = resolveSendableOutboundReplyParts(payload);
    const slackBlocks = readSlackReplyBlocks(payload);
    if (!reply.hasContent && !slackBlocks?.length) {
      continue;
    }

    if (!reply.hasMedia && slackBlocks?.length) {
      const trimmed = reply.trimmedText;
      if (!trimmed && !slackBlocks?.length) {
        continue;
      }
      if (trimmed && isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
        continue;
      }
      await sendWithSentHook(
        trimmed,
        {
          cfg: params.cfg,
          token: params.token,
          threadTs,
          accountId: params.accountId,
          ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
          ...(params.identity ? { identity: params.identity } : {}),
        },
        resolveSlackSentHookContent(trimmed, slackBlocks),
      );
      params.runtime.log?.(`delivered reply to ${params.target}`);
      continue;
    }

    const delivered = await deliverTextOrMediaReply({
      payload,
      text: reply.text,
      chunkText: !reply.hasMedia
        ? (value) => {
            const trimmed = value.trim();
            if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
              return [];
            }
            return [trimmed];
          }
        : undefined,
      sendText: async (trimmed) => {
        await sendWithSentHook(trimmed, {
          cfg: params.cfg,
          token: params.token,
          threadTs,
          accountId: params.accountId,
          ...(params.identity ? { identity: params.identity } : {}),
        });
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        await sendWithSentHook(caption ?? "", {
          cfg: params.cfg,
          token: params.token,
          mediaUrl,
          threadTs,
          accountId: params.accountId,
          ...(params.identity ? { identity: params.identity } : {}),
        });
      },
    });
    if (delivered !== "empty") {
      params.runtime.log?.(`delivered reply to ${params.target}`);
    }
  }
}

export type SlackRespondFn = (payload: {
  text: string;
  blocks?: ReturnType<typeof readSlackReplyBlocks>;
  response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;

/**
 * Compute effective threadTs for a Slack reply based on replyToMode.
 * - "off": stay in thread if already in one, otherwise main channel
 * - "first": first reply goes to thread, subsequent replies to main channel
 * - "all": all replies go to thread
 */
export function resolveSlackThreadTs(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied: boolean;
  isThreadReply?: boolean;
}): string | undefined {
  const planner = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasReplied,
    isThreadReply: params.isThreadReply,
  });
  return planner.use();
}

type SlackReplyDeliveryPlan = {
  peekThreadTs: () => string | undefined;
  nextThreadTs: () => string | undefined;
  markSent: () => void;
};

function createSlackReplyReferencePlanner(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied?: boolean;
  isThreadReply?: boolean;
}) {
  // Older/internal callers may not pass explicit thread classification. Keep
  // genuine thread replies sticky, but do not let Slack's auto-populated
  // top-level thread_ts override the configured replyToMode.
  const effectiveIsThreadReply =
    params.isThreadReply ??
    Boolean(params.incomingThreadTs && params.incomingThreadTs !== params.messageTs);
  const effectiveMode = effectiveIsThreadReply ? "all" : params.replyToMode;
  return createReplyReferencePlanner({
    replyToMode: effectiveMode,
    existingId: params.incomingThreadTs,
    startId: params.messageTs,
    hasReplied: params.hasReplied,
  });
}

export function createSlackReplyDeliveryPlan(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasRepliedRef: { value: boolean };
  isThreadReply?: boolean;
}): SlackReplyDeliveryPlan {
  const replyReference = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasRepliedRef.value,
    isThreadReply: params.isThreadReply,
  });
  return {
    peekThreadTs: () => replyReference.peek(),
    nextThreadTs: () => replyReference.use(),
    markSent: () => {
      replyReference.markSent();
      params.hasRepliedRef.value = replyReference.hasReplied();
    },
  };
}

export async function deliverSlackSlashReplies(params: {
  replies: ReplyPayload[];
  respond: SlackRespondFn;
  ephemeral: boolean;
  textLimit: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
}) {
  const messages: Array<{ text: string; blocks?: ReturnType<typeof readSlackReplyBlocks> }> = [];
  const chunkLimit = Math.min(params.textLimit, SLACK_TEXT_LIMIT);
  for (const payload of params.replies) {
    const reply = resolveSendableOutboundReplyParts(payload);
    const slackBlocks = readSlackReplyBlocks(payload);
    const text =
      reply.hasText && !isSilentReplyText(reply.trimmedText, SILENT_REPLY_TOKEN)
        ? reply.trimmedText
        : undefined;
    if (slackBlocks?.length && !reply.hasMedia) {
      messages.push({ text: text ?? "", blocks: slackBlocks });
      continue;
    }
    const combined = [text ?? "", ...reply.mediaUrls].filter(Boolean).join("\n");
    if (!combined) {
      continue;
    }
    const chunkMode = params.chunkMode ?? "length";
    const markdownChunks =
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode)
        : [combined];
    const chunks = markdownChunks.flatMap((markdown) =>
      markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode }),
    );
    if (!chunks.length && combined) {
      chunks.push(combined);
    }
    for (const chunk of chunks) {
      messages.push({ text: chunk });
    }
  }

  if (messages.length === 0) {
    return;
  }

  // Slack slash command responses can be multi-part by sending follow-ups via response_url.
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  for (const message of messages) {
    await params.respond({ ...message, response_type: responseType });
  }
}
