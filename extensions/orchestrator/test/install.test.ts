import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FLEET_ORCHESTRATOR_AGENT_ID, ensureAgentInstalled } from "../src/install.js";

let tmpRoot: string;
let agentsDir: string;
let templateDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orchestrator-install-"));
  agentsDir = join(tmpRoot, "agents");
  templateDir = join(tmpRoot, "template");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "IDENTITY.md"), "# Fleet Orchestrator\n");
  writeFileSync(join(templateDir, "README.md"), "# template-only — should be skipped\n");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ensureAgentInstalled", () => {
  test("creates the agent dir and copies IDENTITY.md on a clean home", () => {
    const result = ensureAgentInstalled({ agentsDir, templateDir });
    expect(result.copied).toEqual(["IDENTITY.md"]);
    expect(result.skipped).toEqual([]);
    const expectedPath = resolve(agentsDir, FLEET_ORCHESTRATOR_AGENT_ID, "agent", "IDENTITY.md");
    expect(readFileSync(expectedPath, "utf8")).toContain("Fleet Orchestrator");
  });

  test("skips files that already exist (idempotent)", () => {
    ensureAgentInstalled({ agentsDir, templateDir });
    // Operator edits the live copy.
    const live = resolve(agentsDir, FLEET_ORCHESTRATOR_AGENT_ID, "agent", "IDENTITY.md");
    writeFileSync(live, "# Edited by operator\n");

    const result = ensureAgentInstalled({ agentsDir, templateDir });
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(["IDENTITY.md"]);
    expect(readFileSync(live, "utf8")).toBe("# Edited by operator\n");
  });

  test("skips the template's README.md (template-only docs)", () => {
    const result = ensureAgentInstalled({ agentsDir, templateDir });
    expect(result.copied).not.toContain("README.md");
    expect(result.skipped).not.toContain("README.md");
  });

  test("walks nested template subdirectories", () => {
    mkdirSync(join(templateDir, "nested"), { recursive: true });
    writeFileSync(join(templateDir, "nested", "extra.txt"), "extra template content\n");
    const result = ensureAgentInstalled({ agentsDir, templateDir });
    expect(result.copied).toContain("nested/extra.txt");
    expect(
      readFileSync(
        resolve(agentsDir, FLEET_ORCHESTRATOR_AGENT_ID, "agent", "nested", "extra.txt"),
        "utf8",
      ),
    ).toBe("extra template content\n");
  });

  test("real shipped template installs IDENTITY.md (not the README)", () => {
    // No templateDir override: walks the real install/agent-template/ shipped
    // with the extension. Confirms the production path.
    const result = ensureAgentInstalled({ agentsDir });
    expect(result.copied).toContain("IDENTITY.md");
    expect(result.copied).not.toContain("README.md");
  });
});
