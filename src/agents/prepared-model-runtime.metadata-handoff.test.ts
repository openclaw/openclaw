import { createDeferred } from "../../test/helpers/promise.js";
import { withinTest } from "../../test/helpers/promise.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { advancePreparedModelRuntimeConfig } from "./prepared-model-runtime.js";
import { beginPreparedModelRuntimePluginDrain } from "./prepared-model-runtime.js";
import { loadPublishedGatewayReplyDispatchRuntime as loadPublishedDispatch } from "./prepared-model-runtime.js";
import { markPreparedModelRuntimeSnapshotsStale as markStale } from "./prepared-model-runtime.js";
import { prepareModelRuntimeSnapshot as prepare } from "./prepared-model-runtime.js";
import { publishPreparedModelRuntimeSnapshot as publish } from "./prepared-model-runtime.js";
import { refreshPreparedModelRuntimeSnapshots as refresh } from "./prepared-model-runtime.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.js";
import { type PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";

import { describe, expect, it, vi } from "vitest";
import { type ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import * as manifestEligibility from "../plugins/manifest-contract-eligibility.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { type ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { type ModelCatalogEntry } from "./model-catalog.types.js";
import { type ModelCatalogSnapshot } from "./model-catalog.types.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { setPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { type PreparedModelCatalogAuth } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness();
const { mocks } = fixture;

describe("prepared model runtime metadata handoff", () => {
  it("adds an agent using captured model policies without rediscovering plugin inventory", async () => {
    const metadata = (model: string) =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            modelIdNormalization: { providers: { fixture: { aliases: { raw: model } } } },
          },
        ],
      });
    const captured = metadata("canonical");
    const discovery = vi
      .spyOn(manifestEligibility, "loadManifestMetadataSnapshot")
      .mockReturnValue(captured);
    const previousRegistry = captureActivePluginRegistrySnapshot();
    const config: OpenClawConfig = {
      agents: { defaults: { model: "fixture/raw" }, entries: { pro: {} } },
    };
    mocks.configuredAgentIds = ["pro"];
    mocks.resolveStaticCatalogModel.mockImplementation(({ provider, modelId }) => ({
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ["text"],
      contextWindow: 32_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      provider,
      api: "openai-responses",
      baseUrl: "https://synthetic.invalid/v1",
    }));
    try {
      setActivePluginRegistry(
        createEmptyPluginRegistry(),
        undefined,
        "default",
        fixture.state.workspaceDir,
      );
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        pluginMetadataSnapshot: captured,
      });
      const original = getPreparedModelRuntimeSnapshot(fixture.agentInput("pro", config))!;
      discovery.mockClear().mockReturnValue(metadata("ambient"));
      mocks.configuredAgentIds = ["pro", "new-agent"];
      const nextConfig: OpenClawConfig = {
        agents: { ...config.agents, entries: { pro: {}, "new-agent": {} } },
      };

      await refreshModelRuntimeAfterHotReload({
        config: nextConfig,
        agentIds: new Set(["new-agent"]),
        pluginMetadataSnapshot: captured,
      });

      const added = getPreparedModelRuntimeSnapshot(fixture.agentInput("new-agent", nextConfig))!;
      const retained = getPreparedModelRuntimeSnapshot(fixture.agentInput("pro", nextConfig))!;
      expect.soft(discovery.mock.calls.length).toBe(0);
      expect.soft(original.isCurrent()).toBe(true);
      expect.soft(retained.modelCatalog).toBe(original.modelCatalog);
      expect(added.metadataSnapshot).toBe(captured);
      expect(added.isCurrent()).toBe(true);
      const models = added.configuredRuntimeModels.map(({ modelId }) => modelId);
      expect(models).toEqual(["raw"]);
    } finally {
      discovery.mockRestore();
      restoreActivePluginRegistrySnapshot(previousRegistry);
    }
  });
});

