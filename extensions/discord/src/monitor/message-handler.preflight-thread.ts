import type { DiscordChannelInfo } from "./message-channel-info.js";
import { loadDiscordThreadingRuntime } from "./message-handler.preflight-runtime.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

export async function resolveDiscordPreflightThreadContext(params: {
  client: DiscordMessagePreflightContext["client"];
  isGuildMessage: boolean;
  message: DiscordMessagePreflightContext["message"];
  channelInfo: DiscordChannelInfo | null;
  messageChannelId: string;
  abortSignal?: AbortSignal;
}) {
  const { resolveDiscordThreadChannel, resolveDiscordThreadParentInfo } =
    await loadDiscordThreadingRuntime();
  const earlyThreadChannel = resolveDiscordThreadChannel(params);
  if (!earlyThreadChannel) {
    return { earlyThreadChannel: null };
  }
  const parentInfo = await resolveDiscordThreadParentInfo({
    client: params.client,
    threadChannel: earlyThreadChannel,
    channelInfo: params.channelInfo,
  });
  if (params.abortSignal?.aborted) {
    return null;
  }
  return {
    earlyThreadChannel,
    earlyThreadParentId: parentInfo.id,
    earlyThreadParentName: parentInfo.name,
    earlyThreadParentType: parentInfo.type,
  };
}
