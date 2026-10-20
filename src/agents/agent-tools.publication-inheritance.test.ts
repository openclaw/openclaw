import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const parentKey = "agent:main:dashboard:parent";
const childKey = "agent:main:dashboard:child";
const allowed = ["sessions_spawn", "github_publish", "github_identity_status"];
const plan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: true,
  includePluginTools: false,
};

describe("publication policy inherited by a managed child", () => {
  afterEach(() => clearRuntimeConfigSnapshot());

  it("keeps inherited publication separate from the parent's permitted PR actions", async () => {
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      tools: {
        allow: ["github_publish"],
        gatewayPolicy: {
          allow: ["github_publish"],
          actions: { github_publish: ["publish", "inspect"] },
        },
      },
    };
    const additionalInheritedToolNamesRef: string[] = [];
    const tools = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: parentKey,
        operatorAuthority: createAdmittedRunOperatorAuthority({
          profileId: "publication-policy-test",
          scopes: ["operator.write"],
          signal: new AbortController().signal,
          assertCurrent: () => {},
        }),
      },
      () =>
        createOpenClawCodingToolsInternal({
          config,
          sessionKey: parentKey,
          githubPublicationAvailable: false,
          additionalInheritedToolNamesRef,
          toolConstructionPlan: plan,
          wrapBeforeToolCallHook: false,
          conversationCapabilityProfile: resolveConversationCapabilityProfile({
            config,
            sessionKey: parentKey,
            preparedSessionCapabilityStore: {},
          }),
        }),
    );
    const parentPublishers = tools.filter((tool) => tool.name === "github_publish");
    expect(parentPublishers).toHaveLength(1);
    expect(parentPublishers[0]?.parameters).toMatchObject({
      properties: { action: { enum: ["inspect"] } },
    });
    expect(additionalInheritedToolNamesRef).toEqual(["github_publish"]);

    const child = createOpenClawCodingToolsInternal({
      config,
      sessionKey: childKey,
      githubPublicationAvailable: true,
      toolConstructionPlan: plan,
      wrapBeforeToolCallHook: false,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({
        config,
        sessionKey: childKey,
        preparedSessionCapabilityStore: {
          [childKey]: {
            sessionId: "child",
            spawnedBy: parentKey,
            inheritedToolPolicyVersion: 1,
            inheritedToolAllow: [...additionalInheritedToolNamesRef],
          },
        },
      }),
    });
    const childPublishers = child.filter((tool) => tool.name === "github_publish");
    expect(childPublishers).toHaveLength(1);
    expect(childPublishers[0]?.parameters).toMatchObject({
      properties: { action: { enum: ["publish"] } },
    });
  });

  it.each<{
    name: string;
    tools: NonNullable<OpenClawConfig["tools"]>;
    runtime?: string[];
    inheritedDeny?: string[];
    expected: boolean;
  }>([
    { name: "permitted publication", tools: { allow: allowed }, expected: true },
    {
      name: "explicit denial",
      tools: { allow: allowed, deny: ["github_publish"] },
      expected: false,
    },
    { name: "restrictive allowlist", tools: { allow: ["sessions_spawn"] }, expected: false },
    {
      name: "inherited runtime restriction",
      tools: { allow: allowed },
      runtime: ["sessions_spawn"],
      expected: false,
    },
    {
      name: "deployment tool exclusion",
      tools: { allow: allowed, gatewayPolicy: { allow: ["sessions_spawn"] } },
      expected: false,
    },
    {
      name: "deployment action restriction",
      tools: {
        allow: allowed,
        gatewayPolicy: {
          allow: allowed,
          actions: { github_publish: ["inspect"] },
        },
      },
      expected: false,
    },
    {
      name: "profile restriction",
      tools: { profile: "minimal", alsoAllow: ["sessions_spawn"] },
      expected: false,
    },
    {
      name: "sender restriction",
      tools: { allow: allowed, toolsBySender: { "*": { deny: ["github_publish"] } } },
      expected: false,
    },
    {
      name: "inherited denial",
      tools: { allow: allowed },
      inheritedDeny: ["github_publish"],
      expected: false,
    },
  ])(
    "preserves $name when the parent has no publishable repository",
    ({ tools, runtime, inheritedDeny, expected }) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: {} } },
        tools: { ...tools, sandbox: { tools: { alsoAllow: ["github_publish"] } } },
      };
      setRuntimeConfigSnapshot(config);
      const sandbox = createAgentToolsSandboxContext({
        workspaceDir: "/tmp/publication-inheritance",
        tools: resolveSandboxToolPolicyForAgent(config, "main"),
      });
      const inheritedToolAllowlistRef: string[] = [];
      const parent = createOpenClawCodingToolsInternal({
        config,
        sessionKey: parentKey,
        sandbox,
        githubPublicationAvailable: false,
        runtimeToolAllowlist: runtime,
        inheritRuntimeToolAllowlist: true,
        inheritedToolAllowlistRef,
        toolConstructionPlan: plan,
        wrapBeforeToolCallHook: false,
        conversationCapabilityProfile: resolveConversationCapabilityProfile({
          config,
          sessionKey: parentKey,
          runtimeToolAllowlist: runtime,
          inheritRuntimeToolAllowlist: true,
          sandboxToolPolicy: sandbox.tools,
          preparedSessionCapabilityStore: inheritedDeny
            ? {
                [parentKey]: {
                  sessionId: "parent",
                  spawnedBy: "agent:main:dashboard:grandparent",
                  inheritedToolPolicyVersion: 1,
                  inheritedToolAllow: allowed,
                  inheritedToolDeny: inheritedDeny,
                },
              }
            : {},
        }),
      });
      expect(parent.some((tool) => tool.name === "github_publish")).toBe(false);
      expect(inheritedToolAllowlistRef.includes("github_publish")).toBe(expected);

      // Child construction has its own valid publication fact. The captured parent
      // ceiling remains authoritative even when the child's local policy permits it.
      const childConfig: OpenClawConfig = {
        agents: config.agents,
        tools: { allow: allowed, gatewayPolicy: tools.gatewayPolicy },
      };
      const child = createOpenClawCodingToolsInternal({
        config: childConfig,
        sessionKey: childKey,
        sandbox,
        githubPublicationAvailable: true,
        toolConstructionPlan: plan,
        wrapBeforeToolCallHook: false,
        conversationCapabilityProfile: resolveConversationCapabilityProfile({
          config: childConfig,
          sessionKey: childKey,
          sandboxToolPolicy: sandbox.tools,
          preparedSessionCapabilityStore: {
            [childKey]: {
              sessionId: "child",
              spawnedBy: parentKey,
              inheritedToolPolicyVersion: 1,
              inheritedToolAllow: [...inheritedToolAllowlistRef],
              inheritedToolDeny: tools.deny ?? [],
            },
          },
        }),
      });
      expect(child.some((tool) => tool.name === "github_publish")).toBe(expected);
    },
  );
});
