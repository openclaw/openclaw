import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { c as SessionBindingRecord, r as ConversationRef } from "./session-binding.types-CfVgcF6b.js";
import { t as ResolvedAgentRoute } from "./resolve-route-CSRop7gD.js";
import { i as ConfiguredBindingResolution } from "./binding-types-WVRmCk6H.js";

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