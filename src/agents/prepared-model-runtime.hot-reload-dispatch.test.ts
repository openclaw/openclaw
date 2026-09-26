// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { dispatchLowLevelChannelReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { getPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { createGatewayReloadHandlers } from "../gateway/server-reload-hot.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePreparedModelRuntimeSnapshot,
  advancePreparedModelRuntimeConfig,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";
import { getPreparedModelRuntimeStartupStatus } from "./prepared-model-runtime.startup-status.js";

const fixture = usePreparedModelRuntimeHarness(
  { label: "hot-reload-dispatch" },
  clearRuntimeConfigSnapshot,
);
const { mocks } = fixture;

beforeEach(() => {
  mocks.configuredAgentIds = ["default"];
});

function config(enabled: boolean): OpenClawConfig {
  return { hooks: { internal: { entries: { "session-memory": { enabled } } } } };
}

function ownerInput(cfg: OpenClawConfig) {
  return { config: cfg, agentId: "default", agentDir: fixture.state.agentDir("default") };
}

async function publish(cfg: OpenClawConfig) {
  await refreshPreparedModelRuntimeSnapshots(cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
}

function createPluginReloadHandler(
  reloadPlugins: Parameters<typeof createGatewayReloadHandlers>[0]["reloadPlugins"],
) {
  type ReloadParams = Parameters<typeof createGatewayReloadHandlers>[0];
  let reloadState: ReturnType<ReloadParams["getState"]> = {
    hooksConfig: null,
    hookClientIpConfig: {},
    heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
    cronState: {
      cron: { start: vi.fn(), stop: vi.fn() } as never,
      storePath: fixture.state.path("cron.sqlite"),
      cronEnabled: false,
      reconcileExitWatchers: vi.fn(async () => {}),
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
      reconcileSystemJobs: vi.fn(async () => "converged" as const),
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return createGatewayReloadHandlers({
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => reloadState,
    setState: (next) => {
      reloadState = next;
    },
    getPluginRegistry: createEmptyPluginRegistry,
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    releaseChannelRouteHandoffs: vi.fn(),
    pruneInactiveChannelAccountState: vi.fn(),
    reloadPlugins,
    logHooks: logger,
    logChannels: logger,
    logCron: logger,
    logReload: logger,
    cronReconciliation: {
      arm: () => ({ complete: async () => {} }),
      invalidate: vi.fn(),
    },
  });
}

describe("Gateway plugin reload run admission", () => {
  it("cancels degraded startup acquisition before plugin drain and publishes only its replacement", async () => {
    mocks.configuredAgentIds = ["default", "held"];
    const heldWorkspace = fixture.state.path("held-workspace");
    mocks.configuredWorkspaces.set("held", heldWorkspace);
    const modelConfig = (id: string): OpenClawConfig => ({
      agents: { defaults: { model: `custom/${id}` } },
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://provider.invalid/v1",
            models: [
              {
                id,
                name: id,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    });
    const retained = modelConfig("before-reload");
    const committed = modelConfig("after-reload");
    setRuntimeConfigSnapshot(retained, retained);
    const acquisitionStarted = createDeferred();
    const cancelled = createDeferred();
    const finishCleanup = createDeferred();
    const escape = createDeferred();
    const drainageStarted = createDeferred();
    const finishDrainage = createDeferred();
    const pluginCommitted = createDeferred();
    const events: string[] = [];
    let oldSignal: AbortSignal | undefined;
    let oldSettled = false;
    mocks.prepareStaticCatalog.mockImplementation(async (rawOptions) => {
      const options = rawOptions as {
        config: OpenClawConfig;
        workspaceDir?: string;
        signal?: AbortSignal;
      };
      if (options.config.agents?.defaults?.model === "custom/after-reload") {
        events.push("replacement-acquisition");
      } else if (options.workspaceDir === heldWorkspace) {
        events.push("old-acquisition");
        oldSignal = options.signal;
        const onAbort = () => {
          events.push("old-cancelled");
          cancelled.resolve();
        };
        oldSignal?.addEventListener("abort", onAbort, { once: true });
        acquisitionStarted.resolve();
        try {
          await Promise.race([cancelled.promise, escape.promise]);
          await Promise.race([finishCleanup.promise, escape.promise]);
        } finally {
          oldSignal?.removeEventListener("abort", onAbort);
          oldSettled = true;
          events.push("old-cleanup-finished");
        }
      }
      // A cancelled callback may still return; publication must reject its old facts.
      return { entries: [] };
    });
    const publications: Array<{ config: OpenClawConfig; models: string[] }> = [];
    const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) => {
      if (phase !== "published") {
        return;
      }
      const snapshot = getPreparedModelRuntimeSnapshot({
        config: committed,
        agentId: "held",
        agentDir: fixture.state.agentDir("held"),
      });
      if (snapshot) {
        publications.push({
          config: snapshot.config,
          models: snapshot.modelCatalog.entries.map(({ id }) => id),
        });
      }
    });
    const handler = createPluginReloadHandler(async ({ prepareConfigEffects, commitRuntime }) => {
      prepareConfigEffects({ pluginIds: new Set(["synthetic"]), channels: new Set() });
      events.push("plugin-drain");
      drainageStarted.resolve();
      await finishDrainage.promise;
      await commitRuntime({ publish: () => setRuntimeConfigSnapshot(committed, committed) });
      pluginCommitted.resolve();
      return {
        runtime: { operationId: "degraded-reload", generation: 1, pluginIds: ["synthetic"] },
        activeChannels: new Set(),
      };
    });
    const plan = buildGatewayReloadPlan([]);
    plan.changedPaths = ["plugins.entries.synthetic"];
    plan.reloadPlugins = true;
    plan.pluginLifecycle = {
      operationId: "degraded-reload",
      pluginIds: ["synthetic"],
      reason: "reload",
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(120_000);
    const startup = refreshPreparedModelRuntimeSnapshots(retained, {
      gatewayLifecycle: true,
      startup: true,
      catalogMode: "static",
    });
    void startup.catch(() => {});
    let reload: ReturnType<typeof handler.applyHotReload> | undefined;
    try {
      await acquisitionStarted.promise;
      await vi.advanceTimersByTimeAsync(120_000);
      await startup;
      expect(getPreparedModelRuntimeStartupStatus()).toMatchObject({
        degraded: true,
        pendingAgents: ["held"],
      });
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({ config: retained });
      reload = handler.applyHotReload(plan, committed);
      void reload.catch(() => {});
      await Promise.race([drainageStarted.promise, reload]);
      expect(oldSignal?.aborted).toBe(true);
      expect(events.indexOf("old-cancelled")).toBeLessThan(events.indexOf("plugin-drain"));
      finishDrainage.resolve();
      await Promise.race([pluginCommitted.promise, reload]);
      await nextTurn();
      expect(oldSettled).toBe(false);
      expect(events).not.toContain("replacement-acquisition");
      expect(publications).toEqual([]);
      finishCleanup.resolve();
      await expect(reload).resolves.toMatchObject({ status: "applied" });
      expect(events.indexOf("old-cleanup-finished")).toBeLessThan(
        events.indexOf("replacement-acquisition"),
      );
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "held" }),
      ).resolves.toMatchObject({
        config: committed,
        modelCatalog: { entries: [expect.objectContaining({ id: "after-reload" })] },
      });
      expect(publications).toEqual([{ config: committed, models: ["after-reload"] }]);
      expect(getPreparedModelRuntimeStartupStatus()?.degraded).not.toBe(true);
    } finally {
      escape.resolve();
      finishCleanup.resolve();
      finishDrainage.resolve();
      await Promise.allSettled([startup, reload]);
      await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
      unregister();
      handler.stopRestartRetries();
      vi.useRealTimers();
    }
  });

  it.each([
    { outcome: "commit", arrival: "during drainage" },
    { outcome: "rollback", arrival: "during drainage" },
    { outcome: "commit", arrival: "before drainage" },
    { outcome: "rollback", arrival: "before drainage" },
  ] as const)(
    "preserves a run admitted $arrival and waiting requests through plugin $outcome",
    async ({ outcome, arrival }) => {
      const retained = config(true);
      const committed = config(false);
      setRuntimeConfigSnapshot(retained, retained);
      await publish(retained);
      const catalogStarted = createDeferred();
      const finishCatalog = createDeferred();
      const drainageStarted = createDeferred();
      const finishDrainage = createDeferred();
      const pluginFailure = new PluginRuntimeApplicationError(
        "plugin synthetic admitted work did not settle within 60s; the previous plugin generation stays active",
        {
          operationId: "synthetic-reload",
          generation: 1,
          pluginIds: ["synthetic"],
          phase: "drain",
          committed: false,
        },
      );
      const handler = createPluginReloadHandler(async ({ prepareConfigEffects, commitRuntime }) => {
        const restorePreparedRuntime = prepareConfigEffects({
          pluginIds: new Set(["synthetic"]),
          channels: new Set(),
        });
        drainageStarted.resolve();
        await finishDrainage.promise;
        if (outcome === "rollback") {
          await restorePreparedRuntime();
          throw pluginFailure;
        }
        await commitRuntime({ publish: () => setRuntimeConfigSnapshot(committed, committed) });
        return {
          runtime: { operationId: "synthetic-reload", generation: 1, pluginIds: ["synthetic"] },
          activeChannels: new Set(),
        };
      });
      const plan = buildGatewayReloadPlan([]);
      plan.changedPaths = ["plugins.entries.synthetic"];
      plan.reloadPlugins = true;
      plan.pluginLifecycle = {
        operationId: "synthetic-reload",
        pluginIds: ["synthetic"],
        reason: "reload",
      };
      const input = { ...ownerInput(retained), workspaceDir: fixture.state.path("run-workspace") };
      let settled = false;
      let requestSettled = false;
      let admission: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
      let request: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
      let reload: ReturnType<typeof handler.applyHotReload> | undefined;
      const admit = () => {
        admission = acquireAgentRunPreparedModelRuntime(input);
        void admission.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        return admission;
      };
      try {
        if (arrival === "before drainage") {
          mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
            catalogStarted.resolve();
            await finishCatalog.promise;
            throw new PluginInstanceUnavailableError("synthetic");
          });
          const preparing = admit();
          await Promise.race([
            catalogStarted.promise,
            preparing.then(() => {
              throw new Error("Run admission bypassed held catalog preparation");
            }),
          ]);
        }
        reload = handler.applyHotReload(plan, committed);
        void reload.catch(() => {});
        await Promise.race([
          drainageStarted.promise,
          reload.then(() => {
            throw new Error("Plugin reload finished before entering drainage");
          }),
        ]);
        request = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
        void request.then(
          () => {
            requestSettled = true;
          },
          () => {
            requestSettled = true;
          },
        );
        if (arrival === "during drainage") {
          void admit();
        } else {
          finishCatalog.resolve();
        }
        await nextTurn();
        expect(settled).toBe(false);
        expect(requestSettled).toBe(false);
        finishDrainage.resolve();
        if (outcome === "rollback") {
          await expect(reload).rejects.toBe(pluginFailure);
        } else {
          await expect(reload).resolves.toMatchObject({ status: "applied" });
        }
        // The hot-reload catch rejects its original drain gate after rollback
        // republishes. Requests waiting on that gate must follow the new owner.
        await expect(request).resolves.toMatchObject({
          config: outcome === "commit" ? committed : retained,
        });
        const lease = await admission!;
        expect(lease.snapshot.config).toEqual(outcome === "commit" ? committed : retained);
        expect(lease.snapshot.workspaceDir).toBe(input.workspaceDir);
        expect(lease.snapshot.isCurrent()).toBe(true);
      } finally {
        finishCatalog.resolve();
        finishDrainage.resolve();
        await Promise.allSettled([reload, request]);
        await Promise.allSettled([admission?.then((lease) => lease[Symbol.asyncDispose]())]);
        handler.stopRestartRetries();
      }
    },
  );
});

