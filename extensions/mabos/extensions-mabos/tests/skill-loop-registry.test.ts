import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "vitest";
import { SkillCreator } from "../src/skill-loop/creator.js";
import { SkillNudge } from "../src/skill-loop/nudge.js";
import { SkillRegistry } from "../src/skill-loop/registry.js";

describe("SkillRegistry", () => {
  let skillDir: string;
  let registry: SkillRegistry;

  beforeEach(() => {
    skillDir = join(tmpdir(), `mabos-test-skills-${Date.now()}`);
    mkdirSync(join(skillDir, "test-skill"), { recursive: true });
    writeFileSync(join(skillDir, "test-skill", "SKILL.md"), "# Test Skill\nDoes testing things.");
    writeFileSync(
      join(skillDir, "test-skill", "manifest.json"),
      JSON.stringify({
        name: "test-skill",
        version: "1.0.0",
        description: "A test skill",
        author: "tester",
        tags: ["test", "example"],
        createdAt: "2026-01-01",
      }),
    );
    registry = new SkillRegistry([skillDir]);
  });

  afterEach(() => {
    try {
      rmSync(skillDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("scans and lists skills", async () => {
    await registry.scan();
    const skills = registry.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "test-skill");
  });

  it("gets skill by name", async () => {
    await registry.scan();
    const skill = registry.get("test-skill");
    assert.ok(skill);
    assert.equal(skill!.manifest.version, "1.0.0");
  });

  it("searches by query", async () => {
    await registry.scan();
    const results = registry.search("test");
    assert.equal(results.length, 1);
  });

  it("returns empty for no match", async () => {
    await registry.scan();
    const results = registry.search("nonexistent-xyz");
    assert.equal(results.length, 0);
  });
});

describe("SkillCreator", () => {
  it("proposes skill for successful multi-tool sessions", async () => {
    const registry = new SkillRegistry([]);
    const creator = new SkillCreator(registry);
    const proposal = await creator.proposeSkill({
      taskDescription: "Launch new product on Shopify",
      toolsUsed: ["shopify_create_product", "shopify_create_collection", "send_email"],
      outcome: "success",
      agentId: "cmo-agent",
    });
    assert.ok(proposal);
    assert.ok(proposal!.name.includes("launch"));
    assert.ok(proposal!.confidence > 0.5);
  });

  it("rejects failed sessions", async () => {
    const registry = new SkillRegistry([]);
    const creator = new SkillCreator(registry);
    const proposal = await creator.proposeSkill({
      taskDescription: "Failed task",
      toolsUsed: ["tool1", "tool2", "tool3"],
      outcome: "failure",
      agentId: "agent",
    });
    assert.equal(proposal, null);
  });

  it("rejects sessions with too few tools", async () => {
    const registry = new SkillRegistry([]);
    const creator = new SkillCreator(registry);
    const proposal = await creator.proposeSkill({
      taskDescription: "Simple task",
      toolsUsed: ["tool1"],
      outcome: "success",
      agentId: "agent",
    });
    assert.equal(proposal, null);
  });
});

describe("SkillNudge", () => {
  it("nudges after configured interval", async () => {
    const registry = new SkillRegistry([]);
    const creator = new SkillCreator(registry);
    const nudge = new SkillNudge(creator, 3);

    // Sessions 1-2: no nudge
    for (let i = 0; i < 2; i++) {
      const result = await nudge.onSessionEnd({
        taskDescription: "Some task",
        toolsUsed: ["a", "b", "c"],
        outcome: "success",
        agentId: "agent",
      });
      assert.equal(result, null);
    }

    // Session 3: nudge fires
    const result = await nudge.onSessionEnd({
      taskDescription: "Deploy new feature",
      toolsUsed: ["build", "test", "deploy"],
      outcome: "success",
      agentId: "cto-agent",
    });
    assert.ok(result);
    assert.ok(result!.name.includes("deploy"));
  });

  it("tracks session count", () => {
    const registry = new SkillRegistry([]);
    const creator = new SkillCreator(registry);
    const nudge = new SkillNudge(creator, 10);
    assert.equal(nudge.getSessionCount(), 0);
  });
});
