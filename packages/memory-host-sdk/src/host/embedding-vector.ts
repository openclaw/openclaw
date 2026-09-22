export function parseEmbedding(raw: string): number[] {
  try {
    // SAFETY: This public legacy JSON helper preserves its array-only decoding contract.
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Persistent vectors use IEEE-754 binary64 in little-endian order on every host. */
export function encodeMemoryEmbedding(embedding: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(embedding.length * 8);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < embedding.length; index += 1) {
    const coordinate = embedding[index];
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new Error("Memory embeddings require finite numeric coordinates");
    }
    view.setFloat64(index * 8, coordinate, true);
  }
  return bytes;
}

/** Invalid derived vectors stay unusable; cache and indexing owners repair them. */
export function decodeMemoryEmbedding(bytes: Uint8Array): number[] {
  if (bytes.byteLength % 8 !== 0) {
    return [];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const embedding: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    const coordinate = view.getFloat64(offset, true);
    if (!Number.isFinite(coordinate)) {
      return [];
    }
    embedding.push(coordinate);
  }
  return embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
