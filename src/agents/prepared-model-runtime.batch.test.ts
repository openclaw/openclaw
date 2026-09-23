// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as inlineProviderModels from "./embedded-agent-runner/model.inline-provider.js";
import * as legacyAuth from "./legacy-inherited-auth-dir.js";
import * as configuredModels from "./model-selection-shared.js";
import {
  advancePreparedModelRuntimeConfig,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";
import { getPreparedModelRuntimeStartupStatus } from "./prepared-model-runtime.startup-status.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-fleet-batch" });
const { mocks } = fixture;

describe("prepared fleet batches", () => {
  beforeEach(() => {
    mocks.configuredAgentIds = ["first", "middle", "last"];
  });

  it.each([
    { heldIndex: 0, earlyAuth: false },
    { heldIndex: 32, earlyAuth: false },
    { heldIndex: 32, earlyAuth: true },
  ])(
    "continues first Gateway startup while fleet workspace $heldIndex is acquiring (early auth: $earlyAuth)",
    async ({ heldIndex, earlyAuth }) => {
      mocks.configuredAgentIds = Array.from({ length: 64 }, (_, index) => `fleet-${index}`);
      const acquiring = createDeferredCore();
      const acquired = createDeferredCore();
      const completed = createDeferredCore();
      const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) => {
        if (phase === "published" && getPreparedModelRuntimeStartupStatus()?.degraded === false) {
          completed.resolve();
        }
      });
      const heldAgent = `fleet-${heldIndex}`;
      const config = {};
      const credentials = { custom: { type: "api_key" as const, key: "updated-test-key" } };
      const mutateAuth = () => {
        mocks.authStorage.getAll.mockReturnValue(credentials);
        mocks.mutationListener?.({
          agentDir: fixture.state.agentDir("fleet-0"),
          affectsInheritedStores: false,
        });
      };
      mocks.prepareStaticCatalog.mockImplementation(async (options) => {
        if ((options as { workspaceDir: string }).workspaceDir === `/tmp/workspace-${heldAgent}`) {
          acquiring.resolve();
          await acquired.promise;
        }
        return { entries: [] };
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(120_000);
      const publication = refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        startup: true,
        catalogMode: "static",
      });
      const ready = expect(publication).resolves.toBeUndefined();
      // Attach before advancing timers so the expected pre-fix rejection is always observed.
      void ready.catch(() => undefined);
      try {
        await acquiring.promise;
        if (earlyAuth) {
          mutateAuth();
        }
        await vi.advanceTimersByTimeAsync(120_000);
        await ready;
        expect(getPreparedModelRuntimeStartupStatus()).toMatchObject({
          degraded: true,
          pendingAgents: expect.arrayContaining([heldAgent, "fleet-63"]),
          stage: `static provider catalog; agent ${heldAgent}`,
        });
        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(`agent ${heldAgent}`));
        await expect(
          loadPublishedGatewayReplyDispatchRuntime({ agentId: heldAgent }),
        ).rejects.toThrow(heldAgent);
        if (heldIndex > 0) {
          await expect(
            loadPublishedGatewayReplyDispatchRuntime({ agentId: "fleet-0" }),
          ).resolves.toMatchObject({ agentId: "fleet-0" });
          if (!earlyAuth) {
            mutateAuth();
          }
          await expect(
            loadPublishedGatewayReplyDispatchRuntime({ agentId: "fleet-0" }),
          ).resolves.toMatchObject({ agentId: "fleet-0" });
          expect(
            getPreparedModelRuntimeSnapshot({
              config,
              agentId: "fleet-0",
              agentDir: fixture.state.agentDir("fleet-0"),
            })
              ?.createStores()
              .authStorage.getAll(),
          ).toEqual(credentials);
        }
        acquired.resolve();
        await completed.promise;
        expect(getPreparedModelRuntimeStartupStatus()).toEqual({
          degraded: false,
          pendingAgents: [],
        });
        await expect(
          loadPublishedGatewayReplyDispatchRuntime({ agentId: heldAgent }),
        ).resolves.toMatchObject({ agentId: heldAgent });
        expect(
          getPreparedModelRuntimeSnapshot({
            config,
            agentId: heldAgent,
            agentDir: fixture.state.agentDir(heldAgent),
          }),
        ).toBeDefined();
      } finally {
        acquired.resolve();
        await Promise.allSettled([publication]);
        await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
        unregister();
        vi.useRealTimers();
      }
    },
  );

  it("keeps auth admission pending when startup degrades during an adopted refresh", async () => {
    mocks.configuredAgentIds = ["first", "last"];
    const firstAuth = createDeferredCore();
    const finishFirstAuth = createDeferredCore();
    const secondAuth = createDeferredCore();
    const finishSecondAuth = createDeferredCore();
    const mutateAuth = () =>
      mocks.mutationListener?.({
        agentDir: fixture.state.agentDir("first"),
        affectsInheritedStores: false,
      });
    let initial = true;
    mocks.prepareStaticCatalog.mockImplementation(async (options) => {
      if (initial && (options as { workspaceDir: string }).workspaceDir === "/tmp/workspace-last") {
        initial = false;
        mutateAuth();
      }
      return { entries: [] };
    });
    mocks.resolveAmbientCredentials
      .mockImplementationOnce(() => ({}))
      .mockImplementationOnce(() => ({}))
      .mockImplementationOnce(async () => {
        firstAuth.resolve();
        await finishFirstAuth.promise;
        return {};
      })
      .mockImplementationOnce(async () => {
        secondAuth.resolve();
        await finishSecondAuth.promise;
        return {};
      });
    mocks.warn.mockImplementation((message: string) => {
      if (message.includes("startup degraded")) {
        mutateAuth();
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const publication = refreshPreparedModelRuntimeSnapshots(
      {},
      {
        gatewayLifecycle: true,
        startup: true,
        catalogMode: "static",
      },
    );
    let admission: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let settled = false;
    try {
      await firstAuth.promise;
      admission = loadPublishedGatewayReplyDispatchRuntime({ agentId: "first" });
      void admission.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await publication;
      finishFirstAuth.resolve();
      await secondAuth.promise;
      await nextTurn();
      expect(settled).toBe(false);
      finishSecondAuth.resolve();
      await expect(admission).resolves.toMatchObject({ agentId: "first" });
    } finally {
      finishFirstAuth.resolve();
      finishSecondAuth.resolve();
      await Promise.allSettled([publication, admission]);
      await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "retains settled agents after a late failure (neutral config advance: %s)",
    async (advanceConfig) => {
      mocks.configuredAgentIds = ["first", "last"];
      const acquiring = createDeferredCore();
      const acquired = createDeferredCore();
      const failed = createDeferredCore();
      mocks.prepareStaticCatalog.mockImplementation(async (options) => {
        if ((options as { workspaceDir: string }).workspaceDir === "/tmp/workspace-last") {
          acquiring.resolve();
          await acquired.promise;
        }
        return { entries: [] };
      });
      mocks.warn.mockImplementation((message: string) => {
        if (message.includes("background model runtime publication failed")) {
          failed.resolve();
        }
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const publication = refreshPreparedModelRuntimeSnapshots(
        {},
        {
          gatewayLifecycle: true,
          startup: true,
          catalogMode: "static",
        },
      );
      try {
        await acquiring.promise;
        await vi.advanceTimersByTimeAsync(120_000);
        await publication;
        if (advanceConfig) {
          advancePreparedModelRuntimeConfig({ logging: { level: "debug" } });
        }
        acquired.reject(new Error("fixture catalog failure"));
        await failed.promise;
        await expect(
          loadPublishedGatewayReplyDispatchRuntime({ agentId: "first" }),
        ).resolves.toMatchObject({ agentId: "first" });
        expect(getPreparedModelRuntimeStartupStatus()).toMatchObject({
          degraded: true,
          pendingAgents: ["last"],
        });
      } finally {
        acquired.resolve();
        await Promise.allSettled([publication]);
        await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "services queued event-loop work between agents (shared workspace: %s)",
    async (sharedWorkspace) => {
      if (sharedWorkspace) {
        for (const id of mocks.configuredAgentIds) {
          mocks.configuredWorkspaces.set(id, fixture.state.workspaceDir);
        }
      }
      const events: string[] = [];
      let queued: Promise<void> | undefined;
      mocks.discoverAuthStorage.mockImplementation((agentDir) => {
        const agent = mocks.configuredAgentIds.find(
          (id) => fixture.state.agentDir(id) === agentDir,
        )!;
        events.push(agent);
        if (agent === "first") {
          queued = nextTurn().then(() => {
            events.push("event-loop");
          });
        }
        return mocks.authStorage;
      });

      await refreshPreparedModelRuntimeSnapshots(
        {},
        {
          gatewayLifecycle: true,
          catalogMode: "static",
        },
      );
      await queued;

      expect(events.indexOf("first")).toBeLessThan(events.indexOf("event-loop"));
      expect(events.indexOf("event-loop")).toBeLessThan(events.indexOf("last"));
    },
  );

  it("does not start plugin callbacks after cancellation at an event-loop boundary", async () => {
    let cancelled = false;
    let lateLoads = 0;
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      if (cancelled) {
        lateLoads += 1;
      }
      return createEmptyPluginRegistry();
    });
    const publication = publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: fixture.state.agentDir("cancelled"),
      workspaceDir: fixture.state.workspaceDir,
    });
    cancelled = true;
    markPreparedModelRuntimeSnapshotsStale("cancel before workspace preparation");
    await expect(publication).rejects.toThrow("superseded");
    expect(lateLoads).toBe(0);
  });

  it("prepares shared configured model facts once per immutable fleet publication", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "fixture/first" } },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            models: ["first", "second"].map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 4096,
            })),
          },
        },
      },
    };
    const inlineProjection = vi.spyOn(inlineProviderModels, "buildInlineProviderModels");
    const configuredProjection = vi.spyOn(configuredModels, "buildConfiguredModelCatalog");
    const captures: OpenClawConfig[] = [];
    mocks.prepareStaticCatalog.mockImplementation(async (options) => {
      captures.push((options as { config: OpenClawConfig }).config);
      return { entries: [] };
    });
    mocks.createStaticCatalogResolver.mockImplementation((options) => {
      const workspace = options?.workspaceDir?.split("/").at(-1);
      return ({ provider, modelId }) => {
        const model = options?.cfg?.models?.providers?.[provider]?.models.find(
          (candidate) => candidate.id === modelId,
        );
        return model
          ? {
              id: model.id,
              name: model.name,
              provider,
              api: "openai-responses",
              baseUrl: `https://${workspace}.fixture.invalid/v1`,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 4096,
            }
          : undefined;
      };
    });
    const readSnapshots = () =>
      mocks.configuredAgentIds.map((agentId) =>
        getPreparedModelRuntimeSnapshot({
          config,
          agentId,
          agentDir: fixture.state.agentDir(agentId),
        }),
      );
    try {
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      expect(captures).toHaveLength(3);
      expect(new Set(captures).size).toBe(1);
      const first = captures[0]!;
      expect(first).not.toBe(config);
      expect(Object.isFrozen(first.agents?.defaults)).toBe(true);
      expect(Object.isFrozen(config.agents?.defaults)).toBe(false);
      const firstSnapshots = readSnapshots();
      for (const [index, snapshot] of firstSnapshots.entries()) {
        expect(snapshot).toMatchObject({
          agentId: mocks.configuredAgentIds[index],
          workspaceDir: `/tmp/workspace-${mocks.configuredAgentIds[index]}`,
          inlineProviderModels: [
            { id: "first", name: "first" },
            { id: "second", name: "second" },
          ],
          modelCatalog: {
            entries: [
              {
                id: "first",
                api: "openai-responses",
                baseUrl: `https://workspace-${mocks.configuredAgentIds[index]}.fixture.invalid/v1`,
              },
              {
                id: "second",
                api: "openai-completions",
                baseUrl: "https://fixture.invalid/v1",
              },
            ],
          },
        });
      }
      expect(inlineProjection).toHaveBeenCalledOnce();
      expect(configuredProjection.mock.calls.filter(([params]) => !params.catalog)).toHaveLength(1);

      config.agents!.defaults!.model = "fixture/second";
      config.models!.providers!.fixture!.models[1]!.name = "updated";
      expect(first.agents?.defaults?.model).toBe("fixture/first");
      captures.length = 0;
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      expect(captures).toHaveLength(3);
      expect(new Set(captures).size).toBe(1);
      expect(captures[0]).not.toBe(first);
      expect(captures[0]?.agents?.defaults?.model).toBe("fixture/second");
      expect(inlineProjection).toHaveBeenCalledTimes(2);
      expect(configuredProjection.mock.calls.filter(([params]) => !params.catalog)).toHaveLength(2);
      for (const [index, snapshot] of readSnapshots().entries()) {
        expect(snapshot?.inlineProviderModels[1]?.name).toBe("updated");
        expect(snapshot?.modelCatalog.entries.find(({ id }) => id === "second")).toMatchObject({
          api: "openai-responses",
          baseUrl: `https://workspace-${mocks.configuredAgentIds[index]}.fixture.invalid/v1`,
        });
      }
      for (const snapshot of firstSnapshots) {
        expect(snapshot?.inlineProviderModels[1]?.name).toBe("second");
      }
    } finally {
      inlineProjection.mockRestore();
      configuredProjection.mockRestore();
    }
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

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
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
    const inherited = vi.spyOn(legacyAuth, "resolveLegacyInheritedAuthDir");
    inherited.mockReturnValue(fixture.state.agentDir("default"));
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      inherited.mockReturnValue(undefined);
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return { entries: [] };
    });
    try {
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const snapshot = getPreparedModelRuntimeSnapshot({
        config,
        agentId: "first",
        agentDir: fixture.state.agentDir("first"),
        workspaceDir: "/tmp/workspace-first",
      });
      expect(snapshot).toBeDefined();
      expect(snapshot?.inheritedAuthDir).toBeUndefined();
      expect(mocks.discoverAuthStorage.mock.calls.at(-1)?.[1]).not.toHaveProperty(
        "inheritedAuthDir",
      );
    } finally {
      inherited.mockRestore();
    }
  });
});
