import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot as loadPublicCatalog,
  loadPreparedGatewayModelCatalogSnapshot,
} from "../gateway/server-model-catalog.js";
import * as providerRuntime from "../plugins/provider-runtime.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { configFor } from "./model-auth.fixtures.test-support.js";
import { model } from "./model-catalog-fixtures.test-support.js";
import * as catalogWorker from "./prepared-model-catalog-worker.js";
import {
  HARNESS_ID,
  catalogEntry,
  catalogInput,
  PLUGIN_ID,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
  UNRELATED_PLUGIN_ID,
  UNRELATED_PLUGIN_WORKER_MARKER_ENV,
  writeFixturePlugin,
  writeUnrelatedFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import { materializePreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeCatalog,
  markPreparedModelRuntimeSnapshotsStale,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  loadCompletedFullCatalog,
  observeSyntheticAuth,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);

it("keeps settled fleet generations idle without a timer", async () => {
  const createWorker = catalogWorker.createPreparedModelCatalogWorker;
  let checks = 0;
  const observe = vi
    .spyOn(catalogWorker, "createPreparedModelCatalogWorker")
    .mockImplementation((params) =>
      createWorker({
        ...params,
        isCurrent: () => {
          checks += 1;
          return params.isCurrent();
        },
      }),
    );
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const fixture = await createFleetFixture();
    await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
    await Promise.all(
      fixture.snapshots.map((snapshot) =>
        loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] }),
      ),
    );
    expect(catalogWorker.getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
      workers: 1,
      activeTasks: 0,
      pendingTasks: 0,
    });
    const settledChecks = checks;
    await vi.advanceTimersByTimeAsync(100);
    expect(checks).toBe(settledChecks);
  } finally {
    await closePreparedModelRuntimeSnapshots();
    vi.useRealTimers();
    observe.mockRestore();
  }
});

it("joins a parent capture retired synchronously before its promise is registered", async ({
  signal,
}) => {
  const fixture = await createFleetFixture(undefined, false, { asyncSyntheticAuth: true });
  await Promise.all(fixture.snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
  const [retired, sibling] = fixture.snapshots;
  await loadPreparedModelRuntimeAuth(retired!, { providerIds: [] });
  const hold = path.join(fixture.root, "synthetic-auth-hold");
  const cancelled = path.join(fixture.root, "synthetic-auth-cancel.txt");
  fs.writeFileSync(hold, "");
  const auth = observeSyntheticAuth(fixture.root);
  const capture = providerRuntime.captureProviderSyntheticAuthFacts;
  const retirement = vi
    .spyOn(providerRuntime, "captureProviderSyntheticAuthFacts")
    .mockImplementationOnce((params) => {
      const pending = capture(params);
      markPreparedModelRuntimeSnapshotsStale(undefined, {
        agentIds: new Set([fixture.agentIds[0]!]),
      });
      return pending;
    });
  const settled = vi.fn();
  const request = loadPreparedModelRuntimeAuth(retired!, { providerIds: [] }).finally(settled);
  void request.catch(() => {});
  let closing: Promise<void> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        auth.aborted,
        request,
        "parent auth capture settled before observing retirement",
      ),
      signal,
    );
    expect([retired!.isCurrent(), sibling!.isCurrent()]).toEqual([false, true]);
    expect(settled).not.toHaveBeenCalled();
    const closed = vi.fn();
    closing = closePreparedModelRuntimeSnapshots().then(closed);
    await checkpoint();
    expect(closed).not.toHaveBeenCalled();
    fs.rmSync(hold);
    await expect(request).rejects.toThrow("superseded");
    await closing;
    expect(fs.readFileSync(cancelled, "utf8")).toBe("abort\njoined\n");
  } finally {
    fs.rmSync(hold, { force: true });
    auth.close();
    await Promise.allSettled([request, closing]);
    retirement.mockRestore();
  }
});

