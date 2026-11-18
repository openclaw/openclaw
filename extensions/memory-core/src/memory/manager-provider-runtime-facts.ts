// Memory Core reads optional provider runtime diagnostics without widening the provider contract.
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

export function getLocalEmbeddingRuntimeFacts(provider: MemoryEmbeddingProvider | null): unknown {
  if (!provider) {
    return undefined;
  }
  const getRuntimeFacts = Reflect.get(provider, LOCAL_EMBEDDING_RUNTIME_FACTS);
  return typeof getRuntimeFacts === "function" ? getRuntimeFacts() : undefined;
}
