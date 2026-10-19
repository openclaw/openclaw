import type { MemoryWikiCompiledCacheSnapshot } from "./src/compiled-cache.js";

export type MemoryWikiDashboards = MemoryWikiCompiledCacheSnapshot["dashboards"];

export {
  buildPluginConfigSchema,
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";
export { z } from "zod";
