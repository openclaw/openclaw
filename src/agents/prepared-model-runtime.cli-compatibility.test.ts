// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { loadPreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { CliBackendModelCatalogContext } from "../plugins/cli-backend.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { publishPreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";

const fixture = usePreparedModelRuntimeHarness({ label: "cli-compatibility-publication" }, () => {
  vi.restoreAllMocks();
});
const { mocks } = fixture;

const first = {
  provider: "custom",
  id: "first",
  name: "First",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 4096,
};
const discovered = { provider: "custom", id: "discovered", name: "Discovered" };

function installCatalogBackend(
  prepare: NonNullable<
    import("../plugins/cli-backend.types.js").CliBackendPlugin["prepareModelCatalog"]
  >,
) {
  mocks.configuredAgentIds = ["pro"];
  mocks.modelRegistry.getAll.mockReturnValue([first]);
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => ({
    entries: [first, discovered],
    routeVariants: [first, discovered],
    providerOutcomes: [{ provider: "custom", status: "ready" }],
  }));
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    registry.cliBackends.push({
      pluginId: "custom",
      source: "fixture",
      backend: {
        id: "fixture-cli",
        modelProvider: "custom",
        config: { command: "/service/fixture" },
        prepareModelCatalog: prepare,
      },
    });
    return registry;
  });
  return fixture.agentInput("pro", {
    agents: { entries: { pro: { model: "custom/first" } } },
    models: {
      providers: {
        custom: {
          baseUrl: "https://fixture.invalid",
          api: "openai-completions",
          models: [first],
          agentRuntime: { id: "fixture-cli" },
        },
      },
    },
  });
}

it("prepares static and discovered models before publication, then renews only on an expired inventory read", async ({
  signal,
}) => {
  const started = createDeferred();
  const release = createDeferred();
  const routineRelease = createDeferred();
  const renewed = createDeferred();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const prepare = vi.fn(async (context: CliBackendModelCatalogContext) => {
    context.assertCurrent();
    if (prepare.mock.calls.length === 1) {
      started.resolve();
      await release.promise;
    }
    if (context.reason === "routine") {
      await routineRelease.promise;
    }
    context.assertCurrent();
    return {
      models: Object.fromEntries(context.modelIds.map((id) => [id, { available: true }])),
      nextCheckAt: Date.now() + 86_400_000,
    };
  });
  const input = installCatalogBackend(prepare);
  const publication = publishPreparedModelRuntimeSnapshot(input, { catalogMode: "static" });
  let completed = false;
  void publication.then(
    () => {
      completed = true;
    },
    () => {},
  );
  let removeListener: (() => void) | undefined;
  let routineRequested = false;
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        started.promise,
        publication,
        "Static catalog was published before its configured CLI compatibility hook ran",
      ),
      signal,
    );
    expect(completed).toBe(false);
    release.resolve();
    const owner = await publication;
    expect(
      owner.modelCatalog.cliRuntimeCompatibility?.["fixture-cli"]?.models.first?.available,
    ).toBe(true);
    const catalog = await owner.loadFullModelCatalog!({ refresh: true });
    expect(catalog.cliRuntimeCompatibility?.["fixture-cli"]?.models.discovered?.available).toBe(
      true,
    );
    expect(prepare.mock.calls.at(-1)?.[0].modelIds).toContain("discovered");
    const beforeReads = prepare.mock.calls.length;
    owner.readFullModelCatalog!();
    owner.refreshExpiredModelCatalog!();
    expect(prepare).toHaveBeenCalledTimes(beforeReads);
    removeListener = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "catalog-published" || event.phase === "catalog-failed") {
        renewed.resolve();
      }
    });
    clock.mockReturnValue(now + 86_400_001);
    owner.refreshExpiredModelCatalog!();
    owner.refreshExpiredModelCatalog!();
    routineRequested = prepare.mock.calls.some(([context]) => context.reason === "routine");
    expect(routineRequested).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(beforeReads + 1);
    routineRelease.resolve();
    await withinTest(renewed.promise, signal);
    expect(
      owner.readFullModelCatalog!()?.cliRuntimeCompatibility?.["fixture-cli"]?.nextCheckAt,
    ).toBe(now + 172_800_001);
    owner.refreshExpiredModelCatalog!();
    expect(prepare).toHaveBeenCalledTimes(beforeReads + 1);
  } finally {
    release.resolve();
    routineRelease.resolve();
    try {
      await publication;
      if (routineRequested) {
        await withinTest(renewed.promise, signal);
      }
    } finally {
      removeListener?.();
      clock.mockRestore();
    }
  }
});

