// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getPreparedModelRuntimeTestApi, usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import * as legacyAuth from "./legacy-inherited-auth-dir.js";
import { getPreparedModelRuntimePolicyConfigReader } from "./prepared-model-runtime-auth.js";
import { acquirePreparedModelRuntimeLeaseFromOwners } from "./prepared-model-runtime-lease.js";
import * as runtimeBuild from "./prepared-model-runtime.build.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import {
  markPreparedModelRuntimeSnapshotsStale as markStale,
  publishPreparedModelRuntimeSnapshot as publish,
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  acquireAgentRunPreparedModelRuntime as acquireRun,
  activateStandalonePreparedModelRuntime as activate,
  getPreparedModelRuntimeSnapshot as readSnapshot,
  loadPublishedGatewayReplyDispatchRuntime as loadPublishedDispatch,
  prepareModelRuntimeSnapshot as prepare,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots as refresh,
  type PreparedModelRuntimeInput,
} from "./prepared-model-runtime.js";
import { createPreparedModelRuntimeReplacement } from "./prepared-model-runtime.lifecycle.js";
import * as owners from "./prepared-model-runtime.owner.js";
import { PreparedModelRuntimeOwnerRetention } from "./prepared-model-runtime.retention.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const fixture = usePreparedModelRuntimeHarness(
  { label: "prepared-runtime-cancelled-admission" },
  async () => {
    for (const release of pendingBuildReleases) {
      release.resolve();
    }
    await Promise.all(
      buildBatchSpy.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value.completion] : [],
      ),
    );
    buildBatchSpy.mockRestore();
  },
);
const { mocks } = fixture;
const testApi = getPreparedModelRuntimeTestApi();
const configuredInput = () => fixture.agentInput("default", {});

let buildBatchSpy: Mock<typeof runtimeBuild.startSerializedSnapshotBuildBatch>;
let pendingBuildReleases: Array<{ resolve: () => void }>;

function prepareColdBuildGate() {
  const started = createDeferred();
  const release = createDeferred();
  pendingBuildReleases.push(release);
  mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return { entries: [] };
  });
  return { started, release };
}

function cancellableRun(input: PreparedModelRuntimeInput) {
  const controller = new AbortController();
  const pending = acquireRun(input, { abortSignal: controller.signal });
  return {
    pending,
    cancel(reason: string) {
      controller.abort(new Error(reason));
      return expect(pending).rejects.toMatchObject({ name: "AbortError" });
    },
  };
}

function holdModelBuild() {
  const entered = createDeferred();
  const release = createDeferred();
  pendingBuildReleases.push(release);
  mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, _agentDir) => {
    entered.resolve();
    await release.promise;
    return {};
  });
  return { entered, release };
}

function closeProcess() {
  const closing = { done: false, promise: Promise.resolve() };
  closing.promise = drainGlobalSingletonLifecycleState("close").then(() => {
    closing.done = true;
  });
  return closing;
}

function observe<T>(pending: Promise<T>) {
  void pending.catch(() => {});
  return pending;
}

