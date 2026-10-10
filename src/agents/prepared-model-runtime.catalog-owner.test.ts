// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { modelCatalogRouteVariantKey } from "./model-catalog-entry.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import {
  preparePublishedModelCatalogOwnerIdentity,
  resolvePublishedModelCatalogOwner,
} from "./prepared-model-catalog-owner.js";
import { setPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import * as runtimeBuild from "./prepared-model-runtime.build.js";
import {
  acquireAgentRunPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  PreparedModelRuntimeOwnerNotPublishedError,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";
import {
  publishModelRuntimeSnapshot,
  resolvePreparedModelRuntimeOwnerBySnapshot,
} from "./prepared-model-runtime.owner.js";
import * as pluginLifetime from "./prepared-model-runtime.plugin-lifetime.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";

const fixture = usePreparedModelRuntimeHarness();
const { mocks } = fixture;

describe("prepared catalog owner lifecycle", () => {
  it("retains the current preparation across adopted auth", async () => {
    mocks.configuredAgentIds = ["alpha"];
    const agentDir = fixture.state.agentDir("alpha");
    mocks.configuredWorkspaces.set("alpha", "/tmp/old-workspace");
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const workspaceDir = "/tmp/fresh-workspace";
    mocks.configuredWorkspaces.set("alpha", workspaceDir);
    const config = { plugins: {} };
    const source = createDeferred<{ agentDir: string; wrote: false }>();
    const auth = createDeferred<{ agentDir: string; wrote: false }>();
    const started = createDeferred();
    const authStarted = createDeferred();
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => {
        started.resolve();
        return await source.promise;
      })
      .mockImplementationOnce(async () => {
        authStarted.resolve();
        return await auth.promise;
      });
    const phases: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) =>
      phases.push(phase),
    );
    const publication = refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    let published = false;
    void publication.then(
      () => {
        published = true;
      },
      () => undefined,
    );
    let dispatch: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let dispatched = false;
    try {
      await started.promise;
      dispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "alpha" });
      void dispatch.then(
        () => {
          dispatched = true;
        },
        () => undefined,
      );
      // Any later inference is now wrong, including an auth build with no completed snapshot.
      mocks.configuredAgentDirs.set("alpha", "/tmp/later-agent");
      mocks.configuredWorkspaces.set("alpha", "/tmp/later-workspace");
      mocks.mutationListener!({ agentDir, affectsInheritedStores: false });
      source.resolve({ agentDir, wrote: false });
      await authStarted.promise;
      expect(published).toBe(false);
      expect(dispatched).toBe(false);
      expect(phases).not.toContain("published");
      auth.resolve({ agentDir, wrote: false });
      await publication;
      await expect(dispatch).resolves.toMatchObject({
        agentId: "alpha",
        agentDir,
        workspaceDir,
        config,
      });
      const snapshot = await prepareModelRuntimeSnapshot({ agentId: "alpha", agentDir, config });
      expect(resolvePublishedModelCatalogOwner(snapshot)).toMatchObject({
        agentId: "alpha",
        workspaceDir,
      });
      expect(phases.filter((phase) => phase === "published")).toHaveLength(1);
      expect(phases).not.toContain("failed");
    } finally {
      source.resolve({ agentDir, wrote: false });
      auth.resolve({ agentDir, wrote: false });
      await Promise.allSettled([publication, dispatch]);
      unregister();
    }
  });

  it("refreshes a newer beta preparation instead of the completed alpha snapshot", async () => {
    const agentDir = fixture.state.agentDir("rebound-catalog-agent");
    const workspaceDir = "/tmp/rebound-catalog-workspace";
    const input = { agentDir, inheritedAuthDir: agentDir, workspaceDir, config: {} };
    mocks.configuredAgentIds = ["alpha"];
    mocks.configuredAgentDirs.set("alpha", agentDir);
    const alpha = await publishPreparedModelRuntimeSnapshot(input);
    expect(resolvePublishedModelCatalogOwner(alpha)).toMatchObject({ agentId: "alpha" });
    mocks.configuredAgentIds = ["beta"];
    mocks.configuredAgentDirs.set("beta", agentDir);
    const freshInput = { ...input, config: { plugins: {} } };
    const source = createDeferred<{ agentDir: string; wrote: false }>();
    const started = createDeferred();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      started.resolve();
      return await source.promise;
    });
    const fresh = publishPreparedModelRuntimeSnapshot(freshInput, { force: true });
    void fresh.catch(() => undefined);
    let refreshed: Promise<Awaited<ReturnType<typeof prepareModelRuntimeSnapshot>>> | undefined;
    try {
      await started.promise;
      expect(resolvePublishedModelCatalogOwner(alpha)).toMatchObject({ agentId: "alpha" });
      // The beta fact must already exist; neither the old snapshot nor ambient inference can supply it.
      mocks.configuredAgentIds = ["gamma"];
      mocks.configuredAgentDirs.set("gamma", agentDir);
      mocks.mutationListener!({ agentDir, affectsInheritedStores: false });
      refreshed = prepareModelRuntimeSnapshot(freshInput);
      void refreshed.catch(() => undefined);
      source.resolve({ agentDir, wrote: false });
      await expect(fresh).rejects.toThrow("superseded");
      const snapshot = await refreshed;
      expect(snapshot.agentId).toBeUndefined();
      expect(resolvePublishedModelCatalogOwner(snapshot)).toMatchObject({
        agentId: "beta",
        workspaceDir,
      });
      const events = vi.fn();
      const stopObserving = registerPreparedModelRuntimePublicationListener(events);
      try {
        snapshot.accountCatalog?.prepareServiceTierObserver({
          selectedCredential: {
            source: "direct",
            provider: "openai",
            identityKey: "direct:openai",
          },
        })({
          modelId: "fixture-model",
          runtimeId: "openclaw",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          requestedTier: "ultrafast",
          responseTier: "priority",
        });
        expect(events).toHaveBeenCalledExactlyOnceWith({
          phase: "catalog-observation",
          modelFactsChanged: false,
          agentId: "beta",
        });
      } finally {
        stopObserving();
      }
    } finally {
      source.resolve({ agentDir, wrote: false });
      await Promise.allSettled([fresh, refreshed]);
    }
  });

  it("retains known-unbound identity across auth refresh while runtime reads stay usable", async () => {
    const input = {
      config: {},
      agentDir: fixture.state.agentDir("unbound-catalog-agent"),
      readOnly: true,
    };
    mocks.configuredAgentIds = ["alpha"];
    const first = await publishPreparedModelRuntimeSnapshot(input);
    expect(() => resolvePublishedModelCatalogOwner(first)).toThrow(
      "did not identify one configured agent",
    );
    mocks.configuredAgentDirs.set("alpha", input.agentDir);
    expect(preparePublishedModelCatalogOwnerIdentity(input)).toMatchObject({ agentId: "alpha" });
    mocks.mutationListener!({ agentDir: input.agentDir, affectsInheritedStores: false });
    const refreshed = await prepareModelRuntimeSnapshot(input);
    expect(refreshed.createStores().authStorage.getAll()).toMatchObject({
      custom: { type: "api_key" },
    });
    expect(refreshed.workspaceDir).toBeUndefined();
    expect(() => resolvePublishedModelCatalogOwner(refreshed)).toThrow(
      "did not identify one configured agent",
    );
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });
});

