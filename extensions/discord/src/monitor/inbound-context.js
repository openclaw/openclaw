import { buildUntrustedChannelMetadata } from "../../../../src/security/channel-metadata.js";
import {
  resolveDiscordOwnerAllowFrom
} from "./allow-list.js";
function buildDiscordGroupSystemPrompt(channelConfig) {
  const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter(
    (entry) => Boolean(entry)
  );
  return systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : void 0;
}
function buildDiscordUntrustedContext(params) {
  if (!params.isGuild) {
    return void 0;
  }
  const untrustedChannelMetadata = buildUntrustedChannelMetadata({
    source: "discord",
    label: "Discord channel topic",
    entries: [params.channelTopic]
  });
  return untrustedChannelMetadata ? [untrustedChannelMetadata] : void 0;
}
function buildDiscordInboundAccessContext(params) {
  return {
    groupSystemPrompt: params.isGuild ? buildDiscordGroupSystemPrompt(params.channelConfig) : void 0,
    untrustedContext: buildDiscordUntrustedContext({
      isGuild: params.isGuild,
      channelTopic: params.channelTopic
    }),
    ownerAllowFrom: resolveDiscordOwnerAllowFrom({
      channelConfig: params.channelConfig,
      guildInfo: params.guildInfo,
      sender: params.sender,
      allowNameMatching: params.allowNameMatching
    })
  };
}
export {
  buildDiscordGroupSystemPrompt,
  buildDiscordInboundAccessContext,
  buildDiscordUntrustedContext
};
