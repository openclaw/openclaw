import { expect, it } from "vitest";
import { resolveCliRuntimeToolPolicy } from "./prepare-tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

type Input = Parameters<typeof resolveCliRuntimeToolPolicy>[0];
type Tools = RunCliAgentParams["cliToolAvailability"];
type Overrides = Partial<Omit<Input, "params">> & { params?: Partial<RunCliAgentParams> };
const session = { sessionId: "coding", updatedAt: 1 };
const emptyTools = { native: [], openClaw: [] };
const nativeSelection = { native: ["Read"], openClaw: [] };
const base: Input = {
  params: {
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
  },
  policyAgentId: "coder",
  policySessionKey: "agent:coder:dashboard:coding",
  backendId: "fixture-cli",
  bundleMcp: true,
  canEnforceExactToolAvailability: true,
  isSideQuestion: false,
  skipsTurnPreparation: false,
};
function makeInput({ params, ...overrides }: Overrides = {}, defaults = base): Input {
  return { ...defaults, ...overrides, params: { ...defaults.params, ...params } };
}
const workspace = makeInput({
  params: {
    sessionEntry: undefined,
    config: { tools: { fs: { workspaceOnly: true } } },
  },
});
const ordinary = makeInput({
  backendId: "claude-cli",
  params: { provider: "claude-cli", sessionEntry: session },
});
async function expectPolicy(request: Input, tools?: Tools, allow?: string[]) {
  const { params, runtimeToolsAllowPolicy } = await resolveCliRuntimeToolPolicy(request);
  expect([params.cliToolAvailability, runtimeToolsAllowPolicy]).toEqual([tools, allow]);
}

it.each([base, ordinary])("mediates delegated and ordinary Claude turns: %j", async (request) => {
  await expectPolicy(request, emptyTools, ["*"]);
});

it("refuses a backend that cannot enforce live delegated authority", async () => {
  await expect(
    resolveCliRuntimeToolPolicy(makeInput({ canEnforceExactToolAvailability: false })),
  ).rejects.toThrow("cannot enforce delegated execution tool policy");
});

it.each<Overrides>([
  { canEnforceExactToolAvailability: false },
  { bundleMcp: false },
  { params: { sessionEntry: { ...session, execHost: "node" } } },
])("refuses an unmediated workspace-only run: %j", async (overrides) => {
  await expect(resolveCliRuntimeToolPolicy(makeInput(overrides, workspace))).rejects.toThrow(
    "cannot enforce workspace-only tool policy",
  );
});

it("preserves an exact tool cap when replacing native tools", async () => {
  const request = makeInput(
    {
      params: { cliToolAvailability: { native: ["Read"], openClaw: ["message"] } },
      projectNativeToolAuthority: () => ["read"],
    },
    workspace,
  );
  await expectPolicy(request, { native: [], openClaw: ["message", "read"] });
});

it("keeps backend-enforced tool-free questions independent of the file tool policy", async () => {
  await expectPolicy(
    makeInput(
      {
        isSideQuestion: true,
        skipsTurnPreparation: true,
        sideQuestionToolMode: "disabled",
      },
      workspace,
    ),
  );
});

it.each<Overrides>([
  { backendId: "fixture-cli" },
  { bundleMcp: false },
  { canEnforceExactToolAvailability: false },
  { isSideQuestion: true },
  { skipsTurnPreparation: true },
  { params: { cliToolAvailability: nativeSelection } },
  { params: { sessionEntry: { ...session, execHost: "node" } } },
  { params: { config: { tools: { exec: { host: "node" } } } } },
  { params: { execOverrides: { host: "node" } } },
])("preserves the unmediated ordinary CLI surface: %j", async (overrides) => {
  await expectPolicy(makeInput(overrides, ordinary), overrides.params?.cliToolAvailability);
});
