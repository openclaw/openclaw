import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

type ThinkingLevel = "high" | "medium" | "low";

function expectResolvedThinkingPlan(input: {
  expected: ThinkingLevel;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
  targetAgentConfig?: unknown;
  cfg?: OpenClawConfig;
}) {
  const cfg =
    input.cfg ??
    ({
      session: { mainKey: "main", scope: "per-sender" },
      agents: { defaults: { subagents: { thinking: "high" } } },
    } as OpenClawConfig);

  const plan = resolveSubagentThinkingOverride({
    cfg,
    targetAgentConfig: input.targetAgentConfig,
    thinkingOverrideRaw: input.thinkingOverrideRaw,
    callerThinkingRaw: input.callerThinkingRaw,
  });

  expect(plan).toEqual({
    status: "ok",
    thinkingOverride: input.expected,
    initialSessionPatch: { thinkingLevel: input.expected },
  });
}

describe("sessions_spawn thinking defaults", () => {
  it("applies agents.defaults.subagents.thinking when thinking is omitted", () => {
    expectResolvedThinkingPlan({
      expected: "high",
    });
  });

  it("prefers explicit sessions_spawn.thinking over config default", () => {
    expectResolvedThinkingPlan({
      thinkingOverrideRaw: "low",
      expected: "low",
    });
  });

  it("prefers per-agent subagent thinking over global subagent thinking", () => {
    expectResolvedThinkingPlan({
      targetAgentConfig: { subagents: { thinking: "medium" } },
      expected: "medium",
    });
  });

  it("inherits caller thinking when no explicit or configured subagent thinking exists", () => {
    expectResolvedThinkingPlan({
      cfg: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: {} },
      } as OpenClawConfig,
      callerThinkingRaw: "medium",
      expected: "medium",
    });
  });

  it("prefers global subagent thinking over caller thinking", () => {
    expectResolvedThinkingPlan({
      callerThinkingRaw: "medium",
      expected: "high",
    });
  });
});
