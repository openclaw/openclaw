import type { GatewayPluginContract } from "../internal/plugin-contract.js";

export const DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT =
  "openclaw:discord-gateway-transport-activity";

export type MutableDiscordGateway = GatewayPluginContract & {
  state?: {
    sessionId?: string | null;
    resumeGatewayUrl?: string | null;
    sequence?: number | null;
  };
};
