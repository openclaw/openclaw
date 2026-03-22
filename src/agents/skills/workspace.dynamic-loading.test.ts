// Authored by: cc (Claude Code) | 2026-03-22
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillSnapshot } from "./types.js";
import { resolveSkillsPromptForRun } from "./workspace.js";

/** Minimal Skill shape that satisfies the pi-coding-agent Skill interface. */
function makeSkill(name: string, filePath: string) {
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: filePath.replace("/SKILL.md", ""),
    source: "test",
    disableModelInvocation: false,
  };
}

const purchaseSkill = makeSkill("purchase-skill", "/skills/purchase/SKILL.md");
const taskSkill = makeSkill("task-manager", "/skills/tasks/SKILL.md");
const coachSkill = makeSkill("life-coach", "/skills/coach/SKILL.md");

/** Snapshot with 3 skills: purchase (triggers), task (triggers), coach (no triggers). */
const snapshot: SkillSnapshot = {
  prompt: "PRE_BUILT_SNAPSHOT_PROMPT",
  skills: [
    { name: "purchase-skill", triggers: ["buy", "order", "checkout"] },
    { name: "task-manager", triggers: ["task", "remind", "due"] },
    { name: "life-coach" }, // no triggers — always full
  ],
  resolvedSkills: [purchaseSkill, taskSkill, coachSkill],
};

const configEnabled: OpenClawConfig = {
  skills: { dynamicLoading: { enabled: true } },
} as unknown as OpenClawConfig;

const configDisabled: OpenClawConfig = {
  skills: { dynamicLoading: { enabled: false } },
} as unknown as OpenClawConfig;

describe("resolveSkillsPromptForRun — dynamic loading disabled (default)", () => {
  it("returns snapshot prompt unchanged when dynamicLoading is disabled", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snapshot,
      workspaceDir: "/tmp",
      config: configDisabled,
      messageText: "buy something",
    });
    expect(prompt).toBe("PRE_BUILT_SNAPSHOT_PROMPT");
  });

  it("returns snapshot prompt unchanged when config is absent", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snapshot,
      workspaceDir: "/tmp",
      messageText: "buy something",
    });
    expect(prompt).toBe("PRE_BUILT_SNAPSHOT_PROMPT");
  });

  it("returns snapshot prompt when messageText is absent", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snapshot,
      workspaceDir: "/tmp",
      config: configEnabled,
    });
    expect(prompt).toBe("PRE_BUILT_SNAPSHOT_PROMPT");
  });
});

describe("resolveSkillsPromptForRun — dynamic loading enabled", () => {
  it("trigger-matched skill gets full content (<description> present)", () => {
    // "buy" matches purchase-skill triggers
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snapshot,
      workspaceDir: "/tmp",
      config: configEnabled,
      messageText: "I want to buy something",
    });
    // purchase-skill is matched → full format includes <description>
    expect(prompt).toContain("purchase-skill description");
    expect(prompt).toContain("/skills/purchase/SKILL.md");
  });

  it("trigger-unmatched skill appears in compact listing (no <description>)", () => {
    // "buy" matches purchase-skill but NOT task-manager
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snapshot,
      workspaceDir: "/tmp",
      config: configEnabled,
      messageText: "I want to buy something",
    });
    // task-manager unmatched → compact only; description NOT in prompt
    expect(prompt).not.toContain("task-manager description");
    // but location IS present (compact listing)
    expect(prompt).toContain("/skills/tasks/SKILL.md");
  });

  it("skill without triggers is always fully injected", () => {
    // message has no purchase or task keywords — only life-coach has no triggers
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snapshot,
      workspaceDir: "/tmp",
      config: configEnabled,
      messageText: "just chatting",
    });
    // life-coach has no triggers → always full
    expect(prompt).toContain("life-coach description");
    expect(prompt).toContain("/skills/coach/SKILL.md");
  });

  it("multi-intent message matches multiple triggered skills", () => {
    // "buy" + "task" match both purchase-skill and task-manager
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snapshot,
      workspaceDir: "/tmp",
      config: configEnabled,
      messageText: "buy groceries and add a task",
    });
    expect(prompt).toContain("purchase-skill description");
    expect(prompt).toContain("task-manager description");
    expect(prompt).toContain("life-coach description"); // no triggers = always full
  });

  it("no trigger match → all triggered skills shown compact, no-trigger skills full", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snapshot,
      workspaceDir: "/tmp",
      config: configEnabled,
      messageText: "hello world",
    });
    // triggered skills not matched → compact (no description)
    expect(prompt).not.toContain("purchase-skill description");
    expect(prompt).not.toContain("task-manager description");
    // but locations present in compact listing
    expect(prompt).toContain("/skills/purchase/SKILL.md");
    expect(prompt).toContain("/skills/tasks/SKILL.md");
    // life-coach always full
    expect(prompt).toContain("life-coach description");
  });

  it("returns empty string when snapshot has no resolvedSkills", () => {
    const emptySnapshot: SkillSnapshot = {
      prompt: "PROMPT",
      skills: [{ name: "purchase-skill", triggers: ["buy"] }],
      resolvedSkills: [],
    };
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: emptySnapshot,
      workspaceDir: "/tmp",
      config: configEnabled,
      messageText: "buy something",
    });
    // resolvedSkills is empty → falls back to snapshot prompt (no partition to build)
    expect(prompt).toBe("PROMPT");
  });
});

describe("parseTriggersFromFrontmatter (via snapshot)", () => {
  it("trigger matching is case-insensitive", () => {
    const snap: SkillSnapshot = {
      prompt: "PROMPT",
      skills: [{ name: "purchase-skill", triggers: ["BUY", "Order"] }],
      resolvedSkills: [purchaseSkill],
    };
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snap,
      workspaceDir: "/tmp",
      config: configEnabled,
      messageText: "buy something",
    });
    // "buy" matches "BUY" case-insensitively → full content
    expect(prompt).toContain("purchase-skill description");
  });
});
