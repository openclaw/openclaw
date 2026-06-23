import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ExternalMmrReranker, type ExternalRerankerConfig } from "./src/external-reranker.js";

export default definePluginEntry({
  id: "memory-external-reranker",
  name: "Memory External Reranker",
  description:
    "OpenClaw memory reranker plugin that proxies to a Cohere-compatible /v1/rerank endpoint (Cohere, Jina, Voyage, llama.cpp).",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as Partial<ExternalRerankerConfig>;
    api.registerMemoryReranker(
      new ExternalMmrReranker(
        {
          provider: cfg.provider ?? "",
          model: cfg.model ?? "",
          modelFallbacks: cfg.modelFallbacks,
          endpointPath: cfg.endpointPath,
          topN: cfg.topN,
          additionalBodyParams: cfg.additionalBodyParams,
        },
        api.config,
      ),
    );
  },
});
