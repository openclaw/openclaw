import { describe, expect, it } from "vitest";
import { resolveCliRuntimeToolPolicy } from "./prepare-tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

const params: RunCliAgentParams = {
  sessionId: "coding",
  sessionKey: "agent:coder:dashboard:coding",
  sessionFile: "fixture.jsonl",
  workspaceDir: "/workspace",
  prompt: "implement",
  provider: "fixture-cli",
  model: "fixture",
  runId: "fixture-run",
  timeoutMs: 1000,
  config: {
    agents: {
      entries: {
        intake: { subagents: { allowAgents: ["coder"], delegateToolsTo: ["coder"] } },
        coder: {},
      },
    },
  },
  sessionEntry: {
    sessionId: "coding",
    updatedAt: 1,
    spawnedBy: "agent:intake:main",
    spawnDepth: 1,
    inheritedToolPolicyVersion: 1,
    inheritedToolDeny: ["exec"],
    delegatedToolPolicy: {
      requesterSessionKey: "agent:intake:main",
      targetAgentId: "coder",
      deny: [],
      requesterDeny: ["exec"],
    },
  },
};
const input = {
  params,
  policyAgentId: "coder",
  policySessionKey: params.sessionKey,
  backendId: "fixture-cli",
  bundleMcp: true,
  canEnforceExactToolAvailability: true,
  isSideQuestion: false,
  skipsTurnPreparation: false,
};

describe("delegated CLI tool policy", () => {
  it("removes ambient tools and retains the policy-filtered host projection", async () => {
    const result = await resolveCliRuntimeToolPolicy(input);
    expect(result.params.cliToolAvailability).toEqual({ native: [], openClaw: [] });
    expect(result.runtimeToolsAllowPolicy).toEqual(["*"]);
  });
  it("refuses a backend that cannot enforce live delegated authority", async () => {
    await expect(
      resolveCliRuntimeToolPolicy({ ...input, canEnforceExactToolAvailability: false }),
    ).rejects.toThrow("cannot enforce delegated execution tool policy");
  });
});

describe("workspace-only CLI tool policy", () => {
  const workspaceInput = {
    ...input,
    params: {
      ...params,
      sessionEntry: undefined,
      config: { tools: { fs: { workspaceOnly: true } } },
    },
  };

  it.each([
    { canEnforceExactToolAvailability: false },
    { bundleMcp: false },
    {
      params: {
        ...workspaceInput.params,
        sessionEntry: { sessionId: "coding", updatedAt: 1, execHost: "node" as const },
      },
    },
  ])("refuses an unmediated workspace-only run: %j", async (overrides) => {
    await expect(resolveCliRuntimeToolPolicy({ ...workspaceInput, ...overrides })).rejects.toThrow(
      "cannot enforce workspace-only tool policy",
    );
  });

  it("preserves an exact tool cap when replacing native tools", async () => {
    const result = await resolveCliRuntimeToolPolicy({
      ...workspaceInput,
      params: {
        ...workspaceInput.params,
        cliToolAvailability: { native: ["Read"], openClaw: ["message"] },
      },
      projectNativeToolAuthority: () => ["read"],
    });
    expect(result.params.cliToolAvailability).toEqual({
      native: [],
      openClaw: ["message", "read"],
    });
    expect(result.runtimeToolsAllowPolicy).toBeUndefined();
  });

  it("keeps backend-enforced tool-free questions independent of the file tool policy", async () => {
    const result = await resolveCliRuntimeToolPolicy({
      ...workspaceInput,
      isSideQuestion: true,
      skipsTurnPreparation: true,
      sideQuestionToolMode: "disabled",
    });
    expect(result.params.cliToolAvailability).toBeUndefined();
    expect(result.runtimeToolsAllowPolicy).toBeUndefined();
  });
});
