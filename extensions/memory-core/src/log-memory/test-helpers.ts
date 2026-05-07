import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConsolidateFn, ConsolidatedPattern, EmbedFn } from "./types.js";

export function makeTempWorkspace(prefix = "log-memory-test"): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return {
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Deterministic hash-based fake embedder. Produces stable normalized vectors
// for a given string so cosine similarity tests are reproducible. Two strings
// that share most characters produce vectors with high similarity, which is
// good enough for clustering tests without any real model.
export function makeFakeEmbedder(dims = 16): EmbedFn {
  return async (texts) =>
    texts.map((text) => {
      const out = new Float32Array(dims);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        out[code % dims] += 1;
      }
      let norm = 0;
      for (let i = 0; i < dims; i++) {
        norm += out[i] * out[i];
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dims; i++) {
        out[i] /= norm;
      }
      return out;
    });
}

export function makeStaticConsolidator(pattern: ConsolidatedPattern): ConsolidateFn {
  return async () => pattern;
}

export function makeFailingConsolidator(): ConsolidateFn {
  return async () => null;
}
