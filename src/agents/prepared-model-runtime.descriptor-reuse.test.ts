// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelFallbackOptions } from "../auto-reply/reply/agent-runner-run-params.js";
import * as replyAdmission from "../auto-reply/reply/get-reply-run-admission.js";
import * as replyContext from "../auto-reply/reply/get-reply-run-context.js";
import * as replyExecution from "../auto-reply/reply/get-reply-run-execute.js";
import { runPreparedReply } from "../auto-reply/reply/get-reply-run.js";
import type { RunPreparedReplyParams } from "../auto-reply/reply/get-reply-run.types.js";
import { bindPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";
import type { FollowupRun } from "../auto-reply/reply/queue.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import {
  createGatewayModelRuntimeReload,
  refreshModelRuntimeAfterHotReload,
} from "../gateway/server-reload-model-runtime-scope.js";
import * as modelCatalog from "../model-catalog/index.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import { listRuntimePluginIdsFromRegistry } from "../plugins/active-runtime-registry.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { getPluginRuntimeLoadContextState } from "../plugins/runtime/load-context-state.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import * as agentScope from "./agent-scope.js";
import { createContextEngineLogicalTurnLease } from "./harness/context-engine-logical-turn.js";
import {
  resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelections,
} from "./harness/runtime-plugin-load-plan.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import * as modelSelectionConfig from "./model-selection-config.js";
import { getPreparedModelRuntimePluginGeneration } from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime as loadDispatch,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness(
  { label: "descriptor-auth-reload" },
  clearRuntimeConfigSnapshot,
);

it("rejects descriptors captured before auth reload rebinds the retained plugin generation", async () => {
  const { prepareImplicitProviderStaticCatalog, resolveImplicitProviders } = await vi.importActual<
    typeof import("./models-config.providers.implicit.js")
  >("./models-config.providers.implicit.js");
  const id = "descriptor-reload";
  const providerConfig = {
    api: "openai-completions" as const,
    baseUrl: "https://catalog.example.invalid/v1",
    models: [{ ...buildCatalogModel("configured"), input: ["text" as const] }],
  };
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id,
        providers: [id],
        modelCatalog: { discovery: { [id]: "static" }, providers: { [id]: providerConfig } },
      },
    ],
  });
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id }));
  const before: OpenClawConfig = {
    agents: { defaults: { model: `${id}/configured` } },
    plugins: { allow: [id] },
  };
  const after: OpenClawConfig = {
    ...before,
    auth: { profiles: { [`${id}:manual`]: { provider: id, mode: "api_key" } } },
  };
  fixture.mocks.configuredAgentIds = ["default"];
  fixture.mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  fixture.mocks.prepareStaticCatalog.mockImplementation(prepareImplicitProviderStaticCatalog);
  setRuntimeConfigSnapshot(before, before);
  await refreshPreparedModelRuntimeSnapshots(before, {
    gatewayLifecycle: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
    pluginMetadataSnapshot: metadata,
  });
  const previous = await loadDispatch({ agentId: "default" });
  const generation = previous!.pluginGeneration!;
  const prepared = generation.preparedStaticProviderCatalog!;
  const binding = getPluginRuntimeLoadContextState(registry);
  expect(generation.pluginRegistry).toBe(registry);
  expect(prepared.providers).toHaveLength(1);
  const read = (config: OpenClawConfig) =>
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: generation.pluginMetadataSnapshot,
        pluginRegistry: generation.pluginRegistry,
      },
      () =>
        resolveImplicitProviders({
          config,
          env: process.env,
          agentDir: fixture.state.agentDir("default"),
          authStore: { version: 1, profiles: {} },
          pluginMetadataSnapshot: metadata,
          providerDiscoveryProviderIds: [id],
          preparedStaticProviderCatalog: prepared,
        }),
    );
  using plans = vi.spyOn(modelCatalog, "planEffectiveModelCatalogRows");
  await read(before);
  expect(plans).not.toHaveBeenCalled();
  const reload = createGatewayModelRuntimeReload().prepare(
    buildGatewayReloadPlan([`auth.profiles.${id}:manual`]),
    before,
    after,
  );
  expect(reload.scope.preservePluginGenerations).toBe(true);
  setRuntimeConfigSnapshot(after, after);
  await refreshModelRuntimeAfterHotReload({
    config: after,
    agentIds: reload.agentIds,
    ...reload.scope,
    pluginMetadataSnapshot: metadata,
  });
  const current = await loadDispatch({ agentId: "default" });
  expect(current?.config).toBe(after);
  expect(current?.pluginGeneration).toBe(generation);
  expect(current?.pluginGeneration?.preparedStaticProviderCatalog).toBe(prepared);
  expect(getPluginRuntimeLoadContextState(registry)).not.toBe(binding);
  expect(getPluginRuntimeLoadContextState(registry)?.rawConfig).toEqual(after);
  plans.mockClear();
  expect((await read(after))?.[id]?.models[0]?.id).toBe("configured");
  expect(plans).toHaveBeenCalledOnce();
});

