import { describe, expect, it } from "vitest";
import { describeKnowledgeBase, resolveKbProviderLabel } from "./kb-status.js";
import { createKnowledgeBase } from "./knowledge-base.js";

describe("kb-status", () => {
  it("resolveKbProviderLabel maps config", () => {
    expect(resolveKbProviderLabel({ kb_provider: "memory-core" })).toBe("memory-core");
    expect(resolveKbProviderLabel({ kb_path: "/tmp/kb.json" })).toBe("file");
    expect(resolveKbProviderLabel({})).toBe("bm25-memory");
  });

  it("describeKnowledgeBase uses kb.describe when present", async () => {
    const kb = createKnowledgeBase();
    const status = await describeKnowledgeBase(kb, { kb_embed_model: "text-embedding-3-large" });
    expect(status.provider).toBe("bm25-memory");
    expect(status.vector).toBe(false);
    expect(status.kb_embed_model).toBe("text-embedding-3-large");
    expect(status.document_count).toBe(0);
  });
});
