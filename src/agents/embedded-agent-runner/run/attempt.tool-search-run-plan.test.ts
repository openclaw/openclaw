import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import { createSandboxTestContext } from "../../sandbox/test-fixtures.js";
import { AuthStorage } from "../../sessions/auth-storage.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createAttemptNestedToolActivityState } from "./attempt-nested-tool-activity.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const tool = (name: string): AnyAgentTool => ({
  name,
  label: name,
  description: "Tool inventory fixture",
  parameters: Type.Object({}),
  execute: async () => ({ content: [], details: undefined }),
});
const clientTools = [
  {
    type: "function" as const,
    function: {
      name: "client_pick_file",
      parameters: { type: "object", properties: {} },
    },
  },
];
async function plan(
  options: {
    visibleTools?: AnyAgentTool[];
    uncompactedTools?: AnyAgentTool[];
    catalogToolCount?: number;
    codeMode?: boolean;
    directory?: boolean;
    allow?: string[];
    configAllow?: string[];
    agentAllow?: string[];
    toolsEnabled?: boolean;
    disableTools?: boolean;
    effectiveToolsAllow?: string[];
    sandboxed?: boolean;
  } = {},
) {
  const visibleTools = options.visibleTools ?? [tool("dispatch_action")];
  const uncompactedTools = options.uncompactedTools ?? [];
  const config: OpenClawConfig = {
    tools: {
      allow: options.configAllow,
      codeMode: options.codeMode ?? false,
      toolSearch: { enabled: !options.codeMode, mode: options.directory ? "directory" : "tools" },
    },
    agents: { entries: { main: { tools: { allow: options.agentAllow } } } },
  };
  const admission = prepareSystemAgentRunAdmission(config, "catalog-plan", "main", "catalog-test");
  const abort = new AbortController();
  const surface = createAgentHarnessToolSurfaceRuntimeCore({
    config,
    modelToolsEnabled: options.toolsEnabled ?? true,
  });
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
      toolsAllow: options.allow ?? ["missing_tool"],
      disableTools: options.disableTools,
      authProfileStore: { version: 1, profiles: {} },
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
    } satisfies EmbeddedRunAttemptParams;
    const seed = surface.compactTools([]);
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
      inheritedPublicationToolRef: {},
      localModelLeanEnabled: false,
      localModelLeanPreserveToolNames: [],
      replaySafetyOptions: { declaredReplaySafe: () => undefined },
      runtimeCapabilityProfile: resolveConversationCapabilityProfile({ config, agentId: "main" }),
      releaseTools: async () => surface.cleanup(),
      toolSearchCatalogRef: surface.toolSearchCatalogRef,
      toolSurfaceRuntime: {
        ...surface,
        // Fix only upstream compaction facts. The catalog computes every asserted allowlist.
        compactTools: () => ({
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
        }),
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
      bundleTools: { clientTools, uncompactedEffectiveTools: uncompactedTools },
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
    { name: "explicit control", cataloged: true, entries: ["dispatch_action"] },
  ])("recognizes $name as callable", async ({ cataloged, entries }) => {
    const result = await plan({
      directory: !cataloged,
      allow: entries,
    });
    expect([...result.visibleAllowedToolNames]).toEqual(
      cataloged ? ["dispatch_action"] : ["dispatch_action", "client_pick_file"],
    );
    expect(result.hasCallableTools).toBe(true);
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
    {
      entries: ["skill_workshop"],
      toolsEnabled: true,
      disableTools: false,
      expected: "sandboxed run without library-authoring authority",
    },
    {
      entries: ["skill_*"],
      toolsEnabled: true,
      disableTools: false,
      expected: "sandboxed run without library-authoring authority",
    },
    {
      entries: ["query_db"],
      toolsEnabled: true,
      disableTools: false,
      expected: "no registered tools matched",
    },
    {
      entries: ["skill_workshop"],
      toolsEnabled: false,
      disableTools: false,
      expected: "selected model does not support tools",
    },
    {
      entries: ["skill_workshop"],
      toolsEnabled: true,
      disableTools: true,
      expected: "tools are disabled for this run",
    },
  ])(
    "reports the relevant gate for $entries (enabled=$toolsEnabled, disabled=$disableTools)",
    async ({ entries, toolsEnabled, disableTools, expected }) => {
      expect(
        (await diagnostic({ allow: entries, toolsEnabled, disableTools, sandboxed: true }))
          ?.message,
      ).toContain(expected);
    },
  );

  it("fails closed when explicit allowlists resolve to no callable tools", async () => {
    const error = await diagnostic({ configAllow: [" query_db "] });
    expect(error?.message).toContain("No callable tools remain");
    expect(error?.message).toContain("tools.allow: query_db");
    expect(error?.message).toContain("no registered tools matched");
  });

  it("fails closed for runtime toolsAllow when tools are disabled", async () => {
    const error = await diagnostic({ allow: ["query_db"], disableTools: true });
    expect(error?.message).toContain("runtime toolsAllow: query_db");
    expect(error?.message).toContain("tools are disabled for this run");
  });

  it("allows inherited config allowlists when a run intentionally disables tools", async () => {
    expect(
      await diagnostic({ configAllow: ["lobster", "llm-task"], disableTools: true }),
    ).toBeNull();
  });

  it("allows inherited config allowlists when runtime toolsAllow is explicitly empty", async () => {
    expect(
      await diagnostic({ configAllow: ["*", "read", "cron"], effectiveToolsAllow: [] }),
    ).toBeNull();
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

  it("fails closed when the selected model cannot use requested tools", async () => {
    const error = await diagnostic({ agentAllow: ["query_db"], toolsEnabled: false });
    expect(error?.message).toContain("agents.main.tools.allow: query_db");
    expect(error?.message).toContain("the selected model does not support tools");
  });

  it("allows text-only runs without explicit allowlists", async () => {
    expect(await diagnostic()).toBeNull();
  });

  it("allows explicit allowlists when at least one callable tool remains", async () => {
    expect(
      (await plan({ visibleTools: [tool("read")], allow: ["read", "missing_tool"] }))
        .emptyExplicitToolAllowlistError,
    ).toBeNull();
  });

  it("keeps normalized source labels for config and runtime allowlists", async () => {
    expect((await diagnostic({ configAllow: [" read ", ""], allow: ["query_db"] }))?.message).toBe(
      "No callable tools remain after resolving explicit tool allowlist (tools.allow: read; runtime toolsAllow: query_db); no registered tools matched. Fix the allowlist or enable the plugin that registers the requested tool.",
    );
  });
});
