// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness(undefined, () => {
  vi.restoreAllMocks();
});
const { mocks } = fixture;
const configFor = (model = "openai/gpt-5.5") => ({ agents: { defaults: { model } } });
const inputFor = (name: string, config: OpenClawConfig = {}) => ({
  agentDir: fixture.state.agentDir(name),
  config,
});
function holdNextBuild() {
  const started = createDeferred();
  const finish = createDeferred();
  mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, targetDir) => {
    started.resolve();
    await finish.promise;
    return { agentDir: String(targetDir), wrote: false };
  });
  return { started: started.promise, finish: () => finish.resolve() };
}

describe("prepared model runtime snapshots", () => {
  it("materializes Claude CLI thinking capabilities on the prepared logical row", async () => {
    const modelId = "claude-opus-5";
    mocks.resolveStaticCatalogModel.mockImplementation(({ modelId: requestedId, provider }) =>
      provider === "claude-cli"
        ? {
            provider,
            id: requestedId,
            name: `${requestedId} (Claude CLI)`,
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            reasoning: true,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 128_000,
          }
        : undefined,
    );
    const row = { provider: "anthropic", id: modelId, name: modelId, reasoning: false };
    mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [row],
      routeVariants: [row],
    });
    // Raw user config permits sparse provider model overrides. This omission is
    // the contract under test: it must not become an explicit reasoning opt-out.
    const config = {
      agents: {
        defaults: {
          model: `anthropic/${modelId}`,
          models: {
            [`anthropic/${modelId}`]: {
              agentRuntime: { id: "claude-cli" },
              params: { thinking: "medium" },
            },
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [{ id: modelId, name: modelId }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const snapshot = await publishPreparedModelRuntimeSnapshot({
      agentId: "main",
      config,
      agentDir: fixture.state.agentDir("claude-cli-capabilities"),
    });
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
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    markPreparedModelRuntimeSnapshotsStale("test isolated probe replacement", {
      waitForReplacement: true,
    });
    const leasePending = acquireReadOnlyPreparedModelRuntime({
      agentId: "openclaw",
      config: stagedConfig,
      agentDir: fixture.state.agentDir("setup-probe-agent"),
      inheritedAuthDir: fixture.state.agentDir("setup-probe-agent"),
      workspaceDir: "/tmp/setup-probe-workspace",
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.6", runtime: "codex" }],
    });
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);

    await refreshPreparedModelRuntimeSnapshots({
      agents: { defaults: { model: "openai/gpt-5.5" } },
    });
    const lease = await leasePending;
    expect(lease.snapshot).toMatchObject({
      agentId: "openclaw",
      config: stagedConfig,
      agentDir: fixture.state.agentDir("setup-probe-agent"),
      workspaceDir: "/tmp/setup-probe-workspace",
      pluginRegistry: expect.any(Object),
    });
    expect(lease.snapshot.pluginRegistry?.agentHarnesses.map((entry) => entry.harness.id)).toEqual([
      "codex",
    ]);
    await lease[Symbol.asyncDispose]();
  });

  it("never returns a standalone generation invalidated while it is building", async () => {
    const input = inputFor("standalone-build-race");
    const build = holdNextBuild();

    let activation: ReturnType<typeof activateStandalonePreparedModelRuntime> | undefined;
    try {
      activation = activateStandalonePreparedModelRuntime(input);
      await build.started;
      markPreparedModelRuntimeSnapshotsStale("test in-flight standalone publication");
      build.finish();

      const published = await activation;
      expect(published).toBeDefined();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      await expect(prepareModelRuntimeSnapshot(input)).resolves.toBe(published);
    } finally {
      build.finish();
      await Promise.allSettled([activation]);
    }
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

    const snapshot = await publishPreparedModelRuntimeSnapshot(inputFor("provider-outcome-agent"));

    expect(snapshot.modelCatalog.providerOutcomes).toEqual([
      { provider: "openai", status: "auth-rejected" },
    ]);
  });

  it("limits live discovery to the selected agent's models and authenticated providers", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6" } },
        entries: {
          selected: {
            model: { primary: "anthropic/claude-sonnet-5" },
            models: {
              "anthropic/claude-sonnet-5": { agentRuntime: { id: "selected-runtime" } },
            },
            modelPolicy: { allow: ["vllm/*"] },
          },
          sibling: {
            model: { primary: "ollama/sibling" },
            models: { "ollama/sibling": { agentRuntime: { id: "sibling-runtime" } } },
            modelPolicy: { allow: ["sibling-only/*"] },
          },
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

    await publishPreparedModelRuntimeSnapshot({
      agentId: "selected",
      config,
      agentDir: fixture.state.agentDir("selected-provider-scope"),
    });

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledWith(
      config,
      fixture.state.agentDir("selected-provider-scope"),
      expect.objectContaining({
        providerDiscoveryProviderIds: ["anthropic", "custom", "openai", "selected-runtime", "vllm"],
      }),
    );
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ syntheticAuthProviderRefs: ["selected-runtime"] }),
    );
  });

  it("prepares inline provider models when no default model is configured", async () => {
    const snapshot = await publishPreparedModelRuntimeSnapshot(
      inputFor("inline", {
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example.test/v1",
              api: "openai-responses",
              models: [
                {
                  id: "custom-model",
                  name: "Custom Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      }),
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
    const config = {};
    const agentDir = fixture.state.agentDir("credential-free");
    await publishPreparedModelRuntimeSnapshot({ config, agentDir });

    const credentialFree = await publishPreparedModelRuntimeSnapshot({
      config,
      agentDir,
      readOnly: true,
      skipCredentials: true,
    });

    expect(credentialFree).not.toBe(await prepareModelRuntimeSnapshot({ config, agentDir }));
    expect(mocks.discoverAuthStorage).toHaveBeenCalledOnce();
    expect(getPreparedModelRuntimeAuthStore(credentialFree)).toEqual({ version: 1, profiles: {} });
    expect(credentialFree.createStores().authStorage.getAll()).toEqual({});
    const runtime = await prepareModelRuntimeSnapshot({ config, agentDir });
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

      const snapshot = await publishPreparedModelRuntimeSnapshot(inputFor("cli-startup", config));

      const discoveryOptions = mocks.discoverAuthStorage.mock.calls[0]?.[1] as {
        externalCli?: unknown;
      };
      expect(discoveryOptions.externalCli).toBeUndefined();
      expect(snapshot.authModes.openai).toBe(expected);
    },
  );

  it("reuses read-only owners for equivalent config clones but rejects projections", async () => {
    const input = { ...inputFor("read-only-config", configFor()), readOnly: true };
    const first = await publishPreparedModelRuntimeSnapshot(input);
    const equivalent = { ...input, config: configFor() };
    const different = { ...input, config: configFor("anthropic/claude-opus-4-6") };
    expect(getPreparedModelRuntimeSnapshot(equivalent)).toBe(first);
    expect(getPreparedModelRuntimeSnapshot(different)).toBeUndefined();
    await expect(prepareModelRuntimeSnapshot(equivalent)).resolves.toBe(first);
    await expect(prepareModelRuntimeSnapshot(different)).rejects.toThrow("not published");
    const secondLease = await acquireReadOnlyPreparedModelRuntime(different);
    expect(secondLease.snapshot).not.toBe(first);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(2);
    await secondLease[Symbol.asyncDispose]();
  });

  it("keeps replacement readers blocked when an earlier refresh is superseded", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const skippedConfig = configFor("openai/gpt-5.4");
    const latestConfig = configFor();
    await refreshPreparedModelRuntimeSnapshots(initialConfig);
    const build = holdNextBuild();

    let skipped: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    let latest: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    let read: ReturnType<typeof prepareModelRuntimeSnapshot> | undefined;
    try {
      markPreparedModelRuntimeSnapshotsStale("test overlapping config commit", {
        waitForReplacement: true,
      });
      skipped = refreshPreparedModelRuntimeSnapshots(skippedConfig);
      latest = refreshPreparedModelRuntimeSnapshots(latestConfig);
      read = prepareModelRuntimeSnapshot({
        ...fixture.agentInput("default", latestConfig),
        workspaceDir: "/tmp/unused-workspace",
      });

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
    } finally {
      build.finish();
      await Promise.allSettled([skipped, latest, read]);
    }
  });
  it.each(["workspace", "config"] as const)(
    "deduplicates standalone activation while publishing a changed %s",
    async (changed) => {
      const input = {
        config: {},
        agentDir: fixture.state.agentDir("standalone"),
        workspaceDir: "/tmp/prepared-model-runtime-standalone-workspace",
      };

      const first = await activateStandalonePreparedModelRuntime(input);
      await activateStandalonePreparedModelRuntime(input);
      await activateStandalonePreparedModelRuntime({
        ...input,
        agentDir: fixture.state.agentDir("standalone-second"),
      });
      const replacementInput = {
        ...input,
        ...(changed === "workspace"
          ? { workspaceDir: "/tmp/standalone-replacement-workspace" }
          : { config: configFor() }),
      };
      const replacement = await activateStandalonePreparedModelRuntime(replacementInput);
      expect(replacement).not.toBe(first);
      expect(first?.config).toBe(input.config);
      expect(replacement?.config).toBe(replacementInput.config);
      expect(replacement).toMatchObject({
        agentDir: input.agentDir,
        workspaceDir: replacementInput.workspaceDir,
      });
      await expect(prepareModelRuntimeSnapshot(replacementInput)).resolves.toBe(replacement);
      await expect(prepareModelRuntimeSnapshot(input)).resolves.toMatchObject({
        workspaceDir: input.workspaceDir,
      });
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
    },
  );

  it("publishes a run owner from the caller-selected metadata generation", async () => {
    const selectedMetadata = { ...mocks.pluginMetadataSnapshot };
    const lease = await acquireAgentRunPreparedModelRuntime(
      {
        config: {},
        agentId: "main",
        agentDir: fixture.state.agentDir("selected-metadata-agent"),
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
    await lease[Symbol.asyncDispose]();
  });
});
