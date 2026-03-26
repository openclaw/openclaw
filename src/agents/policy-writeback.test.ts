import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyFailureRuleSuggestionToPolicy } from "./policy-writeback.js";

describe("applyFailureRuleSuggestionToPolicy", () => {
  it("creates OPENCLAW.md by default and writes the selected rule", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-writeback-"));
    try {
      const result = await applyFailureRuleSuggestionToPolicy({
        workspaceDir,
        suggestion: {
          key: "verify-before-final",
          title: "Verify before final reply",
          rule: "Run the smallest relevant verification command before claiming success.",
          evidence: "1/1 verification checks failed",
        },
      });

      expect(result.created).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.targetName).toBe("OPENCLAW.md");
      const persisted = await fs.readFile(path.join(workspaceDir, "OPENCLAW.md"), "utf-8");
      expect(persisted).toContain("## Harness Rules");
      expect(persisted).toContain("<!-- harness-rule:verify-before-final -->");
      expect(persisted).toContain(
        "- Run the smallest relevant verification command before claiming success.",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("avoids duplicating an already-applied rule", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-writeback-"));
    try {
      await fs.writeFile(
        path.join(workspaceDir, "OPENCLAW.md"),
        [
          "# OPENCLAW.md",
          "",
          "## Harness Rules",
          "",
          "<!-- harness-rule:verify-before-final -->",
          "- Run the smallest relevant verification command before claiming success.",
          "",
        ].join("\n"),
        "utf-8",
      );

      const result = await applyFailureRuleSuggestionToPolicy({
        workspaceDir,
        suggestion: {
          key: "verify-before-final",
          title: "Verify before final reply",
          rule: "Run the smallest relevant verification command before claiming success.",
          evidence: "1/1 verification checks failed",
        },
      });

      expect(result.duplicate).toBe(true);
      expect(result.applied).toBe(false);
      const persisted = await fs.readFile(path.join(workspaceDir, "OPENCLAW.md"), "utf-8");
      expect(persisted.match(/verify-before-final/g)?.length).toBe(1);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
