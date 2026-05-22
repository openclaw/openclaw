import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { Jt as ProviderPlugin, Lt as ProviderFollowupFallbackRouteContext, Nt as ProviderExtraParamsForTransportContext, Pt as ProviderExtraParamsForTransportResult, Rt as ProviderFollowupFallbackRouteResult, kn as ProviderWrapStreamFnContext, nn as ProviderPrepareExtraParamsContext, pn as ProviderResolveAuthProfileIdContext } from "./types-BOTb5nyG.js";
import { AssistantMessage } from "@mariozechner/pi-ai";
import * as _$_mariozechner_pi_agent_core0 from "@mariozechner/pi-agent-core";
import { AgentMessage } from "@mariozechner/pi-agent-core";

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
}): _$_mariozechner_pi_agent_core0.StreamFn | undefined;
//#endregion
export { resolveProviderFollowupFallbackRoute as a, resolveProviderExtraParamsForTransport as i, prepareProviderExtraParams as n, resolveProviderRuntimePlugin as o, resolveProviderAuthProfileId as r, wrapProviderStreamFn as s, ProviderRuntimePluginHandle as t };