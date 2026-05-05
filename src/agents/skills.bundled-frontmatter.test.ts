import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./skills/frontmatter.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("bundled skill frontmatter", () => {
  it("keeps selected bundled skills parseable from their shipped files", async () => {
    const skillPaths = [
      ["skills/etsy-shop-operator/SKILL.md", "etsy-shop-operator"],
      ["skills/taskflow/SKILL.md", "taskflow"],
      ["skills/taskflow-inbox-triage/SKILL.md", "taskflow-inbox-triage"],
    ] as const;

    for (const [relativePath, expectedName] of skillPaths) {
      const raw = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
      const frontmatter = parseFrontmatter(raw);

      expect(frontmatter.name, relativePath).toBe(expectedName);
      expect(frontmatter.description, relativePath).toBeTruthy();
    }
  });

  it("keeps the Etsy shop operator skill bounded by explicit approval gates", async () => {
    const raw = await fs.readFile(
      path.join(repoRoot, "skills/etsy-shop-operator/SKILL.md"),
      "utf8",
    );

    expect(raw).toContain(
      "Do not guarantee sales, ranking, ad performance, or marketplace outcomes.",
    );
    expect(raw).toContain(
      "If the user says not to ask for approval, that does not override the gates above.",
    );
    expect(raw).toContain("No ad spend or budget changes without explicit approval.");
    expect(raw).toContain(
      "Live account changes, customer contact, spend, purchases, hiring, and legal/tax actions remain approval-gated.",
    );
  });
});
