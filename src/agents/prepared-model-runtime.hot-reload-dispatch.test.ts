// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { dispatchLowLevelChannelReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { getPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { readPreparedGatewayModelCatalogOwnerSnapshot } from "../gateway/server-model-catalog.js";
import { createGatewayReloadHandlers } from "../gateway/server-reload-hot.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
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
  resetInboundDedupe();
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
  requestRecoveryRestart?: Parameters<
    typeof createGatewayReloadHandlers
  >[0]["requestRecoveryRestart"],
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
    scheduler: createTestGatewayScheduler(),
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
    ...(requestRecoveryRestart ? { requestRecoveryRestart } : {}),
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
      const effects = prepareConfigEffects({
        pluginIds: new Set(["synthetic"]),
        channels: new Set(),
      });
      events.push("plugin-drain");
      drainageStarted.resolve();
      await finishDrainage.promise;
      effects.retire();
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
    { outcome: "rollback", arrival: "during drainage" },
    { outcome: "commit", arrival: "before drainage" },
    { outcome: "activation failure", arrival: "during drainage" },
    { outcome: "activation failure", arrival: "before drainage" },
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
        outcome === "activation failure"
          ? "plugin synthetic activation failed after commit"
          : "plugin synthetic admitted work did not settle within 60s; the previous plugin generation stays active",
        {
          operationId: "synthetic-reload",
          generation: 1,
          pluginIds: ["synthetic"],
          phase: outcome === "activation failure" ? "activate" : "drain",
          committed: outcome === "activation failure",
        },
      );
      const handler = createPluginReloadHandler(async ({ prepareConfigEffects, commitRuntime }) => {
        const effects = prepareConfigEffects({
          pluginIds: new Set(["synthetic"]),
          channels: new Set(),
        });
        drainageStarted.resolve();
        await finishDrainage.promise;
        if (outcome === "rollback") {
          await effects.rollback();
          throw pluginFailure;
        }
        effects.retire();
        await commitRuntime({ publish: () => setRuntimeConfigSnapshot(committed, committed) });
        if (outcome === "activation failure") {
          throw pluginFailure;
        }
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
      let catalogSettled = false;
      let admission: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
      let request: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
      let catalogRequest:
        | ReturnType<typeof readPreparedGatewayModelCatalogOwnerSnapshot>
        | undefined;
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
        catalogRequest = readPreparedGatewayModelCatalogOwnerSnapshot({ agentId: "default" });
        void catalogRequest.then(
          () => {
            catalogSettled = true;
          },
          () => {
            catalogSettled = true;
          },
        );
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
        expect(catalogSettled).toBe(true);
        await expect(catalogRequest).resolves.toMatchObject({ config: retained });
        finishDrainage.resolve();
        if (outcome !== "commit") {
          await expect(reload).rejects.toBe(pluginFailure);
        } else {
          await expect(reload).resolves.toMatchObject({ status: "applied" });
        }
        // Execution resumes only after rollback or replacement publication settles.
        await expect(request).resolves.toMatchObject({
          config: outcome === "rollback" ? retained : committed,
        });
        const lease = await admission!;
        expect(lease.snapshot.config).toEqual(outcome === "rollback" ? retained : committed);
        expect(lease.snapshot.workspaceDir).toBe(input.workspaceDir);
        expect(lease.snapshot.isCurrent()).toBe(true);
      } finally {
        finishCatalog.resolve();
        finishDrainage.resolve();
        await Promise.allSettled([reload, request, catalogRequest]);
        await Promise.allSettled([admission?.then((lease) => lease[Symbol.asyncDispose]())]);
        handler.stopRestartRetries();
      }
    },
  );
});

