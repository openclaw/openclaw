// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayReloadHandlerParams } from "../gateway/server-reload-contracts.js";
import {
  createDefaultGatewayReloadState,
  createHotTailPlan,
} from "../gateway/server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "../gateway/server-reload-hot.js";
import { publishConfiguredModelRuntimeSnapshots } from "../gateway/server-startup-model-runtime.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  getProcessPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { retireAgentDeleteRuntime } from "./agent-delete-databases.js";
import { withAgentDeletion } from "./agent-lifecycle-registry.js";
import * as pluginModelCatalog from "./plugin-model-catalog.js";
import * as configuredRefresh from "./prepared-model-runtime.configured-refresh.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  getPreparedModelRuntimeSnapshot as readSnapshot,
  loadPublishedGatewayReplyDispatchRuntime as loadDispatch,
  markPreparedModelRuntimeSnapshotsStale as invalidate,
  prepareModelRuntimeSnapshot as prepare,
  publishPreparedModelRuntimeSnapshot as publish,
  refreshPreparedModelRuntimeSnapshots as refresh,
  retirePreparedModelRuntimeAgent as retireAgent,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots as closeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { getPreparedModelRuntimeStartupStatus as startupStatus } from "./prepared-model-runtime.startup-status.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;

function holdNextCatalogWrite() {
  const started = createDeferred();
  const release = createDeferred();
  mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
    started.resolve();
    await release.promise;
    return { agentDir: String(agentDir), wrote: false };
  });
  return { started, release };
}

function observeSettlement(promise: Promise<void>) {
  let settled = false;
  const finish = () => {
    settled = true;
  };
  return {
    isSettled: () => settled,
    result: promise.then(finish, (error: unknown) => {
      finish();
      return error;
    }),
  };
}

it.for(["success", "preserved admission", "failure before retired cleanup"] as const)(
  "follows an admitted hot reload through catalog pruning: %s",
  async (outcome, { signal }) => {
    const fails = outcome === "failure before retired cleanup";
    mocks.configuredAgentIds = ["default", "deferred"];
    const initial: OpenClawConfig = {
      agents: { entries: { default: {}, deferred: {} } },
      models: {
        providers: { fixture: { baseUrl: "https://provider.example.test/v1", models: [] } },
      },
      messages: { responsePrefix: "initial" },
    };
    const latest: OpenClawConfig = {
      agents: initial.agents,
      messages: { responsePrefix: "latest" },
    };
    setRuntimeConfigSnapshot(initial);
    const started = createDeferred();
    const pruning = createDeferred();
    const releasePruning = createDeferred();
    const retiredCleanup = createDeferred();
    const releaseAcquisition = createDeferred();
    const producerClosed = createDeferred();
    const pruningError = new Error("replacement catalog pruning failed");
    const refreshNow = configuredRefresh.refreshPreparedModelRuntimeSnapshotsNow;
    // Cancellation precedes producer cleanup; observe the real terminal boundary.
    const refreshObservation = vi
      .spyOn(configuredRefresh, "refreshPreparedModelRuntimeSnapshotsNow")
      .mockImplementation(async (...args) => {
        try {
          return await refreshNow(...args);
        } finally {
          if (args[0] === initial) {
            producerClosed.resolve();
          }
        }
      });
    const prune = vi
      .spyOn(pluginModelCatalog, "pruneRemovedProviderPluginModelCatalogs")
      .mockImplementation(async () => {
        pruning.resolve();
        await releasePruning.promise;
        if (fails) {
          throw pruningError;
        }
        return false;
      });
    mocks.prepareStaticCatalog.mockImplementation(async (input) => {
      const options = input as { config: OpenClawConfig; signal: AbortSignal };
      if (options.config.messages?.responsePrefix === "initial") {
        const aborted = createDeferred();
        const onAbort = () => aborted.resolve();
        options.signal.addEventListener("abort", onAbort, { once: true });
        started.resolve();
        try {
          await Promise.race([aborted.promise, releaseAcquisition.promise]);
          if (fails) {
            await retiredCleanup.promise;
          }
          options.signal.throwIfAborted();
        } finally {
          options.signal.removeEventListener("abort", onAbort);
        }
      }
      return { entries: [] };
    });
    let state: ReturnType<GatewayReloadHandlerParams["getState"]> =
      createDefaultGatewayReloadState();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handlers = createGatewayReloadHandlers({
      scheduler: createTestGatewayScheduler(),
      deps: {} as GatewayReloadHandlerParams["deps"],
      broadcast: vi.fn(),
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      getPluginRegistry: () => createEmptyPluginRegistry(),
      startChannel: vi.fn(async () => new Map()),
      stopChannel: vi.fn(async () => {}),
      releaseChannelRouteHandoffs: vi.fn(),
      pruneInactiveChannelAccountState: vi.fn(),
      reloadPlugins: vi.fn(),
      logHooks: log,
      logChannels: log,
      logCron: log,
      logReload: log,
      cronReconciliation: {
        arm: vi.fn(() => ({ complete: vi.fn(async () => {}) })),
        invalidate: vi.fn(),
      },
      requestRecoveryRestart: vi.fn(() => ({ status: "emitted" as const })),
    });
    const startup = publishConfiguredModelRuntimeSnapshots({ cfg: initial });
    const { result: observed, isSettled } = observeSettlement(startup);
    let reload: Promise<unknown> | undefined;
    let reader: ReturnType<typeof loadDispatch> | undefined;
    try {
      await withinTest(started.promise, signal);
      reload = handlers
        .applyHotReload(createHotTailPlan({ changedPaths: ["models.providers.fixture"] }), latest)
        .catch((error: unknown) => error);
      await withinTest(pruning.promise, signal);
      if (!fails) {
        await withinTest(producerClosed.promise, signal);
        await withinTest(nextTurn(), signal);
      }
      if (outcome === "preserved admission") {
        invalidate("replacement still preparing", {
          preserveReplacementWait: true,
        });
      }
      expect(isSettled()).toBe(false);
      releasePruning.resolve();
      if (fails) {
        expect(await withinTest(reload, signal)).toBe("applied-restart-required");
        retiredCleanup.resolve();
      }
      const result = await withinTest(observed, signal);
      if (!fails) {
        expect(result).toBeUndefined();
        for (const agentId of mocks.configuredAgentIds) {
          reader = loadDispatch({ agentId });
          await expect(withinTest(reader, signal)).resolves.toMatchObject({
            agentId,
            config: latest,
          });
        }
        expect(await withinTest(reload, signal)).toBe("applied");
      } else {
        expect(result).toBe(pruningError);
      }
    } finally {
      releasePruning.resolve();
      releaseAcquisition.resolve();
      retiredCleanup.resolve();
      await Promise.allSettled([startup, observed, reload, reader]);
      handlers.stopRestartRetries();
      await closeSnapshots();
      prune.mockRestore();
      refreshObservation.mockRestore();
      clearRuntimeConfigSnapshot();
    }
  },
);