describe("prepared model runtime cancelled admission ownership", () => {
  beforeEach(() => {
    pendingBuildReleases = [];
    buildBatchSpy = vi.spyOn(runtimeBuild, "startSerializedSnapshotBuildBatch");
  });

  it.each([
    ["retains a shared cold owner until its final admission cancels", "cancel"],
    ["retains a shared cold owner until its final admission finishes", "finish"],
    ["does not let an abandoned publication satisfy or delete its same-key replacement", "replace"],
    ["skips workspace preparation for a cancelled queued replacement", "skip"],
  ] as const)("%s", async (_name, outcome) => {
    const input = {
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
      config: {},
      workspaceDir: "/tmp/coalesced-admissions",
    };
    const build = prepareColdBuildGate();
    const first = cancellableRun(input);
    await build.started.promise;
    const shared = outcome === "cancel" || outcome === "finish";
    let replacementBuild: ReturnType<typeof prepareColdBuildGate> | undefined;
    if (!shared) {
      await first.cancel("first request cancelled");
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
      if (outcome === "replace") {
        replacementBuild = prepareColdBuildGate();
      } else {
        await cancellableRun(input).cancel("queued request cancelled");
      }
    }
    const second = cancellableRun(input);
    if (shared) {
      const observed = second.pending.then(
        () => "settled",
        () => "settled",
      );
      await expect(Promise.race([observed, Promise.resolve("pending")])).resolves.toBe("pending");
      await first.cancel("first request cancelled");
    }
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
    if (outcome === "cancel") {
      await second.cancel("second request cancelled");
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
      build.release.resolve();
    } else {
      build.release.resolve();
      if (replacementBuild) {
        await replacementBuild.started.promise;
        expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
        expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
        replacementBuild.release.resolve();
      }
      const lease = await second.pending;
      expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(shared ? 1 : 2);
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
      await lease[Symbol.asyncDispose]();
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
    }
  });

  it("retires model publication before auth snapshots are cleared during restart", async () => {
    mocks.configuredAgentIds = ["default"];
    await refresh({}, { gatewayLifecycle: true });
    const prepared = readSnapshot(configuredInput());
    expect(prepared).toBeDefined();
    await drainGlobalSingletonLifecycleState("restart");
    const builds = mocks.ensureOpenClawModelsJson.mock.calls.length;
    mocks.mutationListener?.({ affectsInheritedStores: true, profileSetChanged: true });
    await nextTurn();
    expect(readSnapshot(configuredInput())).toBeUndefined();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(builds);
    expect(prepared?.isCurrent()).toBe(false);
    await expect(loadPublishedDispatch({ agentId: "default" })).resolves.toBeUndefined();
  });

  it.each(["auth", "config"] as const)(
    "joins the raw %s publication before completing process close",
    async (source) => {
      mocks.configuredAgentIds = ["default"];
      await refresh({}, { gatewayLifecycle: true });
      const { entered, release } = holdModelBuild();
      const published = vi.fn();
      const unregister = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "published") {
          published();
        }
      });
      let refreshWork: Promise<void> | undefined;
      if (source === "auth") {
        mocks.mutationListener?.({ affectsInheritedStores: true });
      } else {
        refreshWork = observe(refresh({}));
      }
      await entered.promise;
      const reader = observe(prepare(configuredInput()));
      const closing = closeProcess();
      try {
        await nextTurn();
        expect(closing.done).toBe(false);
        release.resolve();
        await closing.promise;
        await expect(reader).rejects.toThrow(/closed|superseded/);
        expect(readSnapshot(configuredInput())).toBeUndefined();
        expect(published).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([refreshWork, reader, closing.promise]);
        unregister();
      }
    },
  );

  it("preserves immutable leased data while close drains and allows a fresh standalone activation", async ({
    signal,
  }) => {
    const input = { config: {}, agentDir: fixture.state.agentDir("direct") };
    const options = { retainIdleRunOwner: true, abortSignal: signal };
    const previous = await acquireRun(input, options);
    const closing = closeProcess();
    try {
      await nextTurn(undefined, { signal });
      expect(closing.done).toBe(false);
      expect(previous.snapshot.isCurrent()).toBe(false);
      expect(previous.snapshot.createStores()).toBeDefined();
      await previous[Symbol.asyncDispose]();
      await closing.promise;
      await using next = await acquireRun(input, options);
      expect(next.snapshot).not.toBe(previous.snapshot);
      await previous[Symbol.asyncDispose]();
      expect(readSnapshot(input)).toBe(next.snapshot);
      expect(next.snapshot.isCurrent()).toBe(true);
    } finally {
      await previous[Symbol.asyncDispose]();
      await closing.promise;
    }
  });

  it("does not revive a queued standalone activation after its process lifetime closes", async () => {
    const { entered, release } = holdModelBuild();
    const input = { config: {}, agentDir: fixture.state.agentDir("queued") };
    const first = observe(activate(input));
    await entered.promise;
    const second = observe(activate(input));
    const closing = drainGlobalSingletonLifecycleState("close");
    try {
      release.resolve();
      await closing;
      await expect(first).rejects.toThrow(/closed|superseded/);
      await expect(second).rejects.toThrow(/closed|superseded/);
      expect(readSnapshot(input)).toBeUndefined();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([first, second, closing]);
    }
  });
});