describe("catalog account identity", () => {
  const catalogWorker = mocks.runPreparedModelCatalogWorker;
  const gatewayOptions = { gatewayLifecycle: true, catalogMode: "static" as const };
  const proConfig: OpenClawConfig = { agents: { entries: { pro: {} } } };
  function entry(
    provider: string,
    id: string,
    name: string,
    extra: Partial<ModelCatalogEntry> = {},
  ) {
    return { provider, id, name, ...extra };
  }
  function outcome(provider: string, status: ProviderCatalogOutcome["status"], profileId?: string) {
    return { provider, status, ...(profileId && { profileId }) };
  }
  function containsEntries(
    actual: ModelCatalogEntry[] | undefined,
    ...expected: Partial<ModelCatalogEntry>[]
  ) {
    for (const row of expected) {
      expect(actual).toContainEqual(expect.objectContaining(row));
    }
  }
  function withProvider(
    provider: string,
    value: ModelProviderConfig,
    config = proConfig,
  ): OpenClawConfig {
    return { ...config, models: { providers: { [provider]: value } } };
  }
  function attachAuth(
    catalog: ModelCatalogSnapshot,
    provider: string,
    store = mocks.preparedAuthStore!,
    credentials = mocks.authStorage.getAll(),
  ) {
    setPreparedModelFullCatalogAuth(catalog, catalogAuth(provider, store, credentials));
    return catalog;
  }
  function published(config: OpenClawConfig) {
    return getPreparedModelRuntimeSnapshot(ownerInput(config))!;
  }
  async function refreshCatalog(
    owner: Awaited<ReturnType<typeof prepareCatalogOwner>>,
    catalog: ModelCatalogSnapshot,
  ) {
    serveCatalog(catalog);
    return owner.loadFullModelCatalog!({ refresh: true });
  }
  function makeCatalog(
    entries: ModelCatalogSnapshot["entries"] = [],
    options: Partial<Omit<ModelCatalogSnapshot, "entries">> = {},
  ): ModelCatalogSnapshot {
    return { entries, routeVariants: entries, ...options };
  }
  function catalogAuth(
    provider: string,
    authStore: PreparedModelCatalogAuth["authStore"],
    credentials: PreparedModelCatalogAuth["credentials"] = {},
  ): PreparedModelCatalogAuth {
    return {
      authStore,
      credentials,
      authModes: { [provider]: "api_key" },
      providerAuthLabels: new Map(),
    };
  }
  function ownerInput(config: OpenClawConfig, agentId = "pro") {
    return { config, agentId, agentDir: fixture.state.agentDir(agentId) };
  }
  function hotReload(config: OpenClawConfig, agentIds?: ReadonlySet<string>) {
    return refreshModelRuntimeAfterHotReload({
      config,
      agentIds,
      pluginMetadataSnapshot: undefined,
    });
  }
  function serveCatalog(catalog: ModelCatalogSnapshot) {
    catalogWorker.mockImplementation(async (providerIds?: readonly string[]) => {
      const included = (provider: string) => !providerIds || providerIds.includes(provider);
      const reply: ModelCatalogSnapshot = {
        ...catalog,
        entries: catalog.entries.filter((row) => included(row.provider)),
        routeVariants: catalog.routeVariants.filter((row) => included(row.provider)),
        staticEntries: catalog.staticEntries?.filter((row) => included(row.provider)),
        providerOutcomes: catalog.providerOutcomes?.filter((row) => included(row.provider)),
      };
      const auth = getPreparedModelFullCatalogAuth(catalog);
      if (auth) {
        setPreparedModelFullCatalogAuth(reply, auth);
      }
      return reply;
    });
  }
  async function prepareCatalogOwner(config: OpenClawConfig, catalog: ModelCatalogSnapshot) {
    mocks.configuredAgentIds = ["pro"];
    serveCatalog(catalog);
    await refreshPreparedModelRuntimeSnapshots(config, {
      ...gatewayOptions,
      allowGatewaySubagentBinding: true,
    });
    const owner = getPreparedModelRuntimeSnapshot(ownerInput(config))!;
    await owner.loadFullModelCatalog!({ refresh: true });
    return owner;
  }
  it.each(["credential", "selected-profile"] as const)(
    "does not retain an account inventory after its %s changes",
    async (change) => {
      const learned = entry("demo", "learned", "Learned");
      const starter = entry("demo", "starter", "Starter");
      const profiles = {
        "demo:first": { type: "api_key" as const, provider: "demo", key: "first-key" },
        "demo:second": { type: "api_key" as const, provider: "demo", key: "second-key" },
      };
      const previous = makeCatalog([learned], {
        providerOutcomes: [outcome("demo", "ready", "demo:first")],
      });
      const failed = makeCatalog([], {
        staticEntries: [starter],
        providerOutcomes: [
          outcome(
            "demo",
            "unavailable",
            change === "selected-profile" ? "demo:second" : "demo:first",
          ),
        ],
      });
      const auth = (nextProfiles = profiles) =>
        catalogAuth("demo", { version: 1, profiles: nextProfiles });
      setPreparedModelFullCatalogAuth(previous, auth());
      setPreparedModelFullCatalogAuth(
        failed,
        auth(
          change === "credential"
            ? { ...profiles, "demo:first": { ...profiles["demo:first"], key: "replacement-key" } }
            : profiles,
        ),
      );
      const owner = await prepareCatalogOwner(proConfig, previous);
      expect(await refreshCatalog(owner, failed)).toMatchObject({
        entries: [starter],
        routeVariants: [starter],
        authoritative: false,
      });
    },
  );
  it("does not reuse a post-startup account catalog under the startup credentials", async () => {
    const config = proConfig;
    const learned = entry("demo", "private-model", "Private model");
    const catalog = makeCatalog([learned], {
      providerOutcomes: [outcome("demo", "ready")],
    });
    attachAuth(
      catalog,
      "demo",
      { version: 1, profiles: {} },
      { demo: { type: "api_key", key: "post-startup-key" } },
    );
    const owner = await prepareCatalogOwner(config, catalog);
    containsEntries((await owner.loadFullModelCatalog!()).entries, learned);
    serveCatalog(makeCatalog());
    await hotReload(config);
    const reloaded = published(config);
    expect(reloaded.readFullModelCatalog!()?.entries ?? []).not.toContainEqual(learned);
  });
  it("invalidates retained discovery after the endpoint identity changes", async () => {
    mocks.configuredAgentIds = ["pro"];
    const configuredProvider: ModelProviderConfig = {
      baseUrl: "https://original.example.test/v1",
      models: [],
    };
    const config = withProvider("demo", configuredProvider, {
      ...proConfig,
      plugins: { allow: ["demo"], entries: { demo: { enabled: true } } },
    });
    const learned = entry("demo", "learned", "Learned");
    const unrelated = entry("unrelated", "found", "Found");
    serveCatalog(makeCatalog([learned, unrelated], { routeVariants: [learned] }));
    await refreshPreparedModelRuntimeSnapshots(config, gatewayOptions);
    await published(config).loadFullModelCatalog!({ refresh: true });
    serveCatalog(makeCatalog());
    const nextConfig = withProvider(
      "demo",
      { ...configuredProvider, baseUrl: "https://replacement.example.test/v1" },
      config,
    );
    await refreshPreparedModelRuntimeSnapshots(nextConfig, gatewayOptions);
    const entries = published(nextConfig).readFullModelCatalog!()?.entries ?? [];
    expect(entries).not.toContainEqual(expect.objectContaining(learned));
    expect(entries).toContainEqual(expect.objectContaining(unrelated));
  });
});

