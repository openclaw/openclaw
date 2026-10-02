import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildDelegationGuidanceSection,
  resolveMainSessionDelegationMode,
} from "./delegation-guidance.js";

describe("resolveMainSessionDelegationMode", () => {
  it.each([
    {
      name: "canonical main session",
      config: {},
      agentId: "main",
      sessionKey: "agent:main:main",
      expected: "prefer",
    },
    {
      name: "non-main session",
      config: {},
      agentId: "main",
      sessionKey: "agent:main:slack:channel:C01234567",
      expected: "suggest",
    },
    {
      name: "custom main key",
      config: { session: { mainKey: "inbox" } },
      agentId: "main",
      sessionKey: "agent:main:inbox",
      expected: "prefer",
    },
    {
      name: "global session scope",
      config: { session: { scope: "global" } },
      agentId: "main",
      sessionKey: "global",
      expected: "prefer",
    },
    {
      name: "explicit default prefer outside main",
      config: { agents: { defaults: { subagents: { delegationMode: "prefer" } } } },
      agentId: "main",
      sessionKey: "agent:main:dashboard:project",
      expected: "prefer",
    },
    {
      name: "explicit default suggest in main",
      config: { agents: { defaults: { subagents: { delegationMode: "suggest" } } } },
      agentId: "main",
      sessionKey: "agent:main:main",
      expected: "suggest",
    },
    {
      name: "per-agent prefer overrides default suggest",
      config: {
        agents: {
          defaults: { subagents: { delegationMode: "suggest" } },
          list: [{ id: "coordinator", subagents: { delegationMode: "prefer" } }],
        },
      },
      agentId: "coordinator",
      sessionKey: "agent:coordinator:dashboard:project",
      expected: "prefer",
    },
    {
      name: "per-agent suggest overrides default prefer",
      config: {
        agents: {
          defaults: { subagents: { delegationMode: "prefer" } },
          list: [{ id: "main", subagents: { delegationMode: "suggest" } }],
        },
      },
      agentId: "main",
      sessionKey: "agent:main:main",
      expected: "suggest",
    },
  ] as const)("resolves $name", ({ config, agentId, sessionKey, expected }) => {
    expect(
      resolveMainSessionDelegationMode({
        config: config as OpenClawConfig,
        agentId,
        sessionKey,
      }),
    ).toBe(expected);
  });
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

  it.each([
    { hiddenDelegationTool: "`sessions_spawn`", expected: "delegate via `sessions_spawn`" },
    {
      hiddenDelegationTool: "native `spawn_agent`",
      expected: "delegate via native `spawn_agent`",
    },
  ])("injects $hiddenDelegationTool", ({ hiddenDelegationTool, expected }) => {
    expect(buildSection({ hiddenDelegationTool }).join("\n")).toContain(expected);
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
    { name: "minimal prompts", overrides: { isMinimal: true } },
    { name: "suggest mode", overrides: { mode: "suggest" as const } },
    {
      name: "no usable delegation tool",
      overrides: { hiddenDelegationTool: "", hasVisibleSessionSpawn: false },
    },
  ])("omits the section for $name", ({ overrides }) => {
    expect(buildSection(overrides)).toEqual([]);
  });
});