describe("prepared model runtime automatic selections", () => {
  it("acquires nested auto leases without switching to the default agent's runtime policy", async () => {
    fixture.mocks.configuredAgentIds = ["default", "worker"];
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { model: "xai/grok-4.6", systemAgent: { agentId: "default" } },
        entries: {
          default: { models: { "xai/grok-4.6": { agentRuntime: { id: "other-harness" } } } },
          worker: {},
        },
      },
    };
    await refresh(config, { catalogMode: "static", gatewayLifecycle: true });
    const dispatch = await loadPublishedDispatch({ agentId: "worker" });
    expect(dispatch).toBeDefined();
    const input = {
      ...fixture.agentInput("worker", config),
      workspaceDir: dispatch!.workspaceDir,
      runtimePluginSelections: [{ provider: "xai", modelId: "grok-4.6", runtime: "auto" }],
    };
    const options = { pluginGeneration: dispatch!.pluginGeneration };
    await using outer = await acquireRun(input, options);
    const registryInput = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.at(-1)?.[0];
    expect(registryInput).toMatchObject({
      selections: [{ provider: "xai", modelId: "grok-4.6", runtime: "openclaw" }],
    });
    const resolveConfiguredOwner = owners.resolveConfiguredOwner;
    let iterations = 0;
    // Bound the pre-fix microtask livelock; a timer cannot interrupt it.
    using _ = vi.spyOn(owners, "resolveConfiguredOwner").mockImplementation((...args) => {
      if (++iterations > 8) {
        throw new Error("lease admission repeated without completing");
      }
      return resolveConfiguredOwner(...args);
    });
    await using nested = await acquireRun(
      {
        ...input,
        runtimePluginSelections: [{ ...input.runtimePluginSelections[0]!, agentId: "worker" }],
      },
      options,
    );
    expect(nested.snapshot.catalogOwner).toBe(outer.snapshot.catalogOwner);
    expect(getPreparedModelRuntimePolicyConfigReader(nested.snapshot)?.()).toBe(config);
    expect(getPreparedModelRuntimePolicyConfigReader(outer.snapshot)?.()).toBe(config);
    expect(nested.snapshot.isCurrent()).toBe(true);
  });

  it("rejects a settled replacement that never publishes instead of spinning", async () => {
    const replacement = createPreparedModelRuntimeReplacement();
    replacement.resolve();
    let iterations = 0;
    await expect(
      acquirePreparedModelRuntimeLeaseFromOwners(fixture.agentInput("worker", {}), "run", {
        captureLifetime: () => () => {
          if (++iterations > 16) {
            throw new Error("test iteration guard reached");
          }
        },
        owners: new Map(),
        agentBuildCompletions: new Map(),
        retainedDirectRunOwners: new PreparedModelRuntimeOwnerRetention(1),
        retainedGatewayRunOwners: new PreparedModelRuntimeOwnerRetention(8),
        getBuildTimeoutMs: () => 120_000,
        getGatewayLifecycleActive: () => true,
        getPendingReplacement: () => replacement,
        ensureReady: async () => {},
      }),
    ).rejects.toThrow("lease admission made no publication progress");
  });

  it("refuses a refresh continuation whose settled gate never gives way", async () => {
    const replacement = createPreparedModelRuntimeReplacement();
    replacement.resolve();
    let reads = 0;
    await expect(
      acquirePreparedModelRuntimeLeaseFromOwners(
        fixture.agentInput("worker", {}),
        "run",
        {
          captureLifetime: () => () => undefined,
          owners: new Map(),
          agentBuildCompletions: new Map(),
          retainedDirectRunOwners: new PreparedModelRuntimeOwnerRetention(1),
          retainedGatewayRunOwners: new PreparedModelRuntimeOwnerRetention(8),
          getBuildTimeoutMs: () => 120_000,
          getGatewayLifecycleActive: () => false,
          getPendingReplacement: () => {
            if (++reads > 16) {
              throw new Error("test iteration guard reached");
            }
            return replacement;
          },
          ensureReady: async () => {},
        },
        { waitForReplacementPublication: true },
      ),
    ).rejects.toThrow("lease admission made no publication progress");
    expect(reads).toBe(2);
  });

  it.each([
    { waitForReplacementPublication: false, gatesWaited: 3 },
    { waitForReplacementPublication: true, gatesWaited: 4 },
  ])(
    "waits through back-to-back reloads only for a refresh continuation: $waitForReplacementPublication",
    async ({ waitForReplacementPublication, gatesWaited }) => {
      const gates = Array.from({ length: 4 }, () => {
        const replacement = createPreparedModelRuntimeReplacement();
        replacement.resolve();
        return replacement;
      });
      let reads = 0;
      const outcome = await acquirePreparedModelRuntimeLeaseFromOwners(
        fixture.agentInput("worker", {}),
        "run",
        {
          captureLifetime: () => () => undefined,
          owners: new Map(),
          agentBuildCompletions: new Map(),
          retainedDirectRunOwners: new PreparedModelRuntimeOwnerRetention(1),
          retainedGatewayRunOwners: new PreparedModelRuntimeOwnerRetention(8),
          getBuildTimeoutMs: () => 120_000,
          getGatewayLifecycleActive: () => false,
          getPendingReplacement: () => gates[reads++],
          ensureReady: async () => {},
        },
        { waitForReplacementPublication },
      ).then(
        async (lease) => {
          await lease[Symbol.asyncDispose]();
          return undefined;
        },
        (error: unknown) => error,
      );

      expect(reads).toBe(gatesWaited + 1);
      const gateRefused = String(outcome).includes("made no publication progress");
      expect(gateRefused).toBe(!waitForReplacementPublication);
    },
  );
});

