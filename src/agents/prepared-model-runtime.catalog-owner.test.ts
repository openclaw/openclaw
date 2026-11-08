// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
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
import { PreparedModelRuntimeClosedError } from "./prepared-model-runtime.lifecycle.js";
import {
  publishModelRuntimeSnapshot,
  resolvePreparedModelRuntimeOwnerBySnapshot,
} from "./prepared-model-runtime.owner.js";
import * as pluginLifetime from "./prepared-model-runtime.plugin-lifetime.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const { createMockSubsystemLogger } = await import("../../test/helpers/mock-subsystem-logger.js");
  return {
    ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
    createSubsystemLogger: (subsystem: string) =>
      createMockSubsystemLogger(subsystem, {
        warn: (...args) => getPreparedModelRuntimeMocks().warn(...args),
      }),
  };
});

const fixture = usePreparedModelRuntimeHarness(undefined, () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const { mocks } = fixture;

function makeCatalog(
  entries: ModelCatalogEntry[],
  extra: Partial<ModelCatalogSnapshot> = {},
): ModelCatalogSnapshot {
  return { entries, routeVariants: entries, ...extra };
}

function setCatalogApiKey(
  snapshot: ModelCatalogSnapshot,
  provider = "custom",
  key = "replacement-key",
) {
  setPreparedModelFullCatalogAuth(snapshot, {
    providerAuthLabels: new Map(),
    authStore: { version: 1, profiles: {} },
    authModes: { [provider]: "api_key" },
    credentials: { [provider]: { type: "api_key", key } },
  });
}

function holdCatalogWrite() {
  const started = createDeferred();
  const result = createDeferred<Record<string, never>>();
  const pending: Promise<unknown>[] = [];
  const release = () => result.resolve({});
  mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
    started.resolve();
    return await result.promise;
  });
  return {
    started: started.promise,
    release,
    track<T>(promise: Promise<T>) {
      pending.push(promise);
      return promise;
    },
    async [Symbol.asyncDispose]() {
      release();
      await Promise.allSettled(pending);
    },
  };
}

function publishStandaloneCatalog() {
  return publishPreparedModelRuntimeSnapshot(
    fixture.agentInput("pro", { agents: { entries: { pro: {} } } }),
    { catalogMode: "static", provenance: "standalone" },
  );
}

