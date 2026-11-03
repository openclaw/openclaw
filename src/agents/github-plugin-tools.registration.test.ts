import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { createOpenClawCodingTools, createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { resolveGitHubPluginToolsFixture } from "./github-plugin-tools.test-support.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import * as inProcessGateway from "./tools/in-process-gateway.js";

// Plugin discovery is in-memory; registration, factory contexts, callbacks and tool policy are real.
vi.mock("./openclaw-plugin-tools.js", async (original) => ({
  ...(await original<typeof import("./openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: (
    params: Parameters<typeof resolveGitHubPluginToolsFixture>[0],
  ) => resolveGitHubPluginToolsFixture(params),
}));
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});
function withDefaultRoster(config: OpenClawConfig | undefined): OpenClawConfig {
  return { ...config, agents: config?.agents ?? { entries: { main: {} } } };
}
function hasTool(tools: ReturnType<typeof createOpenClawTools>, name: string) {
  return tools.some((tool) => tool.name === name);
}
function expectToolNamed(tools: ReturnType<typeof createOpenClawTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name} to be registered`);
  }
  return tool;
}

describe("GitHub plugin tool construction through the host", () => {
  it("keeps known publication tools offered while the Gateway owns execution admission", () => {
    expect(hasTool(createOpenClawTools(), "github_publish")).toBe(false);
    expect(hasTool(createOpenClawTools(), "github_identity_status")).toBe(false);
    expect(
      hasTool(createOpenClawTools({ githubPublicationAvailable: false }), "github_publish"),
    ).toBe(true);
    expect(
      hasTool(createOpenClawTools({ githubPublicationAvailable: false }), "github_identity_status"),
    ).toBe(true);
    expect(
      hasTool(createOpenClawTools({ githubPublicationAvailable: true }), "github_publish"),
    ).toBe(true);
  });

  it.each([
    { label: "global disable", plugins: { enabled: false } },
    { label: "entry disable", plugins: { entries: { "github-repositories": { enabled: false } } } },
    { label: "deny", plugins: { deny: ["github-repositories"] } },
    { label: "allowlist exclusion", plugins: { allow: ["visitor-access"] } },
  ])(
    "omits publication tools for plugin $label despite prepared workspace access",
    ({ plugins }) => {
      const tools = createOpenClawTools({ config: { plugins }, githubPublicationAvailable: true });
      expect(hasTool(tools, "github_publish")).toBe(false);
      expect(hasTool(tools, "github_identity_status")).toBe(false);
    },
  );

  it.each([
    {
      scope: "operator.sessions.write",
      publishing: false,
      deny: false,
      managed: true,
      expected: true,
      actions: true,
    },
    {
      scope: "operator.write",
      publishing: false,
      deny: false,
      managed: true,
      expected: true,
      actions: true,
    },
    {
      scope: "operator.admin",
      publishing: false,
      deny: false,
      managed: true,
      expected: true,
      actions: true,
    },
    {
      scope: "operator.write",
      publishing: false,
      deny: true,
      managed: true,
      expected: false,
      actions: false,
    },
    {
      scope: "operator.write",
      publishing: false,
      deny: false,
      managed: false,
      expected: false,
      actions: false,
    },
    {
      scope: "operator.sessions.write",
      publishing: true,
      deny: false,
      managed: true,
      expected: true,
      actions: true,
    },
    {
      scope: "operator.write",
      publishing: true,
      deny: false,
      managed: true,
      expected: true,
      actions: true,
    },
    {
      scope: "operator.admin",
      publishing: true,
      deny: false,
      managed: true,
      expected: true,
      actions: true,
    },
  ])(
    "preserves offered PR actions for $scope, publishing=$publishing, deny=$deny, managed=$managed",
    async ({ scope, publishing, deny, managed, expected, actions }) => {
      const cfg = withDefaultRoster(deny ? { tools: { deny: ["github_publish"] } } : {});
      const sessionKey = "agent:main:nonpublishing-parent";
      const additionalInheritedToolNamesRef: string[] = [];
      const tools = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          operatorAuthority: createAdmittedRunOperatorAuthority({
            profileId: "reviewer",
            scopes: [scope],
            assertCurrent: () => {},
          }),
        },
        () =>
          createOpenClawCodingToolsInternal({
            config: cfg,
            sessionKey,
            sandbox: createAgentToolsSandboxContext({
              workspaceDir: "/tmp/nonpublishing-parent",
              sessionKey,
              tools: resolveSandboxToolPolicyForAgent(cfg, "main"),
            }),
            githubPublicationAvailable: managed ? publishing : undefined,
            additionalInheritedToolNamesRef,
            senderIsOwner: false,
            wrapBeforeToolCallHook: false,
            toolConstructionPlan: {
              includeBaseCodingTools: false,
              includeShellTools: false,
              includeChannelTools: false,
              includeOpenClawTools: true,
              includePluginTools: true,
            },
          }),
      );
      expect(additionalInheritedToolNamesRef.includes("github_publish")).toBe(
        managed && !publishing && !deny,
      );
      if (!expected) {
        expect(hasTool(tools, "github_publish")).toBe(false);
        return;
      }
      expect(tools.filter((tool) => tool.name === "github_publish")).toHaveLength(1);
      const tool = expectToolNamed(tools, "github_publish");
      expect(
        Value.Check(tool.parameters, {
          action: "inspect",
          publishingSessionKey: "agent:main:child",
        }),
      ).toBe(actions);
      expect(Value.Check(tool.parameters, { title: "Publish workspace" })).toBe(publishing);
      expect(Value.Check(tool.parameters, { action: "publish" })).toBe(publishing);
      expect(
        Value.Check(tool.parameters, {
          action: "prepare_pr",
          pullRequestUrl: "https://github.com/example/repository/pull/1",
        }),
      ).toBe(false);
      expect(Value.Check(tool.parameters, { action: "refresh_base" })).toBe(false);
      expect(Value.Check(tool.parameters, { action: "edit" })).toBe(publishing);
      expect(Value.Check(tool.parameters, { action: "ready" })).toBe(publishing || actions);
      expect(
        Value.Check(tool.parameters, { action: "ready", publishingSessionKey: "agent:main:child" }),
      ).toBe(actions);
      expect(Value.Check(tool.parameters, { action: "upload_evidence" })).toBe(false);
      if (!publishing) {
        expect(tool.description).toContain("cannot publish its own workspace");
      } else if (!actions) {
        expect(tool.parameters).toHaveProperty("properties", {
          action: expect.any(Object),
          pullRequestUrl: expect.any(Object),
          draft: expect.any(Object),
          title: expect.any(Object),
          body: expect.any(Object),
          requestId: expect.any(Object),
          expectedHeadCommit: expect.any(Object),
          expectedTitle: expect.any(Object),
          expectedBody: expect.any(Object),
        });
        expect(tool.parameters).toHaveProperty("additionalProperties", false);
        expect(tool.description).not.toContain("use inspect");
        expect(tool.description).toContain("expectedHeadCommit");
      }
    },
  );

  it.each([
    { name: "default policy", config: {}, available: true, expected: true },
    {
      name: "sandbox deny",
      config: { tools: { sandbox: { tools: { deny: ["github_publish"] } } } },
      available: true,
      expected: false,
    },
    {
      name: "restrictive sandbox allow",
      config: { tools: { sandbox: { tools: { allow: ["read"] } } } },
      available: true,
      expected: false,
    },
    {
      name: "global deny",
      config: { tools: { deny: ["github_publish"] } },
      available: true,
      expected: false,
    },
    {
      name: "restrictive agent allow",
      config: { agents: { entries: { main: { tools: { allow: ["read"] } } } } },
      available: true,
      expected: false,
    },
    { name: "unavailable publication", config: {}, available: false, expected: true },
    { name: "unprepared publication", config: {}, available: undefined, expected: false },
  ] satisfies {
    name: string;
    config: OpenClawConfig;
    available: boolean | undefined;
    expected: boolean;
  }[])("filters sandbox GitHub publication with $name", async ({ config, available, expected }) => {
    const cfg = withDefaultRoster(config);
    const sessionKey = "agent:main:sandbox-publisher";
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: "/tmp/sandbox-publisher",
      sessionKey,
      tools: resolveSandboxToolPolicyForAgent(cfg, "main"),
    });
    const callers: unknown[] = [];
    const call = vi
      .spyOn(inProcessGateway, "callInProcessGatewayTool")
      .mockImplementation(async () => {
        callers.push(getGatewayToolCallerIdentity()?.sessionKey);
        return { requestId: "publication-1", status: "requested" } as never;
      });
    try {
      const tools = createOpenClawCodingTools({
        config: cfg,
        sessionKey,
        sandbox,
        githubPublicationAvailable: available,
        senderIsOwner: false,
        wrapBeforeToolCallHook: false,
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: true,
        },
      });
      expect(hasTool(tools, "github_publish")).toBe(expected);
      if (expected && !available) {
        const tool = expectToolNamed(tools, "github_publish");
        expect(Value.Check(tool.parameters, { action: "publish" })).toBe(false);
        await expect(tool.execute("publish-1", { action: "publish" })).rejects.toThrow(
          "This session cannot publish its workspace",
        );
        expect(call).not.toHaveBeenCalled();
      } else if (expected) {
        await expectToolNamed(tools, "github_publish").execute("publish-1", {
          title: "Publish fix",
        });
        expect(call).toHaveBeenCalledWith(
          "sessions.github.publish",
          {
            sessionKey,
            idempotencyKey: "publish-1",
            title: "Publish fix",
          },
          expect.objectContaining({ sessionMutationCommitGuard: expect.any(Function) }),
        );
        expect(callers).toEqual([sessionKey]);
      } else {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      call.mockRestore();
    }
  });
});
