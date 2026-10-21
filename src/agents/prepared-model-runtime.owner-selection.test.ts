// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  usePreparedModelRuntimeHarness,
  getPreparedModelRuntimeTestApi,
} from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import * as legacyAuth from "./legacy-inherited-auth-dir.js";
import {
  scopePreparedModelRuntimeLease,
  withPreparedModelRuntimePluginGenerationScope,
} from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  loadPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";
import { withPreparedModelRuntimeReadBatch } from "./prepared-model-runtime.owner.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;
type RuntimeInput = Parameters<typeof acquireAgentRunPreparedModelRuntime>[0];
const modelConfig = (model = "gpt-5.5") => ({ agents: { defaults: { model: `openai/${model}` } } });
const launchWorkspace = "/tmp/gateway-launch-workspace";

function agentInput(config: RuntimeInput["config"] = {}, overrides: Partial<RuntimeInput> = {}) {
  return { ...fixture.agentInput("default", config), ...overrides };
}

function liveCatalog() {
  const discovered = { id: "live-only", name: "Live catalog row", provider: "custom" };
  mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [discovered],
    routeVariants: [discovered],
  });
  return discovered;
}

function gatewayConfig() {
  return retainLegacyDefaultAgentId(
    { agents: { defaults: { model: "openai/gpt-5.5" }, entries: { default: {} } } },
    "default",
  );
}

async function publishGateway(
  config: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[0] = {},
  options: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[1] = {},
) {
  mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true, ...options });
}

function holdNextCatalogWrite() {
  const started = createDeferred();
  const release = createDeferred();
  const pending: (() => Promise<unknown>)[] = [];
  mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
    started.resolve();
    await release.promise;
    return { agentDir: String(agentDir), wrote: false };
  });
  return {
    started,
    release,
    track<T>(promise: Promise<T>, dispose?: (value: T) => PromiseLike<void>) {
      pending.push(async () => (dispose ? dispose(await promise) : promise));
      return promise;
    },
    async [Symbol.asyncDispose]() {
      release.resolve();
      await Promise.allSettled(pending.map((settle) => settle()));
    },
  };
}

