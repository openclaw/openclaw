import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "../../agent-tools.js";
import { resolveEmbeddedAttemptToolConstructionPlan } from "./attempt-tool-construction-plan.js";

describe("cron isolated session tool construction with messaging profile", () => {
  it("wildcard allowlist overrides messaging profile for tool construction plan", () => {
    const plan = resolveEmbeddedAttemptToolConstructionPlan({
      toolsAllow: ["*"],
    });

    expect(plan.constructTools).toBe(true);
    expect(plan.includeCoreTools).toBe(true);
    expect(plan.codingToolConstructionPlan.includeBaseCodingTools).toBe(true);
    expect(plan.codingToolConstructionPlan.includeShellTools).toBe(true);
    expect(plan.codingToolConstructionPlan.includeOpenClawTools).toBe(true);
    expect(plan.runtimeToolAllowlist).toEqual(["*"]);
  });

  it("messaging profile without wildcard excludes shell tools from plan", () => {
    const plan = resolveEmbeddedAttemptToolConstructionPlan({
      toolsAllow: ["message", "sessions_send"],
    });

    expect(plan.constructTools).toBe(true);
    expect(plan.codingToolConstructionPlan.includeBaseCodingTools).toBe(false);
    expect(plan.codingToolConstructionPlan.includeShellTools).toBe(false);
    expect(plan.codingToolConstructionPlan.includeOpenClawTools).toBe(true);
  });

  it("createOpenClawCodingTools includes exec with wildcard + messaging profile", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
      trigger: "cron",
      jobId: "proof-test-job",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("process");
  });

  it("createOpenClawCodingTools excludes exec with messaging profile only", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      trigger: "cron",
      jobId: "proof-test-job",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("process");
  });

  it("non-cron trigger with wildcard does not override messaging profile", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
      trigger: "interactive",
      jobId: "proof-test-job",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("process");
  });

  it("process tool presence under cron wildcard implies allowBackground consistency", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
      trigger: "cron",
      jobId: "proof-test-job",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("process");
  });
});