it.for(["success", "failure", "shutdown", "foreground grace"] as const)(
  "follows active startup acquisition through a scoped replacement's %s",
  async (outcome, { signal }) => {
    mocks.configuredAgentIds = ["default", "deferred"];
    const initial = { messages: { responsePrefix: "initial" } };
    const latest = { messages: { responsePrefix: "latest" } };
    const started = createDeferred();
    const successorStarted = createDeferred();
    const release = createDeferred();
    const escape = createDeferred();
    const successorError = new Error("replacement catalog acquisition failed");
    if (outcome === "foreground grace") {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    let cancellation: unknown;
    mocks.prepareStaticCatalog.mockImplementation(async (input) => {
      const options = input as { config: OpenClawConfig; signal: AbortSignal };
      if (options.config.messages?.responsePrefix === "initial") {
        const aborted = createDeferred();
        const onAbort = () => {
          cancellation = options.signal.reason;
          aborted.resolve();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        started.resolve();
        try {
          await Promise.race([aborted.promise, escape.promise]);
          options.signal.throwIfAborted();
        } finally {
          options.signal.removeEventListener("abort", onAbort);
        }
      } else {
        successorStarted.resolve();
        await release.promise;
        options.signal.throwIfAborted();
        if (outcome === "failure") {
          throw successorError;
        }
      }
      return { entries: [] };
    });
    const startup = publishConfiguredModelRuntimeSnapshots({ cfg: initial });
    const { result: observed, isSettled } = observeSettlement(startup);
    let successor: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let reader: ReturnType<typeof loadDispatch> | undefined;
    try {
      await withinTest(started.promise, signal);
      expect(startupStatus()?.pendingAgents.length).toBeGreaterThan(0);
      if (outcome === "foreground grace") {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      successor = refresh(latest, {
        gatewayLifecycle: true,
        catalogMode: "static",
        agentIds: new Set(["deferred"]),
      });
      void successor.catch(() => undefined);
      expect(startupStatus()).toBeUndefined();
      await withinTest(successorStarted.promise, signal);
      expect(cancellation).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
      const settledBeforeSuccessor = isSettled();
      if (outcome === "shutdown") {
        closing = closeSnapshots();
      } else if (outcome === "foreground grace") {
        await vi.advanceTimersByTimeAsync(119_000);
        expect(isSettled()).toBe(true);
        expect(await withinTest(observed, signal)).toBeUndefined();
        expect(startupStatus()).toBeUndefined();
      }
      release.resolve();
      const result = await withinTest(observed, signal);
      if (outcome === "success" || outcome === "foreground grace") {
        expect(result).toBeUndefined();
        for (const agentId of mocks.configuredAgentIds) {
          reader = loadDispatch({ agentId });
          await expect(withinTest(reader, signal)).resolves.toMatchObject({
            agentId,
            config: latest,
          });
        }
      } else if (outcome === "failure") {
        expect(result).toBe(successorError);
      } else {
        expect(result).toMatchObject({ message: expect.stringContaining("closed") });
      }
      expect(startupStatus()).toBeUndefined();
      expect(settledBeforeSuccessor).toBe(false);
    } finally {
      escape.resolve();
      release.resolve();
      closing ??= closeSnapshots();
      await Promise.allSettled([startup, observed, successor, closing, reader]);
      vi.useRealTimers();
    }
  },
);

it("retires only the deleted agent's physical owners", async () => {
  mocks.configuredAgentIds = ["worker"];
  mocks.configuredAgentDirs.set("worker", fixture.state.agentDir("isolated-worker"));
  await refresh({}, { gatewayLifecycle: true });
  const separate = await loadDispatch({ agentId: "worker" });
  const input = { config: {}, agentId: "worker", agentDir: fixture.state.agentDir("worker") };
  const deleted = await publish(input);
  const sharing = await publish({ ...input, agentId: "survivor" });

  const options = { env: fixture.state.env };
  await withAgentDeletion(
    input.agentId,
    async (begin) => {
      const deletion = await begin({
        agentId: input.agentId,
        agentDir: input.agentDir,
        workspaceDir: fixture.state.workspaceDir,
        sessionsDir: fixture.state.sessionsDir(input.agentId),
        deleteFiles: false,
      });
      await deletion.assertCurrentAsync();
      const replaceJournal = openOpenClawStateDatabase(options).db.prepare(
        "UPDATE agent_deletion_journal SET operation_id = ? WHERE agent_id = ?",
      );
      replaceJournal.run("replacement", input.agentId);
      await expect(retireAgentDeleteRuntime(deletion, [input.agentDir])).rejects.toThrow(
        "no longer owns",
      );
      expect(deleted.isCurrent()).toBe(true);
      expect(sharing.isCurrent()).toBe(true);

      replaceJournal.run(deletion.entry.operationId, input.agentId);
      await deletion.rollback();
      await expect(retireAgentDeleteRuntime(deletion, [input.agentDir])).rejects.toThrow(
        "no longer owns",
      );
      expect(deleted.isCurrent()).toBe(true);
      expect(sharing.isCurrent()).toBe(true);
    },
    options,
  );

  await retireAgent({ agentId: input.agentId, agentDirs: [input.agentDir] });

  expect(deleted.isCurrent()).toBe(false);
  expect(sharing.isCurrent()).toBe(true);
  await expect(loadDispatch({ agentId: "worker" })).resolves.toBe(separate);
});

it.each([
  "lost claim",
  "invalidation",
  "preserved invalidation",
  "unpublished replacement invalidated",
  "unpublished replacement close",
  "close",
] as const)("does not accept a joined refresh after %s", async (boundary) => {
  mocks.configuredAgentIds = ["default"];
  const { started, release } = holdNextCatalogWrite();
  const first = refresh({}, { joinSupersedingPublication: true });
  const rejected = expect(first).rejects.toThrow(/superseded|closed/);
  let successor: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  try {
    await started.promise;
    if (boundary === "invalidation" || boundary === "preserved invalidation") {
      invalidate("publication owner retired", {
        preserveReplacementWait: boundary === "preserved invalidation",
      });
    } else if (boundary.startsWith("unpublished replacement")) {
      invalidate("replacement preparing", {
        waitForReplacement: true,
      });
      if (boundary === "unpublished replacement close") {
        closing = closeSnapshots();
      } else {
        invalidate("replacement cancelled");
      }
    } else {
      let claimCurrent = true;
      successor = refresh(
        {},
        {
          isPublicationCurrent: () => claimCurrent,
        },
      );
      if (boundary === "lost claim") {
        claimCurrent = false;
      } else {
        closing = closeSnapshots();
      }
    }
    release.resolve();
    await rejected;
  } finally {
    release.resolve();
    await Promise.allSettled([first, successor, closing]);
  }
});

it("joins the latest of multiple replacements without rebuilding skipped config", async () => {
  mocks.configuredAgentIds = ["default"];
  const { started, release } = holdNextCatalogWrite();
  const first = refresh({}, { joinSupersedingPublication: true });
  let skipped: Promise<void> | undefined;
  let latest: Promise<void> | undefined;
  try {
    await started.promise;
    skipped = refresh({ messages: { responsePrefix: "skipped" } });
    latest = refresh({ messages: { responsePrefix: "latest" } });
    release.resolve();
    await expect(first).resolves.toBeUndefined();
    await Promise.all([skipped, latest]);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    expect(mocks.ensureOpenClawModelsJson.mock.calls.at(-1)?.[0]).toEqual({
      messages: { responsePrefix: "latest" },
    });
  } finally {
    release.resolve();
    await Promise.allSettled([first, skipped, latest]);
  }
});

it("finishes config replacement after a second adopted auth mutation", async () => {
  mocks.configuredAgentIds = ["default"];
  const config = {};
  const nextConfig = { messages: { responsePrefix: "updated" } };
  await refresh(config, { gatewayLifecycle: true });
  const input = fixture.agentInput("default", config);
  const configWrite = holdNextCatalogWrite();
  const authWrite = holdNextCatalogWrite();
  const replacement = refresh(nextConfig, {
    gatewayLifecycle: true,
  });
  const result = expect(replacement).resolves.toBeUndefined();
  void result.catch(() => undefined);
  let reader: ReturnType<typeof prepare> | undefined;
  try {
    await configWrite.started.promise;
    mocks.authStorage.getAll.mockReturnValue({
      custom: { type: "api_key", key: "first-update" },
    });
    mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
    configWrite.release.resolve();
    await authWrite.started.promise;
    reader = prepare(input);
    void reader.catch(() => undefined);
    const credentials = { custom: { type: "api_key" as const, key: "latest-update" } };
    mocks.authStorage.getAll.mockReturnValue(credentials);
    mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
    authWrite.release.resolve();

    await result;
    await expect(reader).resolves.toMatchObject({ config: nextConfig });
    const snapshot = await reader;
    expect(snapshot.isCurrent()).toBe(true);
    expect(snapshot.createStores().authStorage.getAll()).toEqual(credentials);
  } finally {
    configWrite.release.resolve();
    authWrite.release.resolve();
    await Promise.allSettled([reader, replacement]);
  }
});

it("keeps logged-out reply dispatch after the config operation cache retires", async ({
  signal,
}) => {
  mocks.configuredAgentIds = ["default"];
  const config = {};
  const nextConfig = { messages: { responsePrefix: "updated" } };
  const metadata = { ...(await pluginMetadata.resolvePluginMetadataSnapshotAsync({ config })) };
  bindPluginMetadataSnapshotCache(metadata, getProcessPluginCache());
  await refresh(config, {
    gatewayLifecycle: true,
    pluginMetadataSnapshot: metadata,
  });
  const input = fixture.agentInput("default", nextConfig);
  const operationCache = createPluginCache();
  const resolveMetadata = vi
    .spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync")
    .mockImplementation(async () => {
      const snapshot = { ...metadata };
      bindPluginMetadataSnapshotCache(snapshot, getPluginCache());
      return snapshot;
    });
  const { started, release } = holdNextCatalogWrite();
  const resources = new AsyncDisposableStack();
  let replacement: ReturnType<typeof refresh> | undefined;
  let reader: ReturnType<typeof loadDispatch> | undefined;
  let snapshotRead: ReturnType<typeof prepare> | undefined;
  let retirement: ReturnType<typeof retirePluginCache> | undefined;
  try {
    replacement = withPluginCache(operationCache, () =>
      refresh(nextConfig, {
        gatewayLifecycle: true,
        pluginMetadataSnapshot: metadata,
      }),
    );
    void replacement.catch(() => undefined);
    await withinTest(started.promise, signal);
    mocks.authStorage.getAll.mockReturnValue({});
    mocks.mutationListener?.({
      agentDir: input.agentDir,
      affectsInheritedStores: false,
      profileSetChanged: true,
    });
    release.resolve();
    await withinTest(replacement, signal);
    retirement = retirePluginCache(operationCache);
    await withinTest(retirement, signal);

    reader = loadDispatch({
      agentId: "default",
      onRuntimeLease: (lease) => {
        resources.use(lease);
      },
    });
    await expect(withinTest(reader, signal)).resolves.toMatchObject({ config: nextConfig });
    snapshotRead = prepare(input);
    const snapshot = await withinTest(snapshotRead, signal);
    expect(snapshot.isCurrent()).toBe(true);
    expect(snapshot.createStores().authStorage.getAll()).toEqual({});
  } finally {
    release.resolve();
    await resources.disposeAsync();
    const closing = closeSnapshots();
    await Promise.allSettled([replacement, reader, snapshotRead, retirement, closing]);
    resolveMetadata.mockRestore();
    await retirePluginCache(operationCache);
  }
});

it("joins a scoped successor only after both configured agents are current", async () => {
  mocks.configuredAgentIds = ["agent-a", "agent-b"];
  const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
  await refresh(config);
  const read = (agentId: string) =>
    readSnapshot({
      ...fixture.agentInput(agentId, config),
      workspaceDir: `/tmp/workspace-${agentId}`,
    });
  for (const agentId of mocks.configuredAgentIds) {
    expect(read(agentId)?.isCurrent()).toBe(true);
  }
  const { started, release } = holdNextCatalogWrite();
  const { started: successorStarted, release: releaseSuccessor } = holdNextCatalogWrite();
  const first = refresh(config, {
    agentIds: new Set(["agent-a"]),
    joinSupersedingPublication: true,
  });
  const { isSettled } = observeSettlement(first);
  let successor: Promise<void> | undefined;
  try {
    await started.promise;
    successor = refresh(config, {
      agentIds: new Set(["agent-b"]),
    });
    release.resolve();
    await successorStarted.promise;
    expect(isSettled()).toBe(false);
    expect(read("agent-a")).toBeUndefined();
    releaseSuccessor.resolve();
    await first;
    for (const agentId of mocks.configuredAgentIds) {
      expect(read(agentId)?.isCurrent()).toBe(true);
    }
    await successor;
  } finally {
    release.resolve();
    releaseSuccessor.resolve();
    await Promise.allSettled([first, successor]);
  }
});

it("stops a superseded same-directory batch before another catalog write", async () => {
  mocks.configuredAgentIds = ["agent-a", "agent-b"];
  for (const agentId of mocks.configuredAgentIds) {
    mocks.configuredAgentDirs.set(agentId, fixture.state.agentDir("shared-catalog-agent-dir"));
    mocks.configuredWorkspaces.set(agentId, `/tmp/catalog-workspace-${agentId}`);
  }
  const staleConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
  const latestConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
  const releaseStaleWriteGate = createDeferred();
  const staleWriteStarted = createDeferred();
  mocks.ensureOpenClawModelsJson.mockImplementation(async (config) => {
    if (isDeepStrictEqual(config, staleConfig)) {
      staleWriteStarted.resolve();
      await releaseStaleWriteGate.promise;
    }
    return { agentDir: fixture.state.agentDir("shared-catalog-agent-dir"), wrote: false };
  });

  let stale: ReturnType<typeof refresh> | undefined;
  let latest: ReturnType<typeof refresh> | undefined;
  try {
    stale = refresh(staleConfig);
    await staleWriteStarted.promise;
    latest = refresh(latestConfig);
    releaseStaleWriteGate.resolve();

    await expect(stale).rejects.toThrow("superseded");
    await latest;
    expect(
      mocks.ensureOpenClawModelsJson.mock.calls.filter(([config]) =>
        isDeepStrictEqual(config, staleConfig),
      ),
    ).toHaveLength(1);
    expect(
      mocks.ensureOpenClawModelsJson.mock.calls.filter(([config]) =>
        isDeepStrictEqual(config, latestConfig),
      ),
    ).toHaveLength(2);
  } finally {
    releaseStaleWriteGate.resolve();
    await Promise.allSettled([stale, latest]);
  }
});
