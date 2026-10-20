// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi as getTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { publishConfiguredModelRuntimeSnapshots } from "../gateway/server-startup-model-runtime.js";
import * as cryptoDigest from "../infra/crypto-digest.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as inlineProviderModels from "./embedded-agent-runner/model.inline-provider.js";
import * as legacyAuth from "./legacy-inherited-auth-dir.js";
import { model as configuredModel, providerConfig } from "./model-catalog-fixtures.test-support.js";
import * as configuredModels from "./model-selection-shared.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  advancePreparedModelRuntimeConfig as advanceConfig,
  getPreparedModelRuntimeSnapshot as readSnapshot,
  loadPublishedGatewayReplyDispatchRuntime as loadDispatch,
  markPreparedModelRuntimeSnapshotsStale as invalidate,
  publishPreparedModelRuntimeSnapshot as publishSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";
import { getPreparedModelRuntimeStartupStatus as startupStatus } from "./prepared-model-runtime.startup-status.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-fleet-batch" });
const { mocks } = fixture;

function publish(config: OpenClawConfig = {}, startup = false) {
  return refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    ...(startup ? { startup: true } : {}),
  });
}

function readAgentSnapshot(agentId: string, config: OpenClawConfig) {
  return readSnapshot({ agentId, config, agentDir: fixture.state.agentDir(agentId) });
}

function gate() {
  const started = createDeferredCore();
  const release = createDeferredCore();
  return {
    started,
    release,
    wait: async () => {
      started.resolve();
      await release.promise;
    },
  };
}

function holdCatalogs(...agentIds: string[]) {
  const gates = agentIds.map(() => gate());
  mocks.prepareStaticCatalog.mockImplementation(async (options) => {
    const index = agentIds.findIndex(
      (id) => (options as { workspaceDir: string }).workspaceDir === `/tmp/workspace-${id}`,
    );
    if (index !== -1) {
      await gates[index]!.wait();
    }
    return { entries: [] };
  });
  return gates;
}

function observe(promise: Promise<unknown>) {
  let settled = false;
  const finish = () => {
    settled = true;
  };
  void promise.then(finish, finish);
  return () => settled;
}

async function finishStartup(...jobs: (Promise<unknown> | undefined)[]) {
  await Promise.allSettled(jobs);
  await getTestApi().resetPreparedModelRuntimeSnapshotsForTest();
  vi.useRealTimers();
}

beforeEach(() => {
  mocks.configuredAgentIds = ["first", "middle", "last"];
});

it.each([false, true])(
  "continues first Gateway startup while fleet workspace 32 is acquiring (early auth: %s)",
  async (earlyAuth) => {
    mocks.configuredAgentIds = Array.from({ length: 64 }, (_, index) => `fleet-${index}`);
    const heldAgent = "fleet-32";
    const [held, last] = holdCatalogs(heldAgent, "fleet-63");
    const completed = createDeferredCore();
    const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) => {
      if (phase === "published" && startupStatus()?.degraded === false) {
        completed.resolve();
      }
    });
    const config = {};
    const credentials = { custom: { type: "api_key" as const, key: "updated-test-key" } };
    const mutateAuth = () => {
      mocks.authStorage.getAll.mockReturnValue(credentials);
      mocks.mutationListener?.({
        agentDir: fixture.state.agentDir("fleet-0"),
        affectsInheritedStores: false,
      });
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const publication = publishConfiguredModelRuntimeSnapshots({ cfg: config });
    const ready = expect(publication).resolves.toBeUndefined();
    // Attach before advancing timers so the expected pre-fix rejection is always observed.
    void ready.catch(() => undefined);
    let admission: ReturnType<typeof loadDispatch> | undefined;
    try {
      await held!.started.promise;
      if (earlyAuth) {
        mutateAuth();
      }
      await vi.advanceTimersByTimeAsync(120_000);
      await ready;
      expect(startupStatus()).toMatchObject({
        degraded: true,
        pendingAgents: expect.arrayContaining([heldAgent, "fleet-63"]),
        stage: `static provider catalog; agent ${heldAgent}`,
      });
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(`agent ${heldAgent}`));
      admission = loadDispatch({ agentId: heldAgent });
      const admissionSettled = observe(admission);
      await expect(loadDispatch({ agentId: "fleet-0" })).resolves.toMatchObject({
        agentId: "fleet-0",
      });
      if (!earlyAuth) {
        mutateAuth();
      }
      await expect(loadDispatch({ agentId: "fleet-0" })).resolves.toMatchObject({
        agentId: "fleet-0",
      });
      expect(readAgentSnapshot("fleet-0", config)?.createStores().authStorage.getAll()).toEqual(
        credentials,
      );
      expect(admissionSettled()).toBe(false);
      held!.release.resolve();
      await last!.started.promise;
      await expect(admission).resolves.toMatchObject({ agentId: heldAgent });
      last!.release.resolve();
      await completed.promise;
      expect(startupStatus()).toEqual({
        degraded: false,
        pendingAgents: [],
      });
      await expect(loadDispatch({ agentId: heldAgent })).resolves.toMatchObject({
        agentId: heldAgent,
      });
      expect(readAgentSnapshot(heldAgent, config)).toBeDefined();
    } finally {
      held!.release.resolve();
      last!.release.resolve();
      await finishStartup(publication, admission);
      unregister();
    }
  },
);

