import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import { createSandboxTestContext } from "../../sandbox/test-fixtures.js";
import { AuthStorage } from "../../sessions/auth-storage.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import {
  createClientToolDefinition as clientTool,
  createStubTool as tool,
} from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createAttemptNestedToolActivityState } from "./attempt-nested-tool-activity.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const clientTools = [clientTool("client_pick_file")];
async function plan(
  options: {
    visibleTools?: AnyAgentTool[];
    uncompactedTools?: AnyAgentTool[];
    catalogToolCount?: number;
    codeMode?: boolean;
    directory?: boolean;
    allow?: string[] | null;
    config?: OpenClawConfig;
    configAllow?: string[];
    agentAllow?: string[];
    toolsEnabled?: boolean;
    disableTools?: boolean;
    effectiveToolsAllow?: string[];
    sandboxed?: boolean;
    clientTools?: typeof clientTools;
    toolSearch?: NonNullable<OpenClawConfig["tools"]>["toolSearch"];
  } = {},
) {
  const visibleTools =
    options.visibleTools ?? (options.codeMode ? undefined : [tool("dispatch_action")]);
  const uncompactedTools = options.uncompactedTools ?? [];
  const config: OpenClawConfig = {
    ...options.config,
    tools: {
      allow: options.configAllow,
      codeMode: options.codeMode ?? false,
      toolSearch: options.toolSearch ?? {
        enabled: !options.codeMode,
        mode: options.directory ? "directory" : "tools",
      },
      ...options.config?.tools,
    },
    agents: options.config?.agents ?? {
      entries: { main: { tools: { allow: options.agentAllow } } },
    },
  };
  const admission = prepareSystemAgentRunAdmission(config, "catalog-plan", "main", "catalog-test");
  const abort = new AbortController();
  const surface = createAgentHarnessToolSurfaceRuntimeCore({
    config,
    modelToolsEnabled: options.toolsEnabled ?? true,
  });
  const runClientTools = options.clientTools ?? clientTools;
  try {
    const authStorage = AuthStorage.inMemory();
    const attempt = {
      config,
      admittedRunContext: await admission.admit("embedded"),
      abortSignal: abort.signal,
      runId: "catalog-plan",
      sessionId: "catalog-plan",
      sessionKey: "agent:main:catalog-plan",
      sessionFile: "catalog-plan",
      workspaceDir: "/tmp/catalog-plan",
      prompt: "Inspect the synthetic tool catalog",
      timeoutMs: 60_000,
      provider: "openai",
      modelId: "catalog-model",
      model: makeProviderModelFixture({
        id: "catalog-model",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://example.test/v1",
      }),
      thinkLevel: "off",
      toolsAllow: options.allow === null ? undefined : (options.allow ?? ["missing_tool"]),
      disableTools: options.disableTools,
      authProfileStore: { version: 1, profiles: {} },
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
    } satisfies EmbeddedRunAttemptParams;
    const seed = surface.compactTools(uncompactedTools);
    const preparedToolBase = {
      toolHookContext: {
        awaitSessionDiffBaseline: undefined,
        watchdogAttempt: undefined,
        agentId: "main",
        config,
        cwd: attempt.workspaceDir,
        sessionKey: attempt.sessionKey,
        sessionId: attempt.sessionId,
        runId: attempt.runId,
        approvalReviewerDeviceId: undefined,
        channelId: undefined,
        trace: { traceId: "1234567890abcdef1234567890abcdef" },
        loopDetection: undefined,
        onToolOutcome: undefined,
        allocateToolOutcomeOrdinal: undefined,
      },
      toolAbortSignal: abort.signal,
      refreshPermissionMode: async () => {
        throw new Error("The catalog fixture does not prepare permission changes");
      },
      webSearchUnconfigured: false,
      hasNativeWebSearch: false,
      codeModeControlsEnabledForRun: surface.codeModeControlsEnabled,
      codeModeSkills: [],
      computerContextEpoch: { value: 0 },
      skillInstructionDeliveryCache: new Map<string, Promise<boolean>>(),
      cronCreatorToolAllowlist: [],
      cronCreatorToolAllowlistCaptureRef: {},
      effectiveToolsAllow: options.effectiveToolsAllow,
      forceDirectMessageTool: false,
      requireExplicitMessageTarget: false,
      inheritedToolAllowlist: [],
      additionalInheritedToolNamesRef: [],
      localModelLeanEnabled: false,
      localModelLeanPreserveToolNames: [],
      replaySafetyOptions: { declaredReplaySafe: () => undefined },
      runtimeCapabilityProfile: resolveConversationCapabilityProfile({ config, agentId: "main" }),
      releaseTools: async () => surface.cleanup(),
      toolSearchCatalogRef: surface.toolSearchCatalogRef,
      toolSurfaceRuntime: {
        ...surface,
        // Fix only upstream compaction facts. The catalog computes every asserted allowlist.
        compactTools: () =>
          visibleTools
            ? {
                ...seed,
                tools: visibleTools,
                projectedTools: visibleTools,
                diagnostics: [],
                catalog: {
                  ...seed.catalog,
                  tools: visibleTools,
                  catalogRegistered: true,
                  catalogToolCount: options.catalogToolCount ?? 0,
                },
              }
            : seed,
      },
      toolSearchConfig: surface.plan.toolSearchConfig,
      toolSearchControlsEnabledForRun: surface.toolSearchControlsEnabled,
      toolSearchRuntimeConfig: surface.plan.toolSearchRuntimeConfig,
      nestedToolActivityState: createAttemptNestedToolActivityState(),
      toolsEnabled: options.toolsEnabled ?? true,
      toolsRaw: uncompactedTools,
    } satisfies Parameters<typeof prepareEmbeddedAttemptToolCatalog>[0]["preparedToolBase"];
    const result = await prepareEmbeddedAttemptToolCatalog({
      attempt,
      setup: createAttemptSetupFixture({
        sandbox: options.sandboxed ? createSandboxTestContext() : null,
        getProviderRuntimeHandle: () => ({
          provider: attempt.provider,
          modelId: attempt.modelId,
          prepared: true,
        }),
      }),
      preparedToolBase,
      bundleTools: { clientTools: runClientTools, uncompactedEffectiveTools: uncompactedTools },
      abortSignal: abort.signal,
      executeCodeModeTool: async () => ({ content: [], details: undefined }),
    });
    return {
      ...result.toolSearchRunPlan,
      emptyExplicitToolAllowlistError: result.emptyExplicitToolAllowlistError,
    };
  } finally {
    abort.abort();
    surface.cleanup();
    admission.close();
  }
}

