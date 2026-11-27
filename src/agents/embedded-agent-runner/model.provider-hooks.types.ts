import type { ProviderToolSearchPolicyContext } from "../../plugin-sdk/provider-model-types.js";
import type {
  applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
  normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel,
} from "../../plugins/provider-runtime.js";

export type ProviderRuntimeHooks = {
  resolveToolSearchMode?: (context: ProviderToolSearchPolicyContext) => "tools" | false | undefined;
  applyProviderResolvedTransportWithPlugin?: (
    params: Parameters<typeof applyProviderResolvedTransportWithPlugin>[0],
  ) => unknown;
  buildProviderUnknownModelHintWithPlugin: typeof buildProviderUnknownModelHintWithPlugin;
  prepareProviderDynamicModel: typeof prepareProviderDynamicModel;
  runProviderDynamicModel: (params: Parameters<typeof runProviderDynamicModel>[0]) => unknown;
  shouldPreferProviderRuntimeResolvedModel?: typeof shouldPreferProviderRuntimeResolvedModel;
  normalizeProviderResolvedModelWithPlugin: (
    params: Parameters<typeof normalizeProviderResolvedModelWithPlugin>[0],
  ) => unknown;
  normalizeProviderTransportWithPlugin: typeof normalizeProviderTransportWithPlugin;
};
