import type { OpenClawConfig, OpenClawPluginApi } from "../api.js";
import type { MemoryWikiConfigResolver } from "./config.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";

export function createWikiCorpusSupplement(params: {
  resolveConfig: MemoryWikiConfigResolver;
  getAppConfig: () => OpenClawConfig | undefined;
}) {
  return {
    search: async (input) => {
      const appConfig = params.getAppConfig();
      const config = params.resolveConfig(input.agentId, appConfig);
      const results = await searchMemoryWiki({
        config,
        appConfig,
        agentId: config.agentId ?? input.agentId,
        agentSessionKey: input.agentSessionKey,
        sandboxed: input.sandboxed,
        query: input.query,
        maxResults: input.maxResults,
        searchBackend: "local",
        searchCorpus: "wiki",
      });
      return results.filter((result) => result.corpus === "wiki");
    },
    get: async (input) => {
      const appConfig = params.getAppConfig();
      const config = params.resolveConfig(input.agentId, appConfig);
      const result = await getMemoryWikiPage({
        config,
        appConfig,
        agentId: config.agentId ?? input.agentId,
        agentSessionKey: input.agentSessionKey,
        sandboxed: input.sandboxed,
        lookup: input.lookup,
        fromLine: input.fromLine,
        lineCount: input.lineCount,
        searchBackend: "local",
        searchCorpus: "wiki",
      });
      return result?.corpus === "wiki" ? result : null;
    },
  } satisfies Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0];
}