describe("embedded attempt tool catalog", () => {
  it.each([
    { allow: ["exec"] },
    { allow: ["bash"] },
    { allow: ["read", "write", "exec", "process"] },
  ])("rejects an empty Code Mode catalog with explicit tools $allow", async ({ allow }) => {
    const result = await plan({ codeMode: true, allow, clientTools: [] });
    expect(result.emptyExplicitToolAllowlistError?.message).toContain("No callable tools remain");
    expect(result.emptyExplicitToolAllowlistError?.message).toContain("Fix the allowlist");
    expect(result.hasCallableTools).toBe(false);
  });

  it("admits a shell tool through Code Mode or direct execution", async () => {
    for (const codeMode of [true, false]) {
      const result = await plan({
        codeMode,
        uncompactedTools: [tool("exec")],
        ...(codeMode ? {} : { visibleTools: [tool("exec")] }),
        allow: ["exec"],
        clientTools: [],
      });
      expect(result.emptyExplicitToolAllowlistError).toBeNull();
      expect(result.hasCallableTools).toBe(true);
    }
  });

  it("keeps unselected clients direct without promoting MCP or client capabilities", async () => {
    const remote = tool("sessions_spawn");
    setPluginToolMeta(remote, {
      pluginId: "remote-plugin",
      optional: false,
      mcp: {
        serverName: "remote",
        safeServerName: "remote",
        toolName: "spawn",
        operation: "tool",
      },
    });
    const result = await plan({
      visibleTools: [remote, tool("native_direct")],
      clientTools: [clientTool("sessions_yield")],
      toolSearch: { mode: "tools", include: [{ source: "mcp" }] },
      allow: [],
    });
    expect([...result.visibleAllowedToolNames]).toEqual([
      "sessions_spawn",
      "native_direct",
      "sessions_yield",
    ]);
    expect([...result.capabilityToolNames]).toEqual(["native_direct"]);
  });

  it("keeps only deferred clients out of visible/live allowlists, not replay", async () => {
    const result = await plan({
      clientTools: [...clientTools, clientTool("client_direct")],
      toolSearch: {
        mode: "tools",
        include: [{ source: "client" }],
        exclude: [{ name: "client_direct" }],
      },
      allow: [],
    });
    expect([...result.visibleAllowedToolNames]).toEqual(["dispatch_action", "client_direct"]);
    expect([...result.liveAllowedToolNames]).toEqual(["dispatch_action", "client_direct"]);
    expect([...result.replayAllowedToolNames]).toEqual([
      "client_pick_file",
      "client_direct",
      "dispatch_action",
    ]);
    expect([...result.capabilityToolNames]).toEqual(["dispatch_action"]);
    expect(result.hasCallableTools).toBe(true);
  });

  it.each([
    ["an explicit allowlist", { allow: ["read"] }, null],
    ["additive plugin grants", { alsoAllow: ["optional_plugin_tool"] }, null],
    ["a denied command-time request", { allow: ["read"] }, ["read"]],
  ] satisfies Array<[string, NonNullable<OpenClawConfig["tools"]>, string[] | null]>)(
    "resolves a deny-all agent under %s",
    async (_name, tools, allow) => {
      const result = await plan({
        visibleTools: [],
        clientTools: [],
        allow,
        config: {
          tools,
          agents: { entries: { main: { tools: { deny: ["*"] } } } },
        },
      });
      expect(result.hasCallableTools).toBe(false);
      expect(result.visibleAllowedToolNames.size).toBe(0);
      if (allow) {
        expect(result.emptyExplicitToolAllowlistError?.message).toContain(
          "runtime toolsAllow: read",
        );
      } else {
        expect(result.emptyExplicitToolAllowlistError).toBeNull();
      }
    },
  );

  it("carries native catalog capabilities without widening direct execution authority", async () => {
    const foreignTool = tool("sessions_yield");
    setPluginToolMeta(foreignTool, { pluginId: "bundle-mcp", optional: false });
    const catalog = [tool("sessions_spawn"), foreignTool];
    const result = await plan({
      visibleTools: [tool("exec"), tool("wait")],
      uncompactedTools: catalog,
      catalogToolCount: 2,
      codeMode: true,
      allow: [],
    });
    expect([...result.visibleAllowedToolNames]).toEqual(["exec", "wait"]);
    expect(result.liveAllowedToolNames).toBe(result.visibleAllowedToolNames);
    expect([...result.replayAllowedToolNames]).toEqual([
      "sessions_spawn",
      "sessions_yield",
      "client_pick_file",
      "exec",
      "wait",
    ]);
    expect([...result.capabilityToolNames]).toEqual(["exec", "wait", "sessions_spawn"]);
    expect(result.hasCallableTools).toBe(true);
  });

  it.each([
    { name: "explicit client", cataloged: true, entries: ["client_pick_file"] },
    { name: "wildcard directory client", cataloged: false, entries: ["client_*"] },
    { name: "explicit control", cataloged: true, entries: ["dispatch_action", "missing_tool"] },
  ])("recognizes $name as callable", async ({ cataloged, entries }) => {
    const result = await plan({
      directory: !cataloged,
      allow: entries,
    });
    expect([...result.visibleAllowedToolNames]).toEqual(
      cataloged ? ["dispatch_action"] : ["dispatch_action", "client_pick_file"],
    );
    expect(result.hasCallableTools).toBe(true);
    expect(result.emptyExplicitToolAllowlistError).toBeNull();
  });

  it("keeps ambiguous deferred names replayable but not directly callable", async () => {
    const result = await plan({
      visibleTools: [tool("tool_search"), tool("tool_describe"), tool("dispatch_action")],
      uncompactedTools: [tool("fake_plugin_tool"), tool("sessions_spawn"), tool("sessions_spawn")],
      catalogToolCount: 3,
      directory: true,
      allow: [],
    });
    expect([...result.liveAllowedToolNames]).toEqual([
      "fake_plugin_tool",
      "tool_search",
      "tool_describe",
      "dispatch_action",
      "client_pick_file",
    ]);
    expect([...result.replayAllowedToolNames]).toContain("sessions_spawn");
    expect([...result.capabilityToolNames]).toEqual(["fake_plugin_tool", "sessions_spawn"]);
  });
});