describe("prepared catalog owner lifecycle", () => {
  it.each([
    ["qwen3:8bb", "qwen3:8b"],
    ["qwen3:8b", "qwen3:8bb"],
  ])("updates retained catalog advisories on hot reload from %s to %s", async (before, after) => {
    const worker = mocks.runPreparedModelCatalogWorker;
    mocks.authStorage.getAll.mockReturnValue({ ollama: { type: "api_key", key: "ollama-local" } });
    mocks.configuredAgentIds = ["pro"];
    const listed = { provider: "ollama", id: "qwen3:8b", name: "Qwen" };
    worker.mockResolvedValue({
      entries: [listed],
      routeVariants: [listed],
      providerOutcomes: [
        {
          provider: "ollama",
          status: "ready",
          modelIdCatalog: { baseUrl: "http://localhost:11434", modelIds: ["qwen3:8b"] },
          ...(before === "qwen3:8bb" ? { unlistedConfiguredModelIds: [before] } : {}),
        },
      ],
    });
    const config: OpenClawConfig = {
      agents: { entries: { pro: {} }, defaults: { model: `ollama/${before}` } },
    };
    const options = { gatewayLifecycle: true, catalogMode: "static" as const };
    await refreshPreparedModelRuntimeSnapshots(config, options);
    const original = await prepareModelRuntimeSnapshot(fixture.agentInput("pro", config));
    const initial = await original.loadFullModelCatalog!({ refresh: true, wait: true });
    const missing = (catalog: ModelCatalogSnapshot) =>
      catalog.providerOutcomes?.flatMap((outcome) => outcome.unlistedConfiguredModelIds ?? []);
    expect(missing(initial)).toEqual(before === "qwen3:8bb" ? [before] : []);
    worker.mockClear();

    const changed: OpenClawConfig = {
      ...config,
      agents: { ...config.agents, defaults: { model: `ollama/${after}` } },
    };
    await refreshPreparedModelRuntimeSnapshots(changed, options);
    const rebuilt = await prepareModelRuntimeSnapshot(fixture.agentInput("pro", changed));
    const current = rebuilt.readFullModelCatalog!();
    expect(current).toBeDefined();
    expect(missing(current!)).toEqual(after === "qwen3:8bb" ? [after] : []);
    expect(worker).not.toHaveBeenCalled();
  });

  it("retains the current preparation across adopted auth", async () => {
    mocks.configuredAgentIds = ["alpha"];
    const agentDir = fixture.state.agentDir("alpha");
    mocks.configuredWorkspaces.set("alpha", "/tmp/old-workspace");
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const workspaceDir = "/tmp/fresh-workspace";
    mocks.configuredWorkspaces.set("alpha", workspaceDir);
    const config = { plugins: {} };
    await using source = holdCatalogWrite();
    await using auth = holdCatalogWrite();
    const phases: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) =>
      phases.push(phase),
    );
    const publication = source.track(
      refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true }),
    );
    const published = vi.fn();
    void publication.then(published, () => undefined);
    const dispatched = vi.fn();
    try {
      await source.started;
      const dispatch = source.track(loadPublishedGatewayReplyDispatchRuntime({ agentId: "alpha" }));
      void dispatch.then(dispatched, () => undefined);
      // Any later inference is now wrong, including an auth build with no completed snapshot.
      mocks.configuredAgentDirs.set("alpha", "/tmp/later-agent");
      mocks.configuredWorkspaces.set("alpha", "/tmp/later-workspace");
      mocks.mutationListener!({ agentDir, affectsInheritedStores: false });
      source.release();
      await auth.started;
      expect(published).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
      expect(phases).not.toContain("published");
      auth.release();
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
    await using source = holdCatalogWrite();
    const fresh = source.track(publishPreparedModelRuntimeSnapshot(freshInput, { force: true }));
    void fresh.catch(() => undefined);
    await source.started;
    expect(resolvePublishedModelCatalogOwner(alpha)).toMatchObject({ agentId: "alpha" });
    // The beta fact must already exist; neither the old snapshot nor ambient inference can supply it.
    mocks.configuredAgentIds = ["gamma"];
    mocks.configuredAgentDirs.set("gamma", agentDir);
    mocks.mutationListener!({ agentDir, affectsInheritedStores: false });
    const refreshed = source.track(prepareModelRuntimeSnapshot(freshInput));
    void refreshed.catch(() => undefined);
    source.release();
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
  it.each([
    [true, "ambient credentials; agent standalone"],
    [false, "agent catalog sources"],
  ] as const)(
    "fences late work after a publication timeout (admission=%s, stage=%s)",
    async (admission, stage) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(1);
      const input = { config: {}, agentDir: fixture.state.agentDir("timeout") };
      const started = createDeferred();
      const finish = createDeferred();
      const pausedBuild = async () => {
        started.resolve();
        await finish.promise;
        return {};
      };
      if (admission) {
        mocks.resolveAmbientCredentials.mockImplementationOnce(pausedBuild);
      } else {
        mocks.ensureOpenClawModelsJson.mockImplementationOnce(pausedBuild);
      }
      using builds = vi.spyOn(runtimeBuild, "startSerializedSnapshotBuildBatch");
      const first = admission
        ? acquireAgentRunPreparedModelRuntime(input)
        : publishPreparedModelRuntimeSnapshot(input);
      const message = `prepared model runtime publication (${stage}) timed out`;
      const timedOut = expect(first).rejects.toThrow(message);
      let retry: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
      try {
        await started.promise;
        await vi.advanceTimersByTimeAsync(1);
        await timedOut;
        if (admission) {
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
          // Late ambient work must stop before discovery or publication.
          expect(mocks.discoverModels).toHaveBeenCalledOnce();
        } else {
          await expect(prepareModelRuntimeSnapshot(input)).rejects.toThrow(message);
          await expect(publishPreparedModelRuntimeSnapshot(input)).rejects.toThrow(message);
          expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
          finish.resolve();
          // Admission settles before capture: join the build, not discovery.
          await builds.mock.results[0]!.value.completion;
          expect(mocks.discoverModels).toHaveBeenCalledOnce();
          await expect(publishPreparedModelRuntimeSnapshot(input)).resolves.toMatchObject({
            agentDir: input.agentDir,
          });
          expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
        }
      } finally {
        finish.resolve();
        await Promise.allSettled([first, retry?.then((lease) => lease[Symbol.asyncDispose]())]);
        await Promise.all(builds.mock.results.map((result) => result.value.completion));
      }
    },
  );

  it.each(["workspace", "standalone"] as const)(
    "serializes conflicting %s publications for one catalog owner",
    async (kind) => {
      const agentDir = fixture.state.agentDir("serial-publication");
      await using write = holdCatalogWrite();
      const workspace = kind === "workspace";
      const firstInput = {
        config: {},
        agentDir,
        ...(workspace ? { workspaceDir: "/tmp/workspace-old" } : {}),
      };
      const nextInput = {
        config: workspace ? firstInput.config : {},
        agentDir,
        ...(workspace ? { workspaceDir: "/tmp/workspace-new" } : {}),
      };
      const publish = workspace
        ? publishPreparedModelRuntimeSnapshot
        : activateStandalonePreparedModelRuntime;
      const first = write.track(publish(firstInput));
      await write.started;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
      const reader = workspace ? write.track(prepareModelRuntimeSnapshot(firstInput)) : undefined;
      const replacement = write.track(publish(nextInput));
      await Promise.resolve();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
      write.release();
      const [initial, next] = await Promise.all([first, replacement]);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      if (workspace) {
        expect(await reader).toBe(initial);
        expect(next?.workspaceDir).toBe("/tmp/workspace-new");
        expect(await prepareModelRuntimeSnapshot(nextInput)).toBe(next);
      } else {
        expect(initial?.config).toBe(firstInput.config);
        expect(next?.config).toBe(nextInput.config);
        expect(initial).not.toBe(next);
      }
    },
  );
});

