import type { ChunkMode } from "../../../../src/auto-reply/chunk.js";
import { chunkMarkdownTextWithMode } from "../../../../src/auto-reply/chunk.js";
import { createReplyReferencePlanner } from "../../../../src/auto-reply/reply/reply-reference.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../../src/auto-reply/tokens.js";
import type { ReplyPayload } from "../../../../src/auto-reply/types.js";
import type { MarkdownTableMode } from "../../../../src/config/types.base.js";
import type { RuntimeEnv } from "../../../../src/runtime.js";
import { parseSlackBlocksInput } from "../blocks-input.js";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { sendMessageSlack, type SlackSendIdentity } from "../send.js";

export function readSlackReplyBlocks(payload: ReplyPayload) {
  const slackData = payload.channelData?.slack;
  if (!slackData || typeof slackData !== "object" || Array.isArray(slackData)) {
    return undefined;
  }
  try {
    return parseSlackBlocksInput((slackData as { blocks?: unknown }).blocks);
  } catch {
    return undefined;
  }
}

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  runtime: RuntimeEnv;
  textLimit: number;
  replyThreadTs?: string;
  replyToMode: "off" | "first" | "all";
  identity?: SlackSendIdentity;
}) {
  for (const payload of params.replies) {
    // Keep reply tags opt-in: when replyToMode is off, explicit reply tags
    // must not force threading.
    const inlineReplyToId = params.replyToMode === "off" ? undefined : payload.replyToId;
    const threadTs = inlineReplyToId ?? params.replyThreadTs;
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    const slackBlocks = readSlackReplyBlocks(payload);
    if (!text && mediaList.length === 0 && !slackBlocks?.length) {
      continue;
    }

    if (mediaList.length === 0) {
      const trimmed = text.trim();
      if (!trimmed && !slackBlocks?.length) {
        continue;
      }
      if (trimmed && isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
        continue;
      }
      await sendMessageSlack(params.target, trimmed, {
        token: params.token,
        threadTs,
        accountId: params.accountId,
        ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
        ...(params.identity ? { identity: params.identity } : {}),
      });
    } else {
      let first = true;
      for (const mediaUrl of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageSlack(params.target, caption, {
          token: params.token,
          mediaUrl,
          threadTs,
          accountId: params.accountId,
          ...(params.identity ? { identity: params.identity } : {}),
        });
      }
    }
    params.runtime.log?.(`delivered reply to ${params.target}`);
  }
}

export type SlackRespondFn = (payload: {
  text: string;
  response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;

/**
 * Compute effective threadTs for a Slack reply based on replyToMode.
 * - "off": stay in thread if already in one, otherwise main channel
 * - "first": first reply goes to thread, subsequent replies to main channel
 * - "all": all replies go to thread
 */
export function resolveSlackThreadTs(params: {
  replyToMode: "off" | "first" | "all";
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
  nextThreadTs: () => string | undefined;
  markSent: () => void;
};

function createSlackReplyReferencePlanner(params: {
  replyToMode: "off" | "first" | "all";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied?: boolean;
  isThreadReply?: boolean;
}) {
  // Keep backward-compatible behavior: when a thread id is present and caller
  // does not provide explicit classification, stay in thread. Callers that can
  // distinguish Slack's auto-populated top-level thread_ts should pass
  // `isThreadReply: false` to preserve replyToMode behavior.
  const effectiveIsThreadReply = params.isThreadReply ?? Boolean(params.incomingThreadTs);
  const effectiveMode = effectiveIsThreadReply ? "all" : params.replyToMode;
  return createReplyReferencePlanner({
    replyToMode: effectiveMode,
    existingId: params.incomingThreadTs,
    startId: params.messageTs,
    hasReplied: params.hasReplied,
  });
}

export function createSlackReplyDeliveryPlan(params: {
  replyToMode: "off" | "first" | "all";
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
  const messages: string[] = [];
  const chunkLimit = Math.min(params.textLimit, 4000);
  for (const payload of params.replies) {
    const textRaw = payload.text?.trim() ?? "";
    const text = textRaw && !isSilentReplyText(textRaw, SILENT_REPLY_TOKEN) ? textRaw : undefined;
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const combined = [text ?? "", ...mediaList.map((url) => url.trim()).filter(Boolean)]
      .filter(Boolean)
      .join("\n");
    if (!combined) {
      continue;
    }
    const chunkMode = params.chunkMode ?? "length";
    const markdownChunks =
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode)
        : [combined];
    // Slash replies use response_url which doesn't support Block Kit table
    // attachments.  Fall back to "code" mode so table content isn't silently
    // dropped when the default table mode is "block".
    const effectiveTableMode = params.tableMode === "block" ? "code" : params.tableMode;
    const chunks = markdownChunks.flatMap((markdown) =>
      markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: effectiveTableMode }),
    );
    if (!chunks.length && combined) {
      chunks.push(combined);
    }
    for (const chunk of chunks) {
      messages.push(chunk);
    }
  }

  if (messages.length === 0) {
    return;
  }

  // Slack slash command responses can be multi-part by sending follow-ups via response_url.
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  for (const text of messages) {
    await params.respond({ text, response_type: responseType });
  }
}
