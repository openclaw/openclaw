// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { publishConfiguredModelRuntimeSnapshots } from "../gateway/server-startup-model-runtime.js";
import * as cryptoDigest from "../infra/crypto-digest.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as inlineProviderModels from "./embedded-agent-runner/model.inline-provider.js";
import * as legacyAuth from "./legacy-inherited-auth-dir.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import * as configuredModels from "./model-selection-shared.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
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
import { observeSettlement } from "./promise-settlement.test-support.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

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

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-fleet-batch" });
const { mocks } = fixture;
const refresh = (config: OpenClawConfig = {}, startup = false) =>
  refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    ...(startup ? { startup } : {}),
  });
const readSnapshot = (agentId: string, config: OpenClawConfig = {}) =>
  getPreparedModelRuntimeSnapshot({ config, agentId, agentDir: fixture.state.agentDir(agentId) });
const expectAdmission = async (agentId: string) =>
  expect(loadPublishedGatewayReplyDispatchRuntime({ agentId })).resolves.toMatchObject({ agentId });
function barrier() {
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  return {
    entered: entered.promise,
    ...finish,
    wait: async () => {
      entered.resolve();
      await finish.promise;
    },
  };
}

describe("prepared fleet batches", () => {
  beforeEach(() => {
    mocks.configuredAgentIds = ["first", "middle", "last"];
  });

  it.each([
    { heldIndex: 32, earlyAuth: false },
    { heldIndex: 32, earlyAuth: true },
  ])(
    "continues first Gateway startup while fleet workspace $heldIndex is acquiring (early auth: $earlyAuth)",
    async ({ heldIndex, earlyAuth }) => {
      mocks.configuredAgentIds = Array.from({ length: 64 }, (_, index) => `fleet-${index}`);
      const held = barrier();
      const last = barrier();
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
          await held.wait();
        }
        if ((options as { workspaceDir: string }).workspaceDir === "/tmp/workspace-fleet-63") {
          await last.wait();
        }
        return { entries: [] };
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(120_000);
      const publication = publishConfiguredModelRuntimeSnapshots({ cfg: config });
      const ready = expect(publication).resolves.toBeUndefined();
      // Attach before advancing timers so the expected pre-fix rejection is always observed.
      void ready.catch(() => undefined);
      let admission: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
      try {
        await held.entered;
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
        admission = loadPublishedGatewayReplyDispatchRuntime({ agentId: heldAgent });
        const admissionSettled = observeSettlement(admission);
        await expectAdmission("fleet-0");
        if (!earlyAuth) {
          mutateAuth();
        }
        await expectAdmission("fleet-0");
        expect(readSnapshot("fleet-0", config)?.createStores().authStorage.getAll()).toEqual(
          credentials,
        );
        expect(admissionSettled()).toBe(false);
        held.resolve();
        await last.entered;
        await expect(admission).resolves.toMatchObject({ agentId: heldAgent });
        last.resolve();
        await completed.promise;
        expect(getPreparedModelRuntimeStartupStatus()).toEqual({
          degraded: false,
          pendingAgents: [],
        });
        await expectAdmission(heldAgent);
        expect(readSnapshot(heldAgent, config)).toBeDefined();
      } finally {
        held.resolve();
        last.resolve();
        await Promise.allSettled([publication, admission]);
        await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
        unregister();
        vi.useRealTimers();
      }
    },
  );

  it("keeps auth admission pending when startup degrades during an adopted refresh", async () => {
    mocks.configuredAgentIds = ["first", "last"];
    const firstAuth = barrier();
    const secondAuth = barrier();
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
        await firstAuth.wait();
        return {};
      })
      .mockImplementationOnce(async () => {
        await secondAuth.wait();
        return {};
      });
    mocks.warn.mockImplementation((message: string) => {
      if (message.includes("startup degraded")) {
        mutateAuth();
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const publication = refresh({}, true);
    let admission: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    try {
      await firstAuth.entered;
      admission = loadPublishedGatewayReplyDispatchRuntime({ agentId: "first" });
      const settled = observeSettlement(admission);
      await vi.advanceTimersByTimeAsync(120_000);
      await publication;
      firstAuth.resolve();
      await secondAuth.entered;
      await nextTurn();
      expect(settled()).toBe(false);
      secondAuth.resolve();
      await expect(admission).resolves.toMatchObject({ agentId: "first" });
    } finally {
      firstAuth.resolve();
      secondAuth.resolve();
      await Promise.allSettled([publication, admission]);
      await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
      vi.useRealTimers();
    }
  });

  it("retains settled agents after a late failure across a neutral config advance", async () => {
    mocks.configuredAgentIds = ["first", "last"];
    const acquisition = barrier();
    const failed = createDeferredCore();
    mocks.prepareStaticCatalog.mockImplementation(async (options) => {
      if ((options as { workspaceDir: string }).workspaceDir === "/tmp/workspace-last") {
        await acquisition.wait();
      }
      return { entries: [] };
    });
    mocks.warn.mockImplementation((message: string) => {
      if (message.includes("background model runtime publication failed")) {
        failed.resolve();
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const publication = refresh({}, true);
    try {
      await acquisition.entered;
      await vi.advanceTimersByTimeAsync(120_000);
      await publication;
      advancePreparedModelRuntimeConfig({ logging: { level: "debug" } });
      acquisition.reject(new Error("fixture catalog failure"));
      await failed.promise;
      await expectAdmission("first");
      expect(getPreparedModelRuntimeStartupStatus()).toMatchObject({
        degraded: true,
        pendingAgents: ["last"],
      });
    } finally {
      acquisition.resolve();
      await Promise.allSettled([publication]);
      await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
      vi.useRealTimers();
    }
  });

  it("services queued event-loop work between agents in a shared workspace", async () => {
    for (const id of mocks.configuredAgentIds) {
      mocks.configuredWorkspaces.set(id, fixture.state.workspaceDir);
    }
    const events: string[] = [];
    let queued: Promise<void> | undefined;
    mocks.discoverAuthStorage.mockImplementation((agentDir) => {
      const agent = mocks.configuredAgentIds.find((id) => fixture.state.agentDir(id) === agentDir)!;
      events.push(agent);
      if (agent === "first") {
        queued = nextTurn().then(() => {
          events.push("event-loop");
        });
      }
      return mocks.authStorage;
    });

    await refresh();
    await queued;

    expect(events.indexOf("first")).toBeLessThan(events.indexOf("event-loop"));
    expect(events.indexOf("event-loop")).toBeLessThan(events.indexOf("last"));
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
    const publication = publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: fixture.state.agentDir("cancelled"),
      workspaceDir: fixture.state.workspaceDir,
    });
    cancelled = true;
    markPreparedModelRuntimeSnapshotsStale("cancel before workspace preparation");
    await expect(publication).rejects.toBeInstanceOf(
      PreparedModelRuntimePublicationSupersededError,
    );
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
            models: ["first", "second"].map((id) =>
              modelDefinition(id, { reasoning: false, contextWindow: 32_000, maxTokens: 4096 }),
            ),
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
          ? makeProviderModelFixture({
              id: model.id,
              name: model.name,
              provider,
              api: "openai-responses",
              baseUrl: `https://${workspace}.fixture.invalid/v1`,
              contextWindow: 32_000,
            })
          : undefined;
      };
    });
    const readSnapshots = () =>
      mocks.configuredAgentIds.map((agentId) => readSnapshot(agentId, config));
    try {
      await refresh(config);
      expect(new Set(captures).size).toBe(1);
      const first = captures[0]!;
      expect(first).not.toBe(config);
      expect(Object.isFrozen(first.agents?.defaults)).toBe(true);
      expect(Object.isFrozen(config.agents?.defaults)).toBe(false);
      const firstSnapshots = readSnapshots();
      for (const [index, snapshot] of firstSnapshots.entries()) {
        const agentId = mocks.configuredAgentIds[index];
        expect(
          snapshot?.modelCatalog.entries.map(({ id, api, baseUrl }) => [id, api, baseUrl]),
        ).toEqual([
          ["first", "openai-responses", `https://workspace-${agentId}.fixture.invalid/v1`],
          ["second", "openai-completions", "https://fixture.invalid/v1"],
        ]);
      }
      expect(inlineProjection).toHaveBeenCalledOnce();
      expect(configuredProjection.mock.calls.filter(([params]) => !params.catalog)).toHaveLength(1);

      config.agents!.defaults!.model = "fixture/second";
      config.models!.providers!.fixture!.models[1]!.name = "updated";
      expect(first.agents?.defaults?.model).toBe("fixture/first");
      captures.length = 0;
      await refresh(config);
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

    await refresh(config);
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
      await refresh(config);
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

describe("prepared catalog source sharing", () => {
  it("keeps full-roster digest work constant as the fleet grows", async () => {
    const marker = "synthetic-roster-hash-boundary";
    const digests = vi.spyOn(cryptoDigest, "sha256Base64Url");
    try {
      const counts: number[] = [];
      for (const size of [8, 16]) {
        mocks.configuredAgentIds = Array.from({ length: size }, (_, index) => `agent-${index}`);
        const config: OpenClawConfig = {
          agents: {
            entries: Object.fromEntries(
              mocks.configuredAgentIds.map((id) => [id, { name: marker }]),
            ),
          },
        };
        digests.mockClear();
        await refresh(config);
        counts.push(
          digests.mock.calls.filter(
            ([value]) => typeof value === "string" && value.includes(marker),
          ).length,
        );
      }
      expect(counts[0]).toBeGreaterThan(0);
      expect(counts[1]).toBe(counts[0]);
    } finally {
      digests.mockRestore();
    }
  });
});
