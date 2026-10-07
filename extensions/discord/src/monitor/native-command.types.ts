import type {
  BuildChannelInboundEventContextParams,
  BuiltChannelInboundEventContext,
  ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
export type DiscordDispatchReplyFromConfig = NonNullable<
  ChannelInboundTurnPlan["dispatchReplyFromConfig"]
>;

export type DiscordBuildInboundContext = (
  params: BuildChannelInboundEventContextParams,
) => BuiltChannelInboundEventContext | Promise<BuiltChannelInboundEventContext>;
