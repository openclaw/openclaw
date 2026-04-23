import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("bundled agent-audit skill", () => {
  it("ships the structured audit references and key artifact guidance", () => {
    const skillPath = path.join(REPO_ROOT, "skills", "agent-audit", "SKILL.md");
    const schemaPath = path.join(
      REPO_ROOT,
      "skills",
      "agent-audit",
      "references",
      "report-schema.json",
    );
    const examplePath = path.join(
      REPO_ROOT,
      "skills",
      "agent-audit",
      "references",
      "example-report.json",
    );

    const skill = fs.readFileSync(skillPath, "utf8");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
    const example = JSON.parse(fs.readFileSync(examplePath, "utf8")) as Record<string, unknown>;

    expect(skill).toContain("agent_check_scope.json");
    expect(skill).toContain("evidence_pack.json");
    expect(skill).toContain("failure_map.json");
    expect(skill).toContain("agent_check_report.json");
    expect(skill).toContain("wrapper-regression");
    expect(skill).toContain("{baseDir}/references/report-schema.json");

    expect(schema["schema_version"]).toBe("agent-audit.report.v1");
    expect(example["schema_version"]).toBe("agent-audit.report.v1");
    expect(example).toHaveProperty("ordered_fix_plan");
  });
});
