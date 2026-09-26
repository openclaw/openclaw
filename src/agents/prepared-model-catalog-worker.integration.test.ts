import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { threadId, Worker } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import { loadPreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withEnvAsync } from "../test-utils/env.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import { isPendingOAuthRefreshFence } from "./auth-profiles/oauth-refresh-marker.js";
import { getRuntimeExternalCliProfileIds } from "./auth-profiles/runtime-external-profile-references.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import { expectRefOnlyAuthProfilesThroughWorker } from "./prepared-model-catalog-worker.ref-only-auth.test-support.js";
import {
  DISCOVERED_HARNESS_ID,
  PROVIDER_ID,
  HARNESS_ID,
  MISSING_AUTH_HARNESS_ID,
  SHARED_AUTH_PROVIDER_ID,
  PROFILE_ID,
  MATERIALIZED_SECRET,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
  DURABLE_AUTH_PROVIDER_ID,
  DURABLE_AUTH_KEY,
  EXTERNAL_AUTH_PROFILE_ID,
  EXTERNAL_AUTH_PATH_ENV,
  createCatalogFixture,
  expectCatalogAuth,
  writeCodexAuth,
  writeFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import { materializePreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { withHeldCatalogOAuthRefresh } from "./test-helpers/prepared-model-catalog-oauth-fixture.js";
import { createStaticCatalogSnapshotFixture } from "./test-helpers/prepared-model-catalog-static-fixture.js";
import {
  loadCompletedFullCatalog,
  readCatalogDiscoveryCaptures,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers, waitForMarker } =
  usePreparedCatalogWorkerFixtures();

const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });

async function createReadyWorkerFixture(spinMs: number) {
  const fixture = await createStaticSnapshot(spinMs);
  // Ordering tests begin at discovery, not cold worker/module startup. The normal
  // auth request prepares the same worker without running catalog hooks.
  await loadPreparedModelRuntimeAuth(fixture.snapshot, { providerIds: [] });
  expect(fs.existsSync(fixture.marker)).toBe(false);
  return fixture;
}

