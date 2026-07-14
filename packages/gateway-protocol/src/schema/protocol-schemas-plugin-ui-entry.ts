import {
  PluginControlUiEntryPointSchema,
  PluginsUiEntryPointLaunchParamsSchema,
  PluginsUiEntryPointLaunchResultSchema,
  PluginsUiEntryPointsParamsSchema,
  PluginsUiEntryPointsResultSchema,
} from "./plugins.js";

export const PluginUiEntryProtocolSchemas = {
  PluginControlUiEntryPoint: PluginControlUiEntryPointSchema,
  PluginsUiEntryPointLaunchParams: PluginsUiEntryPointLaunchParamsSchema,
  PluginsUiEntryPointLaunchResult: PluginsUiEntryPointLaunchResultSchema,
  PluginsUiEntryPointsParams: PluginsUiEntryPointsParamsSchema,
  PluginsUiEntryPointsResult: PluginsUiEntryPointsResultSchema,
} as const;