it("recovers a failed compatibility observation on the first inventory request after its retry deadline", async ({
  signal,
}) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const release = createDeferred();
  const renewed = createDeferred();
  const prepare = vi.fn(async (context: CliBackendModelCatalogContext) => {
    context.assertCurrent();
    if (context.reason !== "routine") {
      throw new Error("Temporary compatibility probe failure");
    }
    await release.promise;
    context.assertCurrent();
    return {
      models: Object.fromEntries(context.modelIds.map((id) => [id, { available: true }])),
      nextCheckAt: Date.now() + 86_400_000,
    };
  });
  let removeListener: (() => void) | undefined;
  let routineRequested = false;
  try {
    const owner = await publishPreparedModelRuntimeSnapshot(installCatalogBackend(prepare), {
      catalogMode: "static",
    });
    expect(owner.modelCatalog.cliRuntimeCompatibility?.["fixture-cli"]?.models.first).toEqual({
      available: false,
      reason: "Temporary compatibility probe failure",
    });
    const catalog = await owner.loadFullModelCatalog!({ refresh: true });
    expect(catalog.cliRuntimeCompatibility?.["fixture-cli"]?.models.discovered?.available).toBe(
      false,
    );
    const beforeReads = prepare.mock.calls.length;
    clock.mockReturnValue(now + 59_999);
    owner.refreshExpiredModelCatalog!();
    expect(prepare).toHaveBeenCalledTimes(beforeReads);
    clock.mockReturnValue(now + 60_000);
    expect(prepare).toHaveBeenCalledTimes(beforeReads);
    removeListener = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "catalog-published" || event.phase === "catalog-failed") {
        renewed.resolve();
      }
    });
    owner.refreshExpiredModelCatalog!();
    owner.refreshExpiredModelCatalog!();
    routineRequested = prepare.mock.calls.some(([context]) => context.reason === "routine");
    expect(routineRequested).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(beforeReads + 1);
    release.resolve();
    await withinTest(renewed.promise, signal);
    const recovered = owner.readFullModelCatalog!();
    expect(recovered?.cliRuntimeCompatibility?.["fixture-cli"]?.models.discovered?.available).toBe(
      true,
    );
    owner.refreshExpiredModelCatalog!();
    expect(prepare).toHaveBeenCalledTimes(beforeReads + 1);
  } finally {
    release.resolve();
    try {
      if (routineRequested) {
        await withinTest(renewed.promise, signal);
      }
    } finally {
      removeListener?.();
      clock.mockRestore();
    }
  }
});

