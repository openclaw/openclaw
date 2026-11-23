import { expect, it } from "vitest";
import {
  backendSupportsOrdinaryHostToolMediation,
  resolveCliBootstrapFileAccess,
  resolveCliRuntimeToolPolicy,
} from "./prepare-tool-policy.js";
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

const managedNative = ["Agent", "Workflow"];
const completion: Partial<RunCliAgentParams> = {
  trustedInternalHandoff: {
    kind: "subagent-completion",
    sourceSessionKey: "agent:coder:subagent:child",
    targetSessionKey: "agent:coder:dashboard:coding",
    targetSessionId: "coding",
    provider: "claude-cli",
    model: "fixture",
  },
};
function withManagedNative(overrides: Overrides, defaults = ordinary): Input {
  return makeInput(
    {
      // Resolve by the policy agent, so per-agent selections follow the turn's owner.
      resolveManagedNativeTools: ({ agentId }) => (agentId === "coder" ? managedNative : []),
      ...overrides,
    },
    defaults,
  );
}

it.each([{}, { params: completion }])(
  "keeps the operator's managed native tools on ordinary and completion turns: %j",
  async (overrides) => {
    await expectPolicy(withManagedNative(overrides), { native: managedNative, openClaw: [] }, [
      "*",
    ]);
    // Prepare reads this list to know the selection confers no file capability.
    const result = await resolveCliRuntimeToolPolicy(withManagedNative(overrides));
    expect(result.managedNativeTools).toEqual(managedNative);
  },
);

it.each<[string, Overrides, Input]>([
  ["delegated execution", {}, base],
  ["workspace-only", { params: { config: { tools: { fs: { workspaceOnly: true } } } } }, ordinary],
  ["a caller tool cap", { params: { ...completion, toolsAllow: ["read"] } }, ordinary],
])("drops managed native tools for %s", async (_name, overrides, defaults) => {
  const result = await resolveCliRuntimeToolPolicy(withManagedNative(overrides, defaults));
  expect(result.params.cliToolAvailability?.native).toEqual([]);
  expect(result.managedNativeTools).toEqual([]);
});

it("leaves node-placed Claude turns on their unmediated native surface", async () => {
  await expectPolicy(
    withManagedNative({ params: { sessionEntry: { ...session, execHost: "node" } } }),
    undefined,
  );
});

const fullHostOwnedTools = ["read", "write", "edit", "apply_patch", "exec", "process"] as const;
const hostOwnedOrdinary = makeInput({
  backendId: "custom-cli",
  hostOwnedTools: fullHostOwnedTools,
  params: { provider: "custom-cli", sessionEntry: session },
});

it.each<[string, Parameters<typeof backendSupportsOrdinaryHostToolMediation>[0], boolean]>([
  ["claude-cli without hostOwnedTools", { backendId: "claude-cli" }, true],
  [
    "claude-cli with shell-only hostOwnedTools",
    { backendId: "claude-cli", hostOwnedTools: ["exec", "process"] },
    true,
  ],
  [
    "non-Claude backend declaring read+write+exec hostOwnedTools",
    { backendId: "custom-cli", hostOwnedTools: fullHostOwnedTools },
    true,
  ],
  [
    "non-Claude backend declaring read+apply_patch hostOwnedTools",
    { backendId: "custom-cli", hostOwnedTools: ["Read", "apply_patch"] },
    true,
  ],
  [
    "non-Claude backend declaring only shell hostOwnedTools",
    { backendId: "custom-cli", hostOwnedTools: ["exec", "process"] },
    false,
  ],
  [
    "non-Claude backend declaring only read hostOwnedTools",
    { backendId: "custom-cli", hostOwnedTools: ["read", "edit"] },
    false,
  ],
  [
    "non-Claude backend declaring read+apply-patch alias hostOwnedTools",
    { backendId: "custom-cli", hostOwnedTools: ["  Read ", "apply-patch", ""] },
    true,
  ],
  [
    "non-Claude backend declaring empty/whitespace hostOwnedTools",
    { backendId: "custom-cli", hostOwnedTools: ["   ", ""] },
    false,
  ],
  [
    "bundled backend without hostOwnedTools",
    { backendId: "google-gemini-cli", hostOwnedTools: undefined },
    false,
  ],
])("evaluates ordinary host-tool mediation support for %s", (_label, input, expected) => {
  expect(backendSupportsOrdinaryHostToolMediation(input)).toBe(expected);
});

