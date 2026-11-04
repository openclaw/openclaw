import { isCrablineServerChannel, OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { listLiveTransportQaAdapterFactories } from "./live-transports/cli.js";
import { qaTransportSupportsModuleFlows } from "./qa-transport-registry.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";

export function resolveQaChannelDriverSelection(channelDriver?: QaScorecardChannelDriver) {
  const liveAdapterFactories =
    channelDriver === "live" ? listLiveTransportQaAdapterFactories() : undefined;
  return {
    liveAdapterFactories,
    defaultChannel: channelDriver === "crabline" ? OPENCLAW_CRABLINE_DEFAULT_CHANNEL : undefined,
    supportsChannel: channelDriver === "crabline" ? isCrablineServerChannel : undefined,
    resolveModuleFlowSupport:
      channelDriver === "live"
        ? (channel?: string) =>
            channel
              ? qaTransportSupportsModuleFlows(liveAdapterFactories, {
                  channelId: channel,
                  driver: "live",
                })
              : false
        : undefined,
  };
}
