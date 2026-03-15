import type { OpenClawConfig, PluginRuntime, ReplyPayload } from "openclaw/plugin-sdk/mattermost";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/mattermost";

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
  const mediaUrls =
    params.payload.mediaUrls ?? (params.payload.mediaUrl ? [params.payload.mediaUrl] : []);
  const text = params.core.channel.text.convertMarkdownTables(
    params.payload.text ?? "",
    params.tableMode,
  );

  if (mediaUrls.length === 0) {
    const chunkMode = params.core.channel.text.resolveChunkMode(
      params.cfg,
      "mattermost",
      params.accountId,
    );
    const chunks = params.core.channel.text.chunkMarkdownTextWithMode(
      text,
      params.textLimit,
      chunkMode,
    );
    for (const chunk of chunks.length > 0 ? chunks : [text]) {
      if (!chunk) {
        continue;
      }
      await params.sendMessage(params.to, chunk, {
        accountId: params.accountId,
        replyToId: params.replyToId,
      });
    }
    return;
  }

  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
  let first = true;
  for (const mediaUrl of mediaUrls) {
    const caption = first ? text : "";
    first = false;
    await params.sendMessage(params.to, caption, {
      accountId: params.accountId,
      mediaUrl,
      mediaLocalRoots,
      replyToId: params.replyToId,
    });
  }
}
