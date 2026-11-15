import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assertAgentHarnessExecutionEnvironment,
  resolveAgentHarnessSessionExecutionRestriction,
  resolvePluginHarnessPolicyToolsAllow,
  preparePluginHarnessToolPolicies,
} from "./execution-environment.js";
import type { AgentHarness } from "./types.js";

const input = { sessionId: "policy-session", provider: "fixture", modelId: "fixture-model" };
type PolicyParams = Partial<Parameters<typeof preparePluginHarnessToolPolicies>[0]>;
const prepare = (params: PolicyParams = {}) =>
  preparePluginHarnessToolPolicies({ ...input, ...params, preparedSessionEntry: null });
const denyExec = { tools: { deny: ["exec"] } };
const grant = { pluginId: "fixture", toolNames: ["fixture_lookup"] };
const scheduled = (toolsAllow: string[], overrides: PolicyParams = {}): PolicyParams => ({
  toolsAllow,
  scheduledToolPolicy: { version: 1, mode: "trusted" },
  ...overrides,
});
const coding = { tools: { profile: "coding" as const } };
const account: PolicyParams = {
  config: denyExec,
  toolsAllow: ["*"],
  scheduledToolPolicy: {
    version: 1,
    mode: "account",
    ownerSessionKey: "agent:main:main",
    ownerAccountId: "default",
    ownerOrigin: { kind: "local" },
  },
};

it.each([
  ["conversation deny", { config: denyExec }, "conversation", true, []],
  ["narrow allowlist", { config: { tools: { allow: ["message"] } } }, "conversation", true, []],
  ["narrow profile", { config: coding }, "conversation", false, []],
  ["full profile", { config: { tools: { profile: "full" } } }, "conversation", false, undefined],
  [
    "empty config allowlist",
    { config: { tools: { allow: [] } } },
    "conversation",
    false,
    undefined,
  ],
  ["request allowlist", { toolsAllow: ["read"] }, "turn", true],
  ["scheduled wildcard", scheduled(["*"]), "conversation", false],
  ["scheduled finite", scheduled(["read"]), "turn", true],
  ["scheduled deny", scheduled(["*"], { config: denyExec }), "conversation", true],
  ["scheduled profile", scheduled(["*"], { config: coding }), "conversation", false],
  ["account scheduled deny", account, "turn", true],
  ["scheduled grant", scheduled(["*"], { runtimePluginToolGrant: grant }), "turn", false],
] satisfies Array<[string, PolicyParams, "conversation" | "turn", boolean, []?]>)(
  "separates lifetime from restriction for %s",
  async (_name, params, scope, restricted, ...sideQuestionAllow) => {
    const policies = await prepare(params);
    expect(policies).toMatchObject({
      toolPolicyScope: scope,
      toolPolicyRestricted: restricted,
    });
    if (sideQuestionAllow.length) {
      expect(resolvePluginHarnessPolicyToolsAllow(policies)).toEqual(sideQuestionAllow[0]);
    }
  },
);

it.each([true, false])("uses the current delegated grant lifetime (active: %s)", async (active) => {
  const requester = "agent:front:main";
  const child = "agent:worker:dashboard:task";
  const policies = await prepare({
    config: {
      agents: {
        entries: {
          front: {
            subagents: { allowAgents: ["worker"], delegateToolsTo: active ? ["worker"] : [] },
          },
          worker: {},
        },
      },
    },
    agentId: "worker",
    sessionKey: child,
    preparedSessionCapabilityEntry: {
      sessionKey: child,
      entry: {
        sessionId: input.sessionId,
        spawnedBy: requester,
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["exec"],
        delegatedToolPolicy: {
          requesterSessionKey: requester,
          targetAgentId: "worker",
          deny: [],
          requesterDeny: ["exec"],
        },
      },
    },
  });
  expect(policies).toMatchObject({
    toolPolicyScope: active ? "turn" : "conversation",
    requiresLiveToolAuthority: active,
    toolPolicyRestricted: true,
  });
});

it.each([true, false])(
  "applies wildcard WebChat sender denial only to non-owners (owner: %s)",
  async (senderIsOwner) => {
    const policies = await preparePluginHarnessToolPolicies({
      ...input,
      config: { tools: { toolsBySender: { "*": { deny: ["*"] } } } },
      messageProvider: "webchat",
      senderIsOwner,
    });
    expect(resolvePluginHarnessPolicyToolsAllow(policies)).toEqual(senderIsOwner ? undefined : []);
    expect(policies).toMatchObject({
      toolPolicyScope: senderIsOwner ? "conversation" : "turn",
      toolPolicyRestricted: !senderIsOwner,
    });
  },
);

it.each([
  ["an owner chat with unset modes", {}, true, true],
  ["a guest chat with unset modes", {}, false, false],
  // A stored spawn receipt is not current owner authority.
  ["a subagent with only an owner spawn receipt", { spawnedBySenderIsOwner: true }, false, false],
  ["an explicit Full Access chat", { permissionMode: "full", sandboxMode: "off" }, false, true],
  ["an owner chat with explicit workspace mode", { permissionMode: "workspace" }, true, "refused"],
] as const)("applies remembered agent consent to %s", async (_name, entry, owner, expected) => {
  await withOpenClawTestState({ label: "remembered-native-consent" }, async (state) => {
    const sessionKey = "agent:main:telegram:group:-100:topic:1";
    const config: OpenClawConfig = {
      agents: { entries: { main: { nativeRuntimeConsent: ["fixture"] } } },
    };
    setRuntimeConfigSnapshot(config);
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env });
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath, env: state.env },
      { sessionId: "chat", updatedAt: 1, ...entry },
    );
    const harness: AgentHarness = {
      id: "fixture",
      label: "Fixture",
      executionEnvironment: "host-only",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    };
    const preflight = assertAgentHarnessExecutionEnvironment(harness, {
      config,
      agentId: "main",
      sessionKey,
      sessionId: "chat",
      senderIsOwner: owner,
      ...("permissionMode" in entry ? { permissionMode: entry.permissionMode } : {}),
    });
    if (expected === "refused") {
      await expect(preflight).rejects.toThrow("requires Full access");
      return;
    }
    await expect(preflight).resolves.toBe(expected);
    // Admission (chat.send) classifies the stored chat with the same owner rule.
    const restriction = resolveAgentHarnessSessionExecutionRestriction({
      harness,
      cfg: config,
      agentId: "main",
      sessionKey,
      entry: { sessionId: "chat", ...entry },
      provider: "fixture",
      modelId: "fixture-model",
      callerCanConsent: owner,
    });
    expect(restriction).toBeUndefined();
  });
});
