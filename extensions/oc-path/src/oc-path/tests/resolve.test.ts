// OC Path tests cover resolve plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../parse.js";
import { resolveMdOcPath as resolveOcPath } from "../resolve.js";

const SAMPLE = `---
name: github
description: gh CLI
---

Preamble.

## Boundaries

- never write to /etc
- deny: secrets

## Tools

- gh: GitHub CLI
- curl: HTTP client
`;

describe("resolveOcPath", () => {
  const { ast } = parseMd(SAMPLE);

  it("resolves frontmatter via [frontmatter] sentinel section", () => {
    const m = resolveOcPath(ast, {
      file: "AGENTS.md",
      section: "[frontmatter]",
      field: "name",
    });
    expect(m?.kind).toBe("frontmatter");
    if (m?.kind === "frontmatter") {
      expect(m.node.value).toBe("github");
    }
  });

  it("returns null for unknown item", () => {
    const m = resolveOcPath(ast, {
      file: "AGENTS.md",
      section: "tools",
      item: "nonexistent",
    });
    expect(m).toBeNull();
  });

  it("returns null for field on non-kv item", () => {
    const m = resolveOcPath(ast, {
      file: "AGENTS.md",
      section: "boundaries",
      item: "never-write-to-etc",
      field: "risk",
    });
    expect(m).toBeNull();
  });
});