describe("prepared model runtime owner selection", () => {
  it("awaits cold metadata preparation before deriving runtime selections", async () => {
    const prepared = createDeferred<pluginMetadata.PluginMetadataSnapshot>();
    const metadataStarted = createDeferred();
    using resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync")
      .mockImplementationOnce(() => {
        metadataStarted.resolve();
        return prepared.promise;
      });
    const deriveRuntimePluginSelections = vi.fn(() => []);
    const input = fixture.agentInput("cold-metadata", {});
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: input.config,
      manifestRegistry: makeRegistry([]),
    });
    const pending = acquireAgentRunPreparedModelRuntime(input, {
      deriveRuntimePluginSelections,
    });
    await metadataStarted.promise;
    expect(resolveMetadata).toHaveBeenCalledOnce();
    expect(deriveRuntimePluginSelections).not.toHaveBeenCalled();
    prepared.resolve(metadataSnapshot);
    await using lease = await pending;
    expect(deriveRuntimePluginSelections).toHaveBeenCalledExactlyOnceWith({
      config: input.config,
      metadataSnapshot,
    });
    expect(lease.snapshot.metadataSnapshot).toBe(metadataSnapshot);
  });

  it.each(["binding owner", "binding demand", "environment", "workspace"] as const)(
    "matches the configured owner for %s",
    async (scope) => {
      const binding = scope === "binding owner" || scope === "binding demand";
      const config = binding ? gatewayConfig() : {};
      await publishGateway(config, {
        ...(binding ? { catalogMode: "static" as const } : {}),
        ...(scope === "binding owner" ? { allowGatewaySubagentBinding: true } : {}),
        defaultWorkspaceDir: launchWorkspace,
      });
      const request = binding
        ? agentInput(config, {
            workspaceDir: launchWorkspace,
            ...(scope === "binding demand" ? { allowGatewaySubagentBinding: true } : {}),
          })
        : {
            config,
            agentDir: fixture.state.agentDir("default"),
            ...(scope === "environment"
              ? { env: { ...process.env, OPENCLAW_PREPARED_RUNTIME_TEST_SCOPE: "different" } }
              : { workspaceDir: "/tmp/other-explicit-workspace" }),
          };
      if (scope === "binding owner") {
        // Flagless readers reuse the binding-capable publication, as models.list requires.
        await expect(
          loadPreparedModelRuntimeSnapshot({ ...request, allowGatewaySubagentBinding: true }),
        ).resolves.toMatchObject({ config });
        await expect(loadPreparedModelRuntimeSnapshot(request)).resolves.toMatchObject({ config });
      } else {
        await expect(prepareModelRuntimeSnapshot(request)).rejects.toThrow(
          "prepared model runtime owner was not published",
        );
      }
    },
  );

  it("keeps explicit empty selections exact for raw published reads", async () => {
    const input = fixture.agentInput("default", {});
    const workspaceDir = "/tmp/explicit-published-workspace";
    const published = await publishPreparedModelRuntimeSnapshot(
      {
        ...input,
        workspaceDir,
        runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "openclaw" }],
      },
      { provenance: "configured", catalogMode: "static" },
    );

    for (const requestedWorkspace of [workspaceDir, ""]) {
      const request = {
        ...input,
        workspaceDir: requestedWorkspace,
        runtimePluginSelections: [],
      };
      await expect(prepareModelRuntimeSnapshot(request)).rejects.toThrow(
        "prepared model runtime owner was not published",
      );
      await expect(loadPreparedModelRuntimeSnapshot(request)).resolves.toBe(published);
      await expect(
        prepareModelRuntimeSnapshot({ ...request, runtimePluginSelections: undefined }),
      ).resolves.toBe(published);
    }
  });

  it("prepares prompt-only runtime owners separately from the configured agent generation", async () => {
    const config = gatewayConfig();
    await publishGateway(config, { catalogMode: "static" });
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();
    await using lease = await acquireAgentRunPreparedModelRuntime(
      agentInput(config, {
        runtimePluginPurpose: "isolated-completion",
        runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.5" }],
      }),
      { catalogMode: "static" },
    );
    expect(lease.pluginGeneration).not.toBe(published.pluginGeneration);
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.calls[0]?.[0]).toMatchObject({
      purpose: "isolated-completion",
    });
  });

  it.each(["static", undefined] as const)(
    "keeps isolated executable catalogs separate from live discovery (%s)",
    async (catalogMode) => {
      const discovered = liveCatalog();
      {
        await using lease = await acquireReadOnlyPreparedModelRuntime(
          {
            config: {},
            agentDir: fixture.state.agentDir("isolated-probe-agent"),
            workspaceDir: fixture.state.workspaceDir,
            loadRuntimePlugins: true,
          },
          { catalogMode },
        );
        expect(lease.snapshot.modelCatalog.entries.map(({ id }) => id)).toEqual(
          catalogMode === "static" ? [] : [discovered.id],
        );
        expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledTimes(
          catalogMode === "static" ? 0 : 1,
        );
      }
      expect(getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
    },
  );

  it("honors live catalog demand inside a retained static parent", async () => {
    const input = agentInput({}, { workspaceDir: fixture.state.workspaceDir });
    liveCatalog();
    await using parent = scopePreparedModelRuntimeLease(
      await acquireAgentRunPreparedModelRuntime(input, { catalogMode: "static" }),
    );
    expect(parent.snapshot.modelCatalog.entries).toEqual([]);
    await parent.run(async () => {
      await using live = await acquireAgentRunPreparedModelRuntime(input, {
        catalogMode: "live",
        pluginGeneration: parent.pluginGeneration,
      });
      expect(live.snapshot.modelCatalog.entries.map(({ id }) => id)).toEqual(["live-only"]);
    });
  });

  it("rejects unpublished plugin generations while matching pending callers share their owner", async () => {
    const config = {};
    await publishGateway(config);
    const generationA = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))
      ?.pluginGeneration;
    expect(generationA).toBeDefined();
    const generationB = {
      ...generationA!,
      pluginMetadataSnapshot: { ...generationA!.pluginMetadataSnapshot },
    };
    await using generationWrite = holdNextCatalogWrite();
    const input = {
      config,
      agentId: "default",
      agentDir: fixture.state.agentDir("dynamic-generation"),
      workspaceDir: "/tmp/dynamic-generation-workspace",
    };

    const acquire = (pluginGeneration: NonNullable<typeof generationA>) =>
      acquireAgentRunPreparedModelRuntime(input, { catalogMode: "live", pluginGeneration });
    const retain = (pending: ReturnType<typeof acquire>) =>
      generationWrite.track(pending, (lease) => lease[Symbol.asyncDispose]());
    const pendingA = retain(acquire(generationA!));
    await generationWrite.started.promise;
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    const matchingPendingA = retain(acquire(generationA!));
    const pendingB = acquire(generationB).catch((error: unknown) => error);
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    generationWrite.release.resolve();
    const [leaseA, matchingLeaseA, rejectedGeneration] = await Promise.all([
      pendingA,
      matchingPendingA,
      pendingB,
    ]);
    expect(matchingLeaseA.snapshot).toBe(leaseA.snapshot);
    expect(rejectedGeneration).toEqual(
      expect.objectContaining({ message: expect.stringContaining("superseded") }),
    );
    expect(leaseA.snapshot.metadataSnapshot).toBe(generationA!.pluginMetadataSnapshot);
    await expect(prepareModelRuntimeSnapshot(input)).resolves.toBe(leaseA.snapshot);
    await leaseA[Symbol.asyncDispose]();
    await matchingLeaseA[Symbol.asyncDispose]();
  });

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
    const admitted = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    const generation = admitted!.pluginGeneration;
    const previousInput = runInput(previousConfig);
    const committedInput = runInput(committedConfig);
    const acquirePrevious = (input = previousInput, pluginGeneration = generation) =>
      acquireAgentRunPreparedModelRuntime(input, { catalogMode: "static", pluginGeneration });
    const previousSnapshot = getPreparedModelRuntimeSnapshot(previousInput);
    expect(admitted?.pluginGeneration).toBeDefined();
    expect(previousSnapshot).toBeDefined();

    await using outerLease = scopePreparedModelRuntimeLease(await acquirePrevious());
    expect(outerLease.snapshot).toBe(previousSnapshot);

    await refreshPreparedModelRuntimeSnapshots(committedConfig, publicationOptions);
    const committedSnapshot = getPreparedModelRuntimeSnapshot(committedInput);
    const registryLoads = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
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
        expect(getPreparedModelRuntimeSnapshot(committedInput)).toBe(committedSnapshot);
        expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(registryLoads);
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
    detachedAdmissionGate.resolve();
    await expect(detachedAdmission).rejects.toThrow("plugin generation was superseded");

    await expect(acquirePrevious()).rejects.toThrow("plugin generation was superseded");
    expect(getPreparedModelRuntimeSnapshot(committedInput)).toBe(committedSnapshot);

    await using next = await acquireAgentRunPreparedModelRuntime(committedInput);
    expect(next.snapshot).toBe(committedSnapshot);
  });

  it("does not choose between configured owners sharing one agent directory", async () => {
    const config = {};
    const agentDir = fixture.state.agentDir("shared-configured-agent");
    const input = { agentId: "shared", config, agentDir };
    const first = await publishPreparedModelRuntimeSnapshot(
      { ...input, workspaceDir: "/tmp/shared-workspace-a" },
      { provenance: "configured" },
    );
    const readError = new Error("nested catalog read failed");
    expect(() =>
      withPreparedModelRuntimeReadBatch(() => {
        expect(getPreparedModelRuntimeSnapshot(input)).toBe(first);
        expect(() =>
          withPreparedModelRuntimeReadBatch(() => {
            expect(getPreparedModelRuntimeSnapshot(input)).toBe(first);
            throw readError;
          }),
        ).toThrow(readError);
        expect(getPreparedModelRuntimeSnapshot(input)).toBe(first);
        throw readError;
      }),
    ).toThrow(readError);

    const second = await publishPreparedModelRuntimeSnapshot(
      { ...input, workspaceDir: "/tmp/shared-workspace-b" },
      { provenance: "configured" },
    );
    expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
    withPreparedModelRuntimeReadBatch(() => {
      expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
      expect(getPreparedModelRuntimeSnapshot({ config, agentDir })).toBeUndefined();
      expect(
        getPreparedModelRuntimeSnapshot({ ...input, workspaceDir: "/tmp/shared-workspace-b" }),
      ).toBe(second);
    });

    await expect(prepareModelRuntimeSnapshot({ config, agentDir })).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
  });

  it("keeps registry parsing isolated across OAuth provider generations in a shared workspace", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b", "agent-c"];
    const sharedCatalog = JSON.stringify({
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://models.example/v1",
          models: [{ id: "shared-model" }],
        },
      },
    });
    const sharedProvider = {
      id: "custom",
      name: "OAuth A",
      login: vi.fn(),
      refreshToken: vi.fn(),
      getApiKey: vi.fn(),
    };
    const distinctProvider = { ...sharedProvider, name: "OAuth B", modifyModels: vi.fn() };
    const oauthProviders = new Map([
      [fixture.state.agentDir("agent-a"), sharedProvider],
      [fixture.state.agentDir("agent-b"), { ...sharedProvider }],
      [fixture.state.agentDir("agent-c"), distinctProvider],
    ]);
    for (const agentId of mocks.configuredAgentIds) {
      const agentDir = fixture.state.agentDir(agentId);
      await fixture.state.writeText(`agents/${agentId}/agent/models.json`, sharedCatalog);
      mocks.configuredAgentDirs.set(agentId, agentDir);
      mocks.configuredWorkspaces.set(agentId, "/tmp/shared-prepared-runtime-workspace");
    }
    mocks.discoverAuthStorage.mockImplementation((agentDir: unknown) => ({
      getAll: () => ({ custom: { type: "api_key" as const, key: "shared-key" } }),
      getOAuthProviders: () => [oauthProviders.get(String(agentDir))!],
    }));
    let runtimeRegistryCount = 0;

    await refreshPreparedModelRuntimeSnapshots(
      { agents: { defaults: { model: "openai/gpt-5.5" } } },
      {
        gatewayLifecycle: true,
        catalogMode: "static",
        onBuildStats: (stats) => {
          runtimeRegistryCount = stats.runtimeRegistryCount;
        },
      },
    );

    expect(mocks.discoverModels).toHaveBeenCalledTimes(2);
    expect(runtimeRegistryCount).toBe(2);
  });
});

