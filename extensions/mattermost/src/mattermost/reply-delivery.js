import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/mattermost";
async function deliverMattermostReplyPayload(params) {
  const mediaUrls = params.payload.mediaUrls ?? (params.payload.mediaUrl ? [params.payload.mediaUrl] : []);
  const text = params.core.channel.text.convertMarkdownTables(
    params.payload.text ?? "",
    params.tableMode
  );
  if (mediaUrls.length === 0) {
    const chunkMode = params.core.channel.text.resolveChunkMode(
      params.cfg,
      "mattermost",
      params.accountId
    );
    const chunks = params.core.channel.text.chunkMarkdownTextWithMode(
      text,
      params.textLimit,
      chunkMode
    );
    for (const chunk of chunks.length > 0 ? chunks : [text]) {
      if (!chunk) {
        continue;
      }
      await params.sendMessage(params.to, chunk, {
        accountId: params.accountId,
        replyToId: params.replyToId
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
      replyToId: params.replyToId
    });
  }
}
export {
  deliverMattermostReplyPayload
};