async function diagnostic(options: Parameters<typeof plan>[0] = {}) {
  const result = await plan({ visibleTools: [], allow: [], ...options });
  return result.emptyExplicitToolAllowlistError;
}

describe("explicit tool allowlist diagnostics", () => {
  it.each([
    ["skill_workshop", true, false, "sandboxed run without library-authoring authority"],
    ["skill_*", true, false, "sandboxed run without library-authoring authority"],
    ["query_db", true, false, "no registered tools matched"],
    ["skill_workshop", false, false, "selected model does not support tools"],
    ["skill_workshop", true, true, "tools are disabled for this run"],
  ] as const)(
    "reports the relevant gate for %s (enabled=%s, disabled=%s)",
    async (entry, toolsEnabled, disableTools, expected) => {
      const error = await diagnostic({
        allow: [entry],
        toolsEnabled,
        disableTools,
        sandboxed: true,
      });
      expect(error?.message).toContain(expected);
      expect(error?.message).toContain(`runtime toolsAllow: ${entry}`);
    },
  );

  it.each([
    {
      name: "unmatched config allowlist",
      options: { configAllow: [" query_db ", ""], allow: ["missing_tool"] },
      messages: [
        "No callable tools remain",
        "tools.allow: query_db; runtime toolsAllow: missing_tool",
        "no registered tools matched",
      ],
    },
    {
      name: "model without tools",
      options: { agentAllow: ["query_db"], toolsEnabled: false },
      messages: ["agents.main.tools.allow: query_db", "the selected model does not support tools"],
    },
  ])("fails closed for $name", async ({ options, messages }) => {
    const error = await diagnostic(options);
    for (const message of messages) {
      expect(error?.message).toContain(message);
    }
  });

  it.each([
    { configAllow: ["lobster", "llm-task"], disableTools: true },
    { configAllow: ["*", "read", "cron"], effectiveToolsAllow: [] },
    {},
  ])("allows intentionally tool-less or unrestricted runs: %j", async (options) => {
    expect(await diagnostic(options)).toBeNull();
  });

  it("still enforces command-time allowlists for explicitly tool-less runs", async () => {
    const error = await diagnostic({
      configAllow: ["read"],
      allow: ["query_db"],
      effectiveToolsAllow: [],
    });
    expect(error?.message).toContain("runtime toolsAllow: query_db");
    expect(error?.message).not.toContain("tools.allow: read");
  });
});
