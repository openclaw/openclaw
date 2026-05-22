import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { D as ChannelOutboundSessionRoute } from "./types.core-BoZgMdCh.js";
//#region extensions/discord/src/outbound-session-route.d.ts
type ResolveDiscordOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: {
    kind: string;
  };
  replyToId?: string | null;
  threadId?: string | number | null;
};
declare function resolveDiscordOutboundSessionRoute(params: ResolveDiscordOutboundSessionRouteParams): ChannelOutboundSessionRoute | null;
//#endregion
export { resolveDiscordOutboundSessionRoute as n, ResolveDiscordOutboundSessionRouteParams as t };