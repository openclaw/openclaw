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

describe("ordinary Claude tool policy", () => {
  const ordinaryParams: RunCliAgentParams = {
    ...params,
    provider: "claude-cli",
    sessionEntry: { sessionId: "coding", updatedAt: 1 },
  };
  const ordinary = { ...input, params: ordinaryParams, backendId: "claude-cli" };

  it("selects the existing completion projection for ordinary agent turns", async () => {
    const result = await resolveCliRuntimeToolPolicy(ordinary);
    expect(result.params.cliToolAvailability).toEqual({ native: [], openClaw: [] });
    expect(result.runtimeToolsAllowPolicy).toEqual(["*"]);
  });

  it.each([
    { name: "another backend", backendId: "fixture-cli" },
    { name: "standalone without MCP", bundleMcp: false },
    { name: "without exact tool enforcement", canEnforceExactToolAvailability: false },
    { name: "side question", isSideQuestion: true },
    { name: "isolated utility completion", skipsTurnPreparation: true },
  ])("preserves the existing surface for $name", async ({ name: _name, ...overrides }) => {
    const result = await resolveCliRuntimeToolPolicy({ ...ordinary, ...overrides });
    expect(result.params.cliToolAvailability).toBeUndefined();
    expect(result.runtimeToolsAllowPolicy).toBeUndefined();
  });

  it("preserves explicit native tool selection and node placement", async () => {
    const selection = { native: ["Read"], openClaw: [] };
    const explicit = await resolveCliRuntimeToolPolicy({
      ...ordinary,
      params: { ...ordinaryParams, cliToolAvailability: selection },
    });
    expect(explicit.params.cliToolAvailability).toEqual(selection);
    const node = await resolveCliRuntimeToolPolicy({
      ...ordinary,
      params: {
        ...ordinaryParams,
        sessionEntry: { sessionId: "coding", updatedAt: 1, execHost: "node" },
      },
    });
    expect(node.params.cliToolAvailability).toBeUndefined();
  });

  it.each(["config", "run"] as const)(
    "preserves node-only execution selected by %s",
    async (source) => {
      const result = await resolveCliRuntimeToolPolicy({
        ...ordinary,
        params: {
          ...ordinaryParams,
          ...(source === "config"
            ? { config: { tools: { exec: { host: "node" as const } } } }
            : { execOverrides: { host: "node" as const } }),
        },
      });
      expect(result.params.cliToolAvailability).toBeUndefined();
    },
  );
});