const { mocks } = fixture;
describe("prepared reply fallback authority", () => {
  const reply = { context: vi.fn(), execute: vi.fn() };
  beforeEach(async () => {
    reply.context.mockReset();
    reply.execute.mockReset();
    vi.spyOn(replyContext, "prepareReplyRunContext").mockImplementation(reply.context);
    vi.spyOn(replyAdmission, "prepareReplyRunAdmission").mockImplementation(
      async (context) => context as never,
    );
    vi.spyOn(replyExecution, "executePreparedReplyRun").mockImplementation(reply.execute);
    const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
    vi.spyOn(agentScope, "resolveAgentConfig").mockImplementation(actual.resolveAgentConfig);
    vi.spyOn(agentScope, "resolveAgentModelFallbacksOverride").mockImplementation(
      actual.resolveAgentModelFallbacksOverride,
    );
    const actualSelection = await vi.importActual<typeof modelSelectionConfig>(
      "./model-selection-config.js",
    );
    vi.spyOn(modelSelectionConfig, "resolveEffectiveModelFallbacks").mockImplementation(
      actualSelection.resolveEffectiveModelFallbacks,
    );
    vi.spyOn(modelSelectionConfig, "resolveModelFallbackAvailability").mockImplementation(
      actualSelection.resolveModelFallbackAvailability,
    );
    vi.spyOn(agentScope, "resolveSubagentSpawnModelFallbacksOverride").mockImplementation(
      actual.resolveSubagentSpawnModelFallbacksOverride,
    );
  });
  afterEach(() => vi.restoreAllMocks());
  it("prepares a reply on the current generation when its captured dispatch generation was replaced", async () => {
    const previous = { messages: { responsePrefix: "before" } };
    const current = { messages: { responsePrefix: "after" } };
    mocks.configuredAgentIds = ["default"];
    const options = { gatewayLifecycle: true, catalogMode: "static" as const };
    await refreshPreparedModelRuntimeSnapshots(previous, options);
    const captured = (await loadDispatch({ agentId: "default" }))!;
    await refreshPreparedModelRuntimeSnapshots(current, options);
    const published = (await loadDispatch({ agentId: "default" }))!;
    reply.context.mockResolvedValue({
      kind: "ready",
      workspaceDir: captured.workspaceDir,
      thinkingRuntime: "openclaw",
    });
    reply.execute.mockImplementation(async () => {
      const pluginGeneration = getPreparedModelRuntimePluginGeneration()!;
      expect(pluginGeneration).not.toBe(captured.pluginGeneration);
      await using nested = await acquireAgentRunPreparedModelRuntime(
        {
          config: current,
          agentId: published.agentId,
          agentDir: published.agentDir,
          workspaceDir: published.workspaceDir,
        },
        { pluginGeneration },
      );
      expect(nested.snapshot.config).toEqual(current);
      return { text: "reply completed after reload" };
    });
    const execute = bindPreparedReplyDispatchRuntime(captured, () =>
      runPreparedReply({
        provider: "custom",
        model: "model",
        ctx: {},
        sessionCtx: {},
        cfg: previous,
        agentId: captured.agentId,
      } as RunPreparedReplyParams),
    );
    await expect(execute()).resolves.toEqual({ text: "reply completed after reload" });
    expect(reply.execute).toHaveBeenCalledOnce();
  });
  it("admits a nested reply after its configured context engine falls back to legacy", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "initial/model" } },
      plugins: {
        allow: ["initial", "selected", "unavailable-context"],
        slots: { memory: "none", contextEngine: "unavailable-context" },
        entries: { "unavailable-context": { enabled: true } },
      },
    };
    const metadata = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    mocks.configuredAgentIds = ["default", "secondary"];
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() =>
      createEmptyPluginRegistry(),
    );
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      pluginMetadataSnapshot: metadata,
    });
    const dispatch = (await loadDispatch({ agentId: "secondary" }))!;
    reply.context.mockResolvedValue({
      kind: "run",
      workspaceDir: dispatch.workspaceDir,
      thinkingRuntime: "openclaw",
    });
    using warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    reply.execute.mockImplementation(async () => {
      const pluginGeneration = getPreparedModelRuntimePluginGeneration()!;
      expect(pluginGeneration).not.toBe(dispatch.pluginGeneration);
      const contextEngine = await createContextEngineLogicalTurnLease({
        config,
        identity: { runId: "reply-context-fallback", sessionId: "reply-context-fallback" },
        agentDir: dispatch.agentDir,
        workspaceDir: dispatch.workspaceDir,
      });
      try {
        expect(contextEngine.effectiveEngineId).toBe("legacy");
        expect(contextEngine.degradedReason).toBe(
          'context engine "unavailable-context" is not registered',
        );
        await using nested = await acquireAgentRunPreparedModelRuntime(
          {
            config,
            agentId: dispatch.agentId,
            agentDir: dispatch.agentDir,
            workspaceDir: dispatch.workspaceDir,
            allowGatewaySubagentBinding: true,
            runtimePluginSelections: [
              { provider: "selected", modelId: "model", runtime: "openclaw" },
            ],
          },
          { pluginGeneration },
        );
        expect(nested.pluginGeneration).toBe(pluginGeneration);
        return { text: "reply admitted with legacy context" };
      } finally {
        await contextEngine.dispose();
      }
    });
    const execute = bindPreparedReplyDispatchRuntime(dispatch, () =>
      runPreparedReply({
        provider: "selected",
        model: "model",
        ctx: {},
        sessionCtx: {},
        cfg: config,
        agentId: dispatch.agentId,
      } as RunPreparedReplyParams),
    );

    await expect(execute()).resolves.toEqual({ text: "reply admitted with legacy context" });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Context engine "unavailable-context" degraded to "legacy"'),
    );
    expect(config.plugins?.slots?.contextEngine).toBe("unavailable-context");
  });
  it.each([
    { source: "user", locked: false },
    { source: "auto", locked: true },
  ] as const)(
    "keeps explicit subagent execution policy (source=$source, locked=$locked)",
    async ({ source, locked }) => {
      const config: OpenClawConfig = {
        agents: {
          entries: { default: {} },
          defaults: {
            model: { primary: "initial/model", fallbacks: [] },
            subagents: { model: { primary: "selected/model", fallbacks: ["fallback/model"] } },
          },
        },
        plugins: { allow: ["initial", "selected", "fallback"], slots: { memory: "none" } },
      };
      const manifests: PluginManifestRecord[] = ["initial", "selected", "fallback"].map((id) => ({
        id,
        name: id,
        origin: "bundled",
        channels: [],
        providers: [id],
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: `/plugins/${id}`,
        source: `/plugins/${id}/index.js`,
        manifestPath: `/plugins/${id}/openclaw.plugin.json`,
        activation: { onStartup: false, onProviders: [id] },
      }));
      const metadata = createPluginMetadataSnapshot({
        config,
        manifestRegistry: { plugins: manifests, diagnostics: [] },
      });
      mocks.configuredAgentIds = ["default"];
      mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) => {
        const registry = createEmptyPluginRegistry();
        const plan = resolveAgentRuntimePluginLoadPlan({
          config,
          workspaceDir: "/tmp/unused-workspace",
          metadataSnapshot: metadata,
          basePluginIds: params.reusableRegistry
            ? listRuntimePluginIdsFromRegistry(params.reusableRegistry)
            : [],
          selections: resolveAgentRuntimePluginSelections(config, params.selections ?? []),
        });
        registry.plugins.push(
          ...(plan.pluginIds ?? []).map((id) => createPluginRecord({ id, origin: "bundled" })),
        );
        return registry;
      });
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        pluginMetadataSnapshot: metadata,
      });
      const dispatch = (await loadDispatch({ agentId: "default" }))!;
      const run = {
        config,
        agentId: "default",
        agentDir: dispatch.agentDir,
        workspaceDir: dispatch.workspaceDir,
        provider: "selected",
        model: "model",
        sessionKey: "agent:default:subagent:test",
        hasSessionModelOverride: true,
        modelOverrideSource: source,
        modelSelectionLocked: locked,
        hasAutoFallbackProvenance: true,
      } as FollowupRun["run"];
      reply.context.mockResolvedValue({ kind: "run", workspaceDir: dispatch.workspaceDir });
      reply.execute.mockImplementation(async () => {
        const pluginGeneration = getPreparedModelRuntimePluginGeneration()!;
        const candidates = resolveModelCandidateChain({
          ...resolveModelFallbackOptions(run),
          manifestPlugins: metadata.plugins,
        });
        expect(candidates.map((candidate) => candidate.provider)).toEqual(["selected"]);
        await using _ = await acquireAgentRunPreparedModelRuntime(
          {
            config,
            agentId: run.agentId,
            agentDir: run.agentDir,
            workspaceDir: run.workspaceDir,
            allowGatewaySubagentBinding: true,
            runtimePluginSelections: candidates.map((candidate) => ({
              provider: candidate.provider,
              modelId: candidate.model,
            })),
          },
          { pluginGeneration },
        );
        return { text: "fallback admitted" };
      });
      const execute = bindPreparedReplyDispatchRuntime(dispatch, () =>
        runPreparedReply({
          provider: run.provider,
          model: run.model,
          ctx: {},
          sessionCtx: {},
          cfg: config,
          agentId: dispatch.agentId,
        } as RunPreparedReplyParams),
      );
      await expect(execute()).resolves.toEqual({ text: "fallback admitted" });
      expect(reply.execute).toHaveBeenCalledOnce();
    },
  );
});