describe("prepared model runtime snapshots", () => {
  it("does not let a read-only draft replace a configured gateway owner", async () => {
    const configured = gatewayConfig();
    await publishGateway(configured, { defaultWorkspaceDir: launchWorkspace });
    const activated = await activateStandalonePreparedModelRuntime(
      agentInput(modelConfig("gpt-5.4"), { workspaceDir: launchWorkspace, readOnly: true }),
    );
    expect(activated).toBeUndefined();
    await expect(
      prepareModelRuntimeSnapshot(agentInput(configured, { workspaceDir: launchWorkspace })),
    ).resolves.toMatchObject({ config: configured });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
  });

  it("does not let a stale dynamic lease authorize a replacement generation", async () => {
    const config = {};
    await publishGateway(config);
    const input = agentInput(config, { workspaceDir: "/tmp/stale-dynamic-workspace" });
    await using _ = await acquireAgentRunPreparedModelRuntime(input);

    markPreparedModelRuntimeSnapshotsStale("test dynamic owner staling");
    await expect(acquireAgentRunPreparedModelRuntime(input)).rejects.toThrow(
      "prepared model runtime owner was not committed",
    );
  });

  it.each(["openclaw", "missing"] as const)(
    "admits only reserved unconfigured identities on an active gateway (%s)",
    async (agentId) => {
      const reserved = agentId === "openclaw";
      mocks.configuredAgentIds = [reserved ? "other" : "default"];
      const config = {};
      await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
      const pending = acquireAgentRunPreparedModelRuntime({
        ...fixture.agentInput("default", config),
        agentId,
        agentDir: reserved ? fixture.state.agentDir("default") : "/tmp/configured-missing",
        workspaceDir: reserved ? "/tmp/configless-mixed-workspace" : "/tmp/workspace-missing",
      });
      if (reserved) {
        await using lease = await pending;
        expect(lease.snapshot.agentDir).toBe(fixture.state.agentDir("default"));
      } else {
        await expect(pending).rejects.toThrow("prepared model runtime owner was not committed");
      }
    },
  );

  it.each(["dynamic", "canonical"] as const)(
    "waits for replacement before rebinding a queued %s run",
    async (kind) => {
      const canonical = kind === "canonical";
      const initialConfig = {};
      const latestConfig = modelConfig();
      await publishGateway(initialConfig);
      await using replacementWrite = holdNextCatalogWrite();
      const executionFolder = canonical
        ? "/tmp/old-workspace-dir"
        : "/tmp/dynamic-replacement-workspace";
      const catalogBuildsBeforeAdmission = mocks.prepareStaticCatalog.mock.calls.length;

      markPreparedModelRuntimeSnapshotsStale("test lease replacement", {
        waitForReplacement: true,
      });
      const leasePending = replacementWrite.track(
        acquireAgentRunPreparedModelRuntime(
          agentInput(initialConfig, {
            workspaceDir: executionFolder,
            ...(canonical
              ? {
                  agentDir: "/tmp/old-agent-dir",
                  inheritedAuthDir: "/tmp/old-agent-dir",
                  preserveWorkspaceDirOnRefresh: false,
                }
              : {}),
          }),
        ),
        (lease) => lease[Symbol.asyncDispose](),
      );
      await Promise.resolve();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);

      const refresh = replacementWrite.track(refreshPreparedModelRuntimeSnapshots(latestConfig));
      await replacementWrite.started.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      replacementWrite.release.resolve();
      await refresh;
      const lease = await leasePending;

      expect(lease.snapshot).toMatchObject({
        config: latestConfig,
        workspaceDir: "/tmp/unused-workspace",
      });
      expect(lease.snapshot.config).toBe(latestConfig);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      if (canonical) {
        expect(lease.snapshot.agentDir).toBe(fixture.state.agentDir("default"));
      } else {
        expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(catalogBuildsBeforeAdmission);
      }
    },
  );

  it("does not serve a retired owner when another owner fails to refresh", async () => {
    mocks.configuredAgentIds = ["default", "removed"];
    const firstConfig = {};
    await refreshPreparedModelRuntimeSnapshots(firstConfig);
    mocks.configuredAgentIds = ["default"];
    const refreshError = new Error("remaining owner refresh failed");
    mocks.ensureOpenClawModelsJson.mockRejectedValueOnce(refreshError);

    await expect(refreshPreparedModelRuntimeSnapshots({})).rejects.toBe(refreshError);
    mocks.mutationListener?.({
      agentDir: fixture.state.agentDir("removed"),
      affectsInheritedStores: false,
    });
    await expect(
      prepareModelRuntimeSnapshot({
        config: firstConfig,
        agentDir: fixture.state.agentDir("removed"),
        inheritedAuthDir: fixture.state.agentDir("default"),
        workspaceDir: "/tmp/workspace-removed",
      }),
    ).rejects.toThrow("owner was not published");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });

  it("stales every owner when queued auth refresh fails after config publication", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    await refreshPreparedModelRuntimeSnapshots({});
    const refreshError = new Error("queued auth refresh failed");
    await using configWrite = holdNextCatalogWrite();
    mocks.ensureOpenClawModelsJson
      .mockResolvedValueOnce({ agentDir: fixture.state.agentDir("secondary"), wrote: false })
      .mockResolvedValueOnce({ agentDir: fixture.state.agentDir("default"), wrote: false })
      .mockRejectedValueOnce(refreshError);

    const refresh = configWrite.track(refreshPreparedModelRuntimeSnapshots({}));
    await configWrite.started.promise;
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
    mocks.mutationListener?.({ affectsInheritedStores: true });
    configWrite.release.resolve();

    await expect(refresh).rejects.toBe(refreshError);
    for (const [agentDir, workspaceDir] of [
      [fixture.state.agentDir("default"), "/tmp/unused-workspace"],
      [fixture.state.agentDir("secondary"), "/tmp/workspace-secondary"],
    ] as const) {
      await expect(
        prepareModelRuntimeSnapshot({
          config: {},
          agentDir,
          inheritedAuthDir: fixture.state.agentDir("default"),
          workspaceDir,
        }),
      ).rejects.toBe(refreshError);
    }
  });

  it("does not replay an auth mutation that occurs before the first owner is registered", async () => {
    getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(100);
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return { entries: [] };
    });
    mocks.ensureOpenClawModelsJson
      .mockResolvedValueOnce({ agentDir: fixture.state.agentDir("default"), wrote: false })
      .mockRejectedValueOnce(new Error("unexpected auth replay"));

    await expect(publishGateway({}, { catalogMode: "static" })).resolves.toBeUndefined();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledOnce();
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
  });

  it("does not announce an auth republication while a config replacement gate is pending", async () => {
    const replacementConfig = modelConfig();
    await publishGateway({});
    const publishedSnapshots: Array<ReturnType<typeof getPreparedModelRuntimeSnapshot>> = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        publishedSnapshots.push(getPreparedModelRuntimeSnapshot(agentInput(replacementConfig)));
      }
    });

    // The auth mutation starts first; the synchronous stale edge of the config refresh transfers
    // its queued event to the replacement transaction before the auth task can publish.
    mocks.mutationListener?.({ affectsInheritedStores: true });
    await refreshPreparedModelRuntimeSnapshots(replacementConfig, { gatewayLifecycle: true });
    unregister();

    expect(publishedSnapshots).toEqual([expect.objectContaining({ config: replacementConfig })]);
  });

  it("keeps one dispatch gate across overlapping auth mutations that rebind an owner", async () => {
    const config = {};
    const agentDir = fixture.state.agentDir("default");
    await publishGateway(config);
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
    using _ = { [Symbol.dispose]: unregister };
    using inheritance = vi.spyOn(legacyAuth, "resolveLegacyInheritedAuthDir");
    await using firstWrite = holdNextCatalogWrite();
    await using secondWrite = holdNextCatalogWrite();
    try {
      mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
      await firstWrite.started.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      const dispatch = firstWrite.track(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      );
      void dispatch.catch(() => undefined);
      inheritance.mockReturnValue(undefined);
      mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
      const reader = secondWrite.track(
        prepareModelRuntimeSnapshot({ config, agentId: "default", agentDir }),
      );
      void reader.catch(() => undefined);
      firstWrite.release.resolve();
      await secondWrite.started.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
      await expect(
        Promise.race([dispatch.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      secondWrite.release.resolve();
      const runtime = await dispatch;
      await expect(reader).resolves.toBe(
        await prepareModelRuntimeSnapshot({ config, agentId: "default", agentDir }),
      );
      unregister();

      expect(runtime).toBe(await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }));
      expect(events.filter((phase) => phase === "published")).toHaveLength(1);
      expect(events).not.toContain("failed");
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      firstWrite.release.resolve();
      secondWrite.release.resolve();
      await Promise.allSettled([loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })]);
    }
  });

  it("does not let a superseded owner hide a genuine sibling refresh failure", async () => {
    const config = {};
    const supersededDir = fixture.state.agentDir("auth-superseded-sibling");
    const failingDir = fixture.state.agentDir("auth-failing-sibling");
    await publishPreparedModelRuntimeSnapshot({ config, agentDir: supersededDir });
    await publishPreparedModelRuntimeSnapshot({ config, agentDir: failingDir });
    await using supersededWrite = holdNextCatalogWrite();
    await using siblingWrite = holdNextCatalogWrite();

    try {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
      mocks.mutationListener?.({ agentDir: supersededDir, affectsInheritedStores: false });
      supersededWrite.release.resolve();
      siblingWrite.release.reject(new Error("genuine sibling refresh failure"));

      await vi.waitFor(() =>
        expect(mocks.warn).toHaveBeenCalledWith(
          expect.stringContaining("genuine sibling refresh failure"),
        ),
      );
      expect(mocks.warn).toHaveBeenCalledOnce();
    } finally {
      supersededWrite.release.resolve();
      siblingWrite.release.resolve();
      await Promise.allSettled([
        prepareModelRuntimeSnapshot({ config, agentDir: supersededDir }),
        prepareModelRuntimeSnapshot({ config, agentDir: failingDir }),
      ]);
    }
  });

  it("preserves an authoritative workspace override across config refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const agentDir = fixture.state.agentDir("default");
    const input = agentInput(config, { workspaceDir: "/tmp/explicit-workspace" });
    await publishPreparedModelRuntimeSnapshot(
      { ...input, preserveWorkspaceDirOnRefresh: true },
      { provenance: "configured" },
    );

    await refreshPreparedModelRuntimeSnapshots(modelConfig());
    const snapshot = await prepareModelRuntimeSnapshot(input);

    expect(snapshot.workspaceDir).toBe("/tmp/explicit-workspace");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      expect.any(Object),
      agentDir,
      expect.objectContaining({ workspaceDir: "/tmp/explicit-workspace" }),
    );
  });
});
