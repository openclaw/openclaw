import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildDelegationGuidanceSection,
  resolveMainSessionDelegationMode,
} from "./delegation-guidance.js";

function delegationConfig(
  delegationMode: "prefer" | "suggest",
  agentMode?: "prefer" | "suggest",
  agentId = "main",
): OpenClawConfig {
  return {
    agents: {
      defaults: { subagents: { delegationMode } },
      ...(agentMode
        ? { entries: { [agentId]: { subagents: { delegationMode: agentMode } } } }
        : {}),
    },
  };
}

describe("resolveMainSessionDelegationMode", () => {
  it.each([
    ["agent:main:main", "prefer"],
    ["agent:main:slack:channel:C01234567", "suggest"],
    ["agent:main:inbox", "prefer", { session: { mainKey: "inbox" } }],
    ["global", "prefer", { session: { scope: "global" } }],
    ["agent:main:dashboard:project", "prefer", delegationConfig("prefer")],
    ["agent:main:main", "suggest", delegationConfig("suggest")],
    [
      "agent:coordinator:dashboard:project",
      "prefer",
      delegationConfig("suggest", "prefer", "coordinator"),
      "coordinator",
    ],
    ["agent:main:main", "suggest", delegationConfig("prefer", "suggest")],
  ] satisfies [string, "prefer" | "suggest", OpenClawConfig?, string?][])(
    "resolves %s to %s",
    (sessionKey, expected, config = {}, agentId = "main") => {
      expect(
        resolveMainSessionDelegationMode({
          config,
          agentId,
          sessionKey,
        }),
      ).toBe(expected);
    },
  );
});

describe("buildDelegationGuidanceSection", () => {
  const buildSection = (
    overrides: Partial<Parameters<typeof buildDelegationGuidanceSection>[0]> = {},
  ) =>
    buildDelegationGuidanceSection({
      mode: "prefer",
      isMinimal: false,
      hiddenDelegationTool: "native `spawn_agent`",
      hasVisibleSessionSpawn: true,
      hasSessionsYield: true,
      hasSubagentsList: true,
      hasSessionsSend: true,
      ...overrides,
    });

  it.each(["`sessions_spawn`", "native `spawn_agent`"])("injects %s", (hiddenDelegationTool) => {
    expect(buildSection({ hiddenDelegationTool }).join("\n")).toContain(
      `delegate via ${hiddenDelegationTool}`,
    );
  });

  it.each([
    { flag: "hasVisibleSessionSpawn", marker: "`sessions_spawn` with `visible=true`" },
    { flag: "hasSessionsSend", marker: "`sessions_send`" },
    { flag: "hasSessionsYield", marker: "`sessions_yield`" },
    { flag: "hasSubagentsList", marker: "`subagents(action=list)`" },
  ] as const)("mentions $marker only when $flag", ({ flag, marker }) => {
    expect(buildSection().join("\n")).toContain(marker);
    expect(buildSection({ [flag]: false }).join("\n")).not.toContain(marker);
  });

  it.each([
    {
      name: "minimal prompts, even with session creation",
      overrides: {
        isMinimal: true,
        sessionsCreateToolName: "sessions_create",
        suggestTaskToolName: "suggest_task",
      },
    },
    { name: "suggest mode without session routing tools", overrides: { mode: "suggest" as const } },
    {
      name: "no usable delegation tool",
      overrides: { hiddenDelegationTool: "", hasVisibleSessionSpawn: false },
    },
  ])("omits the section for $name", ({ overrides }) => {
    expect(buildSection(overrides)).toEqual([]);
  });
});
