import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { deliverTextOrMediaReply } from "openclaw/plugin-sdk/reply-payload";
import type { MarkdownTableMode, ReplyPayload, RuntimeEnv } from "../../../runtime-api.js";
import { getMatrixRuntime } from "../../runtime.js";
import { sendMessageMatrix } from "../send.js";

export async function deliverMatrixReplies(params: {
  replies: ReplyPayload[];
  roomId: string;
  client: MatrixClient;
  runtime: RuntimeEnv;
  textLimit: number;
  replyToMode: "off" | "first" | "all";
  threadId?: string;
  accountId?: string;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const core = getMatrixRuntime();
  const cfg = core.config.loadConfig();
  const tableMode =
    params.tableMode ??
    core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "matrix",
      accountId: params.accountId,
    });
  const logVerbose = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      params.runtime.log?.(message);
    }
  };
  const chunkLimit = Math.min(params.textLimit, 4000);
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "matrix", params.accountId);
  let hasReplied = false;
  for (const reply of params.replies) {
    const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("matrix reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.("matrix reply missing text/media");
      continue;
    }
    // Skip pure reasoning messages so internal thinking traces are never delivered.
    if (reply.text && isReasoningOnlyMessage(reply.text)) {
      logVerbose("matrix reply is reasoning-only; skipping");
      continue;
    }
    const replyToIdRaw = reply.replyToId?.trim();
    const replyToId = params.threadId || params.replyToMode === "off" ? undefined : replyToIdRaw;
    const rawText = reply.text ?? "";
    const text = core.channel.text.convertMarkdownTables(rawText, tableMode);
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];

    const shouldIncludeReply = (id?: string) =>
      Boolean(id) && (params.replyToMode === "all" || !hasReplied);
    const replyToIdForReply = shouldIncludeReply(replyToId) ? replyToId : undefined;

    const delivered = await deliverTextOrMediaReply({
      payload: reply,
      text,
      chunkText: (value) =>
        core.channel.text
          .chunkMarkdownTextWithMode(value, chunkLimit, chunkMode)
          .map((chunk) => chunk.trim())
          .filter(Boolean),
      sendText: async (trimmed) => {
        await sendMessageMatrix(params.roomId, trimmed, {
          client: params.client,
          replyToId: replyToIdForReply,
          threadId: params.threadId,
          accountId: params.accountId,
        });
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        await sendMessageMatrix(params.roomId, caption ?? "", {
          client: params.client,
          mediaUrl,
          replyToId: replyToIdForReply,
          threadId: params.threadId,
          audioAsVoice: reply.audioAsVoice,
          accountId: params.accountId,
        });
      },
    });
    if (replyToIdForReply && !hasReplied && delivered !== "empty") {
      hasReplied = true;
    }
  }
}

const REASONING_PREFIX = "Reasoning:\n";
const THINKING_TAG_RE = /^\s*<\s*(?:think(?:ing)?|thought|antthinking)\b/i;

/**
 * Detect messages that contain only reasoning/thinking content and no user-facing answer.
 * These are emitted by the agent when `includeReasoning` is active but should not
 * be forwarded to channels that do not support a dedicated reasoning lane.
 */
function isReasoningOnlyMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith(REASONING_PREFIX)) {
    return true;
  }
  if (THINKING_TAG_RE.test(trimmed)) {
    return true;
  }
  return false;
}
