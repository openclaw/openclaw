import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./skills/frontmatter.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("bundled skill frontmatter", () => {
  it("keeps selected bundled skills parseable from their shipped files", async () => {
    const skillPaths = [
      "skills/coe-root-cause/SKILL.md",
      "skills/taskflow/SKILL.md",
      "skills/taskflow-inbox-triage/SKILL.md",
    ] as const;

    for (const relativePath of skillPaths) {
      const raw = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
      const frontmatter = parseFrontmatter(raw);

      expect(frontmatter.name, relativePath).toBeTypeOf("string");
      expect(frontmatter.name?.trim(), relativePath).not.toBe("");
      expect(frontmatter.description, relativePath).toBeTypeOf("string");
      expect(frontmatter.description?.trim(), relativePath).not.toBe("");
    }
  });
});
