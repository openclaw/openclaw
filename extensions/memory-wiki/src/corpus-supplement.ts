// Memory Wiki plugin module implements corpus supplement behavior.
import type { MemoryCorpusSupplement } from "openclaw/plugin-sdk/memory-host-core";
import type { OpenClawConfig } from "../api.js";
import type { MemoryWikiConfigResolver } from "./config.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";

export function createWikiCorpusSupplement(params: {
  resolveConfig: MemoryWikiConfigResolver;
  getAppConfig: () => OpenClawConfig | undefined;
}): MemoryCorpusSupplement {
  return {
    search: async (input) => {
      const appConfig = params.getAppConfig();
      const config = params.resolveConfig(input.agentId, appConfig);
      const agentId = config.agentId ?? input.agentId;
      return await searchMemoryWiki({
        config,
        appConfig,
        agentId,
        agentSessionKey: input.agentSessionKey,
        sandboxed: input.sandboxed,
        query: input.query,
        maxResults: input.maxResults,
        searchBackend: "local",
        searchCorpus: "wiki",
      });
    },
    get: async (input) => {
      const appConfig = params.getAppConfig();
      const config = params.resolveConfig(input.agentId, appConfig);
      const agentId = config.agentId ?? input.agentId;
      return await getMemoryWikiPage({
        config,
        appConfig,
        agentId,
        agentSessionKey: input.agentSessionKey,
        sandboxed: input.sandboxed,
        lookup: input.lookup,
        fromLine: input.fromLine,
        lineCount: input.lineCount,
        searchBackend: "local",
        searchCorpus: "wiki",
      });
    },
  };
}