describe("prepared build candidate lifetime", () => {
  describe("unpublished run owners", () => {
    it("retires a timeout while fencing late work ahead of the retry", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(1);
      const input = {
        config: {},
        agentDir: fixture.state.agentDir("timed-out-admission"),
      };
      const started = createDeferred();
      const finish = createDeferred();
      mocks.resolveAmbientCredentials.mockImplementationOnce(async () => {
        started.resolve();
        await finish.promise;
        return {};
      });
      const builds = vi.spyOn(runtimeBuild, "startSerializedSnapshotBuildBatch");
      const first = acquireAgentRunPreparedModelRuntime(input);
      const timedOut = expect(first).rejects.toThrow(
        "prepared model runtime publication (ambient credentials; agent standalone) timed out",
      );
      let retry: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
      try {
        await started.promise;
        await vi.advanceTimersByTimeAsync(1);
        await timedOut;
        await expect(prepareModelRuntimeSnapshot(input)).rejects.toBeInstanceOf(
          PreparedModelRuntimeOwnerNotPublishedError,
        );
        retry = acquireAgentRunPreparedModelRuntime(input);
        expect(builds).toHaveBeenCalledTimes(2);
        expect(mocks.resolveAmbientCredentials).toHaveBeenCalledOnce();

        finish.resolve();
        const lease = await retry;
        expect(await prepareModelRuntimeSnapshot(input)).toBe(lease.snapshot);
        expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(2);
        // The retired build must stop after its held preparation, before discovery or publication.
        expect(mocks.discoverModels).toHaveBeenCalledOnce();
      } finally {
        finish.resolve();
        await Promise.allSettled([first, retry?.then((lease) => lease[Symbol.asyncDispose]())]);
        await Promise.all(builds.mock.results.map((result) => result.value.completion));
        builds.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("fails a timed-out publication without overlapping its late build with a retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(1);
    const sourceStarted = createDeferred();
    const source = createDeferred<{ agentDir: string; wrote: false }>();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      sourceStarted.resolve();
      return await source.promise;
    });
    const input = { config: {}, agentDir: fixture.state.agentDir("timeout") };
    const builds = vi.spyOn(runtimeBuild, "startSerializedSnapshotBuildBatch");
    const publication = publishPreparedModelRuntimeSnapshot(input);
    const timedOut = expect(publication).rejects.toThrow(
      "prepared model runtime publication (agent catalog sources) timed out",
    );
    try {
      await sourceStarted.promise;
      await vi.advanceTimersByTimeAsync(1);
      await timedOut;
      await expect(prepareModelRuntimeSnapshot(input)).rejects.toThrow(
        "prepared model runtime publication (agent catalog sources) timed out",
      );
      await expect(publishPreparedModelRuntimeSnapshot(input)).rejects.toThrow(
        "prepared model runtime publication (agent catalog sources) timed out",
      );
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();

      source.resolve({ agentDir: input.agentDir, wrote: false });
      // The timeout settles admission before capture finishes; join the native build, not discovery.
      await builds.mock.results[0]!.value.completion;
      expect(mocks.discoverModels).toHaveBeenCalledOnce();
      await expect(publishPreparedModelRuntimeSnapshot(input)).resolves.toMatchObject({
        agentDir: input.agentDir,
      });
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    } finally {
      source.resolve({ agentDir: input.agentDir, wrote: false });
      await Promise.all(builds.mock.results.map((result) => result.value.completion));
      builds.mockRestore();
      vi.useRealTimers();
    }
  });

  it("serializes workspace replacements for one agent-owned catalog", async () => {
    const finishFirstGate = createDeferred();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, targetDir) => {
      await finishFirstGate.promise;
      return { agentDir: String(targetDir), wrote: false };
    });
    const config = {};
    const agentDir = fixture.state.agentDir("workspace-replacement");
    let first: ReturnType<typeof publishPreparedModelRuntimeSnapshot> | undefined;
    let requestDuringFirstGeneration: ReturnType<typeof prepareModelRuntimeSnapshot> | undefined;
    let replacement: ReturnType<typeof publishPreparedModelRuntimeSnapshot> | undefined;
    try {
      first = publishPreparedModelRuntimeSnapshot({
        config,
        agentDir,
        workspaceDir: "/tmp/workspace-old",
      });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce());
      requestDuringFirstGeneration = prepareModelRuntimeSnapshot({
        config,
        agentDir,
        workspaceDir: "/tmp/workspace-old",
      });

      replacement = publishPreparedModelRuntimeSnapshot({
        config,
        agentDir,
        workspaceDir: "/tmp/workspace-new",
      });
      await Promise.resolve();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();

      finishFirstGate.resolve();
      const firstSnapshot = await first;
      const replacementSnapshot = await replacement;
      expect(await requestDuringFirstGeneration).toBe(firstSnapshot);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
        config,
        agentDir,
        expect.objectContaining({ workspaceDir: "/tmp/workspace-new" }),
      );
      expect(
        await prepareModelRuntimeSnapshot({
          config,
          agentDir,
          workspaceDir: "/tmp/workspace-new",
        }),
      ).toBe(replacementSnapshot);
    } finally {
      finishFirstGate.resolve();
      await Promise.allSettled([first, replacement, requestDuringFirstGeneration]);
    }
  });

  it("serializes conflicting standalone activations for one owner", async () => {
    const agentDir = fixture.state.agentDir("concurrent-standalone");
    const firstConfig = {};
    const secondConfig = {};
    const finishFirstBuildGate = createDeferred();
    let finishFirstBuild!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, targetDir) => {
      finishFirstBuild = () => finishFirstBuildGate.resolve();
      await finishFirstBuildGate.promise;
      return { agentDir: String(targetDir), wrote: false };
    });

    let firstActivation: ReturnType<typeof activateStandalonePreparedModelRuntime> | undefined;
    let secondActivation: ReturnType<typeof activateStandalonePreparedModelRuntime> | undefined;
    try {
      firstActivation = activateStandalonePreparedModelRuntime({
        config: firstConfig,
        agentDir,
      });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce());
      secondActivation = activateStandalonePreparedModelRuntime({
        config: secondConfig,
        agentDir,
      });

      await Promise.resolve();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
      finishFirstBuild();

      const [first, second] = await Promise.all([firstActivation, secondActivation]);
      expect(first?.config).toBe(firstConfig);
      expect(second?.config).toBe(secondConfig);
      expect(first).not.toBe(second);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    } finally {
      finishFirstBuildGate.resolve();
      await Promise.allSettled([firstActivation, secondActivation]);
    }
  });
});