describe("auth replacement publication", () => {
  const agentDir = (agentId: string) => fixture.state.agentDir(agentId);
  const dispatch = (agentId = "default") => loadPublishedDispatch({ agentId });
  const staticOptions = { gatewayLifecycle: true, catalogMode: "static" as const };
  const build = () => createDeferred<Record<string, never>>();
  const refreshConfigured = (config: OpenClawConfig = {}) =>
    refresh(config, { gatewayLifecycle: true });
  async function start(agentIds = ["default"], config: OpenClawConfig = {}) {
    mocks.configuredAgentIds = agentIds;
    await refreshConfigured(config);
  }
  async function staticSnapshot(config: OpenClawConfig = {}) {
    mocks.configuredAgentIds = ["default"];
    await refresh(config, staticOptions);
    return prepare(fixture.agentInput("default", config));
  }
  const waitForBuilds = (count: number) =>
    vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(count));
  function holdBuilds(...builds: ReturnType<typeof build>[]) {
    for (const pending of builds) {
      mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => await pending.promise);
    }
  }
  function routeBuilds(builds: Record<string, ReturnType<typeof build>>) {
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, directory) => {
      const pending = Object.entries(builds).find(([id]) => agentDir(id) === directory)?.[1];
      return pending ? await pending.promise : {};
    });
  }
  function pendingWork() {
    const releases: (() => void)[] = [];
    const operations: Promise<unknown>[] = [];
    const cleanups: (() => void)[] = [];

    return {
      gate<T>(fallback: T) {
        const started = createDeferred();
        const pending = createDeferred<T>();
        releases.push(() => pending.resolve(fallback));
        return {
          ...pending,
          started: started.promise,
          run: () => {
            started.resolve();
            return pending.promise;
          },
        };
      },
      build() {
        return this.gate<Record<string, never>>({});
      },
      track<T>(operation: Promise<T>): Promise<T> {
        operations.push(operation);
        void operation.catch(() => undefined);
        return operation;
      },
      async [Symbol.asyncDispose]() {
        // Release gates before joining producers; listeners observe their final publication.
        for (const release of releases) {
          release();
        }
        await Promise.allSettled(operations);
        for (const cleanup of cleanups) cleanup();
      },
    };
  }
  const expectPending = (promise: Promise<unknown>) =>
    expect(Promise.race([promise.then(() => "settled"), Promise.resolve("pending")])).resolves.toBe(
      "pending",
    );
  function observePhases() {
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) =>
      events.push(phase),
    );
    return { events, unregister };
  }
  const mutate = (agentId = "default") =>
    mocks.mutationListener?.({
      agentDir: agentDir(agentId),
      affectsInheritedStores: false,
    });

  it("commits auth invalidation inside the active lifecycle publication", async () => {
    await using work = pendingWork();
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await start(["default", "worker"]);
    const configBuild = work.build();
    const authBuild = work.build();
    const { events, unregister } = observePhases();
    work.defer(unregister);
    let defaultBuildCount = 0;
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, directory) => {
      if (directory !== agentDir("default")) {
        return {};
      }
      return await (defaultBuildCount++ === 0 ? configBuild : authBuild).run();
    });

    const publication = work.track(refreshConfigured(replacementConfig));
    await configBuild.started;
    mutate("default");
    const affectedRead = work.track(
      dispatch().then((runtime) => {
        expect(events).toContain("published");
        return runtime;
      }),
    );
    const siblingRead = work.track(dispatch("worker"));
    configBuild.resolve({});
    await authBuild.started;
    await expectPending(publication);
    await expectPending(affectedRead);
    expect(events).not.toContain("published");

    authBuild.resolve({});
    await expect(publication).resolves.toBeUndefined();
    const [affectedRuntime, siblingRuntime] = await Promise.all([affectedRead, siblingRead]);
    unregister();

    expect(events.filter((phase) => phase === "published")).toHaveLength(1);
    expect(events).not.toContain("failed");
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(affectedRuntime?.config).toBe(replacementConfig);
    expect(siblingRuntime?.config).toBe(replacementConfig);
    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      agentDir: agentDir("default"),
      config: replacementConfig,
      workspaceDir: "/tmp/unused-workspace",
    });
    expect(lease.snapshot.config).toBe(replacementConfig);
    await lease[Symbol.asyncDispose]();
  });
  it("keeps transitively overlapping inherited auth mutations atomic", async () => {
    await using work = pendingWork();
    await start(["default", "worker", "research"]);
    const builds = {
      default: work.build(),
      research: work.build(),
      worker: work.build(),
    };
    const refreshError = new Error("inherited research auth build failed");
    routeBuilds(builds);

    mutate("worker");
    mutate("research");
    mocks.mutationListener?.({ affectsInheritedStores: true });
    const dispatches = Object.keys(builds).map((agentId) => work.track(dispatch(agentId)));
    builds.default.resolve({});
    builds.worker.resolve({});
    await vi.waitFor(() =>
      expect(mocks.ensureOpenClawModelsJson.mock.calls.length).toBeGreaterThanOrEqual(6),
    );

    builds.research.reject(refreshError);

    for (const read of dispatches) {
      await expect(read).rejects.toBe(refreshError);
    }
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
  it("settles an adopted auth gate when replacement fails, and permits recovery", async () => {
    await using work = pendingWork();
    const replacementConfig = { plugins: {} };
    await start();
    const authBuild = work.build();
    const configBuild = work.build();
    const failure = new Error("replacement build failed");
    holdBuilds(authBuild, configBuild);
    mutate();
    await waitForBuilds(2);
    const authWaiter = work.track(dispatch());
    const reload = work.track(refreshConfigured(replacementConfig));
    authBuild.resolve({});
    await waitForBuilds(3);
    configBuild.reject(failure);
    await expect(reload).rejects.toBe(failure);
    await expect(authWaiter).rejects.toBe(failure);
    await expect(dispatch()).resolves.toMatchObject({ config: replacementConfig });
  });
  it("revokes changed auth immediately and publishes it after plugin drain replacement", async () => {
    const initialConfig = {};
    const input = fixture.agentInput("default", initialConfig);
    const original = await staticSnapshot(initialConfig);
    const drain = beginPreparedModelRuntimePluginDrain();
    let draining = true;
    mocks.prepareStaticCatalog.mockClear();
    mocks.prepareStaticCatalog.mockImplementation(async () => {
      expect(draining).toBe(false);
      return { entries: [] };
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let read: ReturnType<typeof prepare> | undefined;
    let publication: Promise<void> | undefined;
    try {
      mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
      expect(original.isCurrent()).toBe(false);
      read = prepare(input, { readPublished: true });
      const readSettled = vi.fn();
      void read.then(readSettled, readSettled);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.prepareStaticCatalog).not.toHaveBeenCalled();
      expect(readSettled).not.toHaveBeenCalled();
      draining = false;
      drain.release();
      publication = refresh({ plugins: {} }, staticOptions);
      await publication;
      const refreshed = await read;
      expect(refreshed).not.toBe(original);
      expect(refreshed.isCurrent()).toBe(true);
      expect(mocks.prepareStaticCatalog).toHaveBeenCalled();
    } finally {
      draining = false;
      drain.release();
      vi.useRealTimers();
      await Promise.allSettled([read, publication]);
    }
  });
});
