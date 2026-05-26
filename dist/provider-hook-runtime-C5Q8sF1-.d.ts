import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { Gt as ProviderFollowupFallbackRouteContext, Ht as ProviderExtraParamsForTransportResult, Kt as ProviderFollowupFallbackRouteResult, Ln as ProviderWrapStreamFnContext, Vt as ProviderExtraParamsForTransportContext, nn as ProviderPlugin, un as ProviderPrepareExtraParamsContext, xn as ProviderResolveAuthProfileIdContext } from "./types-lCXG2pW_.js";
import { AssistantMessage } from "@earendil-works/pi-ai";
import * as _$_earendil_works_pi_agent_core0 from "@earendil-works/pi-agent-core";
import { AgentMessage } from "@earendil-works/pi-agent-core";

//#region src/plugins/provider-hook-runtime.d.ts
type ProviderRuntimePluginLookupParams = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
};
type ProviderRuntimePluginHandle = ProviderRuntimePluginLookupParams & {
  plugin?: ProviderPlugin;
};
declare function resolveProviderRuntimePlugin(params: ProviderRuntimePluginLookupParams): ProviderPlugin | undefined;
declare function prepareProviderExtraParams(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderPrepareExtraParamsContext;
}): Record<string, unknown> | undefined;
declare function resolveProviderExtraParamsForTransport(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderExtraParamsForTransportContext;
}): ProviderExtraParamsForTransportResult | undefined;
declare function resolveProviderAuthProfileId(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderResolveAuthProfileIdContext;
}): string | undefined;
declare function resolveProviderFollowupFallbackRoute(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderFollowupFallbackRouteContext;
}): ProviderFollowupFallbackRouteResult | undefined;
declare function wrapProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderWrapStreamFnContext;
}): _$_earendil_works_pi_agent_core0.StreamFn | undefined;
//#endregion
export { resolveProviderFollowupFallbackRoute as a, resolveProviderExtraParamsForTransport as i, prepareProviderExtraParams as n, resolveProviderRuntimePlugin as o, resolveProviderAuthProfileId as r, wrapProviderStreamFn as s, ProviderRuntimePluginHandle as t };