function createScopedCatalogWorkspace(prefix: string) {
  const root = makeTempDir(prefix);
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspace");
  for (const directory of [agentDir, workspaceDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  retireAfterTest(() => {
    unregisterResolvedAgentDir({ agentId: "main", agentDir, env });
  });
  return { root, agentDir, workspaceDir, env };
}
function expectScopedModelResponse(
  respond: RespondFn,
  provider = PROVIDER_ID,
  id = "plugin-generation-v1",
) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      models: expect.arrayContaining([catalogEntry(id, { provider })]),
    }),
    undefined,
  );
}
it("keeps models.list responsive and aborts superseded held discovery", async ({ signal }) => {
  const fixture = createScopedCatalogWorkspace("openclaw-model-catalog-scope-worker-");
  const { root, agentDir, workspaceDir } = fixture;
  const marker = path.join(root, "worker-marker.txt");
  const unrelatedMarker = path.join(root, "unrelated-worker-plugin.txt");

  const pluginFile = writeFixturePlugin({
    root,
    spinMs: 0,
    asyncSyntheticAuth: true,
    syntheticAuthAvailable: false,
  });
  const unrelatedPluginFile = writeUnrelatedFixturePlugin(root);
  const makeConfig = (name?: string) =>
    ({
      agents: {
        defaults: {
          model: `${PROVIDER_ID}/sqlite-model`,
          models: {
            [`${PROVIDER_ID}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } },
            "published-fixture/published-model": { agentRuntime: { id: "openclaw" } },
          },
        },
        entries: { main: { agentDir, workspace: workspaceDir, ...(name ? { name } : {}) } },
      },
      ...configFor("published-fixture", "https://published-fixture.invalid/v1", {
        api: "openai-completions",
        apiKey: "published-fixture-key-not-real",
        models: [model("published-model", "Published model")],
      }),
      plugins: {
        allow: [PLUGIN_ID, UNRELATED_PLUGIN_ID],
        load: { paths: [pluginFile, unrelatedPluginFile] },
        entries: {
          [PLUGIN_ID]: { enabled: true },
          [UNRELATED_PLUGIN_ID]: { enabled: true },
        },
      },
    }) satisfies OpenClawConfig;
  const config = makeConfig();
  const env = {
    ...fixture.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_WORKER_CATALOG_MARKER: marker,
    [UNRELATED_PLUGIN_WORKER_MARKER_ENV]: unrelatedMarker,
    [REF_ONLY_API_ENV]: "ref-only-api-secret-not-real",
    [REF_ONLY_TOKEN_ENV]: "ref-only-token-secret-not-real",
  };
  replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: { version: 1, profiles: {} } }]);

  const input = catalogInput({ agentDir, workspaceDir, config, env });
  const snapshot = await publishPreparedModelRuntimeSnapshot(input, {
    provenance: "configured",
    catalogMode: "static",
  });
  const ownerParams = (full: boolean, providerIds?: readonly string[], refresh?: boolean) => ({
    getConfig: () => config,
    loadPublishedPreparedModelCatalogOwnerSnapshot: async () =>
      materializePreparedModelCatalogOwner(
        snapshot,
        full
          ? await refreshPreparedModelRuntimeCatalog(snapshot, { providerIds, refresh })
          : snapshot.readFullModelCatalog?.(),
      ),
  });
  const loadGatewayModelCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] =
    (params) => loadPublicCatalog(ownerParams(params?.readOnly === false));
  registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
    loadDeferred: (params) =>
      loadPreparedGatewayModelCatalogSnapshot(
        ownerParams(
          params?.readOnly === false,
          params?.providerDiscoveryProviderIds,
          params?.refreshFullCatalog === true,
        ),
      ),
    readPrepared: () => loadPreparedGatewayModelCatalogSnapshot(ownerParams(false)),
  });
  const respond = vi.fn();
  const context = Object.assign({} as GatewayRequestContext, {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot,
    logGateway: { debug: vi.fn(), warn: vi.fn() },
  });
  const handler = expectDefined(modelsHandlers["models.list"], "models.list test invariant");
  const listModels = (id: string, params: Record<string, unknown>, response: RespondFn = respond) =>
    handler({
      req: { type: "req", id, method: "models.list", params },
      params,
      respond: response,
      client: null,
      isWebchatConnect: () => false,
      context,
    });
  expect(snapshot.authModes[HARNESS_ID]).toBeUndefined();
  const probePath = path.join(root, "synthetic-auth-probes.txt");
  const ownerPath = path.join(root, "synthetic-auth-owner.txt");
  fs.writeFileSync(probePath, "");
  fs.writeFileSync(ownerPath, "");
  const hold = path.join(root, "synthetic-auth-hold");
  const auth = observeSyntheticAuth(root);
  fs.writeFileSync(hold, "");
  // The first worker operation must enter through the registered scoped refresh.
  const params = { view: "all", provider: PROVIDER_ID, refresh: true };
  const refresh = Promise.resolve(listModels("models-list-cold-scoped", params));
  let settled = false;
  const observedRefresh = refresh.finally(() => {
    settled = true;
  });
  void observedRefresh.catch(() => {});
  const awaitAuth = (gate: PromiseLike<unknown>, event: string) =>
    withinTest(
      awaitGateBeforeSettlement(
        gate,
        observedRefresh,
        `parent auth probe did not ${event} before models.list settled`,
      ),
      signal,
    );
  try {
    await awaitAuth(auth.entered, "enter");
    expect(fs.readFileSync(ownerPath, "utf8")).toContain("parent\n");
    // The entered probe stays pending until abort; later publication probes may proceed.
    fs.rmSync(hold);
    const readRespond = vi.fn();
    await listModels("models-list-during-refresh", { view: "all" }, readRespond);
    expect(settled).toBe(false);
    const replacementInput = { ...input, config: makeConfig("Updated agent") };
    const publishedReplacement = await publishPreparedModelRuntimeSnapshot(replacementInput, {
      force: true,
      provenance: "configured",
      catalogMode: "static",
    });
    expectScopedModelResponse(readRespond, "published-fixture", "published-model");
    expect(getPreparedModelRuntimeSnapshot(replacementInput)).toBe(publishedReplacement);
    expect(snapshot.isCurrent()).toBe(false);
    await awaitAuth(auth.aborted, "observe abort");
    await withinTest(observedRefresh, signal);
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("superseded"),
        retryable: true,
        retryAfterMs: 0,
      }),
    );
    expect(settled).toBe(true);
    expect(fs.readFileSync(path.join(root, "synthetic-auth-cancel.txt"), "utf8")).toBe(
      "abort\njoined\n",
    );
    await waitForWorkers();
  } finally {
    fs.rmSync(hold, { force: true });
    auth.close();
    await drainGlobalSingletonLifecycleState("close");
    await Promise.allSettled([observedRefresh]);
  }
});
