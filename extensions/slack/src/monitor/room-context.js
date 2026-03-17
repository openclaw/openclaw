import { buildUntrustedChannelMetadata } from "../../../../src/security/channel-metadata.js";
function resolveSlackRoomContextHints(params) {
  if (!params.isRoomish) {
    return {};
  }
  const untrustedChannelMetadata = buildUntrustedChannelMetadata({
    source: "slack",
    label: "Slack channel description",
    entries: [params.channelInfo?.topic, params.channelInfo?.purpose]
  });
  const systemPromptParts = [params.channelConfig?.systemPrompt?.trim() || null].filter(
    (entry) => Boolean(entry)
  );
  const groupSystemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : void 0;
  return {
    untrustedChannelMetadata,
    groupSystemPrompt
  };
}
export {
  resolveSlackRoomContextHints
};