describe("auth admission publication boundaries", () => {
  const refreshBatch = (config: OpenClawConfig = {}, startup = false) =>
    refresh(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      ...(startup ? { startup } : {}),
    });
  it("does not start plugin callbacks after cancellation at an event-loop boundary", async () => {
    let cancelled = false;
    let lateLoads = 0;
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      if (cancelled) {
        lateLoads += 1;
      }
      return createEmptyPluginRegistry();
    });
    const publication = publish({
      config: {},
      agentDir: fixture.state.agentDir("cancelled"),
      workspaceDir: fixture.state.workspaceDir,
    });
    cancelled = true;
    markStale("cancel before workspace preparation");
    await expect(publication).rejects.toBeInstanceOf(
      PreparedModelRuntimePublicationSupersededError,
    );
    expect(lateLoads).toBe(0);
  });
  it("replays an auth change once the first owner starts capturing credentials", async () => {
    mocks.configuredAgentIds = ["first"];
    const config = {};
    const previous = AuthStorage.inMemory({ custom: { type: "api_key", key: "old-test-key" } });
    const credentials = { custom: { type: "api_key" as const, key: "updated-test-key" } };
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      mocks.authStorage.getAll.mockReturnValue(credentials);
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return previous;
    });

    await refreshBatch(config);
    const snapshot = getPreparedModelRuntimeSnapshot({
      ...fixture.agentInput("first", config),
      workspaceDir: "/tmp/workspace-first",
    });
    expect(snapshot?.createStores().authStorage.getAll()).toEqual(credentials);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(2);
  });
  it("rebinds inherited auth when shared-store ownership moves before first capture", async () => {
    mocks.configuredAgentIds = ["first"];
    const config = {};
    using inherited = vi.spyOn(legacyAuth, "resolveLegacyInheritedAuthDir");
    inherited.mockReturnValue(fixture.state.agentDir("default"));
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      inherited.mockReturnValue(undefined);
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return { entries: [] };
    });

    await refreshBatch(config);
    const snapshot = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "first",
      agentDir: fixture.state.agentDir("first"),
      workspaceDir: "/tmp/workspace-first",
    });
    expect(snapshot).toBeDefined();
    expect(snapshot?.inheritedAuthDir).toBeUndefined();
    expect(mocks.discoverAuthStorage.mock.calls.at(-1)?.[1]).not.toHaveProperty("inheritedAuthDir");
  });
});

