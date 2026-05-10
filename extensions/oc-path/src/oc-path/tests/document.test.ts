import { describe, expect, it } from "vitest";
import { OcDocumentKindError, emitOcDocument, parseOcDocument } from "../document.js";

describe("parseOcDocument", () => {
  it("infers markdown from filename", () => {
    const parsed = parseOcDocument("## Tools\n\n- gh: GitHub\n", { fileName: "TOOLS.md" });

    expect(parsed.kind).toBe("md");
    expect(parsed.ast.kind).toBe("md");
    expect(parsed.ast.blocks[0]?.slug).toBe("tools");
  });

  it("infers jsonc from filename", () => {
    const parsed = parseOcDocument('{ "enabled": true }\n', { fileName: "policy.jsonc" });

    expect(parsed.kind).toBe("jsonc");
    expect(parsed.ast.kind).toBe("jsonc");
    expect(parsed.diagnostics).toHaveLength(0);
  });

  it("infers jsonl from filename", () => {
    const parsed = parseOcDocument('{"event":"start"}\n', { fileName: "session.jsonl" });

    expect(parsed.kind).toBe("jsonl");
    expect(parsed.ast.kind).toBe("jsonl");
    expect(parsed.diagnostics).toHaveLength(0);
  });

  it("lets callers override the filename-inferred kind", () => {
    const parsed = parseOcDocument('{ "enabled": true }\n', {
      fileName: "policy.txt",
      kind: "jsonc",
    });

    expect(parsed.kind).toBe("jsonc");
    expect(parsed.ast.kind).toBe("jsonc");
  });

  it("throws when kind cannot be inferred", () => {
    expect(() => parseOcDocument("value", { fileName: "policy.txt" })).toThrow(OcDocumentKindError);
  });
});

describe("emitOcDocument", () => {
  it("dispatches emit by AST kind", () => {
    const parsed = parseOcDocument('{ "enabled": true }\n', { fileName: "policy.jsonc" });

    expect(emitOcDocument(parsed.ast)).toBe('{ "enabled": true }\n');
  });
});
