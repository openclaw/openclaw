import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileKnowledgeBase } from "./knowledge-base-file.js";

describe("createFileKnowledgeBase", () => {
  it("persists ingest and finds on search", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-kb-file-"));
    const kbPath = join(dir, "kb.json");
    const kb = createFileKnowledgeBase(kbPath);

    await kb.ingest("pump vibration baseline 2.1mm/s", { namespace: "ops" });
    const results = await kb.search("vibration", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.text).toContain("vibration");
  });
});