it("keeps auth admission pending when startup degrades during an adopted refresh", async () => {
  mocks.configuredAgentIds = ["first", "last"];
  const firstAuth = gate();
  const secondAuth = gate();
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
  const publication = publish({}, true);
  let admission: ReturnType<typeof loadDispatch> | undefined;
  try {
    await firstAuth.started.promise;
    admission = loadDispatch({ agentId: "first" });
    const settled = observe(admission);
    await vi.advanceTimersByTimeAsync(120_000);
    await publication;
    firstAuth.release.resolve();
    await secondAuth.started.promise;
    await nextTurn();
    expect(settled()).toBe(false);
    secondAuth.release.resolve();
    await expect(admission).resolves.toMatchObject({ agentId: "first" });
  } finally {
    firstAuth.release.resolve();
    secondAuth.release.resolve();
    await finishStartup(publication, admission);
  }
});

it("retains settled agents after a late failure across a neutral config advance", async () => {
  mocks.configuredAgentIds = ["first", "last"];
  const [last] = holdCatalogs("last");
  const failed = createDeferredCore();
  mocks.warn.mockImplementation((message: string) => {
    if (message.includes("background model runtime publication failed")) {
      failed.resolve();
    }
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const publication = publish({}, true);
  try {
    await last!.started.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    await publication;
    advanceConfig({ logging: { level: "debug" } });
    last!.release.reject(new Error("fixture catalog failure"));
    await failed.promise;
    await expect(loadDispatch({ agentId: "first" })).resolves.toMatchObject({ agentId: "first" });
    expect(startupStatus()).toMatchObject({
      degraded: true,
      pendingAgents: ["last"],
    });
  } finally {
    last!.release.resolve();
    await finishStartup(publication);
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

  await publish();
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
  const publication = publishSnapshot({
    config: {},
    agentDir: fixture.state.agentDir("cancelled"),
    workspaceDir: fixture.state.workspaceDir,
  });
  cancelled = true;
  invalidate("cancel before workspace preparation");
  await expect(publication).rejects.toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
  expect(lateLoads).toBe(0);
});

it("prepares shared configured model facts once per immutable fleet publication", async () => {
  const config: OpenClawConfig = {
    agents: { defaults: { model: "fixture/first" } },
    ...providerConfig("fixture", {
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
      models: ["first", "second"].map((id) =>
        configuredModel(id, id, { contextWindow: 32_000, maxTokens: 4096 }),
      ),
    }),
  };
  using inlineProjection = vi.spyOn(inlineProviderModels, "buildInlineProviderModels");
  using configuredProjection = vi.spyOn(configuredModels, "buildConfiguredModelCatalog");
  const captures: OpenClawConfig[] = [];
  mocks.prepareStaticCatalog.mockImplementation(async (options) => {
    captures.push((options as { config: OpenClawConfig }).config);
    return { entries: [] };
  });
  mocks.createStaticCatalogResolver.mockImplementation((options) => {
    const workspace = options?.workspaceDir?.split("/").at(-1);
    return ({ provider, modelId }) => {
      const entry = options?.cfg?.models?.providers?.[provider]?.models.find(
        (candidate) => candidate.id === modelId,
      );
      return entry
        ? {
            ...configuredModel(entry.id, entry.name, { contextWindow: 32_000, maxTokens: 4096 }),
            provider,
            api: "openai-responses",
            baseUrl: `https://${workspace}.fixture.invalid/v1`,
          }
        : undefined;
    };
  });
  const readSnapshots = () =>
    mocks.configuredAgentIds.map((agentId) => readAgentSnapshot(agentId, config));
  await publish(config);
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
      inlineProviderModels: ["first", "second"].map((id) => ({ id, name: id })),
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
  await publish(config);
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

  await publish(config);
  const snapshot = readSnapshot({
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
  await publish(config);
  const snapshot = readSnapshot({
    config,
    agentId: "first",
    agentDir: fixture.state.agentDir("first"),
    workspaceDir: "/tmp/workspace-first",
  });
  expect(snapshot).toBeDefined();
  expect(snapshot?.inheritedAuthDir).toBeUndefined();
  expect(mocks.discoverAuthStorage.mock.calls.at(-1)?.[1]).not.toHaveProperty("inheritedAuthDir");
});
it("keeps full-roster digest work constant as the fleet grows", async () => {
  const marker = "synthetic-roster-hash-boundary";
  using digests = vi.spyOn(cryptoDigest, "sha256Base64Url");
  const counts: number[] = [];
  for (const size of [8, 16]) {
    mocks.configuredAgentIds = Array.from({ length: size }, (_, index) => `agent-${index}`);
    const config: OpenClawConfig = {
      agents: {
        entries: Object.fromEntries(mocks.configuredAgentIds.map((id) => [id, { name: marker }])),
      },
    };
    digests.mockClear();
    await publish(config);
    counts.push(
      digests.mock.calls.filter(([value]) => typeof value === "string" && value.includes(marker))
        .length,
    );
  }
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts[1]).toBe(counts[0]);
});
