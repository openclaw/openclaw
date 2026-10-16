import type { SearchSchema } from "./openclaw-runtime-sqlite.js";

/** Memory owns source selection; the engine owns derived text and vector storage. */
export function memoryTextSearchSchema(tokenizer: "unicode61" | "trigram"): SearchSchema {
  const mode = tokenizer === "trigram" ? { mode: "trigram" as const } : {};
  return {
    text: {
      body: {
        table: "memory_index_chunks",
        fields: ["text"],
        postgres: { identity: "chunk_rowid", ...mode },
      },
      paths: {
        table: "memory_index_sources",
        fields: ["path"],
        postgres: { identity: "id", ...mode },
      },
    },
  };
}

/** Register separately after the embedding provider returns its actual dimensions. */
export function memoryVectorSearchSchema(dimensions: number): SearchSchema {
  return {
    vector: {
      chunks: {
        table: "memory_index_chunks_vec",
        alias: "v",
        rowShape: {
          id: "string",
          path: "string",
          start_line: "number",
          end_line: "number",
          text: "string",
          source: ["memory", "sessions"],
          dist: "finite-number",
        },
        postgres: {
          source: "memory_index_chunks",
          key: "id",
          embedding: "embedding",
          dimensions,
        },
      },
    },
  };
}
