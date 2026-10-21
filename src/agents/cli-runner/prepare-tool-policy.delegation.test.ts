import { describe, expect, it } from "vitest";
import { resolveCliRuntimeToolPolicy } from "./prepare-tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

const session = { sessionId: "coding", updatedAt: 1 };
const emptyTools = { native: [], openClaw: [] };
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
    ...session,
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

async function expectPolicy(
  request: Parameters<typeof resolveCliRuntimeToolPolicy>[0],
  availability?: RunCliAgentParams["cliToolAvailability"],
  allowPolicy?: string[],
) {
  const result = await resolveCliRuntimeToolPolicy(request);
  expect([result.params.cliToolAvailability, result.runtimeToolsAllowPolicy]).toEqual([
    availability,
    allowPolicy,
  ]);
}

describe("delegated CLI tool policy", () => {
  it("removes ambient tools and retains the policy-filtered host projection", async () => {
    await expectPolicy(input, emptyTools, ["*"]);
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
        sessionEntry: { ...session, execHost: "node" as const },
      },
    },
  ])("refuses an unmediated workspace-only run: %j", async (overrides) => {
    await expect(resolveCliRuntimeToolPolicy({ ...workspaceInput, ...overrides })).rejects.toThrow(
      "cannot enforce workspace-only tool policy",
    );
  });

  it("preserves an exact tool cap when replacing native tools", async () => {
    await expectPolicy(
      {
        ...workspaceInput,
        params: {
          ...workspaceInput.params,
          cliToolAvailability: { native: ["Read"], openClaw: ["message"] },
        },
        projectNativeToolAuthority: () => ["read"],
      },
      { native: [], openClaw: ["message", "read"] },
    );
  });

  it("keeps backend-enforced tool-free questions independent of the file tool policy", async () => {
    await expectPolicy({
      ...workspaceInput,
      isSideQuestion: true,
      skipsTurnPreparation: true,
      sideQuestionToolMode: "disabled",
    });
  });
});

describe("ordinary Claude tool policy", () => {
  const ordinaryParams: RunCliAgentParams = {
    ...params,
    provider: "claude-cli",
    sessionEntry: session,
  };
  const ordinary = { ...input, params: ordinaryParams, backendId: "claude-cli" };
  const run = (overrides: Partial<RunCliAgentParams>) => ({
    ...ordinary,
    params: { ...ordinaryParams, ...overrides },
  });

  it("selects the existing completion projection for ordinary agent turns", async () => {
    await expectPolicy(ordinary, emptyTools, ["*"]);
  });

  it.each([
    { name: "another backend", backendId: "fixture-cli" },
    { name: "standalone without MCP", bundleMcp: false },
    { name: "without exact tool enforcement", canEnforceExactToolAvailability: false },
    { name: "side question", isSideQuestion: true },
    { name: "isolated utility completion", skipsTurnPreparation: true },
  ])("preserves the existing surface for $name", async ({ name: _name, ...overrides }) => {
    await expectPolicy({ ...ordinary, ...overrides });
  });

  it("preserves explicit native tool selection and node placement", async () => {
    const selection = { native: ["Read"], openClaw: [] };
    await expectPolicy(run({ cliToolAvailability: selection }), selection);
    const node = await resolveCliRuntimeToolPolicy(
      run({ sessionEntry: { ...session, execHost: "node" } }),
    );
    expect(node.params.cliToolAvailability).toBeUndefined();
  });

  it.each([
    { config: { tools: { exec: { host: "node" as const } } } },
    { execOverrides: { host: "node" as const } },
  ])("preserves node-only execution selected by %j", async (overrides) => {
    const result = await resolveCliRuntimeToolPolicy(run(overrides));
    expect(result.params.cliToolAvailability).toBeUndefined();
  });
});
