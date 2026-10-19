// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as configSerialization from "../config/runtime-config-snapshot-match.js";
import {
  clearRuntimeConfigSnapshot as clearConfig,
  setRuntimeConfigSnapshot as setConfig,
} from "../config/runtime-snapshot.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { modelDefinition, providerConfig } from "./model-auth.fixtures.test-support.js";
import { getPreparedModelCatalogOwnerSnapshot as catalogOwner } from "./prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  acquireAgentRunPreparedModelRuntime as acquireRun,
  acquireReadOnlyPreparedModelRuntime as acquireReadOnly,
  activateStandalonePreparedModelRuntime as activate,
  getPreparedModelRuntimeSnapshot as readSnapshot,
  markPreparedModelRuntimeSnapshotsStale as markStale,
  prepareModelRuntimeSnapshot as prepare,
  publishPreparedModelRuntimeSnapshot as publish,
  refreshPreparedModelRuntimeSnapshots as refresh,
  type PreparedModelRuntimeInput,
} from "./prepared-model-runtime.js";
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
  mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, targetDir) => {
    started.resolve();
    await finish.promise;
    return { agentDir: String(targetDir), wrote: false };
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
      return { agentDir: fixture.state.agentDir("provider-outcome-agent"), wrote: false };
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

  it("prepares inline provider models when no default model is configured", async () => {
    const snapshot = await publish(
      inputFor(
        "inline",
        providerConfig("custom", {
          baseUrl: "https://custom.example.test/v1",
          api: "openai-responses",
          models: [modelDefinition("custom-model", { reasoning: false })],
        }),
      ),
    );

    expect(snapshot.inlineProviderModels).toMatchObject([
      {
        provider: "custom",
        id: "custom-model",
        baseUrl: "https://custom.example.test/v1",
        api: "openai-responses",
      },
    ]);
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