describe("prepared model catalog worker boundary", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
  });

  it("keeps explicit read-only full inventories discoverable without a runtime registry", async () => {
    const fixture = await createStaticSnapshot(0, {}, { readOnly: true });
    expect(fixture.snapshot.pluginRegistry).toBeUndefined();

    const catalog = await loadCompletedFullCatalog(fixture.snapshot);
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
    );
  });

  it("preserves prepared catalog ownership across ambient environment changes", async () => {
    const homeA = makeTempDir("openclaw-catalog-owner-home-a-");
    const homeB = makeTempDir("openclaw-catalog-owner-home-b-");
    const codexHome = makeTempDir("openclaw-catalog-owner-empty-codex-");
    vi.stubEnv("HOME", homeA);
    vi.stubEnv("OPENCLAW_HOME", homeA);
    vi.stubEnv("CODEX_HOME", codexHome);
    const fixture = createCatalogFixture(makeTempDir, 0);
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.env.OPENCLAW_STATE_DIR);
    const config = {
      ...fixture.config,
      agents: { ...fixture.config.agents, entries: { main: {} } },
    } satisfies OpenClawConfig;
    const agentDir = resolveAgentDir(config, "main", fixture.env);
    const workspaceDir = resolveAgentWorkspaceDir(config, "main", fixture.env);
    expect(agentDir).toBe(fixture.agentDir);
    const input = {
      agentId: "main",
      agentDir,
      inheritedAuthDir: agentDir,
      config,
      env: fixture.env,
    };
    let current = true;
    const retirement = new AbortController();
    const supersede = () => {
      current = false;
      retirement.abort();
    };
    retireAfterTest(supersede);
    const isCurrent = () => current;
    const build = startSerializedSnapshotBuildBatch(
      [
        {
          input,
          catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
          isGenerationCurrent: isCurrent,
          retirementSignal: retirement.signal,
          isBuildCurrent: isCurrent,
        },
      ],
      new Map(),
      30_000,
      "static",
    );
    let snapshot: Awaited<typeof build.pending>[number]["snapshot"] | undefined;
    let driftedAgentDir: string | undefined;
    try {
      const result = (await build.pending)[0]!;
      retireAfterTest(retainPreparedPluginGeneration(result.pluginGeneration));
      snapshot = result.snapshot;
      const modelCatalog = await loadCompletedFullCatalog(snapshot);
      expect(modelCatalog.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
      );
      const auth = getPreparedModelFullCatalogAuth(modelCatalog)!;
      const candidate = { ...snapshot, ...auth, modelCatalog };
      const project = () =>
        loadPreparedGatewayModelCatalogSnapshot({
          getConfig: () => config,
          loadPublishedPreparedModelCatalogOwnerSnapshot: async () => candidate,
        });
      const expectedOwner = { agentId: "main", agentDir, workspaceDir, catalogComplete: true };
      await expect(project()).resolves.toMatchObject(expectedOwner);

      vi.stubEnv("HOME", homeB);
      vi.stubEnv("OPENCLAW_HOME", homeB);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(homeB, "state"));
      driftedAgentDir = resolveAgentDir(config, "main");
      expect(driftedAgentDir).not.toBe(agentDir);
      expect(resolveAgentWorkspaceDir(config, "main")).not.toBe(workspaceDir);
      await expect(project()).resolves.toMatchObject(expectedOwner);
    } finally {
      supersede();
      await build.completion;
      if (snapshot) {
        // Requesting after retirement also closes the fixture worker immediately.
        await Promise.allSettled([loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] })]);
      }
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
      if (driftedAgentDir) {
        unregisterResolvedAgentDir({ agentId: "main", agentDir: driftedAgentDir });
      }
      vi.unstubAllEnvs();
    }
  });

  it("configured runtime refresh keeps an unaffected worker live across a scoped sibling reload", async () => {
    const fixture = createCatalogFixture(makeTempDir, 0);
    // Configured publication reads the process environment; keep both the parent and worker
    // inside the same synthetic plugin/state fixture, without a supplied liveness predicate.
    for (const name of [
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_WORKER_CATALOG_MARKER",
      EXTERNAL_AUTH_PATH_ENV,
      REF_ONLY_API_ENV,
      REF_ONLY_TOKEN_ENV,
    ] as const) {
      vi.stubEnv(name, fixture.env[name]);
    }
    const siblingDir = path.join(fixture.root, "sibling-agent");
    const initialConfig = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        entries: {
          main: { default: true, agentDir: fixture.agentDir, workspace: fixture.workspaceDir },
          sibling: {
            agentDir: siblingDir,
            workspace: fixture.workspaceDir,
            tools: { exec: { security: "full", ask: "off" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];
    const options = {
      gatewayLifecycle: true,
      catalogMode: "static" as const,
      onBuildStats: (stats: { agentCount: number }) => buildCounts.push(stats.agentCount),
    };
    const mainInput = { agentId: "main", agentDir: fixture.agentDir, config: initialConfig };
    const siblingInput = { agentId: "sibling", agentDir: siblingDir, config: initialConfig };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
    const main = getPreparedModelRuntimeSnapshot(mainInput)!;
    const sibling = getPreparedModelRuntimeSnapshot(siblingInput)!;
    const catalog = await loadCompletedFullCatalog(main);
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
    );
    const authScope = { providerIds: [PROVIDER_ID] };
    await expect(loadPreparedModelRuntimeAuth(sibling, authScope)).resolves.toMatchObject({
      authStore: { profiles: { [EXTERNAL_AUTH_PROFILE_ID]: { access: "v1:A" } } },
    });
    await loadCompletedFullCatalog(sibling);
    const completed = fs.readFileSync(fixture.marker, "utf8");
    const nextInvocation = () => fs.readFileSync(fixture.marker, "utf8").split("start\n").length;
    const heldInvocation = nextInvocation();

    fs.writeFileSync(`${fixture.marker}.hold`, "", "utf8");
    const inFlight = loadCompletedFullCatalog(main, { refresh: true });
    void inFlight.catch(() => undefined);
    try {
      await expect.poll(() => fs.readFileSync(fixture.marker, "utf8")).toBe(`${completed}start\n`);
      const nextConfig = {
        ...initialConfig,
        agents: {
          ...initialConfig.agents,
          entries: {
            ...initialConfig.agents.entries,
            sibling: {
              ...initialConfig.agents.entries.sibling,
              tools: { exec: { security: "full", ask: "always" } },
            },
          },
        },
      } satisfies OpenClawConfig;
      await refreshPreparedModelRuntimeSnapshots(nextConfig, {
        ...options,
        agentIds: new Set(["sibling"]),
      });
      const retained = getPreparedModelRuntimeSnapshot({ ...mainInput, config: nextConfig })!;
      expect(buildCounts).toEqual([2, 1]);
      expect(retained.modelCatalog).toBe(main.modelCatalog);
      expect(retained.metadataSnapshot).toBe(main.metadataSnapshot);
      expect(retained.readFullModelCatalog!()).toBe(catalog);
      await expect(loadPreparedModelRuntimeAuth(sibling, authScope)).rejects.toThrow("superseded");
      await expect(sibling.loadFullModelCatalog!()).rejects.toThrow("superseded");

      fs.rmSync(`${fixture.marker}.hold`);
      const refreshed = await inFlight;
      expect(refreshed).not.toBe(catalog);
      expect(retained.readFullModelCatalog!()).toBe(refreshed);
      expect(refreshed.entries).toContainEqual(
        expect.objectContaining({
          id: `proof-refresh-${heldInvocation}-sqlite-true-shared-true-unrelated-true`,
        }),
      );
      const replaced = getPreparedModelRuntimeSnapshot({ ...siblingInput, config: nextConfig })!;
      await loadCompletedFullCatalog(replaced);
      fs.writeFileSync(fixture.externalAuthPath, "B", "utf8");
      await expect(loadPreparedModelRuntimeAuth(retained, authScope)).resolves.toMatchObject({
        authStore: { profiles: { [EXTERNAL_AUTH_PROFILE_ID]: { access: "v1:B" } } },
      });
      const refreshedInvocation = nextInvocation();
      await expect(loadCompletedFullCatalog(retained, { refresh: true })).resolves.toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({
            id: `proof-refresh-${refreshedInvocation}-sqlite-true-shared-true-unrelated-true`,
          }),
        ]),
      });
      await expect(loadPreparedModelRuntimeAuth(replaced, authScope)).resolves.toMatchObject({
        authStore: { profiles: { [EXTERNAL_AUTH_PROFILE_ID]: { access: "v1:B" } } },
      });
    } finally {
      fs.rmSync(`${fixture.marker}.hold`, { force: true });
      await Promise.allSettled([inFlight]);
    }
  });

  it.each([
    ["gateway", "catalog"],
    ["gateway", "auth-refresh"],
    ["none", "catalog"],
    ["none", "auth-refresh"],
    ["activation", "catalog"],
    ["activation", "auth-refresh"],
  ] as const)(
    "keeps %s metadata discovery scope with %s first",
    async (metadataWorkspace, first) => {
      const fixture = await createStaticSnapshot(0, {}, { metadataWorkspace });
      if (first === "auth-refresh") {
        const auth = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
          providerIds: [PROVIDER_ID],
        });
        expect(auth?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
          access: "v1:A",
        });
      }
      const catalog = await loadCompletedFullCatalog(fixture.snapshot);
      expect(catalog?.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
      );
    },
  );

  it("publishes account-scoped harness models only in the full catalog", async () => {
    const fixture = await createStaticSnapshot(0);

    expect(fixture.snapshot.modelCatalog.entries).not.toContainEqual(
      expect.objectContaining({ id: "account-scoped-model" }),
    );

    const catalog = await fixture.snapshot.loadFullModelCatalog?.();

    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "account-scoped-model",
      }),
    );
  });

  it.each([false, true])(
    "pairs full catalog native routes with exact-generation auth (async: %s)",
    async (asyncSyntheticAuth) => {
      const fixture = await createStaticSnapshot(
        0,
        {},
        {
          metadataWorkspace: "none",
          provideMetadataToWorker: true,
          asyncSyntheticAuth,
        },
      );
      const syntheticAuthProbePath = path.join(fixture.root, "synthetic-auth-probes.txt");

      expect(fixture.snapshot.authModes[HARNESS_ID]).toBe("api_key");
      expect(fixture.snapshot.authModes[DISCOVERED_HARNESS_ID]).toBeUndefined();
      expect(fixture.snapshot.authModes[MISSING_AUTH_HARNESS_ID]).toBeUndefined();
      expect(fixture.snapshot.authModes[PROVIDER_ID]).toBeUndefined();
      fs.writeFileSync(syntheticAuthProbePath, "", "utf8");
      await loadPreparedModelRuntimeAuth(fixture.snapshot, { providerIds: [] });
      fs.writeFileSync(syntheticAuthProbePath, "", "utf8");

      const catalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true });
      const fullAuth = getPreparedModelFullCatalogAuth(catalog!);

      expect(fullAuth?.credentials?.[DISCOVERED_HARNESS_ID]).toEqual({
        type: "api_key",
        key: "discovered-native-login-not-real",
      });
      expect(catalog).not.toHaveProperty("credentials");

      if (asyncSyntheticAuth) {
        expect(
          fs
            .readFileSync(path.join(fixture.root, "synthetic-auth-owner.txt"), "utf8")
            .trim()
            .split("\n"),
        ).toContain("parent");
      } else {
        expect(fs.readFileSync(syntheticAuthProbePath, "utf8").trim().split("\n")).toEqual([
          HARNESS_ID,
          DISCOVERED_HARNESS_ID,
          MISSING_AUTH_HARNESS_ID,
        ]);
      }
      expect(fullAuth?.authModes[HARNESS_ID]).toBe("api_key");
      expect(fullAuth?.authModes[DISCOVERED_HARNESS_ID]).toBe("api_key");
      expect(fullAuth?.authModes[MISSING_AUTH_HARNESS_ID]).toBeUndefined();
      expect(fullAuth?.authModes[PROVIDER_ID]).toBe("oauth");
    },
  );

  it.each([
    { retirement: "superseded", request: "catalog" },
    { retirement: "process close", request: "catalog" },
    { retirement: "process close", request: "auth" },
  ])(
    "aborts and joins parent $request preparation before $retirement completes",
    async ({ retirement, request }) => {
      const fixture = await createStaticSnapshot(0, {}, { asyncSyntheticAuth: true });
      await loadPreparedModelRuntimeAuth(fixture.snapshot, { providerIds: [] });
      const hold = path.join(fixture.root, "synthetic-auth-hold");
      const started = path.join(fixture.root, "synthetic-auth-owner.txt");
      const cancelled = path.join(fixture.root, "synthetic-auth-cancel.txt");
      fs.rmSync(started, { force: true });
      fs.writeFileSync(hold, "");
      let settled = false;
      const catalog = (
        request === "auth"
          ? loadPreparedModelRuntimeAuth(fixture.snapshot, { providerIds: [] })
          : fixture.snapshot.loadFullModelCatalog!()
      ).finally(() => {
        settled = true;
      });
      void catalog.catch(() => {});
      let closing: Promise<void> | undefined;
      try {
        await waitForMarker(started);
        if (retirement === "process close") {
          let closed = false;
          closing = Promise.all([
            fixture.releaseGeneration(),
            drainGlobalSingletonLifecycleState("close"),
          ]).then(() => {
            closed = true;
          });
          await nextTurn();
          expect(closed).toBe(false);
        } else {
          fixture.supersede();
        }
        await waitForMarker(cancelled);
        expect(settled).toBe(false);
        fs.rmSync(hold);
        await expect(catalog).rejects.toThrow(
          retirement === "superseded" ? "superseded" : "closed",
        );
        await closing;
        expect(fs.readFileSync(cancelled, "utf8")).toBe("abort\njoined\n");
        await waitForWorkers();
      } finally {
        fs.rmSync(hold, { force: true });
        fixture.supersede();
        await Promise.allSettled([catalog, closing]);
      }
    },
  );

  it("settles an in-flight OAuth rotation before retiring the catalog worker", async ({
    signal,
  }) => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    try {
      await withHeldCatalogOAuthRefresh({ makeTempDir, signal }, async (fixture) => {
        await fixture.waitForRefresh();
        const fenced = fixture.readCredential();
        expect(fenced?.type === "oauth" && isPendingOAuthRefreshFence(fenced)).toBe(true);
        terminate.mockClear();
        const reason = new Error("catalog generation superseded");
        fixture.retire(reason);
        await nextTurn();
        // Against the old owner, keep the response held through actual worker exit.
        await terminate.mock.results[0]?.value;
        expect(terminate).not.toHaveBeenCalled();
        fixture.releaseResponse();
        await expect(fixture.pending).rejects.toThrow(reason.message);
        await fixture.closeWorker();
        expect(fixture.readCredential()).toEqual(fixture.rotated);
        expect(fixture.refreshCalls()).toBe(1);
      });
    } finally {
      terminate.mockRestore();
    }
  });

  it("preserves a materialized SecretRef when durable auth retains only its descriptor", async () => {
    const fixture = await createStaticSnapshot(0);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [PROFILE_ID]: {
            type: "token",
            provider: SHARED_AUTH_PROVIDER_ID,
            tokenRef: { source: "env", provider: "default", id: "SHARED_SECRET_REF" },
          },
        },
      },
      fixture.agentDir,
    );

    const catalog = await fixture.snapshot.loadFullModelCatalog?.();

    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "proof-refresh-1-sqlite-true-shared-true-unrelated-true",
      }),
    );
    expect(getPreparedModelFullCatalogAuth(catalog!)).toMatchObject({
      authStore: {
        profiles: {
          [PROFILE_ID]: expect.objectContaining({
            token: MATERIALIZED_SECRET,
            tokenRef: { source: "env", provider: "default", id: "SHARED_SECRET_REF" },
          }),
        },
      },
    });
  });

  it("refreshes durable auth profiles added, updated, and removed after startup", async () => {
    const fixture = await createStaticSnapshot(0);
    const route = {
      provider: DURABLE_AUTH_PROVIDER_ID,
      id: "durable-model",
      name: "Durable model",
      api: "openai-completions" as const,
      baseUrl: "https://durable-auth.invalid/v1",
    };
    const config = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        list: [
          {
            id: "main",
            default: true,
            agentDir: fixture.agentDir,
            workspace: fixture.workspaceDir,
          },
        ],
      },
    } satisfies OpenClawConfig;
    const owner = Object.freeze({
      ...fixture.snapshot,
      config,
      modelCatalog: { entries: [route], routeVariants: [route] },
    });
    const project = async (refresh = true) => {
      const fullCatalog = refresh
        ? await loadCompletedFullCatalog(fixture.snapshot, { refresh: true })
        : fixture.snapshot.readFullModelCatalog?.();
      const materialized = materializePreparedModelCatalogOwner(fixture.snapshot, fullCatalog);
      const authStore = getPreparedModelRuntimeAuthStore(materialized);
      if (!authStore) {
        throw new Error("full catalog omitted prepared auth");
      }
      return await loadPreparedGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot: async () => ({
          ...owner,
          authModes: materialized.authModes,
          authStore,
        }),
      });
    };
    const projectModels = async (refresh = true) => {
      const projected = await project(refresh);
      const loadProjectedCatalogSnapshot = async () => projected;
      registerGatewayModelCatalogPrivateAccess(loadProjectedCatalogSnapshot, {
        loadDeferred: async () => projected,
        readPrepared: async () => projected,
      });
      const context = {
        getRuntimeConfig: () => config,
        loadGatewayModelCatalogSnapshot: loadProjectedCatalogSnapshot,
        logGateway: { debug: () => undefined },
      };
      return {
        projected,
        result: await buildModelsListResult({
          source: { kind: "gateway", context },
          params: { view: "all" },
        }),
      };
    };
    const writeDurableProfile = (key?: string, usageStats?: AuthProfileStore["usageStats"]) =>
      saveAuthProfileStore(
        {
          version: 1,
          usageStats,
          profiles: key
            ? {
                [`${DURABLE_AUTH_PROVIDER_ID}:default`]: {
                  type: "api_key",
                  provider: DURABLE_AUTH_PROVIDER_ID,
                  key,
                },
              }
            : {},
        },
        fixture.agentDir,
      );

    writeDurableProfile(DURABLE_AUTH_KEY);
    const added = await projectModels();
    const addedCatalog = fixture.snapshot.readFullModelCatalog!();
    expect(addedCatalog?.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "post-startup-auth-model" }),
    );
    expect(getPreparedModelFullCatalogAuth(addedCatalog!)).toMatchObject({
      authStore: {
        profiles: {
          [`${DURABLE_AUTH_PROVIDER_ID}:default`]: expect.objectContaining({
            key: DURABLE_AUTH_KEY,
          }),
        },
      },
    });
    expectCatalogAuth(fixture.snapshot, DURABLE_AUTH_PROVIDER_ID).toContain("post-sta...not-real");
    expect(added).toMatchObject({
      result: {
        models: expect.arrayContaining([
          expect.objectContaining({ id: "durable-model", available: true }),
        ]),
      },
      projected: {
        authStore: {
          profiles: {
            [`${DURABLE_AUTH_PROVIDER_ID}:default`]: expect.objectContaining({
              key: DURABLE_AUTH_KEY,
            }),
          },
        },
      },
    });

    writeDurableProfile("second-key-not-real");
    const updated = await project();
    expectCatalogAuth(fixture.snapshot, DURABLE_AUTH_PROVIDER_ID).toContain("second-k...not-real");
    expect(updated).toMatchObject({
      authStore: {
        profiles: {
          [`${DURABLE_AUTH_PROVIDER_ID}:default`]: expect.objectContaining({
            key: "second-key-not-real",
          }),
        },
      },
    });

    const fullCatalog = fixture.snapshot.readFullModelCatalog?.();
    if (!fullCatalog) {
      throw new Error("expected published catalog");
    }
    const fullAuth = getPreparedModelFullCatalogAuth(fullCatalog)!;
    const discoveryBeforeUsage = fs.readFileSync(fixture.marker, "utf8");
    for (const cooldownUntil of [Date.now() + 60_000, undefined, Date.now() + 120_000]) {
      writeDurableProfile(
        "second-key-not-real",
        cooldownUntil === undefined
          ? {}
          : {
              [`${DURABLE_AUTH_PROVIDER_ID}:default`]: { cooldownUntil },
            },
      );
      const current = await projectModels(false);
      expect(current.result.models).toContainEqual(
        expect.objectContaining({
          id: "durable-model",
          available: cooldownUntil === undefined,
        }),
      );
      const currentAuth = getPreparedModelFullCatalogAuth(fullCatalog)!;
      expect(currentAuth.authStore.profiles).toBe(fullAuth.authStore.profiles);
      expect(currentAuth.authModes).toBe(fullAuth.authModes);
      expect(currentAuth.providerAuthLabels).toBe(fullAuth.providerAuthLabels);
      expect(currentAuth.credentials).toBe(fullAuth.credentials);
    }
    expect(fs.readFileSync(fixture.marker, "utf8")).toBe(discoveryBeforeUsage);

    // The worker has captured a block before its provider hook waits at the barrier.
    const hold = fixture.marker + ".hold";
    fs.writeFileSync(hold, "hold");
    const pending = loadCompletedFullCatalog(fixture.snapshot, { refresh: true });
    try {
      await expect
        .poll(() => fs.readFileSync(fixture.marker, "utf8"), { timeout: 30_000 })
        .not.toBe(discoveryBeforeUsage);
      writeDurableProfile("second-key-not-real", {});
      fs.rmSync(hold);
      await pending;
      const recovered = await projectModels(false);
      expect(recovered.result.models).toContainEqual(
        expect.objectContaining({
          id: "durable-model",
          available: true,
        }),
      );
    } finally {
      fs.rmSync(hold, { force: true });
      await pending;
    }

    writeDurableProfile();
    const removed = await projectModels();
    expectCatalogAuth(fixture.snapshot, DURABLE_AUTH_PROVIDER_ID).toBe("missing");
    expect(removed.result.models).toContainEqual(
      expect.objectContaining({ id: "durable-model", available: false }),
    );
    expect(removed.projected.authStore).toBeDefined();
    expect(
      removed.projected.authStore?.profiles[`${DURABLE_AUTH_PROVIDER_ID}:default`],
    ).toBeUndefined();
    fixture.supersede();
    await waitForWorkers({ requireCreated: true });
    expect(getPreparedModelFullCatalogAuth(fullCatalog)?.authStore).toBe(fullAuth.authStore);
  });

  it("refreshes plugin external auth without changing the prepared plugin generation", async () => {
    const fixture = await createStaticSnapshot(0);
    fs.rmSync(fixture.externalAuthPath);
    const loggedOutAtStartup = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [PROVIDER_ID],
    });
    expect(loggedOutAtStartup?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toBeUndefined();

    fs.writeFileSync(fixture.externalAuthPath, "A", "utf8");
    const loggedIn = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [PROVIDER_ID],
    });
    expect(loggedIn?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
      access: "v1:A",
    });

    writeFixturePlugin({ root: fixture.root, spinMs: 0, pluginVersion: "v2" });
    fs.writeFileSync(fixture.externalAuthPath, "B", "utf8");

    const refreshed = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [PROVIDER_ID],
    });
    expect(refreshed?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
      access: "v1:B",
    });

    const catalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true });
    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "plugin-generation-v1",
      }),
    );
    expect(catalog?.entries).not.toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "plugin-generation-v2",
      }),
    );
    expect(
      getPreparedModelFullCatalogAuth(catalog!)?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID],
    ).toMatchObject({ access: "v1:B" });

    fs.rmSync(fixture.externalAuthPath);
    const loggedOut = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [PROVIDER_ID],
    });
    expect(loggedOut?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toBeUndefined();
  });

  it.each([
    [false, undefined],
    [true, undefined],
    [true, "agent"],
    [true, "user"],
  ] as const)(
    "auth-refresh worker request scopes native login/logout to explicit sharing (nativeOwner=%s, homeScope=%s)",
    async (nativeOwner, homeScope) => {
      // A developer's ambient OpenAI key would count as usable openai auth and
      // mark the route available before the staged Codex login exists.
      vi.stubEnv("OPENAI_API_KEY", undefined);
      const codexHome = makeTempDir("openclaw-models-list-codex-");
      fs.writeFileSync(
        path.join(codexHome, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
      );
      const fixture = await createStaticSnapshot(
        0,
        { CODEX_HOME: codexHome },
        {
          // Auth refresh is a passive read; activating the full harness is a separate contract.
          readOnly: true,
          codexNativeOwner: nativeOwner,
          ...(homeScope ? { codexNativeHomeScope: homeScope } : {}),
        },
      );
      const nativeCli = createRequire(
        new URL("../../extensions/codex/package.json", import.meta.url),
      ).resolve("@openai/codex/bin/codex.js");
      const nativeCommand = (args: string[], input?: string) => {
        const result = spawnSync(process.execPath, [nativeCli, ...args], {
          env: fixture.env,
          encoding: "utf8",
          timeout: 5000,
          input,
        });
        expect(result.status, result.stderr).toBe(0);
      };
      const refreshAuth = async () => {
        const refreshed = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
          providerIds: ["openai"],
        });
        if (!refreshed) {
          throw new Error("prepared auth refresh was unavailable");
        }
        expect(
          Object.values(refreshed.authStore.profiles).filter(
            (profile) => profile.provider === "openai",
          ),
        ).toEqual([]);
        return refreshed.authModes;
      };
      expect((await refreshAuth()).codex).toBeUndefined();
      nativeCommand(
        ["login", "--with-api-key"],
        "sk-synthetic-warm-native-owner-111111111111111111111111111\n",
      );
      const nativeCredential = fs.readFileSync(path.join(codexHome, "auth.json"));

      expect((await refreshAuth()).codex).toEqual(
        nativeOwner && homeScope === "user" ? { source: "native", mode: "api_key" } : undefined,
      );
      expect(fs.readFileSync(path.join(codexHome, "auth.json"))).toEqual(nativeCredential);
      nativeCommand(["logout"]);
      expect(fs.existsSync(path.join(codexHome, "auth.json"))).toBe(false);
      expect((await refreshAuth()).codex).toBeUndefined();
      fixture.supersede();
      await expect(
        loadPreparedModelRuntimeAuth(fixture.snapshot, { providerIds: ["openai"] }),
      ).rejects.toThrow("superseded");
    },
  );

  it("keeps native Codex logins out of prepared OpenClaw profiles", async () => {
    const codexHome = makeTempDir("openclaw-prepared-codex-");
    writeCodexAuth(codexHome, "startup");
    const fixture = await withEnvAsync({ CODEX_HOME: codexHome }, () =>
      createStaticSnapshot(0, {}, { hydrateExternalCliProviderIds: ["openai"] }),
    );
    const preparedStore = getPreparedModelRuntimeAuthStore(fixture.snapshot);
    expect(fixture.hydratedAuthStore?.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toBeUndefined();
    expect(preparedStore?.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toBeUndefined();
    expect(preparedStore && getRuntimeExternalCliProfileIds(preparedStore)).toEqual([]);

    writeCodexAuth(codexHome, "rotated");
    const rotated = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [],
      profileIds: [OPENAI_CODEX_DEFAULT_PROFILE_ID],
    });
    expect(rotated?.authStore.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toBeUndefined();

    fs.rmSync(path.join(codexHome, "auth.json"));
    const loggedOut = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: ["openai"],
    });
    expect(loggedOut?.authStore.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toBeUndefined();
  });

  it("keeps accepted catalog and auth work alive after overload and permits later refresh", async () => {
    const fixture = await createReadyWorkerFixture(0);
    const barrier = `${fixture.marker}.hold`;
    fs.writeFileSync(barrier, "", "utf8");
    const catalog = fixture.snapshot.loadFullModelCatalog!();
    void catalog.catch(() => {});
    const accepted: ReturnType<typeof loadPreparedModelRuntimeAuth>[] = [];
    try {
      await waitForMarker(fixture.marker);
      // Alternating scopes reach the worker instead of sharing the latest auth request.
      for (let index = 0; index < 127; index += 1) {
        const auth = loadPreparedModelRuntimeAuth(fixture.snapshot, {
          providerIds: index % 2 === 0 ? [PROVIDER_ID] : [PROVIDER_ID, SHARED_AUTH_PROVIDER_ID],
        });
        void auth.catch(() => {});
        accepted.push(auth);
      }
      await expect(
        loadPreparedModelRuntimeAuth(fixture.snapshot, {
          providerIds: [PROVIDER_ID, SHARED_AUTH_PROVIDER_ID],
        }),
      ).rejects.toMatchObject({ name: "WorkerTaskError", code: "overloaded" });
      fs.rmSync(barrier);

      const outcomes = await Promise.allSettled([catalog, ...accepted]);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
      expect((await catalog).entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
      );
      fs.writeFileSync(fixture.externalAuthPath, "B", "utf8");
      const refreshedAuth = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
        providerIds: [PROVIDER_ID],
      });
      expect(refreshedAuth?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
        access: "v1:B",
      });
      const refreshedCatalog = await fixture.snapshot.loadFullModelCatalog!({ refresh: true });
      expect(refreshedCatalog.entries).toContainEqual(
        expect.objectContaining({
          provider: PROVIDER_ID,
          id: "proof-refresh-2-sqlite-true-shared-true-unrelated-true",
        }),
      );
    } finally {
      fs.rmSync(barrier, { force: true });
      await Promise.allSettled([catalog, ...accepted]);
    }
  });

  it("shares in-flight discovery, caches completion, and explicitly refreshes prepared facts", async () => {
    const fixture = await createReadyWorkerFixture(0);
    const barrier = `${fixture.marker}.hold`;
    // Keep discovery pending for both callers without relying on parent-thread scheduling.
    fs.writeFileSync(barrier, "", "utf8");
    let settled = false;
    const first = fixture.snapshot.loadFullModelCatalog?.().finally(() => {
      settled = true;
    });
    const second = fixture.snapshot.loadFullModelCatalog?.();
    const completion = Promise.all([first, second]);
    void completion.catch(() => {});
    try {
      await waitForMarker(fixture.marker);

      expect(settled).toBe(false);
      fs.rmSync(barrier);
      const [catalog, sharedCatalog] = await completion;
      expect(sharedCatalog).toBe(catalog);
      expect(catalog?.entries).toContainEqual(
        expect.objectContaining({
          provider: PROVIDER_ID,
          id: "proof-refresh-1-sqlite-true-shared-true-unrelated-true",
        }),
      );
      await expect(fixture.snapshot.loadFullModelCatalog?.()).resolves.toBe(catalog);
      const refreshedCatalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true });
      expect(refreshedCatalog?.entries).toContainEqual(
        expect.objectContaining({
          provider: PROVIDER_ID,
          id: "proof-refresh-2-sqlite-true-shared-true-unrelated-true",
        }),
      );
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\nstart\ndone\n");
    } finally {
      fixture.supersede();
      fs.rmSync(barrier, { force: true });
      await Promise.allSettled([completion]);
    }
  });

  it("terminates discovery when its owning generation is superseded", async () => {
    const fixture = await createReadyWorkerFixture(10_000);
    const catalog = fixture.snapshot.loadFullModelCatalog?.();
    void catalog?.catch(() => {});
    try {
      await waitForMarker(fixture.marker);
      const captures = readCatalogDiscoveryCaptures(fixture.root).filter(
        (capture) => capture.threadId !== threadId,
      );
      expect(captures.length).toBeGreaterThan(0);
      expect(captures.every((capture) => fs.existsSync(capture.filename))).toBe(true);
      fixture.supersede();

      await expect(catalog).rejects.toThrow("superseded");
      await waitForWorkers();
      expect(captures.filter((capture) => fs.existsSync(capture.filename))).toEqual([]);
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\n");
    } finally {
      fixture.supersede();
      await Promise.allSettled([catalog]);
    }
  });

  it("preserves ref-only api-key and token profiles through the real worker", async () => {
    const fixture = await createStaticSnapshot(0);
    await expectRefOnlyAuthProfilesThroughWorker(fixture);
  });
});
const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai:default";