describe("retained config and committed model publication", () => {
  it.each(["build", "cleanup"] as const)(
    "preserves an unrelated %s failure when preparation is superseded",
    async (failureKind) => {
      const retained = config(true);
      await publish(retained);
      const entered = createDeferred();
      const release = createDeferred();
      const failure =
        failureKind === "build"
          ? new Error("fixture catalog failed")
          : new AggregateError([new Error("fixture cleanup failed")], "fixture build cleanup");
      mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      });
      const admission = acquireAgentRunPreparedModelRuntime({
        ...ownerInput(retained),
        workspaceDir: fixture.state.path("failed-run-workspace"),
      });
      const result = admission.catch((error: unknown) => error);
      try {
        await Promise.race([entered.promise, result]);
        markPreparedModelRuntimeSnapshotsStale(undefined, { waitForReplacement: true });
        release.resolve();
        // Finish replacement so a mistaken retry would return a lease, not hang this assertion.
        await publish(retained);
        expect(await result).toBe(failure);
      } finally {
        release.resolve();
        await Promise.allSettled([admission.then((lease) => lease[Symbol.asyncDispose]())]);
      }
    },
  );

  it.each(["advance", "hot reload"])(
    "%s preserves exact catalog isolation while dispatch selects the committed config",
    async (publication) => {
      const retained = config(true);
      const committed = config(false);
      await publish(retained);
      await expect(
        loadPreparedModelCatalogOwnerSnapshot(ownerInput(retained)),
      ).resolves.toMatchObject({
        config: retained,
      });
      if (publication === "advance") {
        advancePreparedModelRuntimeConfig(committed);
      } else {
        await refreshModelRuntimeAfterHotReload({
          config: committed,
          agentIds: undefined,
          pluginMetadataSnapshot: undefined,
        });
      }
      await expect(
        loadPreparedModelCatalogOwnerSnapshot(ownerInput(retained)),
      ).rejects.toBeInstanceOf(PreparedModelCatalogConfigReplacedError);
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({
        config: committed,
      });
      await expect(
        loadPreparedModelCatalogOwnerSnapshot(ownerInput(committed)),
      ).resolves.toMatchObject({
        config: committed,
      });
    },
  );

  it("advances model-neutral config without another catalog discovery", async () => {
    await publish(config(true));
    const discoveries = mocks.runPreparedModelCatalogWorker.mock.calls.length;
    const committed = config(false);
    advancePreparedModelRuntimeConfig(committed);
    const runtime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    expect(runtime?.config).toEqual(committed);
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(discoveries);
  });

  it("does not let a retained lease authorize an old config catalog read", async () => {
    const retained = config(true);
    await publish(retained);
    await using lease = await acquirePreparedModelRuntimeSnapshot(ownerInput(retained));
    advancePreparedModelRuntimeConfig(config(false));
    await withPreparedModelRuntimePluginGenerationScope(
      lease.pluginGeneration,
      async () => {
        await expect(
          loadPreparedModelCatalogOwnerSnapshot(ownerInput(retained)),
        ).rejects.toBeInstanceOf(PreparedModelCatalogConfigReplacedError);
      },
      () => lease.snapshot,
    );
  });
});