it("waits for an authorized Gateway manual compatibility pass after concurrent discovery", async ({
  signal,
}) => {
  const started = createDeferred();
  const release = createDeferred();
  const reasons: string[] = [];
  const prepare = vi.fn(async (context: CliBackendModelCatalogContext) => {
    context.assertCurrent();
    reasons.push(context.reason);
    return {
      models: Object.fromEntries(
        context.modelIds.map((id) => [id, { available: context.reason === "manual" }]),
      ),
      nextCheckAt: Date.now() + 86_400_000,
    };
  });
  const input = installCatalogBackend(prepare);
  const owner = await publishPreparedModelRuntimeSnapshot(input, { catalogMode: "static" });
  const originalWorker = mocks.runPreparedModelCatalogWorker.getMockImplementation()!;
  mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async (...args) => {
    started.resolve();
    await release.promise;
    return originalWorker(...args);
  });
  const discovery = owner.loadFullModelCatalog!({ refresh: true });
  let manual:
    | Promise<Awaited<ReturnType<typeof loadPreparedGatewayModelCatalogSnapshot>>>
    | undefined;
  const manualStarted = createDeferred();
  const assertCurrent = vi.fn(() => manualStarted.resolve());
  try {
    await withinTest(started.promise, signal);
    manual = loadPreparedGatewayModelCatalogSnapshot({
      agentId: "pro",
      getConfig: () => input.config,
      readOnly: false,
      refreshFullCatalog: true,
      cliCompatibilityRefresh: { assertCurrent },
    });
    await withinTest(manualStarted.promise, signal);
    release.resolve();
    await discovery;
    const result = await manual;
    expect(reasons).toEqual(["discovery", "discovery", "manual"]);
    expect(assertCurrent).toHaveBeenCalled();
    expect(result.cliRuntimeCompatibility?.["fixture-cli"]?.models.discovered?.available).toBe(
      true,
    );
  } finally {
    release.resolve();
    await Promise.allSettled([discovery, ...(manual ? [manual] : [])]);
  }
});

it("does not repair through a Gateway request whose authority expired during discovery", async ({
  signal,
}) => {
  const started = createDeferred();
  const release = createDeferred();
  const installed: string[] = [];
  const input = installCatalogBackend(async (context) => {
    context.assertCurrent();
    if (context.reason === "manual") {
      installed.push(...context.modelIds);
    }
    return { models: {}, nextCheckAt: Date.now() + 86_400_000 };
  });
  await publishPreparedModelRuntimeSnapshot(input, { catalogMode: "static" });
  const originalWorker = mocks.runPreparedModelCatalogWorker.getMockImplementation()!;
  mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async (...args) => {
    started.resolve();
    await release.promise;
    return originalWorker(...args);
  });
  let current = true;
  const manual = loadPreparedGatewayModelCatalogSnapshot({
    agentId: "pro",
    getConfig: () => input.config,
    readOnly: false,
    refreshFullCatalog: true,
    cliCompatibilityRefresh: {
      assertCurrent: () => {
        if (!current) {
          throw new Error("Manual requester expired");
        }
      },
    },
  });
  const rejected = expect(manual).rejects.toThrow("Manual requester expired");
  try {
    await withinTest(started.promise, signal);
    current = false;
    release.resolve();
    await rejected;
    expect(installed).toEqual([]);
  } finally {
    release.resolve();
    await Promise.allSettled([manual, rejected]);
  }
});

it("cancels an in-flight manual maintenance operation when its Gateway request is cancelled", async ({
  signal,
}) => {
  const started = createDeferred();
  const release = createDeferred();
  const cancelled = new AbortController();
  let updaterSignal: AbortSignal | undefined;
  let updated = false;
  const input = installCatalogBackend(async (context) => {
    if (context.reason === "manual") {
      await context.withMaintenance!(async () => {
        updaterSignal = context.signal;
        started.resolve();
        await racePromiseWithAbortSignal(release.promise, context.signal);
        updated = true;
      });
    }
    return { models: Object.fromEntries(context.modelIds.map((id) => [id, { available: true }])) };
  });
  await publishPreparedModelRuntimeSnapshot(input, { catalogMode: "static" });
  const manual = loadPreparedGatewayModelCatalogSnapshot({
    agentId: "pro",
    getConfig: () => input.config,
    readOnly: false,
    refreshFullCatalog: true,
    cliCompatibilityRefresh: {
      signal: cancelled.signal,
      assertCurrent: () => cancelled.signal.throwIfAborted(),
    },
  });
  const result = manual.then(
    () => "completed",
    (error: unknown) => error,
  );
  try {
    await withinTest(started.promise, signal);
    cancelled.abort(new Error("Manual request cancelled"));
    expect(updaterSignal?.aborted).toBe(true);
    expect(await withinTest(result, signal)).toEqual(new Error("Manual request cancelled"));
    expect(updated).toBe(false);
    const ordinary = await loadPreparedGatewayModelCatalogSnapshot({
      agentId: "pro",
      getConfig: () => input.config,
      readOnly: false,
      refreshFullCatalog: true,
    });
    expect(ordinary.cliRuntimeCompatibility?.["fixture-cli"]?.models.discovered?.available).toBe(
      true,
    );
  } finally {
    release.resolve();
    await result;
  }
});

