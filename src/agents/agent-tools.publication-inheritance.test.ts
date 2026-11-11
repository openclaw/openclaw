import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
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
import type { SandboxContext } from "./sandbox/types.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createOpenClawOnlyToolConstructionPlan } from "./test-helpers/tool-construction-plan.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const parentKey = "agent:main:dashboard:parent";
const childKey = "agent:main:dashboard:child";
const allowed = ["sessions_spawn", "github_publish", "github_identity_status"];
const plan = createOpenClawOnlyToolConstructionPlan();
type ToolOptions = Parameters<typeof createOpenClawCodingToolsInternal>[0];
type CapabilityStore = Parameters<
  typeof resolveConversationCapabilityProfile
>[0]["preparedSessionCapabilityStore"];
function buildTools(
  options: ToolOptions & { config: OpenClawConfig; sessionKey: string },
  preparedSessionCapabilityStore: CapabilityStore = {},
) {
  return createOpenClawCodingToolsInternal({
    ...options,
    toolConstructionPlan: plan,
    wrapBeforeToolCallHook: false,
    conversationCapabilityProfile: resolveConversationCapabilityProfile({
      config: options.config,
      sessionKey: options.sessionKey,
      runtimeToolAllowlist: options.runtimeToolAllowlist,
      inheritRuntimeToolAllowlist: options.inheritRuntimeToolAllowlist,
      sandboxToolPolicy: options.sandbox?.tools,
      preparedSessionCapabilityStore,
    }),
  });
}
function inheritedEntry(allow: string[], deny?: string[], parent = parentKey) {
  return {
    sessionId: parent === parentKey ? "child" : "parent",
    spawnedBy: parent,
    inheritedToolPolicyVersion: 1,
    inheritedToolAllow: [...allow],
    ...(deny ? { inheritedToolDeny: deny } : {}),
  };
}

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
        buildTools({
          config,
          sessionKey: parentKey,
          githubPublicationAvailable: false,
          additionalInheritedToolNamesRef,
        }),
    );
    const parentPublishers = tools.filter((tool) => tool.name === "github_publish");
    expect(parentPublishers).toHaveLength(1);
    expect(parentPublishers[0]?.parameters).toMatchObject({
      properties: { action: { enum: ["inspect"] } },
    });
    expect(additionalInheritedToolNamesRef).toEqual(["github_publish"]);

    const child = buildTools(
      {
        config,
        sessionKey: childKey,
        githubPublicationAvailable: true,
      },
      { [childKey]: inheritedEntry(additionalInheritedToolNamesRef) },
    );
    const childPublishers = child.filter((tool) => tool.name === "github_publish");
    expect(childPublishers).toHaveLength(1);
    expect(childPublishers[0]?.parameters).toMatchObject({
      properties: { action: { enum: ["publish", "inspect"] } },
    });
  });

  it.each<[string, NonNullable<OpenClawConfig["tools"]>, boolean, string[]?, string[]?]>([
    ["permitted publication", { allow: allowed }, true],
    [
      "preparation-only deployment policy",
      {
        allow: allowed,
        gatewayPolicy: { allow: ["github_publish"], actions: { github_publish: ["prepare_pr"] } },
      },
      true,
    ],
    ["explicit denial", { allow: allowed, deny: ["github_publish"] }, false],
    ["restrictive allowlist", { allow: ["sessions_spawn"] }, false],
    ["inherited runtime restriction", { allow: allowed }, false, ["sessions_spawn"]],
    [
      "deployment tool exclusion",
      {
        allow: allowed,
        gatewayPolicy: { allow: ["sessions_spawn"] },
      },
      false,
    ],
    [
      "deployment action restriction",
      {
        allow: allowed,
        gatewayPolicy: { allow: allowed, actions: { github_publish: ["inspect"] } },
      },
      false,
    ],
    ["profile restriction", { profile: "minimal", alsoAllow: ["sessions_spawn"] }, false],
    [
      "sender restriction",
      {
        allow: allowed,
        toolsBySender: { "*": { deny: ["github_publish"] } },
      },
      false,
    ],
    ["inherited denial", { allow: allowed }, false, undefined, ["github_publish"]],
  ])(
    "preserves %s when the parent has no publishable repository",
    (_name, tools, expected, runtime, inheritedDeny) => {
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
      const parent = buildTools(
        {
          config,
          sessionKey: parentKey,
          sandbox,
          githubPublicationAvailable: false,
          runtimeToolAllowlist: runtime,
          inheritRuntimeToolAllowlist: true,
          inheritedToolAllowlistRef,
        },
        inheritedDeny
          ? {
              [parentKey]: inheritedEntry(
                allowed,
                inheritedDeny,
                "agent:main:dashboard:grandparent",
              ),
            }
          : {},
      );
      expect(
        parent.some(
          (tool) =>
            tool.name === "github_publish" && Value.Check(tool.parameters, { action: "publish" }),
        ),
      ).toBe(false);
      expect(inheritedToolAllowlistRef.includes("github_publish")).toBe(
        expected || tools.gatewayPolicy?.actions?.github_publish?.includes("inspect") === true,
      );

      // Child construction has its own valid publication fact. The captured parent
      // ceiling remains authoritative even when the child's local policy permits it.
      const childConfig: OpenClawConfig = {
        agents: config.agents,
        tools: { allow: allowed, gatewayPolicy: tools.gatewayPolicy },
      };
      // PR preparation is offered only to a writable managed sandbox.
      const childSandbox: SandboxContext = {
        ...sandbox,
        workspaceSource: "managed-worktree",
        backend: {
          id: "docker",
          runtimeId: sandbox.runtimeId,
          runtimeLabel: sandbox.runtimeLabel,
          workdir: sandbox.containerWorkdir,
          buildExecSpec: async () => {
            throw new Error("Inheritance fixture does not execute commands");
          },
          runShellCommand: async () => {
            throw new Error("Inheritance fixture does not execute commands");
          },
        },
      };
      const child = buildTools(
        {
          config: childConfig,
          sessionKey: childKey,
          sandbox: childSandbox,
          githubPublicationAvailable: true,
        },
        { [childKey]: inheritedEntry(inheritedToolAllowlistRef, tools.deny ?? []) },
      );
      expect(
        child.some(
          (tool) =>
            tool.name === "github_publish" &&
            (Value.Check(tool.parameters, { action: "publish" }) ||
              Value.Check(tool.parameters, {
                action: "prepare_pr",
                pullRequestUrl: "https://github.com/example/repository/pull/1",
              })),
        ),
      ).toBe(expected);
      if (tools.gatewayPolicy?.actions?.github_publish?.includes("prepare_pr")) {
        const publisher = expectDefined(
          child.find((tool) => tool.name === "github_publish"),
          "child preparation tool",
        );
        expect(
          Value.Check(publisher.parameters, {
            action: "prepare_pr",
            pullRequestUrl: "https://github.com/example/repository/pull/1",
          }),
        ).toBe(true);
        expect(Value.Check(publisher.parameters, { action: "publish" })).toBe(false);
      }
    },
  );
});