it.each([
  "refresh failure",
  "shutdown",
  "replacement",
  "config supersession",
  "replacement during refresh",
] as const)("keeps committed plugin recovery bound to its Gateway across %s", async (event) => {
  const retained = config(true);
  const committed = config(false);
  setRuntimeConfigSnapshot(retained, retained);
  await publish(retained);
  const pluginLifecycle = {
    operationId: "lifecycle-recovery",
    pluginIds: ["synthetic"],
    reason: "reload" as const,
  };
  const pluginFailure = new PluginRuntimeApplicationError("Plugin activation failed", {
    ...pluginLifecycle,
    generation: 7,
    phase: "activate",
    committed: true,
  });
  const refreshFailure = new Error("Configured agent discovery unavailable");
  let configCurrent = true;
  let replacement: ReturnType<typeof createPluginReloadHandler> | undefined;
  const replaceGateway = () => {
    replacement = createPluginReloadHandler(async () => {
      throw new Error("Replacement must not reload plugins");
    });
  };
  const refreshStarted = createDeferred();
  const finishRefresh = createDeferred();
  let refreshEntered = false;
  if (event === "replacement during refresh") {
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      refreshEntered = true;
      refreshStarted.resolve();
      await finishRefresh.promise;
      return { entries: [] };
    });
  }
  const handler = createPluginReloadHandler(async ({ prepareConfigEffects, commitRuntime }) => {
    prepareConfigEffects({
      pluginIds: new Set(pluginLifecycle.pluginIds),
      channels: new Set(),
    }).retire();
    await commitRuntime({ publish: () => setRuntimeConfigSnapshot(committed, committed) });
    if (event === "refresh failure") {
      mocks.configuredAgentIdsError = refreshFailure;
    } else if (event === "shutdown") {
      handler.stopRestartRetries();
    } else if (event === "replacement") {
      replaceGateway();
    } else if (event === "config supersession") {
      configCurrent = false;
    }
    throw pluginFailure;
  });
  const plan = buildGatewayReloadPlan([]);
  plan.changedPaths = ["plugins.entries.synthetic"];
  plan.reloadPlugins = true;
  plan.pluginLifecycle = pluginLifecycle;
  const reload = handler.applyHotReload(plan, committed, {
    sourceConfig: committed,
    publish: async (commit) => await commit(),
    isCurrent: () => configCurrent,
  });
  const result = reload.catch((error: unknown) => error);
  try {
    if (event === "replacement during refresh") {
      await Promise.race([refreshStarted.promise, result]);
      expect(refreshEntered).toBe(true);
      replaceGateway();
      finishRefresh.resolve();
    }
    const error = await result;
    expect(error).toBeInstanceOf(PluginRuntimeApplicationError);
    if (event === "refresh failure") {
      assert(error instanceof PluginRuntimeApplicationError);
      expect(error.details).toEqual(pluginFailure.details);
      expect(error.message).toContain("Retry the plugin reload or restart the Gateway");
      assert(error.cause instanceof AggregateError);
      expect(error.cause.errors).toEqual([pluginFailure, refreshFailure]);
    } else if (event !== "replacement during refresh") {
      expect(error).toBe(pluginFailure);
    }
    if (event === "config supersession") {
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({
        config: committed,
      });
    } else {
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).rejects.toThrow();
    }
  } finally {
    finishRefresh.resolve();
    await result;
    mocks.configuredAgentIdsError = undefined;
    handler.stopRestartRetries();
    replacement?.stopRestartRetries();
  }
});

