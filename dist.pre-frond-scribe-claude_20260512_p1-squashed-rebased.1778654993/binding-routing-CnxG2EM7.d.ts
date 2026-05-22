import { i as OpenClawConfig } from "./types.openclaw-BdSNxnBz.js";
import { c as SessionBindingRecord, r as ConversationRef } from "./session-binding.types-BvHHQXaH.js";
import { t as ResolvedAgentRoute } from "./resolve-route-BW_9VNYz.js";
import { i as ConfiguredBindingResolution } from "./binding-types-D7Cv86R7.js";

//#region src/channels/plugins/binding-routing.d.ts
type ConfiguredBindingRouteResult = {
  bindingResolution: ConfiguredBindingResolution | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
};
type RuntimeConversationBindingRouteResult = {
  bindingRecord: SessionBindingRecord | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
};
type ConfiguredBindingRouteConversationInput = {
  conversation: ConversationRef;
} | {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};
declare function resolveConfiguredBindingRoute(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
} & ConfiguredBindingRouteConversationInput): ConfiguredBindingRouteResult;
declare function resolveRuntimeConversationBindingRoute(params: {
  route: ResolvedAgentRoute;
} & ConfiguredBindingRouteConversationInput): RuntimeConversationBindingRouteResult;
declare function ensureConfiguredBindingRouteReady(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution | null;
}): Promise<{
  ok: true;
} | {
  ok: false;
  error: string;
}>;
//#endregion
export { resolveRuntimeConversationBindingRoute as a, resolveConfiguredBindingRoute as i, RuntimeConversationBindingRouteResult as n, ensureConfiguredBindingRouteReady as r, ConfiguredBindingRouteResult as t };