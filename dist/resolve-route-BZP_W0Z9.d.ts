import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as ChatType } from "./chat-type-BtX_XjMF.js";

//#region src/routing/resolve-route.d.ts
/** @deprecated Use ChatType from channels/chat-type.js */
type RoutePeerKind = ChatType;
type RoutePeer = {
  kind: ChatType;
  id: string;
};
type ResolveAgentRouteInput = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null; /** Parent peer for threads — used for binding inheritance when peer doesn't match directly. */
  parentPeer?: RoutePeer | null;
  guildId?: string | null;
  teamId?: string | null; /** Discord member role IDs — used for role-based agent routing. */
  memberRoleIds?: string[];
};
type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string; /** Internal session key used for persistence + concurrency. */
  sessionKey: string; /** Convenience alias for direct-chat collapse. */
  mainSessionKey: string; /** Which session should receive inbound last-route updates. */
  lastRoutePolicy: "main" | "session"; /** Match description for debugging/logging. */
  matchedBy: "binding.peer" | "binding.peer.parent" | "binding.peer.wildcard" | "binding.guild+roles" | "binding.guild" | "binding.team" | "binding.account" | "binding.channel" | "default";
};
declare function deriveLastRoutePolicy(params: {
  sessionKey: string;
  mainSessionKey: string;
}): ResolvedAgentRoute["lastRoutePolicy"];
declare function resolveInboundLastRouteSessionKey(params: {
  route: Pick<ResolvedAgentRoute, "lastRoutePolicy" | "mainSessionKey">;
  sessionKey: string;
}): string;
declare function buildAgentSessionKey(params: {
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null; /** DM session scope. */
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  identityLinks?: Record<string, string[]>;
}): string;
declare function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute;
//#endregion
export { deriveLastRoutePolicy as a, buildAgentSessionKey as i, RoutePeer as n, resolveAgentRoute as o, RoutePeerKind as r, resolveInboundLastRouteSessionKey as s, ResolvedAgentRoute as t };