import { describe, expect, it } from "vitest";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import {
  resolvePluginHarnessPolicyToolsAllow,
  preparePluginHarnessToolPolicies,
} from "./execution-environment.js";

const input = { sessionId: "policy-session", provider: "fixture", modelId: "fixture-model" };
type PolicyParams = Partial<Parameters<typeof preparePluginHarnessToolPolicies>[0]>;
const prepare = (params: PolicyParams = {}) =>
  preparePluginHarnessToolPolicies({ ...input, ...params, preparedSessionEntry: null });
const trusted = { version: 1, mode: "trusted" } as const;
const denyExec = { tools: { deny: ["exec"] } };
const grant = { pluginId: "fixture", toolNames: ["fixture_lookup"] };
const scheduled = (toolsAllow: string[], overrides: PolicyParams = {}): PolicyParams => ({
  toolsAllow,
  scheduledToolPolicy: trusted,
  ...overrides,
});
const intersection = attachToolAllowlistIntersection(["*"], [["*"], ["read"]]);
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
const sender: PolicyParams = {
  config: { tools: { toolsBySender: { "*": { deny: ["exec"] } } } },
  messageProvider: "webchat",
  senderIsOwner: false,
};

describe("native harness tool policy", () => {
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
    ["wildcard intersection", { toolsAllow: intersection }, "turn", true],
    ["scheduled wildcard", scheduled(["*"]), "conversation", false],
    ["scheduled finite", scheduled(["read"]), "turn", true],
    ["scheduled deny", scheduled(["*"], { config: denyExec }), "conversation", true],
    ["scheduled profile", scheduled(["*"], { config: coding }), "conversation", false],
    ["account scheduled deny", account, "turn", true],
    ["disabled tools despite wildcard", { disableTools: true, toolsAllow: ["*"] }, "turn", true],
    ["run-owned plugin grant", { runtimePluginToolGrant: grant }, "turn", false],
    ["unrestricted request allowlist", { toolsAllow: ["*"] }, "conversation", false],
    ["scheduled grant", scheduled(["*"], { runtimePluginToolGrant: grant }), "turn", false],
    ["sender deny", sender, "turn", true],
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

  it.each([true, false])(
    "uses the current delegated grant lifetime (active: %s)",
    async (active) => {
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
    },
  );

  it.each([true, false])(
    "applies wildcard WebChat sender denial only to non-owners (owner: %s)",
    async (senderIsOwner) => {
      expect(
        resolvePluginHarnessPolicyToolsAllow(
          await preparePluginHarnessToolPolicies({
            ...input,
            config: { tools: { toolsBySender: { "*": { deny: ["*"] } } } },
            messageProvider: "webchat",
            senderIsOwner,
          }),
        ),
      ).toEqual(senderIsOwner ? undefined : []);
    },
  );
});
