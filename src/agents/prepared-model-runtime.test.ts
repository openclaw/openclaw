// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withinTest } from "../../test/helpers/promise.js";
import { dispatchLowLevelChannelReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { getPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import * as configSerialization from "../config/runtime-config-snapshot-match.js";
import {
  clearRuntimeConfigSnapshot as clearConfig,
  setRuntimeConfigSnapshot as setConfig,
} from "../config/runtime-snapshot.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "../gateway/server-model-catalog.js";
import * as pricing from "../model-catalog/pricing.js";
import {
  captureRemoteModelCatalogSnapshot,
  captureRemoteModelCatalogStartupSnapshot,
  prepareRemoteModelCatalogStartupSnapshot,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createEnteredGate } from "./entered-gate.test-support.js";
import { modelDefinition, providerConfig } from "./model-auth.fixtures.test-support.js";
import { getPreparedModelCatalogOwnerSnapshot as catalogOwner } from "./prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import { scopePreparedModelRuntimeLease } from "./prepared-model-runtime-generation-scope.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  acquireAgentRunPreparedModelRuntime as acquireRun,
  acquireReadOnlyPreparedModelRuntime as acquireReadOnly,
  activateStandalonePreparedModelRuntime as activate,
  getPreparedModelRuntimeSnapshot as readSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale as markStale,
  prepareModelRuntimeSnapshot as prepare,
  publishPreparedModelRuntimeSnapshot as publish,
  refreshPreparedModelRuntimeSnapshots as refresh,
  type PreparedModelRuntimeInput,
} from "./prepared-model-runtime.js";
import { applyRemoteModelCatalogUpdate } from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const pendingBuilds: Array<() => Promise<void>> = [];
const fixture = usePreparedModelRuntimeHarness(undefined, async () => {
  for (const close of pendingBuilds.splice(0)) {
    await close();
  }
  vi.restoreAllMocks();
});
const { mocks } = fixture;
const configFor = (model = "openai/gpt-5.5", defaults: Partial<AgentDefaultsConfig> = {}) => ({
  agents: { defaults: { model, ...defaults } },
});
const inputFor = (
  name: string,
  config: OpenClawConfig = {},
  options: Partial<PreparedModelRuntimeInput> = {},
) => ({
  agentDir: fixture.state.agentDir(name),
  config,
  ...options,
});
const scopedModel = (model: string, runtime: string, allow: string) => ({
  model: { primary: model },
  models: { [model]: { agentRuntime: { id: runtime } } },
  modelPolicy: { allow: [allow] },
});
function holdNextBuild() {
  const started = createDeferred();
  const finish = createDeferred();
  mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, _targetDir) => {
    started.resolve();
    await finish.promise;
    return {};
  });
  const work: Promise<unknown>[] = [];
  pendingBuilds.push(async () => {
    finish.resolve();
    await Promise.allSettled(work);
  });
  return {
    started: started.promise,
    finish: () => finish.resolve(),
    track<T>(pending: Promise<T>) {
      work.push(pending);
      return pending;
    },
  };
}