describe("legacy provider catalog retention", () => {
  const learned = { provider: "custom", id: "learned", name: "Learned" };
  const starter = { provider: "custom", id: "starter", name: "Starter" };
  const supplemental = { provider: "custom", id: "supplemental", name: "Previous overlay" };

  it.each([
    { name: "nonempty legacy inventory", empty: false, expected: [learned] },
    {
      name: "last-good configured and supplemental overlays",
      empty: false,
      overlay: true,
      expected: [learned, supplemental],
    },
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
  ])("preserves the provider retention boundary for $name", async (scenario) => {
    const entries = scenario.empty ? [] : [learned, ...(scenario.overlay ? [supplemental] : [])];
    const previous = makeCatalog(
      entries,
      scenario.ready
        ? { providerOutcomes: [{ provider: "custom", status: "ready" as const }] }
        : scenario.failed
          ? { providerOutcomes: [{ provider: "custom", status: "unavailable" as const }] }
          : {},
    );
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(previous);
    const owner = await publishStandaloneCatalog();
    const stored = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!;
    expect(stored.catalogInventory?.providers.has("custom")).not.toBe(true);
    await owner.loadFullModelCatalog!({ refresh: true });
    expect(stored.catalogInventory?.providers.has("custom")).toBe(true);
    if (!scenario.ready && !scenario.failed) {
      expect(stored.catalogInventory?.catalog.providerOutcomes ?? []).toEqual([]);
      expect(stored.catalogInventory?.discoveryOrigins).toEqual([]);
    }

    const failed: ModelCatalogSnapshot = {
      entries: scenario.overlay ? [{ ...supplemental, name: "Unaccepted refresh overlay" }] : [],
      routeVariants: [],
      staticEntries: [starter],
      providerOutcomes: [
        { provider: "custom", profileId: scenario.profileId, status: "unavailable" },
      ],
    };
    if (scenario.changedKey) {
      setCatalogApiKey(failed);
    }
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(failed);
    const result = await owner.loadFullModelCatalog!({ refresh: true });
    expect(result.entries.map(({ provider, id, name }) => ({ provider, id, name }))).toEqual(
      scenario.expected,
    );
    expect(result.routeVariants.map(({ provider, id, name }) => ({ provider, id, name }))).toEqual(
      scenario.expected,
    );
    expect(result.providerOutcomes).toEqual(failed.providerOutcomes);
    expect(result.authoritative).toBe(false);
    if (scenario.overlay) {
      const repeated = await owner.loadFullModelCatalog!({ refresh: true });
      expect(repeated.entries).toEqual(result.entries);
    }
  });

  it.each([
    ["failed refresh", ["learned", "other"]],
    ["changed auth", []],
    ["restrictive success", ["other"]],
  ] as const)("publishes accepted membership across %s", async (scenario, expected) => {
    const second = { provider: "custom", id: "other", name: "Other" };
    const previous = makeCatalog([learned, second], {
      providerOutcomes: [
        { provider: "custom", status: "ready", listedModelIds: ["learned", "other"] },
      ],
    });
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(previous);
    const owner = await publishStandaloneCatalog();
    await owner.loadFullModelCatalog!({ refresh: true });
    const next: ModelCatalogSnapshot = {
      entries: scenario === "restrictive success" ? [second] : [],
      routeVariants: scenario === "restrictive success" ? [second] : [],
      providerOutcomes: [
        scenario === "restrictive success"
          ? { provider: "custom", status: "ready", listedModelIds: ["other"] }
          : { provider: "custom", status: "unavailable" },
      ],
    };
    if (scenario === "changed auth") {
      setCatalogApiKey(next);
    }
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(next);
    const result = await owner.loadFullModelCatalog!({ refresh: true });
    expect(result.providerOutcomes?.[0]?.listedModelIds).toEqual(
      expected.length ? expected : undefined,
    );
    expect(result.entries.map(({ id }) => id).toSorted()).toEqual(expected);
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
    const unavailable = makeCatalog([], {
      staticEntries: [starter],
      providerOutcomes: [{ provider: "custom", status: "unavailable" }],
    });
    const ready = makeCatalog([learned], {
      providerOutcomes: [{ provider: "custom", status: "ready" }],
    });
    const worker = mocks.runPreparedModelCatalogWorker;
    const publishFailedOwner = async () => {
      worker.mockResolvedValue(unavailable);
      const owner = await publishStandaloneCatalog();
      const failed = await owner.loadFullModelCatalog!({ refresh: true });
      expect(failed.entries.map(({ id }) => id)).toEqual(["starter"]);
      return { owner, calls: worker.mock.calls.length };
    };

    it("retries with backoff without a read or explicit refresh", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
    });

    it("measures a new failure episode from its own failure", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
    });
  });

  it("refreshes native Claude inventory with the canonical Anthropic scope", async () => {
    const native = { provider: "claude-cli", id: "claude-new", name: "Native" };
    mocks.runPreparedModelCatalogWorker.mockImplementation(async (providers) => {
      const discovered: ModelCatalogSnapshot = {
        entries: providers?.includes("claude-cli") ? [native] : [],
        routeVariants: [],
        providerOutcomes: providers?.includes("claude-cli")
          ? [{ provider: "claude-cli", status: "ready", listedModelIds: [native.id] }]
          : [],
      };
      setPreparedModelFullCatalogAuth(discovered, {
        providerAuthLabels: new Map(),
        authStore: { version: 1, profiles: {} },
        authModes: {},
        credentials: {},
      });
      return discovered;
    });
    mocks.configuredAgentIds = ["pro"];
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    const owner = await publishPreparedModelRuntimeSnapshot(fixture.agentInput("pro", config), {
      catalogMode: "static",
    });
    const catalog = await owner.loadFullModelCatalog!({
      refresh: true,
      providerIds: ["anthropic"],
    });
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({ ...native, provider: "anthropic" }),
    );
    expect(catalog.providerOutcomes).toContainEqual({
      provider: "claude-cli",
      status: "ready",
      listedModelIds: [native.id],
    });
  });

  it("reacquires discovered providers that a config rebuild cannot retain", async () => {
    // Claude CLI shape: only discovery observes the native sign-in, so a rebuild's agent facts
    // cannot prove the same account and the retained inventory drops the provider.
    const plain = { provider: "plain", id: "plain-model", name: "Plain" };
    const nativeCli = { provider: "native-cli", id: "cli-model", name: "CLI" };
    const worker = mocks.runPreparedModelCatalogWorker;
    worker.mockImplementation(async () => {
      const discovered: ModelCatalogSnapshot = {
        entries: [{ ...plain }, { ...nativeCli }],
        routeVariants: [],
        providerOutcomes: [
          { provider: "plain", status: "ready" },
          { provider: "native-cli", status: "ready" },
        ],
      };
      setCatalogApiKey(discovered, "native-cli", "native-sign-in-marker");
      return discovered;
    });
    mocks.configuredAgentIds = ["pro"];
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    const options = { gatewayLifecycle: true, catalogMode: "static" as const };
    await refreshPreparedModelRuntimeSnapshots(config, options);
    const original = await prepareModelRuntimeSnapshot(fixture.agentInput("pro", config));
    const initial = await original.loadFullModelCatalog!({ refresh: true, wait: true });
    expect(initial.entries).toContainEqual(expect.objectContaining(nativeCli));

    const toggled: OpenClawConfig = {
      ...config,
      plugins: { entries: { unrelated: { config: { flag: true } } } },
    };
    worker.mockClear();
    await refreshPreparedModelRuntimeSnapshots(toggled, options);
    const rebuilt = await prepareModelRuntimeSnapshot(fixture.agentInput("pro", toggled));
    expect(rebuilt).not.toBe(original);
    const reacquired = await rebuilt.loadFullModelCatalog!({ changedOnly: true });
    expect(reacquired.entries.map(({ provider, id }) => `${provider}/${id}`)).toEqual(
      expect.arrayContaining(["plain/plain-model", "native-cli/cli-model"]),
    );
    expect(worker).toHaveBeenCalledOnce();
    expect(worker.mock.calls[0]?.[0]).toContain("native-cli");
  });
});