describe("legacy provider catalog retention", () => {
  const learned = { provider: "custom", id: "learned", name: "Learned" };
  const starter = { provider: "custom", id: "starter", name: "Starter" };

  it.each([
    { name: "nonempty legacy inventory", empty: false, expected: [learned] },
    { name: "empty legacy inventory", empty: true, expected: [starter] },
    {
      name: "profile-specific failure",
      empty: false,
      profileId: "custom:account",
      expected: [starter],
    },
    { name: "changed credentials", empty: false, changedKey: true, expected: [starter] },
    { name: "explicit successful empty inventory", empty: true, ready: true, expected: [] },
    { name: "previous failed acquisition", empty: false, failed: true, expected: [starter] },
  ])("preserves the shipped retention boundary for $name", async (scenario) => {
    const previous: ModelCatalogSnapshot = {
      entries: scenario.empty ? [] : [learned],
      routeVariants: scenario.empty ? [] : [learned],
      ...(scenario.ready
        ? { providerOutcomes: [{ provider: "custom", status: "ready" as const }] }
        : scenario.failed
          ? { providerOutcomes: [{ provider: "custom", status: "unavailable" as const }] }
          : {}),
    };
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(previous);
    mocks.catalogHookRows = new Map([
      [
        "custom",
        new Set(
          previous.entries.map((entry) =>
            modelCatalogRouteVariantKey(entry, resolveModelCatalogIdentityKey(entry)),
          ),
        ),
      ],
    ]);
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    const owner = await publishPreparedModelRuntimeSnapshot(fixture.agentInput("pro", config), {
      catalogMode: "static",
      provenance: "standalone",
    });
    const stored = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!;
    expect(stored.catalogInventory?.providers.has("custom")).not.toBe(true);
    await owner.loadFullModelCatalog!({ refresh: true });
    expect(stored.catalogInventory?.providers.has("custom")).toBe(true);
    if (!scenario.ready && !scenario.failed) {
      expect(stored.catalogInventory?.catalog.providerOutcomes ?? []).toEqual([]);
      expect(stored.catalogInventory?.discoveryOrigins).toEqual([]);
    }

    const failed: ModelCatalogSnapshot = {
      entries: [],
      routeVariants: [],
      staticEntries: [starter],
      providerOutcomes: [
        { provider: "custom", profileId: scenario.profileId, status: "unavailable" },
      ],
    };
    if (scenario.changedKey) {
      setPreparedModelFullCatalogAuth(failed, {
        providerAuthLabels: new Map(),
        authStore: { version: 1, profiles: {} },
        authModes: { custom: "api_key" },
        credentials: { custom: { type: "api_key", key: "replacement-key" } },
      });
    }
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(failed);
    mocks.catalogHookRows = new Map();
    const result = await owner.loadFullModelCatalog!({ refresh: true });
    expect(result.entries.map(({ provider, id, name }) => ({ provider, id, name }))).toEqual(
      scenario.expected,
    );
    expect(result.routeVariants.map(({ provider, id, name }) => ({ provider, id, name }))).toEqual(
      scenario.expected,
    );
    expect(result.providerOutcomes).toEqual(failed.providerOutcomes);
    expect(result.authoritative).toBe(false);
  });

  it("does not treat native-first configured rows as a completed provider acquisition", async () => {
    const configured = {
      id: "configured",
      name: "Configured",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    };
    const native = { provider: "custom", id: "native", name: "Native", nativeRuntime: "fixture" };
    mocks.modelRegistry.getAll.mockReturnValue([{ ...configured, provider: "custom" }]);
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "fixture",
        source: "fixture",
        harness: {
          id: "fixture",
          label: "Fixture",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          loadModelCatalog: async () => [native],
        },
      });
      return registry;
    });
    const config: OpenClawConfig = {
      agents: { entries: { pro: { model: "custom/configured" } } },
      models: {
        providers: {
          custom: {
            baseUrl: "https://catalog.example.invalid/v1",
            api: "openai-completions",
            models: [configured],
          },
        },
      },
    };
    const owner = await publishPreparedModelRuntimeSnapshot(fixture.agentInput("pro", config), {
      catalogMode: "static",
      provenance: "standalone",
    });
    await owner.loadNativeModelCatalog!({
      provider: "custom",
      modelId: "native",
      runtime: "fixture",
    });
    const stored = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!;
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
    expect(stored.catalogInventory?.providers.size).toBe(0);
    expect(stored.catalogInventory?.catalog.entries).toContainEqual(
      expect.objectContaining({ provider: "custom", id: "configured" }),
    );
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [],
      routeVariants: [],
      staticEntries: [starter],
      providerOutcomes: [{ provider: "custom", status: "unavailable" }],
    });
    const result = await owner.loadFullModelCatalog!({ refresh: true });
    expect(result.entries).toContainEqual(expect.objectContaining(starter));
    expect(result.authoritative).toBe(false);
  });

  describe("failed provider discovery retry", () => {
    const unavailable: ModelCatalogSnapshot = {
      entries: [],
      routeVariants: [],
      staticEntries: [starter],
      providerOutcomes: [{ provider: "custom", status: "unavailable" }],
    };
    const ready: ModelCatalogSnapshot = {
      entries: [learned],
      routeVariants: [learned],
      providerOutcomes: [{ provider: "custom", status: "ready" }],
    };
    const worker = mocks.runPreparedModelCatalogWorker;
    const publishFailedOwner = async () => {
      worker.mockResolvedValue(unavailable);
      const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
      const owner = await publishPreparedModelRuntimeSnapshot(fixture.agentInput("pro", config), {
        catalogMode: "static",
        provenance: "standalone",
      });
      const failed = await owner.loadFullModelCatalog!({ refresh: true });
      expect(failed.entries.map(({ id }) => id)).toEqual(["starter"]);
      return { owner, calls: worker.mock.calls.length };
    };

    it("retries with backoff without a read or explicit refresh", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const { owner, calls } = await publishFailedOwner();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(worker).toHaveBeenCalledTimes(calls + 1);
        worker.mockResolvedValue(ready);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(worker).toHaveBeenCalledTimes(calls + 1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(worker).toHaveBeenCalledTimes(calls + 2);
        await vi.waitFor(() =>
          expect(owner.readFullModelCatalog!()?.entries.map(({ id }) => id)).toEqual(["learned"]),
        );
        // A recovered provider returns to its ordinary renewal contract.
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(worker).toHaveBeenCalledTimes(calls + 2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("measures a new failure episode from its own failure", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const { owner, calls } = await publishFailedOwner();
        await vi.advanceTimersByTimeAsync(10_000);
        worker.mockResolvedValue(ready);
        await owner.loadFullModelCatalog!({ refresh: true, providerIds: ["custom"] });
        await vi.advanceTimersByTimeAsync(10_000);
        worker.mockResolvedValue(unavailable);
        await owner.loadFullModelCatalog!({ refresh: true, providerIds: ["custom"] });
        await vi.advanceTimersByTimeAsync(29_000);
        expect(worker).toHaveBeenCalledTimes(calls + 2);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(worker).toHaveBeenCalledTimes(calls + 3);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

it("preserves the primary publication error when terminal generation cleanup also fails", async () => {
  const primary = new Error("plugin generation retired before publication");
  const cleanup = new Error("registration cleanup failed");
  let failedOwner: PreparedModelRuntimeOwner | undefined;
  const publish = vi
    .spyOn(pluginLifetime, "publishPreparedPluginGeneration")
    .mockImplementationOnce((owner) => {
      failedOwner = owner;
      throw primary;
    });
  const discardGeneration = pluginLifetime.discardPreparedPluginGeneration;
  const discard = vi
    .spyOn(pluginLifetime, "discardPreparedPluginGeneration")
    .mockImplementationOnce(async (generation) => {
      await discardGeneration(generation);
      throw cleanup;
    });
  try {
    const failure = await publishModelRuntimeSnapshot(
      {
        config: {},
        agentDir: fixture.state.agentDir("main"),
        workspaceDir: fixture.state.workspaceDir,
      },
      new Map(),
      new Map(),
      30_000,
      undefined,
      "explicit",
      "static",
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SuppressedError);
    expect(failure).toMatchObject({ error: cleanup, suppressed: primary });
    expect(failedOwner?.refreshError).toBe(primary);
    expect(failedOwner?.pending).toBeUndefined();
  } finally {
    publish.mockRestore();
    discard.mockRestore();
  }
});

async function prepareCatalogOwner(
  config: OpenClawConfig,
  catalogs: readonly ModelCatalogSnapshot[],
) {
  mocks.configuredAgentIds = ["pro"];
  for (const catalog of catalogs) {
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(catalog);
  }
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
  });
  return getPreparedModelRuntimeSnapshot({
    config,
    agentId: "pro",
    agentDir: fixture.state.agentDir("pro"),
  })!;
}

describe("captured startup inventory refresh", () => {
  it("reports redacted nested failures from the committed catalog refresh", async () => {
    const warning = createDeferred<string>();
    const token = "sk-abcdefghijklmnopqrstuv";
    const failure = new AggregateError(
      [
        new Error("registry release failed", {
          cause: new Error(`Authorization: Bearer ${token}`),
        }),
        new Error("donor close failed"),
      ],
      "Prepared plugin resources failed to close",
    );
    mocks.configuredAgentIds = ["pro"];
    mocks.runPreparedModelCatalogWorker.mockRejectedValue(failure);
    mocks.warn.mockImplementation((message: string) => warning.resolve(message));

    await refreshPreparedModelRuntimeSnapshots(
      { agents: { entries: { pro: {} } } },
      { gatewayLifecycle: true, catalogMode: "static" },
    );
    const message = await warning.promise;

    expect(message).toContain("provider catalog refresh failed:");
    expect(message).toContain("Prepared plugin resources failed to close");
    expect(message).toContain("registry release failed");
    expect(message).toContain("donor close failed");
    expect(message).toContain("Authorization: Bearer");
    expect(message).not.toContain(token);
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it("does not refill a successful empty refresh from the captured startup registry", async () => {
    const captured = {
      provider: "custom",
      id: "removed",
      name: "Previously discovered",
      api: "openai-completions" as const,
      baseUrl: "https://custom.example.test/v1",
    };
    mocks.modelRegistry.getAll.mockReturnValue([captured]);
    const owner = await prepareCatalogOwner(
      { models: { mode: "merge" }, agents: { entries: { pro: {} } } },
      [
        {
          entries: [],
          routeVariants: [],
          providerOutcomes: [{ provider: "custom", status: "ready" }],
        },
      ],
    );
    expect(owner.modelCatalog.entries).toContainEqual(expect.objectContaining({ id: "removed" }));

    const refreshed = await owner.loadFullModelCatalog!({ refresh: true });

    expect(refreshed.entries).toEqual([]);
    expect(refreshed.routeVariants).toEqual([]);
    expect(refreshed.providerOutcomes).toEqual([{ provider: "custom", status: "ready" }]);
  });
});