it("delivers low-level channel replies after hot reload with a retained monitor config", async () => {
  const retained = config(true);
  await publish(retained);
  const deliver = vi.fn(async (_payload: ReplyPayload) => undefined);
  const dispatch = async (messageId: string) => {
    const dispatcher = createReplyDispatcher({ deliver });
    const result = await dispatchLowLevelChannelReplyFromConfig({
      cfg: retained,
      ctx: finalizeInboundContext({
        Body: "hello",
        From: "synthetic-user",
        To: "synthetic-bot",
        AgentId: "default",
        SessionKey: "agent:default:main",
        MessageSid: messageId,
        Provider: "synthetic-channel",
        Surface: "synthetic-channel",
        ChatType: "direct",
        InboundAccessAuthorized: true,
      }),
      dispatcher,
      replyResolver: async (_ctx, _opts, configOverride) => {
        const runtime = getPreparedReplyDispatchRuntime();
        const owner = await loadPreparedModelCatalogOwnerSnapshot(
          ownerInput(runtime?.config ?? configOverride ?? retained),
        );
        return {
          text: `memory enabled: ${owner.config.hooks?.internal?.entries?.["session-memory"]?.enabled}`,
        };
      },
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(result.queuedFinal).toBe(true);
  };
  await dispatch("before-reload");
  await refreshModelRuntimeAfterHotReload({
    config: config(false),
    agentIds: undefined,
    pluginMetadataSnapshot: undefined,
  });
  await dispatch("after-reload");
  expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual([
    "memory enabled: true",
    "memory enabled: false",
  ]);
});
