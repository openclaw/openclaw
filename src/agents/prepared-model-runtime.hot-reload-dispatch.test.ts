// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePreparedModelRuntimeSnapshot,
  advancePreparedModelRuntimeConfig,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "hot-reload-dispatch" });
  await resetPreparedModelRuntimeHarness(state);
  mocks.configuredAgentIds = ["default"];
});

afterEach(async ({ task }) => {
  clearRuntimeConfigSnapshot();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

function config(enabled: boolean): OpenClawConfig {
  return { hooks: { internal: { entries: { "session-memory": { enabled } } } } };
}

function ownerInput(cfg: OpenClawConfig) {
  return { config: cfg, agentId: "default", agentDir: state.agentDir("default") };
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
      storePath: state.path("cron.sqlite"),
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
  it.each([
    { outcome: "commit", arrival: "during drainage" },
    { outcome: "rollback", arrival: "during drainage" },
    { outcome: "commit", arrival: "before drainage" },
    { outcome: "rollback", arrival: "before drainage" },
  ] as const)(
    "preserves a run admitted $arrival through plugin $outcome",
    async ({ outcome, arrival }) => {
      const retained = config(true);
      const committed = config(false);
      setRuntimeConfigSnapshot(retained, retained);
      await publish(retained);
      const catalogStarted = createDeferred();
      const finishCatalog = createDeferred();
      const drainageStarted = createDeferred();
      const finishDrainage = createDeferred();
      const pluginFailure = new Error("replacement plugin activation failed");
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
      const input = { ...ownerInput(retained), workspaceDir: state.path("run-workspace") };
      let settled = false;
      let admission: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
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
        if (arrival === "during drainage") {
          void admit();
        } else {
          finishCatalog.resolve();
        }
        await nextTurn();
        expect(settled).toBe(false);
        finishDrainage.resolve();
        if (outcome === "rollback") {
          await expect(reload).rejects.toBe(pluginFailure);
        } else {
          await expect(reload).resolves.toMatchObject({ status: "applied" });
        }
        const lease = await admission!;
        expect(lease.snapshot.config).toEqual(outcome === "commit" ? committed : retained);
        expect(lease.snapshot.workspaceDir).toBe(input.workspaceDir);
        expect(lease.snapshot.isCurrent()).toBe(true);
      } finally {
        finishCatalog.resolve();
        finishDrainage.resolve();
        await Promise.allSettled([reload]);
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
        workspaceDir: state.path("failed-run-workspace"),
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
