import { registerMemoryReranker } from "openclaw/plugin-sdk/memory-core-host-engine-reranker";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ExternalMmrReranker, type ExternalRerankerConfig } from "./src/reranker.js";

export default definePluginEntry({
  id: "memory-external-reranker",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as Partial<ExternalRerankerConfig>;
    registerMemoryReranker(
      new ExternalMmrReranker({
        model: cfg.model ?? "",
        modelFallbacks: cfg.modelFallbacks,
        endpointPath: cfg.endpointPath,
        topN: cfg.topN,
        providers: cfg.providers ?? {},
      }),
    );
  },
});
