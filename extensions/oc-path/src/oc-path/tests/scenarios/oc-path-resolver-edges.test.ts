// OC Path tests cover oc path resolver edges plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";
import { resolveMdOcPath as resolveOcPath } from "../../resolve.js";

const SAMPLE = `---
name: github
---
## Tools
- gh: GitHub CLI
`;

describe("oc-path-resolver-edges", () => {
  const ast = parseMd(SAMPLE);

  it("field that does not match kv.key returns null", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "tools",
      item: "gh",
      field: "nonexistent",
    });
    expect(m).toBeNull();
  });

  it("frontmatter unknown key returns null", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "[frontmatter]",
      field: "nonexistent",
    });
    expect(m).toBeNull();
  });

  it("frontmatter without field returns null", () => {
    const m = resolveOcPath(ast, {
      file: "X.md",
      section: "[frontmatter]",
    });
    expect(m).toBeNull();
  });

  it("multiple frontmatter keys with same name — first match wins", () => {
    const dupeAst = {
      kind: "md" as const,
      raw: "",
      frontmatter: [
        { key: "k", value: "first", line: 2 },
        { key: "k", value: "second", line: 3 },
      ],
      preamble: "",
      blocks: [],
    };
    const m = resolveOcPath(dupeAst, {
      file: "X.md",
      section: "[frontmatter]",
      field: "k",
    });
    expect(m?.kind).toBe("frontmatter");
    if (m?.kind === "frontmatter") {
      expect(m.node.value).toBe("first");
    }
  });
});
