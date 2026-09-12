// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "../gateway/server-model-catalog.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";
import { notifyPreparedModelRuntimePublication } from "./prepared-model-runtime.publication-events.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;
async function prepareCatalogOwner(
  config: OpenClawConfig,
  catalogs: readonly ModelCatalogSnapshot[],
) {
  mocks.configuredAgentIds = ["pro"];
  for (const catalog of catalogs) {
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(catalog);
  }
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
  });
  return getPreparedModelRuntimeSnapshot({
    config,
    agentId: "pro",
    agentDir: state.agentDir("pro"),
  })!;
}

type FixturePublication =
  | { phase: "catalog-published" }
  | { phase: "catalog-failed" | "failed"; error: Error }
  | { phase: "cancelled" };
type HeldCatalogFixture<T> = {
  provider: ReturnType<typeof createServer>;
  events: string[];
  started: Promise<void>;
  publication: Promise<FixturePublication>;
  respond(catalog: ModelCatalogSnapshot): void;
  reject(): void;
  refresh(): Promise<T>;
  requests(): number;
  dispose(): Promise<void>;
};

async function withHeldCatalogProvider<T, R>(
  owner: Awaited<ReturnType<typeof prepareCatalogOwner>>,
  refresh: () => Promise<T>,
  run: (fixture: HeldCatalogFixture<T>) => Promise<R>,
): Promise<R> {
  await using resources = new AsyncDisposableStack();
  const started = createDeferred();
  const response = createDeferred<
    { kind: "catalog"; catalog: ModelCatalogSnapshot } | { kind: "reject" } | { kind: "closed" }
  >();
  const publication = createDeferred<FixturePublication>();
  const controller = new AbortController();
  let workerRequest: Promise<ModelCatalogSnapshot> | undefined;
  let refreshCompletion: Promise<PromiseSettledResult<T>[]> | undefined;
  let providerRequests = 0;
  const provider = createServer((_request, reply) => {
    providerRequests += 1;
    started.resolve();
    void response.promise.then((result) => {
      if (result.kind === "closed") {
        reply.destroy();
      } else if (result.kind === "reject") {
        reply.writeHead(503).end("Fixture catalog refresh rejected");
      } else {
        reply.setHeader("content-type", "application/json");
        reply.end(JSON.stringify(result.catalog));
      }
    });
  });
  resources.defer(async () => {
    controller.abort();
    response.resolve({ kind: "closed" });
    provider.closeAllConnections();
    await provider[Symbol.asyncDispose]();
    await Promise.allSettled([workerRequest, refreshCompletion]);
  });
  const events: string[] = [];
  const stop = registerPreparedModelRuntimePublicationListener((event) => {
    events.push(event.phase);
    if (event.phase === "catalog-failed" || event.phase === "failed") {
      publication.resolve({ phase: event.phase, error: event.error });
    } else if (event.phase === "invalidated") {
      publication.resolve({ phase: "cancelled" });
    } else if (
      event.phase === "catalog-published" &&
      !owner.readFullModelCatalog!()?.pendingProviders?.length
    ) {
      publication.resolve({ phase: "catalog-published" });
    }
  });
  resources.defer(() => {
    stop();
    publication.resolve({ phase: "cancelled" });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (!address || typeof address === "string") {
    throw new Error("Catalog fixture did not bind a loopback port");
  }
  mocks.runPreparedModelCatalogWorker.mockImplementationOnce(() => {
    workerRequest = (async () => {
      const reply = await fetch(`http://127.0.0.1:${address.port}/models`, {
        signal: controller.signal,
      });
      if (!reply.ok) {
        throw new Error("Fixture catalog refresh rejected");
      }
      const catalog: ModelCatalogSnapshot = await reply.json();
      return catalog;
    })();
    return workerRequest;
  });
  const fixture: HeldCatalogFixture<T> = {
    provider,
    events,
    started: started.promise,
    publication: publication.promise,
    respond: (catalog) => response.resolve({ kind: "catalog", catalog }),
    reject: () => response.resolve({ kind: "reject" }),
    refresh: () => {
      const request = refresh();
      // Retain rejection as an observable request outcome while teardown can join either result.
      refreshCompletion = Promise.allSettled([request]);
      return request;
    },
    requests: () => providerRequests,
    dispose: () => resources.disposeAsync(),
  };
  return await run(fixture);
}

describe("captured startup inventory refresh", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "captured-model-runtime" });
    await resetPreparedModelRuntimeHarness(state);
  });
  afterEach(async ({ task }) => {
    await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
  });

  it("does not refill a successful empty refresh from the captured startup registry", async () => {
    const captured = {
      provider: "custom",
      id: "removed",
      name: "Previously discovered",
      api: "openai-completions" as const,
      baseUrl: "https://custom.example.test/v1",
    };
    mocks.modelRegistry.getAll.mockReturnValue([captured]);
    const owner = await prepareCatalogOwner(
      { models: { mode: "merge" }, agents: { entries: { pro: {} } } },
      [
        {
          entries: [],
          routeVariants: [],
          providerOutcomes: [{ provider: "custom", status: "ready" }],
        },
      ],
    );
    expect(owner.modelCatalog.entries).toContainEqual(expect.objectContaining({ id: "removed" }));

    const refreshed = await owner.loadFullModelCatalog!({ refresh: true });

    expect(refreshed.entries).toEqual([]);
    expect(refreshed.routeVariants).toEqual([]);
    expect(refreshed.providerOutcomes).toEqual([{ provider: "custom", status: "ready" }]);
  });

  it.each(["ready", "unavailable"] as const)(
    "publishes a late %s refresh after returning the current RPC inventory",
    async (status) => {
      const config: OpenClawConfig = {
        agents: { entries: { pro: {} } },
        models: { mode: "merge" },
      };
      const before = { provider: "custom", id: "inventory-before", name: "Before" };
      const after = { provider: "custom", id: "inventory-after", name: "After" };
      const initial: ModelCatalogSnapshot = {
        entries: [before],
        routeVariants: [before],
        providerOutcomes: [{ provider: "custom", status: "ready" }],
      };
      const owner = await prepareCatalogOwner(config, [initial]);
      await owner.loadFullModelCatalog!();
      const context = {
        getRuntimeConfig: () => config,
        loadGatewayModelCatalogSnapshot: () =>
          loadPreparedGatewayModelCatalogSnapshot({ getConfig: () => config }),
        logGateway: { debug: vi.fn() },
      };
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        loadDeferred: (params) =>
          loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig: () => config }),
        readPrepared: (params) =>
          readPreparedGatewayModelCatalogOwnerSnapshot({ ...params, getConfig: () => config }),
      });
      const list = (refresh = false) =>
        buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: "pro",
          params: { view: "all", refresh },
        });
      const next: ModelCatalogSnapshot = {
        entries: status === "ready" ? [after] : [],
        routeVariants: status === "ready" ? [after] : [],
        providerOutcomes: [{ provider: "custom", status }],
      };
      await withHeldCatalogProvider(
        owner,
        () => list(true),
        async (fixture) => {
          const refresh = fixture.refresh();
          await fixture.started;
          const foreground = await refresh;
          console.log(
            "CATALOG_PENDING_RPC",
            JSON.stringify({
              status,
              workerRequests: mocks.runPreparedModelCatalogWorker.mock.calls.length,
              providerRequests: fixture.requests(),
              foreground,
            }),
          );
          // Foreground completion is not provider completion: the published generation stays usable.
          expect(foreground.models).toContainEqual(expect.objectContaining(before));
          expect(foreground.pendingProviders).toEqual(["custom"]);
          expect(foreground.refreshFailed).toBeUndefined();
          expect((await list()).models).toEqual(foreground.models);
          expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
          expect(fixture.requests()).toBe(1);
          fixture.respond(next);
          expect(await fixture.publication).toEqual({ phase: "catalog-published" });
          const completed = await list();
          console.log(
            "CATALOG_COMPLETED_RPC",
            JSON.stringify({
              status,
              workerRequests: mocks.runPreparedModelCatalogWorker.mock.calls.length,
              providerRequests: fixture.requests(),
              completed,
              sameOwner:
                getPreparedModelRuntimeSnapshot({
                  config,
                  agentId: "pro",
                  agentDir: state.agentDir("pro"),
                }) === owner,
            }),
          );
          expect(completed.pendingProviders).toBeUndefined();
          expect(completed.models).toContainEqual(
            expect.objectContaining(status === "ready" ? after : before),
          );
          expect(completed.refreshFailed).toBe(status === "unavailable" ? true : undefined);
          expect(completed.providerOutcomes).toEqual([{ provider: "custom", status }]);
          expect(
            getPreparedModelRuntimeSnapshot({
              config,
              agentId: "pro",
              agentDir: state.agentDir("pro"),
            }),
          ).toBe(owner);
          await list();
          expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
          expect(fixture.requests()).toBe(1);
        },
      );
    },
  );

  it.each(["before-foreground", "after-foreground", "before-refresh"] as const)(
    "releases held catalog fixture resources on failure %s",
    async (timing) => {
      const owner = await prepareCatalogOwner({ agents: { entries: { pro: {} } } }, [
        {
          entries: [],
          routeVariants: [],
          providerOutcomes: [{ provider: "custom", status: "ready" }],
        },
      ]);
      await owner.loadFullModelCatalog!();
      const checkpoint = createDeferred();
      let reachedCheckpoint = false;
      const markCheckpoint = () => {
        reachedCheckpoint = true;
        checkpoint.resolve();
      };
      using _failureObserver = {
        [Symbol.dispose]: registerPreparedModelRuntimePublicationListener((event) => {
          if (event.phase === "catalog-failed") markCheckpoint();
        }),
      };
      let captured: HeldCatalogFixture<ModelCatalogSnapshot> | undefined;
      let publication: FixturePublication | undefined;
      let serverClosed = false;
      const bodyFailure = new Error("Fixture body failed before refresh");
      const operation = withHeldCatalogProvider(
        owner,
        () => owner.loadFullModelCatalog!({ refresh: true }),
        async (fixture) => {
          captured = fixture;
          fixture.provider.once("close", () => {
            serverClosed = true;
          });
          void fixture.publication.then((value) => {
            publication = value;
          });
          if (timing === "before-refresh") {
            markCheckpoint();
            throw bodyFailure;
          }
          const refresh = fixture.refresh();
          await fixture.started;
          if (timing === "after-foreground") {
            expect((await refresh).pendingProviders).toEqual(["custom"]);
          }
          fixture.reject();
          if (timing === "before-foreground") return await refresh;
          const outcome = await fixture.publication;
          if (outcome.phase !== "catalog-failed")
            throw new Error("Expected failed catalog publication");
          throw outcome.error;
        },
      );
      const completion = operation.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          checkpoint.promise,
          completion.then(({ error }) => {
            if (!reachedCheckpoint) throw error;
          }),
        ]);
        // Fence continuations of the actual failure, without waiting for a success-only observer.
        await nextTurn();
        if (!captured) throw new Error("Failure fixture was not created");
        const beforeProbe = captured.events.length;
        const serverListening = captured.provider.listening;
        notifyPreparedModelRuntimePublication({
          phase: "catalog-failed",
          error: new Error("Post-cleanup notification probe"),
        });
        const observed = {
          serverListening,
          listenerReceivedProbe: captured.events.length !== beforeProbe,
          publicationPhase: publication?.phase ?? "pending",
        };
        console.log("IRF001_CLEANUP_STATE", JSON.stringify({ timing, ...observed }));
        expect(observed).toEqual({
          serverListening: false,
          listenerReceivedProbe: false,
          publicationPhase: timing === "before-refresh" ? "cancelled" : "catalog-failed",
        });
        const result = await completion;
        if (timing === "before-refresh") expect(result.error).toBe(bodyFailure);
        else expect(result.error).toMatchObject({ message: "Fixture catalog refresh rejected" });
        expect(serverClosed).toBe(true);
        expect(captured.provider.address()).toBeNull();
        expect(captured.requests()).toBe(timing === "before-refresh" ? 0 : 1);
      } finally {
        // Rescue an intentionally failing regression run only after checking the leaked state.
        // Idempotent disposal also leaves no listener/socket behind if an assertion fails.
        await captured?.dispose();
        await completion;
      }
    },
  );
});