it("mediates ordinary turns for non-Claude backends declaring file hostOwnedTools", async () => {
  await expectPolicy(hostOwnedOrdinary, emptyTools, ["*"]);
});

it("preserves explicit exact-list turns without leaking file tools on hostOwnedTools backends", async () => {
  const exactCron = { native: [], openClaw: ["session_status"] };
  await expectPolicy(
    makeInput({ params: { cliToolAvailability: exactCron } }, hostOwnedOrdinary),
    exactCron,
    undefined,
  );
});

it.each<Overrides>([
  { hostOwnedTools: ["exec", "process"] },
  { hostOwnedTools: undefined, backendId: "google-gemini-cli" },
  { bundleMcp: false },
  { canEnforceExactToolAvailability: false },
  { isSideQuestion: true },
  { skipsTurnPreparation: true },
  { params: { sessionEntry: { ...session, execHost: "node" } } },
  { params: { config: { tools: { exec: { host: "node" } } } } },
  { params: { execOverrides: { host: "node" } } },
])(
  "does not trigger ordinary mediation for non-Claude hostOwnedTools backend when %j",
  async (overrides) => {
    await expectPolicy(makeInput(overrides, hostOwnedOrdinary), undefined, undefined);
  },
);

it.each<[string, Parameters<typeof resolveCliBootstrapFileAccess>[0], boolean]>([
  [
    "grants bootstrap file access for mediated read+write on hostOwnedTools backend",
    {
      backend: {
        id: "custom-cli",
        nativeToolMode: "selectable",
        hostOwnedTools: fullHostOwnedTools,
      },
      params: { cliToolAvailability: { native: [], openClaw: ["read", "write"] } },
      managedNativeTools: [],
      projectedToolNames: ["read", "write", "edit", "exec"],
    },
    true,
  ],
  [
    "grants bootstrap file access for mediated read+apply_patch on hostOwnedTools backend",
    {
      backend: {
        id: "custom-cli",
        nativeToolMode: "selectable",
        hostOwnedTools: ["read", "apply_patch"],
      },
      params: { cliToolAvailability: { native: [], openClaw: ["read", "apply_patch"] } },
      managedNativeTools: [],
      projectedToolNames: ["read", "apply_patch"],
    },
    true,
  ],
  [
    "denies bootstrap file access when mediated projected tools lack write/apply_patch",
    {
      backend: {
        id: "custom-cli",
        nativeToolMode: "selectable",
        hostOwnedTools: fullHostOwnedTools,
      },
      params: { cliToolAvailability: { native: [], openClaw: ["read", "edit"] } },
      managedNativeTools: [],
      projectedToolNames: ["read", "edit"],
    },
    false,
  ],
  [
    "denies bootstrap file access when mediated projected tools lack read",
    {
      backend: {
        id: "custom-cli",
        nativeToolMode: "selectable",
        hostOwnedTools: fullHostOwnedTools,
      },
      params: { cliToolAvailability: { native: [], openClaw: ["write"] } },
      managedNativeTools: [],
      projectedToolNames: ["write"],
    },
    false,
  ],
  [
    "denies bootstrap file access when tools are disabled",
    {
      backend: {
        id: "custom-cli",
        nativeToolMode: "selectable",
        hostOwnedTools: fullHostOwnedTools,
      },
      params: {
        cliToolAvailability: { native: [], openClaw: ["read", "write"] },
        disableTools: true,
      },
      managedNativeTools: [],
      projectedToolNames: ["read", "write"],
    },
    false,
  ],
  [
    "denies mediated bootstrap file access for non-Claude backend with shell-only hostOwnedTools",
    {
      backend: {
        id: "custom-cli",
        nativeToolMode: "selectable",
        hostOwnedTools: ["exec", "process"],
      },
      params: { cliToolAvailability: { native: [], openClaw: ["read", "write"] } },
      managedNativeTools: [],
      projectedToolNames: ["read", "write"],
    },
    false,
  ],
  [
    "keeps existing claude-cli mediated bootstrap file access unchanged",
    {
      backend: {
        id: "claude-cli",
        nativeToolMode: "selectable",
        hostOwnedTools: ["exec", "process"],
      },
      params: { cliToolAvailability: { native: [], openClaw: ["read", "write"] } },
      managedNativeTools: [],
      projectedToolNames: ["read", "write"],
    },
    true,
  ],
])("%s", (_label, input, expected) => {
  expect(resolveCliBootstrapFileAccess(input)).toBe(expected);
});