describe("prepared model runtime snapshots", () => {
  it("materializes Claude CLI thinking capabilities on the prepared logical row", async () => {
    const modelId = "claude-opus-5";
    mocks.resolveStaticCatalogModel.mockImplementation(({ modelId: requestedId, provider }) =>
      provider === "claude-cli"
        ? makeProviderModelFixture({
            provider,
            id: requestedId,
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            reasoning: true,
          })
        : undefined,
    );
    const row = { provider: "anthropic", id: modelId, name: modelId, reasoning: false };
    mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [row],
      routeVariants: [row],
    });
    // A sparse user override must not become an explicit reasoning opt-out.
    const config = {
      ...configFor(`anthropic/${modelId}`, {
        models: {
          [`anthropic/${modelId}`]: {
            agentRuntime: { id: "claude-cli" },
            params: { thinking: "medium" },
          },
        },
      }),
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [{ id: modelId, name: modelId }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const snapshot = await publish(
      inputFor("claude-cli-capabilities", config, { agentId: "main" }),
    );
    expect(snapshot.modelCatalog.entries).toEqual([
      expect.objectContaining({ provider: "anthropic", id: modelId, reasoning: true }),
    ]);
  });

  it("keeps an isolated setup probe exact after a gateway replacement", async () => {
    mocks.configuredAgentIds = ["default"];
    const stagedConfig = configFor("openai/gpt-5.6");
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) => {
      // Fresh acquisitions cannot reuse the registry retired by an earlier generation.
      const registry = createEmptyPluginRegistry();
      if ((params as { selections?: unknown }).selections) {
        registry.agentHarnesses.push({
          pluginId: "codex",
          source: "test",
          harness: {
            id: "codex",
            label: "Codex",
            supports: () => ({ supported: true }),
            runAttempt: async () => {
              throw new Error("unused");
            },
          },
        });
      }
      return registry;
    });
    await refresh({}, { gatewayLifecycle: true });
    markStale("test isolated probe replacement", { waitForReplacement: true });
    const input = inputFor("setup-probe-agent", stagedConfig, {
      agentId: "openclaw",
      inheritedAuthDir: fixture.state.agentDir("setup-probe-agent"),
      workspaceDir: "/tmp/setup-probe-workspace",
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.6", runtime: "codex" }],
    });
    const leasePending = acquireReadOnly(input);
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);

    await refresh(configFor());
    await using lease = await leasePending;
    expect(lease.snapshot).toMatchObject({
      agentId: input.agentId,
      config: stagedConfig,
      agentDir: input.agentDir,
      workspaceDir: input.workspaceDir,
      pluginRegistry: expect.any(Object),
    });
    expect(lease.snapshot.pluginRegistry?.agentHarnesses.map((entry) => entry.harness.id)).toEqual([
      "codex",
    ]);
  });

  it("never returns a standalone generation invalidated while it is building", async () => {
    const input = inputFor("standalone-build-race");
    const build = holdNextBuild();

    const activation = build.track(activate(input));
    await build.started;
    markStale("test in-flight standalone publication");
    build.finish();

    await expect(activation).rejects.toThrow(PreparedModelRuntimePublicationSupersededError);
    expect(readSnapshot(input)).toBeUndefined();
  });

  it("keeps provider catalog outcomes on the published live snapshot", async () => {
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[2] as {
        onProviderCatalogOutcome?: (outcome: {
          provider: string;
          status: "ready" | "auth-rejected" | "unavailable";
        }) => void;
      };
      options.onProviderCatalogOutcome?.({ provider: "openai", status: "auth-rejected" });
      return {};
    });

    const snapshot = await publish(inputFor("provider-outcome-agent"));

    expect(snapshot.modelCatalog.providerOutcomes).toEqual([
      { provider: "openai", status: "auth-rejected" },
    ]);
  });

  it("limits live discovery to the selected agent's models and authenticated providers", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6" } },
        entries: {
          selected: scopedModel("anthropic/claude-sonnet-5", "selected-runtime", "vllm/*"),
          sibling: scopedModel("ollama/sibling", "sibling-runtime", "sibling-only/*"),
        },
      },
      models: {
        providers: {
          unrelated: { baseUrl: "https://unrelated.example/v1", models: [] },
          vllm: { baseUrl: "https://vllm.example/v1", models: [] },
        },
      },
    } as OpenClawConfig;
    mocks.runtimeSyntheticAuthProviderRefs = ["selected-runtime", "sibling-runtime"];

    const input = inputFor("selected-provider-scope", config, { agentId: "selected" });
    await publish(input);

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledWith(
      config,
      input.agentDir,
      expect.objectContaining({
        providerDiscoveryProviderIds: ["anthropic", "custom", "openai", "selected-runtime", "vllm"],
      }),
    );
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ syntheticAuthProviderRefs: ["selected-runtime"] }),
    );
  });

  it("builds credential-free command owners separately from runtime owners", async () => {
    const input = inputFor("credential-free");
    await publish(input);

    const credentialFree = await publish({
      ...input,
      readOnly: true,
      skipCredentials: true,
    });

    const runtime = await prepare(input);
    expect(credentialFree).not.toBe(runtime);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledOnce();
    expect(getPreparedModelRuntimeAuthStore(credentialFree)).toEqual({ version: 1, profiles: {} });
    expect(credentialFree.createStores().authStorage.getAll()).toEqual({});
    expect(runtime.createStores().authStorage.getAll()).toEqual({
      custom: { type: "api_key", key: "test-key" },
    });
  });

  it.each([
    ["usable", { type: "oauth", access: "a", refresh: "r", expires: 1 }, "oauth"],
    ["unusable", { type: "oauth", access: "", refresh: "", expires: 0 }, undefined],
  ] as const)(
    "consumes %s startup CLI hydration without rediscovery",
    async (_label, credential, expected) => {
      const config = configFor("openai/gpt-5.4");
      mocks.authStorage.getAll.mockReturnValue({ openai: credential });

      const snapshot = await publish(inputFor("cli-startup", config));

      const discoveryOptions = mocks.discoverAuthStorage.mock.calls[0]?.[1] as {
        externalCli?: unknown;
      };
      expect(discoveryOptions.externalCli).toBeUndefined();
      expect(snapshot.authModes.openai).toBe(expected);
    },
  );

  it("reuses read-only owners for equivalent config clones but rejects projections", async () => {
    const input = { ...inputFor("read-only-config", configFor()), readOnly: true };
    const first = await publish(input);
    const equivalent = { ...input, config: configFor() };
    const different = { ...input, config: configFor("anthropic/claude-opus-4-6") };
    expect(readSnapshot(equivalent)).toBe(first);
    expect(readSnapshot(different)).toBeUndefined();
    await expect(prepare(equivalent)).resolves.toBe(first);
    await expect(prepare(different)).rejects.toThrow("not published");
    await using secondLease = await acquireReadOnly(different);
    expect(secondLease.snapshot).not.toBe(first);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(2);
  });

  it("reuses publication fingerprints across fleet catalog reads without caching mutable projections", async () => {
    using stringify = vi.spyOn(configSerialization, "stableConfigStringify");
    try {
      for (const size of [8, 16]) {
        const config: OpenClawConfig = {
          agents: {
            entries: Object.fromEntries(
              Array.from({ length: size }, (_, index) => [`agent-${index}`, { name: "original" }]),
            ),
          },
        };
        setConfig(config);
        const input = inputFor(`read-only-fleet-${size}`, config, {
          agentId: "agent-0",
          readOnly: true,
        });
        const snapshot = await publish(input, { catalogMode: "static" });
        stringify.mockClear();
        for (let request = 0; request < 16; request++) {
          expect(catalogOwner(input)).toBe(snapshot);
        }
        expect(stringify.mock.calls.filter(([value]) => value === config)).toHaveLength(0);

        const projected = structuredClone(config);
        expect(catalogOwner({ ...input, config: projected })).toBe(snapshot);
        projected.agents!.entries!["agent-0"]!.name = "projected";
        expect(catalogOwner({ ...input, config: projected })).toBeUndefined();

        config.agents!.entries!["agent-0"]!.name = "republished";
        setConfig(config);
        expect(catalogOwner(input)).toBeUndefined();
        const replacement = await publish(input, { catalogMode: "static" });
        expect(replacement).not.toBe(snapshot);
        expect(catalogOwner(input)).toBe(replacement);
      }
    } finally {
      clearConfig();
    }
  });

  it("keeps replacement readers blocked when an earlier refresh is superseded", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const skippedConfig = configFor("openai/gpt-5.4");
    const latestConfig = configFor();
    await refresh(initialConfig);
    const build = holdNextBuild();

    markStale("test overlapping config commit", { waitForReplacement: true });
    const skipped = build.track(refresh(skippedConfig));
    const latest = build.track(refresh(latestConfig));
    const read = build.track(
      prepare({
        ...fixture.agentInput("default", latestConfig),
        workspaceDir: "/tmp/unused-workspace",
      }),
    );

    await skipped;
    await expect(
      Promise.race([
        read.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");
    await build.started;
    build.finish();
    await latest;
    await expect(read).resolves.toMatchObject({ config: latestConfig });
  });
  it.each(["workspace", "config"] as const)(
    "deduplicates standalone activation while publishing a changed %s",
    async (changed) => {
      const input = {
        ...inputFor("standalone"),
        workspaceDir: "/tmp/prepared-model-runtime-standalone-workspace",
      };

      const first = await activate(input);
      await activate(input);
      await activate({
        ...input,
        agentDir: fixture.state.agentDir("standalone-second"),
      });
      const replacementInput = {
        ...input,
        ...(changed === "workspace"
          ? { workspaceDir: "/tmp/standalone-replacement-workspace" }
          : { config: configFor() }),
      };
      const replacement = await activate(replacementInput);
      expect(replacement).not.toBe(first);
      expect(first?.config).toBe(input.config);
      expect(replacement?.config).toBe(replacementInput.config);
      expect(replacement).toMatchObject({
        agentDir: input.agentDir,
        workspaceDir: replacementInput.workspaceDir,
      });
      await expect(prepare(replacementInput)).resolves.toBe(replacement);
      await expect(prepare(input)).resolves.toMatchObject({
        workspaceDir: input.workspaceDir,
      });
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
    },
  );

  it("publishes a run owner from the caller-selected metadata generation", async () => {
    const selectedMetadata = { ...mocks.pluginMetadataSnapshot };
    await using lease = await acquireRun(
      {
        ...inputFor("selected-metadata-agent"),
        agentId: "main",
        workspaceDir: "/tmp/selected-metadata-workspace",
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
      },
      {
        catalogMode: "static",
        pluginMetadataSnapshot: selectedMetadata as never,
      },
    );

    expect(lease.snapshot.metadataSnapshot).toBe(selectedMetadata);
  });
});

