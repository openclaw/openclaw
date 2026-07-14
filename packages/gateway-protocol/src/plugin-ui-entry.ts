import { lazyCompile } from "./protocol-validator.js";
import {
  PluginsUiEntryPointLaunchParamsSchema,
  PluginsUiEntryPointLaunchResultSchema,
  PluginsUiEntryPointsParamsSchema,
  PluginsUiEntryPointsResultSchema,
} from "./schema/plugins.js";

export const validatePluginsUiEntryPointsParams = lazyCompile(PluginsUiEntryPointsParamsSchema);
export const validatePluginsUiEntryPointsResult = lazyCompile(PluginsUiEntryPointsResultSchema);
export const validatePluginsUiEntryPointLaunchParams = lazyCompile(
  PluginsUiEntryPointLaunchParamsSchema,
);
export const validatePluginsUiEntryPointLaunchResult = lazyCompile(
  PluginsUiEntryPointLaunchResultSchema,
);
export {
  PluginsUiEntryPointLaunchParamsSchema,
  PluginsUiEntryPointLaunchResultSchema,
  PluginsUiEntryPointsParamsSchema,
  PluginsUiEntryPointsResultSchema,
} from "./schema/plugins.js";
export type {
  PluginControlUiEntryPoint,
  PluginsUiEntryPointLaunchParams,
  PluginsUiEntryPointLaunchResult,
  PluginsUiEntryPointsParams,
  PluginsUiEntryPointsResult,
} from "./schema/plugins.js";