describe("borrowed preparation cancellation", () => {
  function catalogGate(onRelease?: () => void) {
    const started = createDeferred();
    const finish = createDeferred();
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      onRelease?.();
      return { entries: [] };
    });
    return { started: started.promise, finish: () => finish.resolve() };
  }

  const prepareGroup = (
    input: Parameters<typeof prepareWorkspaceBuildGroup>[0][number],
    previous?: Parameters<typeof prepareWorkspaceBuildGroup>[4],
    preparedMetadata?: Parameters<typeof prepareWorkspaceBuildGroup>[5],
    resolveRegistry?: Parameters<typeof prepareWorkspaceBuildGroup>[3],
  ) =>
    prepareWorkspaceBuildGroup([input], "static", {}, resolveRegistry, previous, preparedMetadata);

  function publication(phase: "published" | "failed") {
    const ready = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === phase) {
        ready.resolve();
      }
    });
    return () => ready.promise.finally(unregister);
  }
  const metadata = (config: OpenClawConfig, plugins: Parameters<typeof makeRegistry>[0] = []) =>
    createPluginMetadataSnapshot({ config, manifestRegistry: makeRegistry(plugins) });

  const publishGateway = (
    config: OpenClawConfig = {},
    options: Parameters<typeof refresh>[1] = {},
  ) =>
    refresh(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      ...options,
    });
  it("holds inspected input through accepted preparation and refuses a retired result", async () => {
    const database = new DatabaseSync(fixture.state.path("prepared-registration.sqlite"));
    database.exec(
      "CREATE TABLE observations (value INTEGER); INSERT INTO observations VALUES (42)",
    );
    const registry = createEmptyPluginRegistry();
    const resources = new PluginRegistryInspectionResources(async () => {});
    resources.attach(registry);
    const dispose = vi.fn(() => database.close());
    resources.runRegistration("prepared-native", () => {
      resources.register("prepared-native", {
        id: "sqlite",
        dispose,
      });
    });
    let observedValue: unknown;
    const gate = catalogGate(() => {
      observedValue = database.prepare("SELECT value FROM observations").get()?.value;
    });
    const config = {};
    const preparation = prepareGroup(
      {
        config,
        agentDir: fixture.state.agentDir("default"),
        workspaceDir: fixture.state.workspaceDir,
        env: fixture.state.env,
        skipCredentials: true,
      },
      undefined,
      metadata(config),
      () => registry,
    );
    const outcome = preparation.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        gate.started,
        preparation,
        "Preparation completed before its static catalog dependency",
      );
      await resources.release();
      expect(database.isOpen).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
      gate.finish();
      expect(await outcome).toEqual(new Error("Plugin inspection resources have been released"));
      expect(observedValue).toBe(42);
      expect(database.isOpen).toBe(false);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      gate.finish();
      await Promise.allSettled([outcome, resources.release()]);
      if (database.isOpen) {
        database.close();
      }
    }
  });
  it("recovers a rejected auth refresh projection without affecting siblings", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    await publishGateway();
    const defaultRuntime = await loadPublishedDispatch({ agentId: "default" });
    const refreshFailed = publication("failed");
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw new Error("auth refresh rejected");
    });

    mocks.mutationListener?.({
      agentDir: fixture.state.agentDir("worker"),
      affectsInheritedStores: false,
    });
    await refreshFailed();

    await expect(loadPublishedDispatch({ agentId: "worker" })).resolves.toMatchObject({
      agentId: "worker",
    });
    const retained = await loadPublishedDispatch({ agentId: "default" });
    expect(retained?.pluginGeneration).toBe(defaultRuntime?.pluginGeneration);
  });
  it("aborts run admission without retaining an owner after auth publication", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const input = {
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
      config,
      workspaceDir: "/tmp/dynamic-workspace",
    };
    await refresh(config, { gatewayLifecycle: true });
    const admissionTestApi = getPreparedModelRuntimeTestApi();
    expect(admissionTestApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
    const finishAuthRefreshGate = createDeferred();
    let finishAuthRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, _agentDir) => {
      finishAuthRefresh = () => finishAuthRefreshGate.resolve();
      await finishAuthRefreshGate.promise;
      return {};
    });

    let admission: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
    try {
      mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
      await vi.waitFor(() => expect(finishAuthRefresh).toBeDefined());
      const abort = new AbortController();
      admission = acquireAgentRunPreparedModelRuntime(input, { abortSignal: abort.signal });
      const observed = admission.then(
        () => "resolved",
        () => "rejected",
      );
      await expect(Promise.race([observed, Promise.resolve("pending")])).resolves.toBe("pending");
      abort.abort(new Error("request cancelled"));
      await expect(admission).rejects.toMatchObject({ name: "AbortError" });
      expect(admissionTestApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

      finishAuthRefreshGate.resolve();
      await loadPublishedDispatch({ agentId: "default" });
      expect(admissionTestApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
      await using lease = await acquireAgentRunPreparedModelRuntime(input);
      expect(lease.snapshot).toMatchObject({
        agentId: "default",
        agentDir: input.agentDir,
        workspaceDir: "/tmp/unused-workspace",
      });
      expect(admissionTestApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
    } finally {
      finishAuthRefreshGate.resolve();
      await Promise.allSettled([
        admission?.then((lease) => lease[Symbol.asyncDispose]()),
        loadPublishedDispatch({ agentId: "default" }),
      ]);
    }
  });
});
