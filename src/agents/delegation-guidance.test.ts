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
      expect(resolveMainSessionDelegationMode({ config, agentId, sessionKey })).toBe(expected);
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
    ["hasVisibleSessionSpawn", "`sessions_spawn` with `visible=true`"],
    ["hasSessionsSend", "`sessions_send`"],
    ["hasSessionsYield", "`sessions_yield`"],
    ["hasSubagentsList", "`subagents(action=list)`"],
  ] as const)("mentions %s only when enabled", (flag, marker) => {
    expect(buildSection().join("\n")).toContain(marker);
    expect(buildSection({ [flag]: false }).join("\n")).not.toContain(marker);
  });

  it.each([
    [
      "minimal prompts, even with session creation",
      {
        isMinimal: true,
        sessionsCreateToolName: "sessions_create",
        suggestTaskToolName: "suggest_task",
      },
    ],
    ["suggest mode without session routing tools", { mode: "suggest" }],
    ["no usable delegation tool", { hiddenDelegationTool: "", hasVisibleSessionSpawn: false }],
  ] as const)("omits the section for %s", (_name, overrides) => {
    expect(buildSection(overrides)).toEqual([]);
  });
});