describe("retained config and committed model publication", () => {
  it.each<{
    name: string;
    retained: OpenClawConfig;
    committed: OpenClawConfig;
    changedPath: string;
    rebuild: boolean;
    addedAgentId?: string;
  }>([
    {
      name: "keeps the catalog ready throughout a channel-only hot reload",
      retained: { channels: { slack: { streaming: { mode: "off" } } } },
      committed: { channels: { slack: { streaming: { mode: "partial" } } } },
      changedPath: "channels.slack.streaming.mode",
      rebuild: false,
    },
    {
      name: "keeps the catalog ready throughout a UI preference commit",
      retained: { ui: { prefs: { sidebarEntries: [] } } },
      committed: { ui: { prefs: { sidebarEntries: ["sessions"] } } },
      changedPath: "ui.prefs.sidebarEntries",
      rebuild: false,
    },
    {
      name: "replaces channel activation facts after disabling a configured channel",
      retained: { channels: { slack: { streaming: { mode: "off" }, enabled: true } } },
      committed: { channels: { slack: { streaming: { mode: "off" }, enabled: false } } },
      changedPath: "channels.slack.enabled",
      rebuild: true,
    },
    {
      name: "replaces configured channel model selection facts",
      retained: { channels: { modelByChannel: { slack: { C1: "custom/before" } } } },
      committed: { channels: { modelByChannel: { slack: { C1: "custom/after" } } } },
      changedPath: "channels.modelByChannel.slack.C1",
      rebuild: true,
    },
    {
      name: "publishes a current catalog for an added agent after roster replacement",
      retained: { agents: { entries: { default: {} } } },
      committed: { agents: { entries: { default: {}, other: {} } } },
      changedPath: "agents.entries",
      rebuild: true,
      addedAgentId: "other",
    },
  ])("$name", async ({ retained, committed, changedPath, rebuild, addedAgentId }) => {
    setRuntimeConfigSnapshot(retained, retained);
    await publish(retained);
    const previous = getPreparedModelRuntimeSnapshot(ownerInput(retained));
    expect(previous?.isCurrent()).toBe(true);
    const preparations = mocks.prepareStaticCatalog.mock.calls.length;
    if (addedAgentId) {
      mocks.configuredAgentIds.push(addedAgentId);
    }
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handler = createPluginReloadHandler(async () => {
      throw new Error("Config-only hot reload must not replace plugins");
    }, requestRecoveryRestart);
    const plan = buildGatewayReloadPlan([]);
    plan.changedPaths = [changedPath];
    plan.hotReasons = [...plan.changedPaths];
    try {
      await expect(
        handler.applyHotReload(plan, committed, {
          sourceConfig: committed,
          isCurrent: () => true,
          publish: async (commit) => {
            await commit();
            const catalog = getPreparedModelRuntimeSnapshot(ownerInput(committed));
            if (rebuild) {
              expect(catalog).toBeUndefined();
            } else {
              expect(catalog?.config).toBe(committed);
              expect(catalog?.isCurrent()).toBe(true);
            }
          },
        }),
      ).resolves.toBe("applied");
      const catalog = await readPreparedGatewayModelCatalogOwnerSnapshot({
        agentId: "default",
        getConfig: () => committed,
      });
      expect(catalog?.config).toBe(committed);
      expect(catalog?.isCurrent()).toBe(true);
      expect(previous?.isCurrent()).toBe(!rebuild);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(
        preparations + (rebuild ? mocks.configuredAgentIds.length : 0),
      );
      if (addedAgentId) {
        const addedCatalog = await readPreparedGatewayModelCatalogOwnerSnapshot({
          agentId: addedAgentId,
          getConfig: () => committed,
        });
        expect(addedCatalog?.agentId).toBe(addedAgentId);
        expect(addedCatalog?.config).toBe(committed);
        expect(addedCatalog?.isCurrent()).toBe(true);
      }
    } finally {
      handler.stopRestartRetries();
    }
  });

  it("reads the atomic replacement catalog while a model config reload is pending", async () => {
    const retained: OpenClawConfig = { agents: { defaults: { model: "custom/before" } } };
    const committed: OpenClawConfig = { agents: { defaults: { model: "custom/after" } } };
    await publish(retained);
    const entered = createDeferred();
    const release = createDeferred();
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { entries: [] };
    });
    const publication = publish(committed);
    const reading = createDeferred();
    let read: ReturnType<typeof readPreparedGatewayModelCatalogOwnerSnapshot> | undefined;
    try {
      await entered.promise;
      read = readPreparedGatewayModelCatalogOwnerSnapshot({
        agentId: "default",
        getConfig: () => {
          reading.resolve();
          return committed;
        },
      });
      await reading.promise;
      release.resolve();
      await publication;
      const catalog = await read;
      expect(catalog?.config).toBe(committed);
      expect(catalog?.isCurrent()).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([publication, read]);
    }
  });

  it("preserves an unrelated aggregate failure when preparation is superseded", async () => {
    const retained = config(true);
    await publish(retained);
    const entered = createDeferred();
    const release = createDeferred();
    const failure = new AggregateError(
      [new Error("fixture cleanup failed")],
      "fixture build cleanup",
    );
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
  });

  it("does not let a retained lease authorize an old config catalog read", async () => {
    const retained = config(true);
    await publish(retained);
    await using lease = await acquirePreparedModelRuntimeSnapshot(ownerInput(retained));
    const discoveries = mocks.runPreparedModelCatalogWorker.mock.calls.length;
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
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(discoveries);
  });
});

it.each(["success", "activation failure"] as const)(
  "delivers low-level channel replies after plugin reload %s with a retained monitor config",
  async (outcome) => {
    const retained = config(true);
    setRuntimeConfigSnapshot(retained, retained);
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
    const committed = config(false);
    const pluginLifecycle = {
      operationId: "reply-reload",
      pluginIds: ["synthetic"],
      reason: "reload" as const,
    };
    const activationFailure = new PluginRuntimeApplicationError("synthetic activation failed", {
      ...pluginLifecycle,
      generation: 1,
      phase: "activate",
      committed: true,
    });
    const handler = createPluginReloadHandler(async ({ prepareConfigEffects, commitRuntime }) => {
      prepareConfigEffects({
        pluginIds: new Set(pluginLifecycle.pluginIds),
        channels: new Set(),
      }).retire();
      await commitRuntime({ publish: () => setRuntimeConfigSnapshot(committed, committed) });
      if (outcome === "activation failure") {
        throw activationFailure;
      }
      return {
        runtime: { ...pluginLifecycle, generation: 1 },
        activeChannels: new Set(),
      };
    });
    const plan = buildGatewayReloadPlan([]);
    plan.changedPaths = ["plugins.entries.synthetic"];
    plan.reloadPlugins = true;
    plan.pluginLifecycle = pluginLifecycle;
    try {
      await dispatch("before-reload");
      const reload = handler.applyHotReload(plan, committed);
      if (outcome === "activation failure") {
        await expect(reload).rejects.toBe(activationFailure);
      } else {
        await expect(reload).resolves.toMatchObject({ status: "applied" });
      }
      await dispatch("after-reload");
      expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual([
        "memory enabled: true",
        "memory enabled: false",
      ]);
    } finally {
      handler.stopRestartRetries();
    }
  },
);