it("preserves the primary publication error when terminal generation cleanup also fails", async () => {
  const primary = new Error("plugin generation retired before publication", {
    cause: { generation: "superseded" },
  });
  const cleanup = new Error("registration cleanup failed");
  let failedOwner: PreparedModelRuntimeOwner | undefined;
  vi.spyOn(pluginLifetime, "publishPreparedPluginGeneration").mockImplementationOnce((owner) => {
    failedOwner = owner;
    throw primary;
  });
  const discardGeneration = pluginLifetime.discardPreparedPluginGeneration;
  vi.spyOn(pluginLifetime, "discardPreparedPluginGeneration").mockImplementationOnce(
    async (generation) => {
      await discardGeneration(generation);
      throw cleanup;
    },
  );
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
  expect(failedOwner?.refreshError).not.toBe(primary);
  expect(failedOwner?.refreshError).toMatchObject({
    message: primary.message,
    stack: primary.stack,
  });
  expect(failedOwner?.refreshError?.cause).toBeUndefined();
  expect(failedOwner?.pending).toBeUndefined();
});

describe("captured startup inventory refresh", () => {
  it.each(["nested cleanup", "identical shutdown text", "wrapped shutdown"] as const)(
    "reports %s failures from the committed catalog refresh",
    async (kind) => {
      const warning = createDeferred<string>();
      const token = "sk-abcdefghijklmnopqrstuv";
      const closedMessage = "prepared model runtime process lifetime closed";
      const failure =
        kind === "identical shutdown text"
          ? new Error(closedMessage)
          : new AggregateError(
              [
                new Error("registry release failed", {
                  cause: new Error(`Authorization: Bearer ${token}`),
                }),
                new Error("donor close failed"),
                ...(kind === "wrapped shutdown" ? [new PreparedModelRuntimeClosedError()] : []),
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
      if (kind === "identical shutdown text") {
        expect(message).toContain(closedMessage);
      } else {
        expect(message).toContain("Prepared plugin resources failed to close");
        expect(message).toContain("registry release failed");
        expect(message).toContain("donor close failed");
        expect(message).toContain("Authorization: Bearer");
        if (kind === "wrapped shutdown") {
          expect(message).toContain(closedMessage);
        }
      }
      expect(message).not.toContain(token);
      expect(mocks.warn).toHaveBeenCalledOnce();
    },
  );

  it("does not refill a successful empty refresh from the captured startup registry", async () => {
    const captured = {
      provider: "custom",
      id: "removed",
      name: "Previously discovered",
      api: "openai-completions" as const,
      baseUrl: "https://custom.example.test/v1",
    };
    mocks.modelRegistry.getAll.mockReturnValue([captured]);
    const config: OpenClawConfig = { models: { mode: "merge" }, agents: { entries: { pro: {} } } };
    mocks.configuredAgentIds = ["pro"];
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(
      makeCatalog([], { providerOutcomes: [{ provider: "custom", status: "ready" }] }),
    );
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    const owner = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "pro",
      agentDir: fixture.state.agentDir("pro"),
    })!;
    expect(owner.modelCatalog.entries).toContainEqual(expect.objectContaining({ id: "removed" }));

    const refreshed = await owner.loadFullModelCatalog!({ refresh: true });

    expect(refreshed.entries).toEqual([]);
    expect(refreshed.routeVariants).toEqual([]);
    expect(refreshed.providerOutcomes).toEqual([{ provider: "custom", status: "ready" }]);
  });
});
