import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  deliverTextOrMediaReply,
  isReasoningReplyPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentScopedOutboundMediaAccess } from "./runtime-api.js";

type MarkdownTableMode = Parameters<PluginRuntime["channel"]["text"]["convertMarkdownTables"]>[1];

type SendMattermostMessage = (
  to: string,
  text: string,
  opts: {
    cfg: OpenClawConfig;
    accountId?: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    replyToId?: string;
  },
) => Promise<unknown>;

/**
 * Result of `deliverMattermostReplyPayload`. Callers in `monitor.ts` use this
 * to distinguish a successful visible send from an intentionally suppressed
 * reasoning payload from a substantive payload that ended up sending nothing
 * (the silent-completion symptom in #80501).
 */
export type MattermostReplyDeliveryOutcome = "reasoning_skipped" | "empty" | "text" | "media";

export async function deliverMattermostReplyPayload(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  payload: ReplyPayload;
  to: string;
  accountId: string;
  agentId?: string;
  replyToId?: string;
  textLimit: number;
  tableMode: MarkdownTableMode;
  sendMessage: SendMattermostMessage;
}): Promise<MattermostReplyDeliveryOutcome> {
  if (isReasoningReplyPayload(params.payload)) {
    return "reasoning_skipped";
  }
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.core.channel.text.convertMarkdownTables(
      params.payload.text ?? "",
      params.tableMode,
    ),
  });
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const chunkMode = params.core.channel.text.resolveChunkMode(
    params.cfg,
    "mattermost",
    params.accountId,
  );
  return await deliverTextOrMediaReply({
    payload: params.payload,
    text: reply.text,
    chunkText: (value) =>
      params.core.channel.text.chunkMarkdownTextWithMode(value, params.textLimit, chunkMode),
    sendText: async (chunk) => {
      await params.sendMessage(params.to, chunk, {
        cfg: params.cfg,
        accountId: params.accountId,
        replyToId: params.replyToId,
      });
    },
    sendMedia: async ({ mediaUrl, caption }) => {
      await params.sendMessage(params.to, caption ?? "", {
        cfg: params.cfg,
        accountId: params.accountId,
        mediaUrl,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile: mediaAccess.readFile,
        replyToId: params.replyToId,
      });
    },
  });
}
