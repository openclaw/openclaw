import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { mmrRerank } from "./src/mmr-reranker.js";

const log = createSubsystemLogger("memory/mmr");

export function createMMRRerankerProvider() {
  return {
    id: "memory-mmr",
    rerank: async (params: {
      query: string;
      documents: Array<{ id: string; content: string; score: number }>;
      limit: number;
      lambda?: number;
    }) => {
      const startedAt = Date.now();
      const mmrItems = params.documents.map((doc) => ({
        id: doc.id,
        score: doc.score,
        content: doc.content,
      }));
      const reranked = mmrRerank(mmrItems, { enabled: true, lambda: params.lambda ?? 0.7 });
      const result = reranked.map((item) => ({ id: item.id, score: item.score }));
      log.debug("memory-mmr rerank elapsed", {
        elapsedMs: Date.now() - startedAt,
        documents: params.documents.length,
        reranked: result.length,
      });
      return result;
    },
  };
}

export default definePluginEntry({
  id: "memory-mmr",
  name: "Memory MMR Reranker",
  description:
    "Bundled OpenClaw MMR (Maximal Marginal Relevance) reranker for memory hybrid search diversity.",
  register(api) {
    api.registerMemoryReranker(createMMRRerankerProvider());
  },
});
