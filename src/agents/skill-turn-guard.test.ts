import { beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  detectSkillNameFromBody,
  evaluateSkillTurnToolCall,
  setActiveSkillTurn,
} from "./skill-turn-guard.js";

describe("skill turn guard", () => {
  beforeEach(() => {
    __testing.ACTIVE_SKILL_TURNS.clear();
  });

  it("blocks mission spawn for delegate turn before delegate_run", () => {
    setActiveSkillTurn({ sessionKey: "main", skillName: "delegate" });

    const reason = evaluateSkillTurnToolCall({
      sessionKey: "main",
      toolName: "spawn_sequential_mission",
      toolParams: {},
    });

    expect(reason).toContain("delegate_run");
  });

  it("allows mission spawn after delegate_run workflow call", () => {
    setActiveSkillTurn({ sessionKey: "main", skillName: "delegate" });
    const planReason = evaluateSkillTurnToolCall({
      sessionKey: "main",
      toolName: "workflows.run_workflow",
      toolParams: { name: "delegate_run", inputs: { request: "test" } },
    });
    const spawnReason = evaluateSkillTurnToolCall({
      sessionKey: "main",
      toolName: "spawn_sequential_mission",
      toolParams: {},
    });

    expect(planReason).toBeNull();
    expect(spawnReason).toBeNull();
  });

  it("does not enforce delegate guard for non-delegate skills", () => {
    setActiveSkillTurn({ sessionKey: "main", skillName: "summarize" });

    const reason = evaluateSkillTurnToolCall({
      sessionKey: "main",
      toolName: "spawn_parallel_mission",
      toolParams: {},
    });

    expect(reason).toBeNull();
  });

  it("detects skill from rewritten body form", () => {
    expect(
      detectSkillNameFromBody('Use the "delegate" skill for this request.\n\nUser input:\nfoo'),
    ).toBe("delegate");
  });

  it("detects skill from slash form", () => {
    expect(detectSkillNameFromBody("/delegate check shopee sales")).toBe("delegate");
  });

  it("normalizes legacy task-delegation alias to delegate", () => {
    expect(detectSkillNameFromBody("/task_delegation check shopee sales")).toBe("delegate");
  });

  it("enforces guard when set/eval session keys differ by canonical form", () => {
    setActiveSkillTurn({ sessionKey: "agent:main:main", skillName: "delegate" });

    const reason = evaluateSkillTurnToolCall({
      sessionKey: "main",
      agentId: "main",
      toolName: "spawn_sequential_mission",
      toolParams: {},
    });

    expect(reason).toContain("delegate_run");
  });
});