describe("remote catalog publication boundaries", () => {
  const sourceUrl = "https://catalog.openclaw.ai/models/v2/catalog.json";
  const stored = vi.fn();
  const config: OpenClawConfig = {
    agents: {
      entries: { default: {}, other: {} },
      defaults: { model: "custom/remote-200" },
    },
    ...providerConfig("custom", {
      baseUrl: "https://fixture.invalid",
      api: "openai-completions",
      models: [modelDefinition("remote-200", { reasoning: false })],
    }),
  };
  function bundle(generatedAt: number) {
    return {
      source_url: sourceUrl,
      bundle_json: JSON.stringify({
        schemaVersion: 1,
        sourceCommit: "fixture",
        generatedAt,
        providers: {
          custom: { models: [{ id: `remote-${generatedAt}`, name: `Remote ${generatedAt}` }] },
        },
        pricing: {
          [`custom/remote-${generatedAt}`]: { input: generatedAt, output: generatedAt * 2 },
        },
      }),
    };
  }
  async function setup(
    options: { allowGatewaySubagentBinding?: true } = {},
    runtimeConfig = config,
  ) {
    stored.mockReturnValue(bundle(200));
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 100,
      readStoredCatalog: stored,
    });
    await prepareRemoteModelCatalogStartupSnapshot();
    mocks.configuredAgentIds = ["default", "other"];
    mocks.buildPreparedModelCatalogSnapshot.mockImplementation(async () => {
      const entries = Object.values(captureRemoteModelCatalogSnapshot()?.providers ?? {}).flatMap(
        (provider) =>
          (provider.models ?? []).map((model) => ({
            id: model.id,
            provider: "custom",
            name: model.name ?? model.id,
          })),
      );
      return { entries, routeVariants: entries };
    });
    await refresh(runtimeConfig, {
      ...options,
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    stored.mockReturnValue(bundle(300));
  }
  async function listModels(
    refreshFullCatalog: boolean,
    afterRead?: () => Promise<void>,
    success = true,
  ) {
    const respond = vi.fn();
    const loader = (params: Parameters<typeof loadPreparedGatewayModelCatalogSnapshot>[0]) =>
      loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig: () => config });
    registerGatewayModelCatalogPrivateAccess(loader, {
      loadDeferred: loader,
      readPrepared: async (params) => {
        const snapshot = await readPreparedGatewayModelCatalogOwnerSnapshot({
          ...params,
          getConfig: () => config,
        });
        await afterRead?.();
        return snapshot;
      },
    });
    await modelsHandlers["models.list"]!({
      req: { type: "req", id: "list", method: "models.list" },
      params: { agentId: "default", view: "all", refresh: refreshFullCatalog },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => config,
        loadGatewayModelCatalogSnapshot: loader,
        logGateway: { debug: vi.fn(), warn: vi.fn() },
      } as never,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(success);
    return respond.mock.calls[0]?.[success ? 1 : 2];
  }
  afterEach(() => setRemoteModelCatalogOverlaySourcesForTest());

  function holdPricing() {
    const preparing = createDeferred();
    const commit = createDeferred();
    const preparePricing = pricing.prepareModelPricingContext;
    const pricingSpy = vi
      .spyOn(pricing, "prepareModelPricingContext")
      .mockImplementationOnce(async (...args) => {
        preparing.resolve();
        await commit.promise;
        return await preparePricing(...args);
      });
    return { preparing, commit, pricingSpy };
  }

  it("models.list does not retry after the remote replacement itself loses authority", async () => {
    await setup();
    const afterRead = vi.fn(async () => {
      expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
      await refresh(config, { gatewayLifecycle: true, catalogMode: "static" });
    });
    const error = await listModels(false, afterRead, false);
    expect(error.code).toBe("UNAVAILABLE");
    expect(afterRead).toHaveBeenCalledTimes(1);
  });

  it("delivers the first reply when catalog adoption retires its captured dispatch publication", async () => {
    await setup({ allowGatewaySubagentBinding: true });
    const { preparing, commit, pricingSpy } = holdPricing();
    const adoption = applyRemoteModelCatalogUpdate(() => config);
    await preparing.promise;
    const deliver = vi.fn(async (_payload: ReplyPayload) => undefined);
    const dispatcher = createReplyDispatcher({ deliver });
    try {
      const result = await dispatchLowLevelChannelReplyFromConfig({
        cfg: config,
        ctx: finalizeInboundContext({
          Body: "hello",
          From: "synthetic-user",
          To: "synthetic-bot",
          AgentId: "default",
          SessionKey: "agent:default:main",
          MessageSid: "catalog-adoption-first-reply",
          Provider: "synthetic-channel",
          Surface: "synthetic-channel",
          ChatType: "direct",
          InboundAccessAuthorized: true,
        }),
        dispatcher,
        replyResolver: async () => {
          const runtime = getPreparedReplyDispatchRuntime()!;
          commit.resolve();
          expect(await adoption).toBe("published");
          await using lease = await acquireRun(
            {
              config: runtime.config,
              agentId: runtime.agentId,
              agentDir: runtime.agentDir,
              workspaceDir: runtime.workspaceDir,
              allowGatewaySubagentBinding: true,
              runtimePluginSelections: [
                { provider: "custom", modelId: "remote-200", runtime: "openclaw" },
              ],
            },
            { catalogMode: "static", pluginGeneration: runtime.pluginGeneration },
          );
          expect(runtime.readFullModelCatalog?.()?.entries.map((row) => row.id)).toContain(
            "remote-200",
          );
          expect(lease.pluginGeneration.remoteCatalog?.generatedAt).toBe(200);
          expect(lease.snapshot.modelCatalog.entries.map((row) => row.id)).toContain("remote-200");
          expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
          return { text: "first reply completed" };
        },
      });
      expect(result.queuedFinal).toBe(true);
    } finally {
      commit.resolve();
      await Promise.allSettled([adoption]);
      pricingSpy.mockRestore();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
    expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual(["first reply completed"]);
  });

  it("does not hold Gateway shutdown on an adoption's pricing preparation", async ({ signal }) => {
    await setup();
    const pricingGate = createEnteredGate();
    const preparePricing = pricing.prepareModelPricingContext;
    const pricingSpy = vi
      .spyOn(pricing, "prepareModelPricingContext")
      .mockImplementation(async (...args) => {
        await pricingGate.wait();
        return preparePricing(...args);
      });
    const adoption = applyRemoteModelCatalogUpdate(() => config);
    try {
      await pricingGate.entered;
      // Pricing stays held until `finally`; shutdown that joined it never settles.
      await withinTest(closePreparedModelRuntimeSnapshots(), signal);
      expect(await adoption).toBe("superseded");
      expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
    } finally {
      pricingGate.release();
      pricingSpy.mockRestore();
    }
  });
});

