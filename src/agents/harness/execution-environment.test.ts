import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import {
  resolvePluginHarnessPolicyToolsAllow,
  preparePluginHarnessToolPolicies,
} from "./execution-environment.js";

const input = { sessionId: "policy-session", provider: "fixture", modelId: "fixture-model" };

describe("native harness tool policy", () => {
  it.each([
    {
      name: "conversation deny",
      params: { config: { tools: { deny: ["exec"] } } },
      scope: "conversation",
      restricted: true,
    },
    {
      name: "request allowlist",
      params: { toolsAllow: ["read"] },
      scope: "turn",
      restricted: true,
    },
    {
      name: "wildcard with a restrictive intersection",
      params: { toolsAllow: attachToolAllowlistIntersection(["*"], [["*"], ["read"]]) },
      scope: "turn",
      restricted: true,
    },
    {
      name: "unrestricted scheduled policy",
      params: { toolsAllow: ["*"], scheduledToolPolicy: { version: 1, mode: "trusted" } },
      scope: "conversation",
      restricted: false,
    },
    {
      name: "finite scheduled policy",
      params: { toolsAllow: ["read"], scheduledToolPolicy: { version: 1, mode: "trusted" } },
      scope: "turn",
      restricted: true,
    },
    {
      name: "unrestricted scheduled policy with conversation deny",
      params: {
        config: { tools: { deny: ["exec"] } },
        toolsAllow: ["*"],
        scheduledToolPolicy: { version: 1, mode: "trusted" },
      },
      scope: "conversation",
      restricted: true,
    },
    {
      name: "unrestricted scheduled policy with conversation profile",
      params: {
        config: { tools: { profile: "coding" } },
        toolsAllow: ["*"],
        scheduledToolPolicy: { version: 1, mode: "trusted" },
      },
      scope: "conversation",
      restricted: false,
    },
    {
      name: "account-scoped scheduled policy with conversation deny",
      params: {
        config: { tools: { deny: ["exec"] } },
        toolsAllow: ["*"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:main",
          ownerAccountId: "default",
          ownerOrigin: { kind: "local" },
        },
      },
      scope: "turn",
      restricted: true,
    },
    {
      name: "disabled tools despite wildcard",
      params: { disableTools: true, toolsAllow: ["*"] },
      scope: "turn",
      restricted: true,
    },
    {
      name: "run-owned plugin grant",
      params: { runtimePluginToolGrant: { pluginId: "fixture", toolNames: ["fixture_lookup"] } },
      scope: "turn",
      restricted: false,
    },
    {
      name: "unrestricted request allowlist",
      params: { toolsAllow: ["*"] },
      scope: "conversation",
      restricted: false,
    },
    {
      name: "scheduled additive grant",
      params: {
        toolsAllow: ["*"],
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        runtimePluginToolGrant: { pluginId: "fixture", toolNames: ["fixture_lookup"] },
      },
      scope: "turn",
      restricted: false,
    },
    {
      name: "sender deny",
      params: {
        config: { tools: { toolsBySender: { "*": { deny: ["exec"] } } } },
        messageProvider: "webchat",
        senderIsOwner: false,
      },
      scope: "turn",
      restricted: true,
    },
  ] satisfies Array<{
    name: string;
    params: Partial<Parameters<typeof preparePluginHarnessToolPolicies>[0]>;
    scope: "conversation" | "turn";
    restricted: boolean;
  }>)("separates lifetime from restriction for $name", async ({ params, scope, restricted }) => {
    expect(
      await preparePluginHarnessToolPolicies({ ...input, ...params, preparedSessionEntry: null }),
    ).toMatchObject({ toolPolicyScope: scope, toolPolicyRestricted: restricted });
  });

  it.each([true, false])(
    "uses the current delegated grant lifetime (active: %s)",
    async (active) => {
      const requester = "agent:front:main";
      const child = "agent:worker:dashboard:task";
      const policies = await preparePluginHarnessToolPolicies({
        ...input,
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
        preparedSessionEntry: null,
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

  it.each([
    { name: "narrow allowlist", config: { tools: { allow: ["message"] } }, restricted: true },
    { name: "specific denylist", config: { tools: { deny: ["exec"] } }, restricted: true },
    { name: "narrow profile", config: { tools: { profile: "coding" } }, restricted: true },
    { name: "full profile", config: { tools: { profile: "full" } }, restricted: false },
    { name: "empty config allowlist", config: { tools: { allow: [] } }, restricted: false },
  ] satisfies Array<{ name: string; config: OpenClawConfig; restricted: boolean }>)(
    "preserves plugin side-question restrictions for $name",
    async ({ config, restricted }) => {
      expect(
        resolvePluginHarnessPolicyToolsAllow(
          await preparePluginHarnessToolPolicies({ ...input, config }),
        ),
      ).toEqual(restricted ? [] : undefined);
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
