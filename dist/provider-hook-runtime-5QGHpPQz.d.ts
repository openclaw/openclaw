import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { En as ProviderResolveAuthProfileIdContext, Hn as ProviderWrapStreamFnContext, Kt as ProviderExtraParamsForTransportContext, Xt as ProviderFollowupFallbackRouteContext, Zt as ProviderFollowupFallbackRouteResult, hn as ProviderPrepareExtraParamsContext, qt as ProviderExtraParamsForTransportResult, sn as ProviderPlugin } from "./types-Vx7Jq4_-2.js";
import { AssistantMessage } from "@earendil-works/pi-ai";
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
}): import("@earendil-works/pi-agent-core").StreamFn | undefined;
//#endregion
export { resolveProviderFollowupFallbackRoute as a, resolveProviderExtraParamsForTransport as i, prepareProviderExtraParams as n, resolveProviderRuntimePlugin as o, resolveProviderAuthProfileId as r, wrapProviderStreamFn as s, ProviderRuntimePluginHandle as t };