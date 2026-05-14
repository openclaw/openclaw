import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importSpecFromSource } from "./importer.js";

async function makeSpecRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-center-import-"));
  const specDir = path.join(dir, "specs", "arkclaw-plugins-daily");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "daily.yaml"),
    [
      "id: arkclaw-plugins-daily-run",
      "title: ArkClaw plugins daily validation and repair",
      "type: daily_run",
      "status: approved",
      "version: 3",
      "owner:",
      "  team: arkclaw",
      "  maintainer: plugins-platform",
      "inputs:",
      "  - id: targetRepo",
      "    type: string",
      "    default: openclaw/openclaw",
      "steps:",
      "  - id: validate_api",
      "    type: tool_task",
      "    title: Run API validation",
      "    outputs:",
      "      - api_result",
      "  - id: validate_frontend",
      "    type: tool_task",
      "    title: Run frontend validation",
      "    outputs:",
      "      - frontend_result",
      "  - id: diagnose_failures",
      "    type: agent_task",
      "    title: Diagnose failed lanes",
      "    dependsOn:",
      "      - validate_api",
      "      - validate_frontend",
      "    outputs:",
      "      - diagnosis_report",
      "  - id: approve_submit",
      "    type: approval",
      "    title: Approve code submission",
      "    dependsOn:",
      "      - diagnose_failures",
      "  - id: publish_daily_report",
      "    type: notify",
      "    title: Publish daily report",
      "    dependsOn:",
      "      - approve_submit",
      "",
    ].join("\n"),
  );
  return { dir, specDir };
}

describe("importSpecFromSource", () => {
  it("imports an arkclaw_plugins_spec-style legacy YAML as Markdown-first spec metadata", async () => {
    const { dir } = await makeSpecRepo();

    const result = await importSpecFromSource({
      id: "arkclaw-plugins-daily-run",
      repo: dir,
      path: "specs/arkclaw-plugins-daily",
      targetRepo: "openclaw/openclaw",
    });

    expect(result.spec).toMatchObject({
      id: "arkclaw-plugins-daily-run",
      title: "ArkClaw plugins daily validation and repair",
      type: "daily_run",
      status: "approved",
      targetRepo: "openclaw/openclaw",
      owner: {
        team: "arkclaw",
        maintainer: "plugins-platform",
      },
    });
    expect(result.spec.artifacts.map((artifact) => artifact.name)).toEqual([
      "overview.md",
      "requirements.md",
      "design.md",
      "tasks.md",
      "coverage.md",
      "runbook.md",
    ]);
    expect(result.spec.warnings.map((warning) => warning.code)).toContain("legacy_yaml_imported");
    expect(result.preview.waves.map((wave) => wave.steps)).toEqual([
      ["validate_api", "validate_frontend"],
      ["diagnose_failures"],
      ["approve_submit"],
      ["publish_daily_report"],
    ]);
    expect(result.check.ok).toBe(true);
  });
});
