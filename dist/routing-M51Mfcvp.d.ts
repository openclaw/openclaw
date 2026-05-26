import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as RoutePeer } from "./resolve-route-BZP_W0Z9.js";

//#region src/routing/bindings.d.ts
declare function listBoundAccountIds(cfg: OpenClawConfig, channelId: string): string[];
declare function resolveDefaultAgentBoundAccountId(cfg: OpenClawConfig, channelId: string): string | null;
//#endregion
//#region src/routing/default-account-warnings.d.ts
declare function formatSetExplicitDefaultInstruction(channelKey: string): string;
declare function formatSetExplicitDefaultToConfiguredInstruction(params: {
  channelKey: string;
}): string;
//#endregion
//#region src/infra/outbound/base-session-key.d.ts
declare function buildOutboundBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: RoutePeer;
}): string;
//#endregion
//#region src/infra/outbound/thread-id.d.ts
declare function normalizeOutboundThreadId(value?: string | number | null): string | undefined;
//#endregion
export { listBoundAccountIds as a, formatSetExplicitDefaultToConfiguredInstruction as i, buildOutboundBaseSessionKey as n, resolveDefaultAgentBoundAccountId as o, formatSetExplicitDefaultInstruction as r, normalizeOutboundThreadId as t };