import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
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
  } = {},
) {
  const visibleTools = options.visibleTools ?? [tool("dispatch_action")];
  const uncompactedTools = options.uncompactedTools ?? [];
  const config: OpenClawConfig = {
    tools: {
      codeMode: options.codeMode ?? false,
      toolSearch: { enabled: !options.codeMode, mode: options.directory ? "directory" : "tools" },
    },
  };
  const admission = prepareSystemAgentRunAdmission(config, "catalog-plan", "main", "catalog-test");
  const abort = new AbortController();
  const surface = createAgentHarnessToolSurfaceRuntimeCore({ config, modelToolsEnabled: true });
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
      effectiveToolsAllow: undefined,
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
      toolsEnabled: true,
      toolsRaw: uncompactedTools,
    } satisfies Parameters<typeof prepareEmbeddedAttemptToolCatalog>[0]["preparedToolBase"];
    const result = await prepareEmbeddedAttemptToolCatalog({
      attempt,
      setup: createAttemptSetupFixture({
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
    return result.toolSearchRunPlan;
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
