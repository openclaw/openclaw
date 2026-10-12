// Verifies OpenClaw tool registration, availability, and construction policy.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as userProfileList from "../state/user-profile-list.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
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
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import * as inProcessGateway from "./tools/in-process-gateway.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

type CreateOpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;

function withDefaultRoster(config: OpenClawConfig | undefined): OpenClawConfig {
  return {
    ...config,
    agents: config?.agents ?? { entries: { main: {} } },
  };
}

function toolNames(tools: ReturnType<typeof createOpenClawTools>): string[] {
  return tools.map((tool) => tool.name);
}

function createFastToolNames(options: CreateOpenClawToolsOptions): string[] {
  // Disable unrelated dynamic surfaces so registration assertions stay deterministic.
  return toolNames(
    createTestOpenClawTools({
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      ...options,
    }),
  );
}

function createTestOpenClawTools(options: CreateOpenClawToolsOptions = {}) {
  return createOpenClawTools({
    ...options,
    config: withDefaultRoster(options.config),
  });
}

function expectToolNamed(
  tools: ReturnType<typeof createOpenClawTools>,
  name: string,
): ReturnType<typeof createOpenClawTools>[number] {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name} to be registered`);
  }
  return tool;
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
      includeBaseCodingTools: true,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
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
  afterEach(() => {
    setEmbeddedMode(false);
  });

  it.each([false, true])(
    "gates personal instructions on multiple people (%s) without general filesystem access",
    (multipleProfiles) => {
      const identityCount = vi
        .spyOn(userProfileList, "hasMultipleSessionSharingIdentities")
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

  it("keeps human-question tools on permitted primary sessions", () => {
    for (const toolName of ["ask_user", "secrets"] as const) {
      const includeTool = (agentSessionKey?: string) =>
        shouldIncludePrimarySessionToolForOpenClawTools(toolName, { agentSessionKey });
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
    expect(
      createFastToolNames({
        runSessionKey: "agent:main:non-embedded",
      }),
    ).toEqual(expect.arrayContaining(["ask_user", "secrets"]));
    setEmbeddedMode(true);

    expect(
      createFastToolNames({
        agentSessionKey: "agent:main:subagent:worker",
      }),
    ).not.toContain("ask_user");
    expect(
      createFastToolNames({
        runSessionKey: "agent:main:run",
      }),
    ).toContain("ask_user");
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
    const regular = createFastToolNames({
      agentSessionKey: "agent:main:main",
    });
    const sandboxed = createFastToolNames({
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });
    const system = createFastToolNames({
      agentSessionKey: "agent:openclaw:main",
    });
    setEmbeddedMode(true);
    const embedded = createFastToolNames({
      agentSessionKey: "agent:main:main",
    });

    expect(regular).toContain("openclaw");
    expect(sandboxed).not.toContain("openclaw");
    expect(system).not.toContain("openclaw");
    expect(embedded).not.toContain("openclaw");
  });

  it("registers transcripts for an active local operator with an explicit global opt-out", () => {
    const capability = createCronCreatorAuthorityCapability("run-local", { kind: "local" })!;
    const { defaultTools, disabledTools } = runWithCronCreatorAuthorityCapability(
      capability,
      () => ({
        defaultTools: createFastToolNames({
          runId: "run-local",
        }),
        disabledTools: createFastToolNames({
          config: { transcripts: { enabled: false } } as OpenClawConfig,
          runId: "run-local",
        }),
      }),
    );

    expect(defaultTools).toContain("transcripts");
    expect(disabledTools).not.toContain("transcripts");
  });

  it("registers task suggestions only for sessions with an actionable gateway sink", () => {
    const withoutSession = createFastToolNames({
      cwd: "/repo",
      taskSuggestionDeliveryMode: "gateway",
    });
    const withoutSink = createFastToolNames({
      agentSessionKey: "agent:main:main",
      cwd: "/repo",
    });
    const withSink = createFastToolNames({
      agentSessionKey: "agent:main:main",
      cwd: "/repo",
      taskSuggestionDeliveryMode: "gateway",
    });

    expect(withoutSession).not.toContain("suggest_task");
    expect(withoutSession).not.toContain("dismiss_task");
    expect(withoutSink).not.toContain("suggest_task");
    expect(withoutSink).not.toContain("dismiss_task");
    expect(withSink).toEqual(expect.arrayContaining(["suggest_task", "dismiss_task"]));
  });

  it("keeps explicitly allowed message tool in embedded completions", () => {
    setEmbeddedMode(true);
    const fromRuntimeAllowlist = createTestOpenClawTools({
      disablePluginTools: true,
      pluginToolAllowlist: ["message"],
      wrapBeforeToolCallHook: false,
    });
    const fromGlobalAlsoAllow = createTestOpenClawTools({
      config: { tools: { profile: "minimal", alsoAllow: ["message"] } } as OpenClawConfig,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });
    const denied = createTestOpenClawTools({
      disablePluginTools: true,
      pluginToolAllowlist: ["message"],
      pluginToolDenylist: ["message"],
      wrapBeforeToolCallHook: false,
    });

    expect(toolNames(fromRuntimeAllowlist)).toContain("message");
    expect(toolNames(fromGlobalAlsoAllow)).toContain("message");
    expect(toolNames(denied)).not.toContain("message");
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

    try {
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
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it("hides current-channel widgets when no presenter matches the trusted run facts", () => {
    registerPresenters(widgetPresenter());

    try {
      expect(
        hasTool(
          createOpenClawTools({ agentChannel: "discord", agentAccountId: "unconfigured" }),
          "show_widget",
        ),
      ).toBe(false);
      expect(hasTool(createOpenClawTools({ agentChannel: "slack" }), "show_widget")).toBe(false);
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it("fails closed when current-channel presenter matching is ambiguous", () => {
    const match: WidgetPresenter["match"] = (context) => context.messageChannel === "discord";
    registerPresenters(widgetPresenter({ match }), widgetPresenter({ match }));

    try {
      expect(hasTool(createOpenClawTools({ agentChannel: "discord" }), "show_widget")).toBe(false);
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it("retains the requesting browser through coding tool assembly", async () => {
    const gatewayUiCommandTarget = { connId: "requester-tab", profileId: "requester" };
    const targets: unknown[] = [];
    const call = vi
      .spyOn(inProcessGateway, "callInProcessGatewayTool")
      .mockImplementation(async () => {
        targets.push(getGatewayToolCallerIdentity()?.gatewayUiCommandTarget);
        return { ok: true } as never;
      });
    try {
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
    } finally {
      call.mockRestore();
    }
  });

  it("exposes GitHub publication only from a prepared session capability", () => {
    expect(hasTool(createOpenClawTools(), "github_publish")).toBe(false);
    expect(hasTool(createOpenClawTools(), "github_identity_status")).toBe(false);
    expect(
      hasTool(createOpenClawTools({ githubPublicationAvailable: false }), "github_publish"),
    ).toBe(false);
    expect(
      hasTool(createOpenClawTools({ githubPublicationAvailable: false }), "github_identity_status"),
    ).toBe(true);
    expect(
      hasTool(createOpenClawTools({ githubPublicationAvailable: true }), "github_publish"),
    ).toBe(true);
  });

  it("omits host UI runtime tools for sandboxed agents", () => {
    expect(hasTool(createOpenClawTools({ agentSessionKey: "agent:main:main" }), "terminal")).toBe(
      true,
    );
    expect(hasTool(createOpenClawTools({ agentSessionKey: "agent:main:main" }), "portal")).toBe(
      true,
    );
    expect(
      hasTool(
        createOpenClawTools({ agentSessionKey: "agent:main:main", sandboxed: true }),
        "terminal",
      ),
    ).toBe(false);
    expect(
      hasTool(
        createOpenClawTools({ agentSessionKey: "agent:main:main", sandboxed: true }),
        "portal",
      ),
    ).toBe(false);
  });

  it("does not let tools.allow resurrect a gated tool for a channel run", () => {
    const tools = createOpenClawCodingTools({
      messageProvider: "telegram",
      disableMessageTool: true,
      config: { tools: { allow: ["show_widget"] } },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: true,
      },
    });

    expect(hasTool(tools, "show_widget")).toBe(false);
  });

  it("does not add the core widget tool to plugin-only construction plans", () => {
    const plan = {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: true,
    };

    expect(
      hasTool(
        createOpenClawCodingTools({ messageProvider: "telegram", toolConstructionPlan: plan }),
        "show_widget",
      ),
    ).toBe(false);
    expect(
      hasTool(
        createOpenClawCodingTools({
          messageProvider: "webchat",
          clientCaps: ["inline-widgets"],
          toolConstructionPlan: plan,
        }),
        "show_widget",
      ),
    ).toBe(false);
    expect(
      hasTool(
        createOpenClawCodingTools({ messageProvider: "webchat", toolConstructionPlan: plan }),
        "progress_card",
      ),
    ).toBe(false);
  });
});
