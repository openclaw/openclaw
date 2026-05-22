import { describe, expect, it } from "vitest";
import {
  buildCitation,
  chunkKbText,
  deriveDocumentTitle,
  inferDocType,
  inferKbLayer,
} from "./kb-chunk.js";

describe("kb-chunk", () => {
  it("infers L0 layer from standard-like source", () => {
    expect(inferKbLayer({ source: "GB/T 12345-2020" })).toBe("L0");
    expect(inferKbLayer({ source: "notes.txt" })).toBe("L2");
  });

  it("chunks markdown sections with citations", () => {
    const chunks = chunkKbText({
      text: "# Safety\n\nWear PPE.\n\n# Ops\n\nCheck valve.",
      source: "sop.md",
      layer: "L2",
    });
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.citation).toContain("sop.md");
    expect(chunks[0]?.text).toContain("Safety");
  });

  it("builds citation and title helpers", () => {
    expect(buildCitation({ source: "manual.pdf", layer: "L1", seq: 0 })).toBe(
      "L1:manual.pdf#chunk-1",
    );
    expect(deriveDocumentTitle({ text: "# Title\nbody", source: "folder/doc.md" })).toBe("doc");
    expect(inferDocType("price-list.csv", "报价价目表")).toBe("pricing");
  });
});
