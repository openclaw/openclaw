import { deliverTextOrMediaReply } from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig, PluginRuntime, ReplyPayload } from "../runtime-api.js";
import { getAgentScopedMediaLocalRoots } from "../runtime-api.js";

type MarkdownTableMode = Parameters<PluginRuntime["channel"]["text"]["convertMarkdownTables"]>[1];

type SendMattermostMessage = (
  to: string,
  text: string,
  opts: {
    accountId?: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    replyToId?: string;
  },
) => Promise<unknown>;

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
}): Promise<void> {
  const text = params.core.channel.text.convertMarkdownTables(
    params.payload.text ?? "",
    params.tableMode,
  );
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
  const chunkMode = params.core.channel.text.resolveChunkMode(
    params.cfg,
    "mattermost",
    params.accountId,
  );
  await deliverTextOrMediaReply({
    payload: params.payload,
    text,
    chunkText: (value) =>
      params.core.channel.text.chunkMarkdownTextWithMode(value, params.textLimit, chunkMode),
    sendText: async (chunk) => {
      await params.sendMessage(params.to, chunk, {
        accountId: params.accountId,
        replyToId: params.replyToId,
      });
    },
    sendMedia: async ({ mediaUrl, caption }) => {
      await params.sendMessage(params.to, caption ?? "", {
        accountId: params.accountId,
        mediaUrl,
        mediaLocalRoots,
        replyToId: params.replyToId,
      });
    },
  });
}
