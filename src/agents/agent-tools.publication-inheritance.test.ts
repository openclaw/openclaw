import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";

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

  it.each([
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
  ])(
    "preserves $name when the parent has no publishable repository",
    ({ tools, runtime, expected }) => {
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
          preparedSessionCapabilityStore: {},
        }),
      });
      expect(parent.some((tool) => tool.name === "github_publish")).toBe(false);
      expect(inheritedToolAllowlistRef.includes("github_publish")).toBe(expected);

      // Child construction has its own valid publication fact. The captured parent
      // ceiling remains authoritative even when the child's local policy permits it.
      const childConfig: OpenClawConfig = { agents: config.agents, tools: { allow: allowed } };
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
