import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KnowledgeBase, KbResult } from "../../kernel/types.js";

type KbDoc = {
  id: string;
  text: string;
  namespace?: string;
  source?: string;
};

type KbFile = {
  documents: KbDoc[];
};

/**
 * File-backed knowledge base (JSON). Used when config.data.kb_path is set.
 */
export function createFileKnowledgeBase(filePath: string): KnowledgeBase {
  const load = (): KbFile => {
    if (!existsSync(filePath)) {
      return { documents: [] };
    }
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as KbFile;
      return { documents: Array.isArray(parsed.documents) ? parsed.documents : [] };
    } catch {
      return { documents: [] };
    }
  };

  const save = (data: KbFile): void => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  };

  return {
    async search(query, opts) {
      const limit = opts?.limit ?? 5;
      const ns = opts?.namespace;
      const q = query.toLowerCase();
      const docs = load().documents.filter((d) => !ns || d.namespace === ns);
      const hits: KbResult[] = [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i]!;
        if (doc.text.toLowerCase().includes(q)) {
          hits.push({
            id: doc.id,
            text: doc.text,
            score: 1 - i * 0.05,
            namespace: doc.namespace,
            source: doc.source,
          });
        }
        if (hits.length >= limit) {
          break;
        }
      }
      return hits;
    },

    async ingest(text, opts) {
      const data = load();
      const doc: KbDoc = {
        id: randomUUID(),
        text,
        namespace: opts?.namespace,
        source: opts?.source,
      };
      data.documents.push(doc);
      save(data);
    },
  };
}
