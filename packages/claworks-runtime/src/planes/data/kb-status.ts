import { join } from "node:path";
import type { ClaworksRobotConfig } from "../../claworks/config-types.js";
import { defaultClaworksStateDir } from "../../claworks/product-config-repair.js";
import type { KnowledgeBase, KbStatus } from "../../kernel/types.js";

export function resolveKbProviderLabel(
  data: ClaworksRobotConfig["data"] | undefined,
): KbStatus["provider"] {
  if (data?.kb_provider === "memory-core") {
    return "memory-core";
  }
  if (data?.kb_path?.trim()) {
    return "file";
  }
  return "bm25-memory";
}

export async function describeKnowledgeBase(
  kb: KnowledgeBase,
  data: ClaworksRobotConfig["data"] | undefined,
  opts?: { memorySlot?: string },
): Promise<KbStatus> {
  if (kb.describe) {
    const described = await kb.describe();
    return {
      ...described,
      memory_slot: opts?.memorySlot ?? described.memory_slot,
      kb_embed_model: data?.kb_embed_model ?? described.kb_embed_model,
      kb_path: data?.kb_path ?? described.kb_path,
    };
  }
  const provider = resolveKbProviderLabel(data);
  return {
    provider,
    vector: provider === "memory-core",
    kb_path: data?.kb_path,
    kb_embed_model: data?.kb_embed_model,
    kb_drop_dir: join(defaultClaworksStateDir(), "kb-drop"),
    memory_slot: opts?.memorySlot,
    document_count: 0,
    note:
      provider === "bm25-memory"
        ? "in-memory BM25 KB (no vectors; set kb_provider=memory-core for RAG)"
        : undefined,
  };
}
