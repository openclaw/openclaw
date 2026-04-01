import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./skills/frontmatter.js";

describe("atlas-delivery bundled skill", () => {
  it("describes Atlas-backed coordination instead of direct code ownership", () => {
    const skillPath = path.join(process.cwd(), "skills", "atlas-delivery", "SKILL.md");
    const raw = fs.readFileSync(skillPath, "utf-8");
    const frontmatter = parseFrontmatter(raw);
    const description = String(frontmatter.description || "");
    const normalizedRaw = raw.toLowerCase();

    expect(description.toLowerCase()).toContain("atlas");
    expect(description.toLowerCase()).toContain("atlas_inspect");
    expect(description.toLowerCase()).toContain("atlas_execution");
    expect(description.toLowerCase()).toContain("not for direct code editing");
    expect(normalizedRaw).toContain("show the user a short brief");
    expect(raw).toContain("Do not promise to push code");
    expect(raw).toContain("no_files_changed");
    expect(raw).toContain("homio/core");
    expect(raw).toContain("do not ask which repo or branch to use");
    expect(raw).toContain("do not propose a local/manual fallback path");
  });

  it("ships the detailed Atlas contract reference", () => {
    const referencePath = path.join(
      process.cwd(),
      "skills",
      "atlas-delivery",
      "references",
      "atlas-contract.md",
    );
    const raw = fs.readFileSync(referencePath, "utf-8");

    expect(raw).toContain("atlas_inspect");
    expect(raw).toContain("atlas_execution");
    expect(raw).toContain("/api/a2a/tasks");
    expect(raw).toContain("/api/runtime/work-threads/by-topic");
    expect(raw).toContain("OpenClaw");
    expect(raw).toContain("Atlas");
    expect(raw).toContain("implementation work targets `homio/core`");
    expect(raw).toContain("returns infrastructure errors such as `503`");
  });
});