it("reprepares run admission when config publication supersedes its unfinished build", async () => {
  const config = { messages: { responsePrefix: "before" } };
  const current = { messages: { responsePrefix: "after" } };
  await refresh(config, { gatewayLifecycle: true, catalogMode: "static" });
  const gate = createEnteredGate();
  mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    await gate.wait();
    return { entries: [] };
  });
  const admission = acquireRun({
    ...fixture.agentInput("default", config),
    loadRuntimePlugins: true,
  });
  void admission.catch(() => {});
  let publication: Promise<void> | undefined;
  try {
    await gate.entered;
    publication = refresh(current, { gatewayLifecycle: true, catalogMode: "static" });
    gate.release();
    await publication;
    await using lease = await admission;
    expect(lease.snapshot.config).toEqual(current);
    expect(lease.snapshot.isCurrent()).toBe(true);
    expect(
      (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))?.config,
    ).toEqual(current);
  } finally {
    gate.release();
    await Promise.allSettled([
      publication,
      admission.then((lease) => lease[Symbol.asyncDispose]()),
    ]);
  }
});

describe("prepared runtime generation admission", () => {
  const agentInput = (
    config: OpenClawConfig = {},
    overrides: Partial<PreparedModelRuntimeInput> = {},
  ) => ({ ...fixture.agentInput("default", config), ...overrides });
  const publishedRuntime = () => loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
  const publishGateway = async (
    config: OpenClawConfig = {},
    options: Parameters<typeof refresh>[1] = {},
  ) => {
    mocks.configuredAgentIds = ["default"];
    await refresh(config, { gatewayLifecycle: true, ...options });
  };
  it("keeps a committed gateway owner current when an admitted turn resumes on its older generation", async () => {
    const defaults = {
      model: "openai/gpt-5",
      models: {
        "openai/gpt-5": { params: { transport: "sse" as const, openaiWsWarmup: false } },
      },
    };
    const configFor = (responsePrefix: string) => ({
      agents: { defaults },
      messages: { responsePrefix },
    });
    const previousConfig = configFor("previous");
    const committedConfig = configFor("committed");
    const publicationOptions = {
      allowGatewaySubagentBinding: true,
      catalogMode: "static" as const,
      gatewayLifecycle: true,
    };
    const runInput = (config: typeof previousConfig) => ({
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
      allowGatewaySubagentBinding: true,
      config,
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5", runtime: "openclaw" }],
      workspaceDir: "/tmp/unused-workspace",
    });

    await publishGateway(previousConfig, publicationOptions);
    const admitted = await publishedRuntime();
    const generation = admitted!.pluginGeneration;
    const previousInput = runInput(previousConfig);
    const committedInput = runInput(committedConfig);
    const acquirePrevious = (input = previousInput, pluginGeneration = generation) =>
      acquireRun(input, { catalogMode: "static", pluginGeneration });
    const previousSnapshot = readSnapshot(previousInput);

    await using outerLease = scopePreparedModelRuntimeLease(await acquirePrevious());
    expect(outerLease.snapshot).toBe(previousSnapshot);

    await refresh(committedConfig, publicationOptions);
    const committedSnapshot = readSnapshot(committedInput);
    expect(committedSnapshot).toBeDefined();
    expect(committedSnapshot).not.toBe(previousSnapshot);
    const detachedAdmissionGate = createDeferred();
    let detachedAdmission!: Promise<unknown>;

    try {
      await outerLease.run(async () => {
        const resumed = await withPreparedModelRuntimePluginGenerationScope(
          generation,
          acquirePrevious,
        );

        expect(resumed.snapshot).toBe(previousSnapshot);
        expect(readSnapshot(committedInput)).toBe(committedSnapshot);
        await resumed[Symbol.asyncDispose]();
        {
          await using cloned = await acquirePrevious(runInput(structuredClone(previousConfig)));
          expect(cloned.snapshot).toBe(previousSnapshot);
        }
        for (const [input, requestedGeneration] of [
          [{ ...previousInput, workspaceDir: "/tmp/different-workspace" }, generation],
          [previousInput, { ...generation }],
        ] as const) {
          await expect(acquirePrevious(input, requestedGeneration)).rejects.toThrow(
            "plugin generation was superseded",
          );
        }
        detachedAdmission = detachedAdmissionGate.promise.then(() => acquirePrevious());
      });
    } finally {
      await outerLease[Symbol.asyncDispose]();
      detachedAdmissionGate.resolve();
      await Promise.allSettled([detachedAdmission]);
    }
    await expect(detachedAdmission).rejects.toThrow("plugin generation was superseded");

    await expect(acquirePrevious()).rejects.toThrow("plugin generation was superseded");
    expect(readSnapshot(committedInput)).toBe(committedSnapshot);

    await using next = await acquireRun(committedInput);
    expect(next.snapshot).toBe(committedSnapshot);
  });
  it("does not let a stale dynamic lease authorize a replacement generation", async () => {
    const config = {};
    await publishGateway(config);
    const input = agentInput(config, { workspaceDir: "/tmp/stale-dynamic-workspace" });
    await using _ = await acquireRun(input);

    markStale("test dynamic owner staling");
    await expect(acquireRun(input)).rejects.toThrow(
      "prepared model runtime owner was not committed",
    );
  });
  it("stales every owner when queued auth refresh fails after config publication", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    await refresh({});
    const refreshError = new Error("queued auth refresh failed");
    await using configWrite = holdNextBuild();
    mocks.ensureOpenClawModelsJson
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(refreshError);

    const refresh = configWrite.track(refresh({}));
    await configWrite.started;
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
    mocks.mutationListener?.({ affectsInheritedStores: true });
    configWrite.finish();

    await expect(refresh).rejects.toBe(refreshError);
    for (const [agentDir, workspaceDir] of [
      [fixture.state.agentDir("default"), "/tmp/unused-workspace"],
      [fixture.state.agentDir("secondary"), "/tmp/workspace-secondary"],
    ] as const) {
      await expect(
        prepare({
          config: {},
          agentDir,
          inheritedAuthDir: fixture.state.agentDir("default"),
          workspaceDir,
        }),
      ).rejects.toMatchObject({ message: refreshError.message, stack: refreshError.stack });
    }
  });
  it("rejects unreserved unconfigured identities on an active gateway", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refresh(config, { gatewayLifecycle: true });
    await expect(
      acquireRun({
        ...fixture.agentInput("default", config),
        agentId: "missing",
        agentDir: "/tmp/configured-missing",
        workspaceDir: "/tmp/workspace-missing",
      }),
    ).rejects.toThrow("prepared model runtime owner was not committed");
  });
});
