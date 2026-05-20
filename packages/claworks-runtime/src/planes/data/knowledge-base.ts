import type { KnowledgeBase, KbResult } from "../../kernel/types.js";

/** In-memory KB stub; use `data.kb_provider: memory-core` in claworks-robot for memory-core search. */
export function createKnowledgeBase(): KnowledgeBase {
  const docs: Array<{ id: string; text: string; namespace?: string; source?: string }> = [];

  return {
    async search(query, opts) {
      const limit = opts?.limit ?? 5;
      const q = query.toLowerCase();
      const hits = docs
        .filter((d) => !opts?.namespace || d.namespace === opts.namespace)
        .filter((d) => d.text.toLowerCase().includes(q))
        .slice(0, limit)
        .map(
          (d, i): KbResult => ({
            id: d.id,
            score: 1 - i * 0.1,
            text: d.text,
            source: d.source,
            namespace: d.namespace,
          }),
        );
      return hits;
    },

    async ingest(text, opts) {
      docs.push({
        id: `kb-${docs.length + 1}`,
        text,
        namespace: opts?.namespace,
        source: opts?.source,
      });
    },
  };
}
