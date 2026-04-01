/**
 * Skill Inventory Merge Tests
 *
 * Validates that `skill_inventory` merges OpenClaw platform skills
 * alongside Capabilities.md entries in the generated Skill.md.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "vitest";
import { createBdiTools } from "../src/tools/bdi-tools.js";

// ── Mock OpenClawPluginApi ──

function createMockApi(opts: {
  workspace: string;
  skills?: Array<{ name: string; primaryEnv?: string }>;
  hasGetSkillSnapshot?: boolean;
}) {
  const base: Record<string, any> = {
    id: "mabos-test",
    name: "MABOS Test",
    version: "0.1.0",
    description: "Test instance",
    source: "test",
    config: {
      agents: {
        defaults: {
          workspace: opts.workspace,
        },
      },
    },
    pluginConfig: {},
    runtime: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    registerTool: () => {},
    registerHook: () => {},
    registerHttpHandler: () => {},
    registerHttpRoute: () => {},
    registerChannel: () => {},
    registerGatewayMethod: () => {},
    registerCli: () => {},
    registerService: () => {},
    registerProvider: () => {},
    registerCommand: () => {},
    resolvePath: (p: string) => p,
    on: () => {},
  };

  if (opts.hasGetSkillSnapshot !== false) {
    base.getSkillSnapshot = () => ({
      prompt: "",
      skills: opts.skills ?? [],
    });
  }

  return base;
}

// ── Tests ──

describe("skill_inventory — OpenClaw skill merge", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mabos-skill-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("includes OpenClaw skills in generated Skill.md", async () => {
    // Set up agent workspace with Capabilities.md
    const agentDir = join(tmpDir, "agents", "test-agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "Capabilities.md"),
      `# Capabilities

- Financial analysis
- Report generation
`,
      "utf-8",
    );

    const api = createMockApi({
      workspace: tmpDir,
      skills: [{ name: "web-search", primaryEnv: "browser" }, { name: "code-execution" }],
    });

    const tools = createBdiTools(api as any);
    const skillInventory = tools.find((t) => t.name === "skill_inventory");
    assert.ok(skillInventory, "skill_inventory tool should exist");

    const result = await skillInventory.execute("test-call", { agent_id: "test-agent" });

    // Verify return message includes OpenClaw count
    const resultText = result.content[0].text;
    assert.ok(
      resultText.includes("2 OpenClaw skills"),
      `Result should mention 2 OpenClaw skills, got: ${resultText}`,
    );
    assert.ok(
      resultText.includes("2 capabilities"),
      `Result should mention 2 capabilities, got: ${resultText}`,
    );

    // Verify Skill.md content
    const skillMd = await readFile(join(agentDir, "Skill.md"), "utf-8");

    // Should have the Skill Registry section with capabilities
    assert.ok(skillMd.includes("## Skill Registry"), "Should have Skill Registry section");
    assert.ok(skillMd.includes("Financial analysis"), "Should include capability entries");
    assert.ok(skillMd.includes("Report generation"), "Should include capability entries");

    // Should have the OpenClaw Skills section
    assert.ok(skillMd.includes("## OpenClaw Skills"), "Should have OpenClaw Skills section");
    assert.ok(skillMd.includes("web-search"), "Should include OpenClaw skill name");
    assert.ok(skillMd.includes("(browser)"), "Should include primaryEnv annotation");
    assert.ok(skillMd.includes("code-execution"), "Should include second OpenClaw skill");
    assert.ok(skillMd.includes("openclaw-skill"), "Should mark source as openclaw-skill");

    // Should have the Notes section with OpenClaw info
    assert.ok(
      skillMd.includes("OpenClaw eligible skills: web-search, code-execution"),
      "Notes should list OpenClaw skills",
    );

    // Verify SK IDs are sequential across both sections
    assert.ok(skillMd.includes("SK-001"), "First capability should be SK-001");
    assert.ok(skillMd.includes("SK-002"), "Second capability should be SK-002");
    assert.ok(skillMd.includes("SK-003"), "First OpenClaw skill should be SK-003");
    assert.ok(skillMd.includes("SK-004"), "Second OpenClaw skill should be SK-004");
  });

  it("gracefully handles missing getSkillSnapshot", async () => {
    // Set up agent workspace with Capabilities.md
    const agentDir = join(tmpDir, "agents", "test-agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "Capabilities.md"),
      `# Capabilities

- Data processing
`,
      "utf-8",
    );

    // API without getSkillSnapshot
    const api = createMockApi({
      workspace: tmpDir,
      hasGetSkillSnapshot: false,
    });

    const tools = createBdiTools(api as any);
    const skillInventory = tools.find((t) => t.name === "skill_inventory");
    assert.ok(skillInventory, "skill_inventory tool should exist");

    // Should not throw
    const result = await skillInventory.execute("test-call", { agent_id: "test-agent" });

    // Verify return message shows 0 OpenClaw skills
    const resultText = result.content[0].text;
    assert.ok(
      resultText.includes("0 OpenClaw skills"),
      `Result should mention 0 OpenClaw skills, got: ${resultText}`,
    );

    // Verify Skill.md content
    const skillMd = await readFile(join(agentDir, "Skill.md"), "utf-8");

    // Should have the Skill Registry section
    assert.ok(skillMd.includes("## Skill Registry"), "Should have Skill Registry section");
    assert.ok(skillMd.includes("Data processing"), "Should include capability entry");

    // Should NOT have OpenClaw Skills section
    assert.ok(
      !skillMd.includes("## OpenClaw Skills"),
      "Should NOT have OpenClaw Skills section when no snapshot",
    );

    // Notes should say none for OpenClaw
    assert.ok(
      skillMd.includes("OpenClaw eligible skills: none"),
      "Notes should say 'none' for OpenClaw skills",
    );
  });

  it("gracefully handles getSkillSnapshot that throws", async () => {
    // Set up agent workspace
    const agentDir = join(tmpDir, "agents", "test-agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "Capabilities.md"),
      `# Capabilities

- Basic capability
`,
      "utf-8",
    );

    // API with a getSkillSnapshot that throws
    const api = createMockApi({
      workspace: tmpDir,
    });
    api.getSkillSnapshot = () => {
      throw new Error("Snapshot service unavailable");
    };

    const tools = createBdiTools(api as any);
    const skillInventory = tools.find((t) => t.name === "skill_inventory");
    assert.ok(skillInventory, "skill_inventory tool should exist");

    // Should not throw despite getSkillSnapshot throwing
    const result = await skillInventory.execute("test-call", { agent_id: "test-agent" });

    const resultText = result.content[0].text;
    assert.ok(
      resultText.includes("0 OpenClaw skills"),
      `Should gracefully degrade to 0 OpenClaw skills, got: ${resultText}`,
    );

    const skillMd = await readFile(join(agentDir, "Skill.md"), "utf-8");
    assert.ok(
      !skillMd.includes("## OpenClaw Skills"),
      "Should NOT have OpenClaw Skills section when snapshot throws",
    );
  });
});
