// Deterministic PGMEMSTORE corpus. Construct on demand so --help never allocates vectors.
import { createHash } from "node:crypto";

export const identity = {
  provider: "synthetic",
  model: "pgmemstore-1536",
  providerKey: "deterministic-v1",
};
export const vocabulary = [
  "gateway",
  "postgres",
  "memory",
  "session",
  "project",
  "document",
  "calendar",
  "deploy",
  "schema",
  "search",
  "vector",
  "index",
  "release",
  "client",
  "storage",
  "backup",
  "retry",
  "latency",
  "worker",
  "meeting",
  "inbox",
  "review",
  "team",
  "settings",
  "model",
  "history",
  "source",
  "browser",
  "message",
  "pipeline",
  "migration",
  "delivery",
];

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function embedding(seed, rounded = false) {
  let state = (seed + 1) >>> 0;
  const vector = [];
  let norm = 0;
  for (let index = 0; index < 1536; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = (state >>> 0) / 2147483648 - 1;
    vector.push(value);
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  return vector.map((value) => (rounded ? Math.fround(value / norm) : value / norm));
}

export function createMemorySearchFixture(n, createEmbedding = embedding) {
  if (!Number.isInteger(n) || n <= 0 || n % 10 !== 0) {
    throw new Error("Fixture chunk count must be a positive multiple of 10");
  }
  const sources = [];
  for (let sourceIndex = 0; sourceIndex < n / 10; sourceIndex++) {
    const source = sourceIndex % 5 === 0 ? "memory" : "sessions";
    const pathname =
      source === "memory"
        ? `memory/project-${sourceIndex}/notes.md`
        : `sessions/${String(sourceIndex).padStart(6, "0")}.jsonl`;
    const chunks = [];
    for (let chunkIndex = 0; chunkIndex < 10; chunkIndex++) {
      const id = sourceIndex * 10 + chunkIndex;
      const words = [];
      for (let wordIndex = 0; wordIndex < 155; wordIndex++) {
        words.push(
          vocabulary[(id * 7 + wordIndex * 11) % vocabulary.length] +
            (wordIndex % 17 === 0 ? ` topic${id % 200}` : ""),
        );
      }
      const text = `${source === "sessions" ? "User: " : "# "}${vocabulary[id % 32]} design note ${id}.\n${words.join(" ")}.\nDecision ${id}: preserve source identity and exact replay across storage updates.`;
      chunks.push({
        startLine: chunkIndex * 12 + 1,
        endLine: chunkIndex * 12 + 12,
        hash: hash(text),
        text,
        importance: chunkIndex === 0 ? 7 : null,
        triggers: chunkIndex === 0 ? "storage,search" : null,
        projectKey: source === "memory" ? `project-${sourceIndex}` : null,
        provenance: {
          originClass: source === "memory" ? "owner" : "agent",
          sessionKind: source === "memory" ? "unknown" : "interactive",
          observedAt: 1_760_000_000_000,
        },
      });
    }
    const entry = {
      path: pathname,
      hash: hash(chunks.map((chunk) => chunk.hash).join("")),
      mtimeMs: 1_760_000_000_000,
      size: chunks.reduce((size, chunk) => size + Buffer.byteLength(chunk.text), 0),
    };
    sources.push({
      ...(source === "sessions"
        ? { source, agentId: "fixture", sessionId: String(sourceIndex) }
        : { source }),
      entry,
      chunks,
      embeddings: chunks.map((_, index) => createEmbedding(sourceIndex * 10 + index)),
      model: identity.model,
      now: 1_760_000_000_000,
      vectorReady: true,
    });
  }
  return { n, sources };
}
