export {
  buildPluginConfigSchema,
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";
export { z } from "openclaw/plugin-sdk/zod";

export {
  resolveMemoryWikiConfig,
  type MemoryWikiPluginConfig,
  type ResolvedMemoryWikiConfig,
  type WikiSearchBackend,
  type WikiSearchCorpus,
} from "./src/config.js";
export {
  getMemoryWikiPage,
  searchMemoryWiki,
  type WikiGetResult,
  type WikiSearchResult,
} from "./src/query.js";
