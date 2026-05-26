import { s as ReplyPayload } from "./get-reply-options.types-BalBo_kk.js";
import { st as PluginInteractiveHandlerRegistration } from "./types-lCXG2pW_.js";
import { Ut as PluginConversationBinding, Wt as PluginConversationBindingRequestParams } from "./hook-types-CECscVcN.js";
import { a as GatewayRequestOptions, t as GatewayRequestContext } from "./types-BczMykKN.js";
import { p as requestPluginConversationBinding } from "./conversation-binding-BBHpkIP5.js";

//#region src/plugins/interactive-binding-helpers.d.ts
type RegisteredInteractiveMetadata = {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};
type PluginBindingConversation = Parameters<typeof requestPluginConversationBinding>[0]["conversation"];
declare function createInteractiveConversationBindingHelpers(params: {
  registration: RegisteredInteractiveMetadata;
  senderId?: string;
  conversation: PluginBindingConversation;
}): {
  requestConversationBinding: (binding?: PluginConversationBindingRequestParams) => Promise<{
    status: "bound";
    binding: PluginConversationBinding;
  } | {
    status: "pending";
    approvalId: string;
    reply: ReplyPayload;
  } | {
    status: "error";
    message: string;
  }>;
  detachConversationBinding: () => Promise<{
    removed: boolean;
  }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};
//#endregion
//#region src/plugins/interactive-state.d.ts
type RegisteredInteractiveHandler = PluginInteractiveHandlerRegistration & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};
//#endregion
//#region src/plugins/interactive-registry.d.ts
type InteractiveRegistrationResult = {
  ok: boolean;
  error?: string;
};
declare function registerPluginInteractiveHandler(pluginId: string, registration: PluginInteractiveHandlerRegistration, opts?: {
  pluginName?: string;
  pluginRoot?: string;
}): InteractiveRegistrationResult;
declare function clearPluginInteractiveHandlers(): void;
declare function clearPluginInteractiveHandlersForPlugin(pluginId: string): void;
//#endregion
//#region src/plugins/interactive.d.ts
type InteractiveDispatchResult = {
  matched: false;
  handled: false;
  duplicate: false;
} | {
  matched: true;
  handled: boolean;
  duplicate: boolean;
};
type PluginInteractiveDispatchRegistration = {
  channel: string;
  namespace: string;
};
type PluginInteractiveMatch<TRegistration extends PluginInteractiveDispatchRegistration> = {
  registration: RegisteredInteractiveHandler & TRegistration;
  namespace: string;
  payload: string;
};
declare function dispatchPluginInteractiveHandler<TRegistration extends PluginInteractiveDispatchRegistration>(params: {
  channel: TRegistration["channel"];
  data: string;
  dedupeId?: string;
  onMatched?: () => Promise<void> | void;
  invoke: (match: PluginInteractiveMatch<TRegistration>) => Promise<{
    handled?: boolean;
  } | void> | {
    handled?: boolean;
  } | void;
}): Promise<InteractiveDispatchResult>;
//#endregion
//#region src/plugins/lazy-service-module.d.ts
type LazyServiceModule = Record<string, unknown>;
type LazyPluginServiceHandle = {
  stop: () => Promise<void>;
};
declare function defaultLoadOverrideModule(specifier: string, importModule?: (specifier: string) => Promise<LazyServiceModule>): Promise<LazyServiceModule>;
declare function startLazyPluginServiceModule(params: {
  skipEnvVar?: string;
  overrideEnvVar?: string;
  validateOverrideSpecifier?: (specifier: string) => string;
  loadDefaultModule: () => Promise<LazyServiceModule>;
  loadOverrideModule?: (specifier: string) => Promise<LazyServiceModule>;
  startExportNames: string[];
  stopExportNames?: string[];
}): Promise<LazyPluginServiceHandle | null>;
//#endregion
//#region src/plugins/runtime/gateway-request-scope.d.ts
type PluginRuntimeGatewayRequestScope = {
  context?: GatewayRequestContext;
  client?: GatewayRequestOptions["client"];
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
  pluginId?: string;
  pluginSource?: string;
};
/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
declare function getPluginRuntimeGatewayRequestScope(): PluginRuntimeGatewayRequestScope | undefined;
//#endregion
export { PluginInteractiveMatch as a, clearPluginInteractiveHandlers as c, createInteractiveConversationBindingHelpers as d, startLazyPluginServiceModule as i, clearPluginInteractiveHandlersForPlugin as l, LazyPluginServiceHandle as n, dispatchPluginInteractiveHandler as o, defaultLoadOverrideModule as r, InteractiveRegistrationResult as s, getPluginRuntimeGatewayRequestScope as t, registerPluginInteractiveHandler as u };