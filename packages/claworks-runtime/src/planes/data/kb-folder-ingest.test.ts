import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestKbFolder } from "./kb-folder-ingest.js";
import { createKnowledgeBase } from "./knowledge-base.js";

describe("ingestKbFolder", () => {
  it("ingests supported text files and makes them searchable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-kb-ingest-"));
    writeFileSync(join(dir, "a.txt"), "公司简介 ISO9001 认证");
    writeFileSync(join(dir, "b.md"), "# 案例\n石化数字孪生项目");

    const kb = createKnowledgeBase();
    const result = await ingestKbFolder(kb, {
      folder_path: dir,
      namespace: "company",
    });

    expect(result.total).toBe(2);
    expect(result.ingested).toBe(2);
    expect(result.errors).toBe(0);

    const hits = await kb.search("ISO9001", { namespace: "company", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });
});
