import { registerMemoryReranker } from "openclaw/plugin-sdk/memory-core-host-engine-reranker";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { mmrRerank } from "./src/mmr-reranker.js";

export function createMMRRerankerProvider() {
  return {
    id: "memory-mmr",
    rerank: async (params: {
      query: string;
      documents: Array<{ id: string; content: string; score: number }>;
      limit: number;
      lambda?: number;
    }) => {
      const mmrItems = params.documents.map((doc) => ({
        id: doc.id,
        score: doc.score,
        content: doc.content,
      }));
      const reranked = mmrRerank(mmrItems, { enabled: true, lambda: params.lambda ?? 0.7 });
      return reranked.map((item) => ({ id: item.id, score: item.score }));
    },
  };
}

export default definePluginEntry({
  id: "memory-mmr",
  activation: {
    onStartup: false,
  },
  kind: "memory",
  contracts: {
    tools: [],
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register() {
    registerMemoryReranker(createMMRRerankerProvider());
  },
});