it.for(["routine compatibility renewal", "provider discovery"] as const)(
  "settles a cancelled manual request while shared %s remains pending",
  async (sharedWork, { signal }) => {
    const sharedStarted = createDeferred();
    const releaseShared = createDeferred();
    const sharedPublished = createDeferred();
    const manualEntered = createDeferred();
    const cancelled = new AbortController();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let sharedFinished = false;
    let routineSignal: AbortSignal | undefined;
    const reasons: string[] = [];
    const input = installCatalogBackend(async (context) => {
      reasons.push(context.reason);
      if (context.reason === "routine") {
        routineSignal = context.signal;
        sharedStarted.resolve();
        await releaseShared.promise;
        sharedFinished = true;
      }
      context.assertCurrent();
      return {
        models: Object.fromEntries(context.modelIds.map((id) => [id, { available: true }])),
        nextCheckAt: Date.now() + 86_400_000,
      };
    });
    let shared: Promise<unknown> | undefined;
    let manual: Promise<unknown> | undefined;
    let removeListener: (() => void) | undefined;
    try {
      const owner = await publishPreparedModelRuntimeSnapshot(input, { catalogMode: "static" });
      await owner.loadFullModelCatalog!({ refresh: true });
      if (sharedWork === "routine compatibility renewal") {
        removeListener = registerPreparedModelRuntimePublicationListener((event) => {
          if (
            sharedFinished &&
            (event.phase === "catalog-published" || event.phase === "catalog-failed")
          ) {
            sharedPublished.resolve();
          }
        });
        clock.mockReturnValue(now + 86_400_001);
        shared = sharedPublished.promise;
        owner.refreshExpiredModelCatalog!();
      } else {
        const originalWorker = mocks.runPreparedModelCatalogWorker.getMockImplementation()!;
        mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async (...args) => {
          sharedStarted.resolve();
          await releaseShared.promise;
          sharedFinished = true;
          return originalWorker(...args);
        });
        shared = owner.loadFullModelCatalog!({ refresh: true });
      }
      await withinTest(sharedStarted.promise, signal);
      manual = loadPreparedGatewayModelCatalogSnapshot({
        agentId: "pro",
        getConfig: () => input.config,
        readOnly: false,
        refreshFullCatalog: true,
        cliCompatibilityRefresh: {
          signal: cancelled.signal,
          assertCurrent: () => {
            manualEntered.resolve();
            cancelled.signal.throwIfAborted();
          },
        },
      }).then(
        () => {
          throw new Error("Cancelled manual refresh unexpectedly completed");
        },
        (error: unknown) => error,
      );
      await withinTest(manualEntered.promise, signal);
      cancelled.abort(new Error("Manual request cancelled while waiting"));
      expect(await withinTest(manual, signal)).toMatchObject({ name: "AbortError" });
      expect(sharedFinished).toBe(false);
      expect(reasons).not.toContain("manual");
      if (sharedWork === "routine compatibility renewal") {
        expect(routineSignal?.aborted).toBe(false);
      }
      releaseShared.resolve();
      await withinTest(shared, signal);
      expect(
        owner.readFullModelCatalog!()?.cliRuntimeCompatibility?.["fixture-cli"]?.models.discovered
          ?.available,
      ).toBe(true);
    } finally {
      releaseShared.resolve();
      await Promise.allSettled([...(shared ? [shared] : []), ...(manual ? [manual] : [])]);
      removeListener?.();
      clock.mockRestore();
    }
  },
);
