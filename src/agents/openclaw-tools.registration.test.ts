import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as userProfileList from "../state/user-profile-list.native.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { createOpenClawCodingTools, createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { createCodeModeTools } from "./code-mode.js";
import { resolveCoreToolFactoryFamily } from "./core-tool-factory-descriptors.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  shouldIncludePrimarySessionToolForOpenClawTools,
  shouldIncludeProgressCardToolForOpenClawTools,
} from "./openclaw-tools.registration.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import { withPreparedSessionCapabilityRead } from "./subagents/spawn/subagent-session-store.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import * as inProcessGateway from "./tools/in-process-gateway.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

type CreateOpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

const withDefaultRoster = (config: OpenClawConfig | undefined): OpenClawConfig => ({
  ...config,
  agents: config?.agents ?? { entries: { main: {} } },
});

const toolNames = (tools: ReturnType<typeof createOpenClawTools>) => tools.map((tool) => tool.name);

function createFastToolNames(options: CreateOpenClawToolsOptions): string[] {
  return toolNames(
    createOpenClawTools({
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      ...options,
      config: withDefaultRoster(options.config),
    }),
  );
}

function expectToolNamed(tools: ReturnType<typeof createOpenClawTools>, name: string) {
  return expectDefined(
    tools.find((candidate) => candidate.name === name),
    `Expected tool ${name}`,
  );
}

it("keeps top-level tool argument names distinct from the required schema keyword", () => {
  const config: OpenClawConfig = {
    agents: { entries: { main: {} } },
    tools: { swarm: true },
  };
  const directTools = createOpenClawCodingTools({
    config,
    sessionKey: "agent:main:main",
    wrapBeforeToolCallHook: false,
    toolConstructionPlan: {
      ...openClawOnlyPlan,
      includeBaseCodingTools: true,
      includeShellTools: true,
    },
  });
  const codeModeTools = createCodeModeTools({ config, agentId: "main" });
  expect(toolNames(directTools)).toEqual(expect.arrayContaining(["exec", "agents_wait"]));
  expect(toolNames(codeModeTools)).toEqual(["exec", "wait"]);
  const completionTools = finalizeAgentToolAvailability([createLazyExecTool()]);
  expect(completionTools[0]!.parameters).not.toHaveProperty(["properties", "background"]);
  expect(completionTools[0]!.parameters).not.toHaveProperty(["properties", "yieldMs"]);
  const surfaces = {
    direct: directTools,
    codeMode: codeModeTools,
    completion: completionTools,
  };
  // Kimi confuses a top-level argument named required with JSON Schema's keyword.
  for (const [surface, tools] of Object.entries(surfaces)) {
    for (const tool of tools) {
      expect
        .soft(tool.parameters, `${surface}:${tool.name}`)
        .not.toHaveProperty(["properties", "required"]);
    }
  }
});

describe("openclaw-tools progress_card gating", () => {
  afterEach(() => setEmbeddedMode(false));

  it.each([false, true])(
    "keeps progress-card policy with the admitted sandbox owner (allowed: %s)",
    async (allowed) => {
      const policy = (denied: boolean) => ({ tools: { deny: denied ? ["progress_card"] : [] } });
      const entries = { main: policy(!allowed), work: policy(allowed) };
      const available = await withPreparedSessionCapabilityRead(() =>
        shouldIncludeProgressCardToolForOpenClawTools({
          config: { agents: { entries } },
          agentId: "work",
          sandboxAgentId: "main",
          agentSessionKey: "agent:main:policy",
        }),
      );
      expect(available).toBe(allowed);
    },
  );

  it.each([false, true])(
    "gates personal instructions on multiple people (%s) without general filesystem access",
    (multipleProfiles) => {
      const identityCount = vi
        .spyOn(userProfileList, "hasMultipleSessionSharingIdentitiesNative")
        .mockReturnValue(multipleProfiles);
      const tools = createOpenClawCodingTools({
        sessionKey: "agent:main:dashboard:project",
        runSessionKey: "agent:main:dashboard:project",
        cwd: "/project/worktree",
        workspaceDir: "/project/worktree",
        config: {
          agents: { entries: { main: { workspace: "/agent/workspace" } } },
          tools: { allow: ["personal_instructions"], fs: { workspaceOnly: true } },
        },
        disableMessageTool: true,
        wrapBeforeToolCallHook: false,
      });
      expect(toolNames(tools).includes("personal_instructions")).toBe(multipleProfiles);
      expect(toolNames(tools)).not.toContain("write");
      expect(toolNames(tools)).not.toContain("exec");
      expect(resolveCoreToolFactoryFamily("personal_instructions")).toBe("openclaw");
      setEmbeddedMode(true);
      expect(createFastToolNames({ agentSessionKey: "agent:main:main" })).not.toContain(
        "personal_instructions",
      );
      identityCount.mockRestore();
    },
  );

  it("keeps human-question tools on permitted primary sessions", async () => {
    const questionTools = (options: CreateOpenClawToolsOptions) =>
      createFastToolNames({ ...options, questionInputMode: "native" });
    for (const toolName of ["ask_user", "secrets"] as const) {
      const includeTool = (agentSessionKey?: string) =>
        shouldIncludePrimarySessionToolForOpenClawTools(toolName, {
          agentSessionKey,
          questionInputMode: "native",
        });
      expect(includeTool()).toBe(false);
      expect(includeTool("agent:main:main")).toBe(true);
      expect(includeTool("agent:main:subagent:worker")).toBe(false);
      expect(includeTool("agent:main:acp:worker")).toBe(false);
    }
    expect(
      shouldIncludePrimarySessionToolForOpenClawTools("secrets", {
        agentSessionKey: "agent:main:main",
        pluginToolDenylist: ["secrets"],
      }),
    ).toBe(false);
    // ask_user must not depend on the TUI embedded-host flag; normal gateway
    // runs are the primary consumer.
    expect(questionTools({ runSessionKey: "agent:main:non-embedded" })).toEqual(
      expect.arrayContaining(["ask_user", "secrets"]),
    );
    setEmbeddedMode(true);

    expect(
      await withPreparedSessionCapabilityRead(() =>
        questionTools({ agentSessionKey: "agent:main:subagent:worker" }),
      ),
    ).not.toContain("ask_user");
    expect(questionTools({ runSessionKey: "agent:main:run" })).toContain("ask_user");
  });

  it("keeps message tool in embedded message-tool-only completions", () => {
    setEmbeddedMode(true);
    const tools = createTestOpenClawTools({
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(toolNames(tools)).toContain("message");
  });

  it("exposes delegation only to regular unsandboxed gateway agents", () => {
    const exposed = (options: CreateOpenClawToolsOptions) =>
      createFastToolNames(options).includes("openclaw");
    expect(exposed({ agentSessionKey: "agent:main:main" })).toBe(true);
    expect(exposed({ agentSessionKey: "agent:main:main", sandboxed: true })).toBe(false);
    expect(exposed({ agentSessionKey: "agent:openclaw:main" })).toBe(false);
    setEmbeddedMode(true);
    expect(exposed({ agentSessionKey: "agent:main:main" })).toBe(false);
  });

  it("registers transcripts for an active local operator with an explicit global opt-out", () => {
    const capability = createCronCreatorAuthorityCapability("run-local", { kind: "local" })!;
    runWithCronCreatorAuthorityCapability(capability, () => {
      expect(createFastToolNames({ runId: "run-local" })).toContain("transcripts");
      expect(
        createFastToolNames({
          config: { transcripts: { enabled: false } } as OpenClawConfig,
          runId: "run-local",
        }),
      ).not.toContain("transcripts");
    });
  });

  it("registers task suggestions only for sessions with an actionable gateway sink", () => {
    const expectNoTasks = (options: CreateOpenClawToolsOptions) => {
      const names = createFastToolNames(options);
      expect(names).not.toContain("suggest_task");
      expect(names).not.toContain("dismiss_task");
    };
    expectNoTasks({
      cwd: "/repo",
      taskSuggestionDeliveryMode: "gateway",
    });
    expectNoTasks({
      agentSessionKey: "agent:main:main",
      cwd: "/repo",
    });
    const withSink = createFastToolNames({
      agentSessionKey: "agent:main:main",
      cwd: "/repo",
      taskSuggestionDeliveryMode: "gateway",
    });

    expect(withSink).toEqual(expect.arrayContaining(["suggest_task", "dismiss_task"]));
  });

  it("keeps explicitly allowed message tool in embedded completions", () => {
    setEmbeddedMode(true);
    const messageTools = (options: CreateOpenClawToolsOptions) =>
      createFastToolNames({ ...options, disableMessageTool: false });
    expect(messageTools({ pluginToolAllowlist: ["message"] })).toContain("message");
    expect(
      messageTools({
        config: { tools: { profile: "minimal", alsoAllow: ["message"] } } as OpenClawConfig,
      }),
    ).toContain("message");
    expect(
      messageTools({
        pluginToolAllowlist: ["message"],
        pluginToolDenylist: ["message"],
      }),
    ).not.toContain("message");
  });

  it("lets an explicit updatePlan false override an allowlist that includes the tool", () => {
    expect(
      shouldIncludeProgressCardToolForOpenClawTools({
        config: { tools: { updatePlan: false, allow: ["update_plan"] } },
      }),
    ).toBe(false);
  });
});

function hasTool(tools: readonly { name: string }[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

function expectRegistered(options: CreateOpenClawToolsOptions, name: string, expected = true) {
  expect(hasTool(createOpenClawTools(options), name)).toBe(expected);
}

const openClawOnlyPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: true,
  includePluginTools: false,
};

function sandboxOptions(config: OpenClawConfig, sessionKey: string, workspaceDir: string) {
  return {
    config,
    sessionKey,
    sandbox: createAgentToolsSandboxContext({
      workspaceDir,
      sessionKey,
      tools: resolveSandboxToolPolicyForAgent(config, "main"),
    }),
    senderIsOwner: false,
    wrapBeforeToolCallHook: false,
    toolConstructionPlan: openClawOnlyPlan,
  };
}

type ChannelPresenter = Extract<WidgetPresenter, { target: "current_channel" }>;

function widgetPresenter(overrides: Partial<ChannelPresenter> = {}): ChannelPresenter {
  return {
    target: "current_channel",
    description: "Present in the configured Discord channel",
    capabilities: { sourceKinds: ["html"] },
    match: (context) => context.messageChannel === "discord" && context.accountId === "configured",
    availability: async () => ({ ok: true, value: { available: true } }),
    present: async () => {
      throw new Error("present must not run");
    },
    ...overrides,
  };
}

function registerPresenters(...presenters: WidgetPresenter[]) {
  const registry = createEmptyPluginRegistry();
  registry.widgetPresenters.push(
    ...presenters.map((presenter, index) => ({
      pluginId: `fixture-${index}`,
      presenter,
      source: "widget-fixture",
    })),
  );
  setActivePluginRegistry(registry);
}

describe("gateway client capability tool filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
  });

  it("exposes one core widget tool for a matching current-channel presenter", async () => {
    const present = vi.fn(async () => ({
      ok: true as const,
      value: {
        kind: "message" as const,
        receipt: {
          primaryPlatformMessageId: "discord-message-1",
          platformMessageIds: ["discord-message-1"],
          parts: [],
          sentAt: 1,
        },
      },
    }));
    registerPresenters(widgetPresenter({ present }));

    const tools = createOpenClawTools({
      agentChannel: "discord",
      agentAccountId: "configured",
      nativeChannelId: "channel-1",
      agentSessionKey: "agent:main:discord",
    });
    const widgetTools = tools.filter((tool) => tool.name === "show_widget");

    expect(widgetTools).toHaveLength(1);
    expect(widgetTools[0]?.requiredClientCaps).toBeUndefined();
    const result = await widgetTools[0]?.execute("discord-widget", {
      title: "Status",
      widget_code: "<p>ready</p>",
    });
    expect(result?.details).toMatchObject({
      kind: "widget",
      presentation: {
        target: "current_channel",
        receipt: { primaryPlatformMessageId: "discord-message-1" },
      },
    });
    expect(present).toHaveBeenCalledOnce();
  });

  it("hides current-channel widgets when no presenter matches the trusted run facts", () => {
    registerPresenters(widgetPresenter());

    expectRegistered(
      { agentChannel: "discord", agentAccountId: "unconfigured" },
      "show_widget",
      false,
    );
    expectRegistered({ agentChannel: "slack" }, "show_widget", false);
  });

  it("fails closed when current-channel presenter matching is ambiguous", () => {
    const match: WidgetPresenter["match"] = (context) => context.messageChannel === "discord";
    registerPresenters(widgetPresenter({ match }), widgetPresenter({ match }));

    expectRegistered({ agentChannel: "discord" }, "show_widget", false);
  });

  it("retains the requesting browser through coding tool assembly", async () => {
    const gatewayUiCommandTarget = { connId: "requester-tab", profileId: "requester" };
    const targets: unknown[] = [];
    vi.spyOn(inProcessGateway, "callInProcessGatewayTool").mockImplementation(async () => {
      targets.push(getGatewayToolCallerIdentity()?.gatewayUiCommandTarget);
      return { ok: true } as never;
    });
    const tools = createOpenClawCodingTools({
      config: withDefaultRoster(undefined),
      sessionKey: "agent:main:main",
      clientCaps: ["ui-commands"],
      gatewayUiCommandTarget,
    });
    await expectToolNamed(tools, "screen").execute("select", {
      action: "navigate",
      sessionKey: "agent:main:other",
    });
    expect(targets).toEqual([gatewayUiCommandTarget]);
  });

  it("exposes GitHub publication only from a prepared session capability", () => {
    expectRegistered({}, "github_publish", false);
    expectRegistered({}, "github_identity_status", false);
    expectRegistered({ githubPublicationAvailable: false }, "github_publish", false);
    expectRegistered({ githubPublicationAvailable: false }, "github_identity_status");
    expectRegistered({ githubPublicationAvailable: true }, "github_publish");
  });

  it.each([
    ["operator.sessions.write", false, false, true, false, false],
    ["operator.write", false, false, true, true, true],
    ["operator.admin", false, false, true, true, true],
    ["operator.write", false, true, true, false, false],
    ["operator.write", false, false, false, false, false],
    ["operator.sessions.write", true, false, true, true, false],
    ["operator.write", true, false, true, true, true],
    ["operator.admin", true, false, true, true, true],
  ] as const)(
    "projects PR actions for %s, publishing=%s, deny=%s, managed=%s",
    async (scope, publishing, deny, managed, expected, actions) => {
      const cfg = withDefaultRoster(deny ? { tools: { deny: ["github_publish"] } } : {});
      const sessionKey = "agent:main:nonpublishing-parent";
      const inheritedPublicationToolRef: {
        current?: ReturnType<typeof createOpenClawTools>[number];
      } = {};
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
            ...sandboxOptions(cfg, sessionKey, "/tmp/nonpublishing-parent"),
            githubPublicationAvailable: managed ? publishing : undefined,
            inheritedPublicationToolRef,
          }),
      );
      expect(Boolean(inheritedPublicationToolRef.current)).toBe(managed && !publishing && !deny);
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
      expect(Value.Check(tool.parameters, { action: "publish" })).toBe(publishing && actions);
      expect(Value.Check(tool.parameters, { action: "refresh_base" })).toBe(publishing);
      expect(Value.Check(tool.parameters, { action: "edit" })).toBe(publishing);
      if (!publishing) {
        expect(tool.description).toContain("cannot publish its own workspace");
      } else if (!actions) {
        expect(tool.parameters).toHaveProperty("properties", {
          action: expect.any(Object),
          conflictsResolved: expect.any(Object),
          baseCommit: expect.any(Object),
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

  it.each<[string, OpenClawConfig, boolean | undefined, boolean]>([
    ["default policy", {}, true, true],
    ["sandbox deny", { tools: { sandbox: { tools: { deny: ["github_publish"] } } } }, true, false],
    [
      "restrictive sandbox allow",
      { tools: { sandbox: { tools: { allow: ["read"] } } } },
      true,
      false,
    ],
    ["global deny", { tools: { deny: ["github_publish"] } }, true, false],
    [
      "restrictive agent allow",
      { agents: { entries: { main: { tools: { allow: ["read"] } } } } },
      true,
      false,
    ],
    ["unavailable publication", {}, false, false],
    ["unprepared publication", {}, undefined, false],
  ])("filters sandbox GitHub publication with %s", async (_name, config, available, expected) => {
    const cfg = withDefaultRoster(config);
    const sessionKey = "agent:main:sandbox-publisher";
    const options = sandboxOptions(cfg, sessionKey, "/tmp/sandbox-publisher");
    const callers: unknown[] = [];
    const call = vi
      .spyOn(inProcessGateway, "callInProcessGatewayTool")
      .mockImplementation(async () => {
        callers.push(getGatewayToolCallerIdentity()?.sessionKey);
        return { requestId: "publication-1", status: "requested" } as never;
      });
    const tools = createOpenClawCodingTools({
      ...options,
      githubPublicationAvailable: available,
    });
    expect(hasTool(tools, "github_publish")).toBe(expected);
    if (expected) {
      await expectToolNamed(tools, "github_publish").execute("publish-1", {
        title: "Publish fix",
      });
      expect(call).toHaveBeenCalledWith("sessions.github.publish", {
        sessionKey,
        idempotencyKey: "publish-1",
        title: "Publish fix",
      });
      expect(callers).toEqual([sessionKey]);
    } else {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("omits host UI runtime tools for sandboxed agents", () => {
    const agentSessionKey = "agent:main:main";
    expectRegistered({ agentSessionKey }, "terminal");
    expectRegistered({ agentSessionKey }, "portal");
    expectRegistered({ agentSessionKey, sandboxed: true }, "terminal", false);
    expectRegistered({ agentSessionKey, sandboxed: true }, "portal", false);
  });

  it("does not let tools.allow resurrect a gated tool for a channel run", () => {
    const tools = createOpenClawCodingTools({
      messageProvider: "telegram",
      disableMessageTool: true,
      config: { tools: { allow: ["show_widget"] } },
      toolConstructionPlan: { ...openClawOnlyPlan, includePluginTools: true },
    });

    expect(hasTool(tools, "show_widget")).toBe(false);
  });

  it("does not add the core widget tool to plugin-only construction plans", () => {
    const expectAbsent = (messageProvider: string, name: string, clientCaps?: string[]) => {
      const tools = createOpenClawCodingTools({
        messageProvider,
        clientCaps,
        toolConstructionPlan: {
          ...openClawOnlyPlan,
          includeOpenClawTools: false,
          includePluginTools: true,
        },
      });
      expect(hasTool(tools, name)).toBe(false);
    };
    expectAbsent("telegram", "show_widget");
    expectAbsent("webchat", "show_widget", ["inline-widgets"]);
    expectAbsent("webchat", "progress_card");
  });
});
