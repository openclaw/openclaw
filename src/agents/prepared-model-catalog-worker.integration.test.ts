import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { threadId, Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import { loadPreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withEnvAsync } from "../test-utils/env.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import { isPendingOAuthRefreshFence } from "./auth-profiles/oauth-refresh-marker.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import { stubCatalogEnv } from "./prepared-model-catalog-worker.shared.test-support.js";
import {
  DISCOVERED_HARNESS_ID,
  PROVIDER_ID,
  HARNESS_ID,
  MISSING_AUTH_HARNESS_ID,
  SHARED_AUTH_PROVIDER_ID,
  PROFILE_ID,
  MATERIALIZED_SECRET,
  REF_ONLY_API_PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_PROVIDER_ID,
  REF_ONLY_TOKEN_ENV,
  DURABLE_AUTH_PROVIDER_ID,
  DURABLE_AUTH_KEY,
  EXTERNAL_AUTH_PROFILE_ID,
  createCatalogFixture,
  catalogEntry,
  makeCatalogAgentFacts,
  pendingCatalogWork,
  catalogInput,
  startCatalogBuild,
  expectCatalogAuth,
  writeFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import { materializePreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { withHeldCatalogOAuthRefresh } from "./test-helpers/prepared-model-catalog-oauth-fixture.js";
import { createStaticCatalogSnapshotFixture } from "./test-helpers/prepared-model-catalog-static-fixture.js";
import {
  observeSyntheticAuth,
  loadCompletedFullCatalog,
  readCatalogDiscoveryCaptures,
  usePreparedCatalogWorkerFixtures,
  writeCodexAuth,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers, observeCatalogEntry } =
  usePreparedCatalogWorkerFixtures({ observeCatalogWork: true });

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
const createStaticSnapshot = createStaticCatalogSnapshotFixture({
  makeTempDir,
  retireAfterTest,
  receiptBroadcastName: () => receipts.broadcastName,
});
type Snapshot = Parameters<typeof loadPreparedModelRuntimeAuth>[0];
const requestAuth = (snapshot: Snapshot, providerIds = [PROVIDER_ID]) =>
  loadPreparedModelRuntimeAuth(snapshot, { providerIds });
const profileFrom = (
  auth: { authStore: AuthProfileStore } | undefined,
  id = EXTERNAL_AUTH_PROFILE_ID,
) => auth?.authStore.profiles[id];
const refreshProfile = async (snapshot: Snapshot) => profileFrom(await requestAuth(snapshot));
const proofEntry = (invocation: number) =>
  catalogEntry(`proof-refresh-${invocation}-sqlite-true-shared-true-unrelated-true`);
function expectDurableAvailability(
  result: Awaited<ReturnType<typeof buildModelsListResult>>,
  available: boolean,
) {
  expect(result.models).toContainEqual(expect.objectContaining({ id: "durable-model", available }));
}
function heldDiscovery(fixture: { marker: string; agentDir: string }, retire?: () => void) {
  const hold = `${fixture.marker}.hold`;
  fs.writeFileSync(hold, "", "utf8");
  return {
    ...pendingCatalogWork(hold, retire),
    entered: observeCatalogEntry(receipts, fixture),
    release: () => fs.rmSync(hold),
  };
}
const saveProfiles = (
  agentDir: string,
  profiles: AuthProfileStore["profiles"],
  usageStats?: AuthProfileStore["usageStats"],
) => saveAuthProfileStore({ version: 1, profiles, usageStats }, agentDir);

async function createReadyWorkerFixture(spinMs: number) {
  const fixture = await createStaticSnapshot(spinMs);
  // Warm the worker without running discovery hooks.
  await requestAuth(fixture.snapshot, []);
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
    expect(catalog.entries).toContainEqual(catalogEntry("plugin-generation-v1"));
  });

  it("preserves prepared catalog ownership across ambient environment changes", async () => {
    const homeA = makeTempDir("openclaw-catalog-owner-home-a-");
    const homeB = makeTempDir("openclaw-catalog-owner-home-b-");
    const codexHome = makeTempDir("openclaw-catalog-owner-empty-codex-");
    vi.stubEnv("HOME", homeA);
    vi.stubEnv("OPENCLAW_HOME", homeA);
    vi.stubEnv("CODEX_HOME", codexHome);
    const fixture = await createCatalogFixture(makeTempDir, 0);
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.env.OPENCLAW_STATE_DIR);
    const config = {
      ...fixture.config,
      agents: { ...fixture.config.agents, entries: { main: {} } },
    } satisfies OpenClawConfig;
    const agentDir = resolveAgentDir(config, "main", fixture.env);
    const workspaceDir = resolveAgentWorkspaceDir(config, "main", fixture.env);
    expect(agentDir).toBe(fixture.agentDir);
    const input = catalogInput(fixture, { config, workspaceDir: undefined });
    const retirement = new AbortController();
    const supersede = () => retirement.abort();
    retireAfterTest(supersede);
    const build = startCatalogBuild(input, retirement);
    let snapshot: Awaited<typeof build.pending>[number]["snapshot"] | undefined;
    let driftedAgentDir: string | undefined;
    try {
      const result = (await build.pending)[0]!;
      retireAfterTest(retainPreparedPluginGeneration(result.pluginGeneration));
      snapshot = result.snapshot;
      const modelCatalog = await loadCompletedFullCatalog(snapshot);
      expect(modelCatalog.entries).toContainEqual(catalogEntry("plugin-generation-v1"));
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
        await Promise.allSettled([requestAuth(snapshot, [])]);
      }
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
      if (driftedAgentDir) {
        unregisterResolvedAgentDir({ agentId: "main", agentDir: driftedAgentDir });
      }
      vi.unstubAllEnvs();
    }
  });

  it("keeps unaffected workers live across scoped sibling reloads", async ({ signal }) => {
    const fixture = await createCatalogFixture(
      makeTempDir,
      0,
      {},
      { receiptBroadcastName: receipts.broadcastName },
    );
    // Configured publication reads the parent environment, unlike explicit fixture builds.
    stubCatalogEnv(fixture.env);
    const siblingDir = path.join(fixture.root, "sibling-agent");
    const configWithSiblingPolicy = (ask: "off" | "always") =>
      ({
        ...fixture.config,
        agents: {
          ...fixture.config.agents,
          entries: {
            main: { agentDir: fixture.agentDir, workspace: fixture.workspaceDir },
            sibling: {
              agentDir: siblingDir,
              workspace: fixture.workspaceDir,
              tools: { exec: { security: "full", ask } },
            },
          },
        },
      }) satisfies OpenClawConfig;
    const initialConfig = configWithSiblingPolicy("off");
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
    expect(catalog.entries).toContainEqual(catalogEntry("plugin-generation-v1"));
    expect(await refreshProfile(sibling)).toMatchObject({ access: "v1:A" });
    await loadCompletedFullCatalog(sibling);
    const completed = fs.readFileSync(fixture.marker, "utf8");
    const nextInvocation = () => fs.readFileSync(fixture.marker, "utf8").split("start\n").length;
    const heldInvocation = nextInvocation();

    await using held = heldDiscovery(fixture);
    const inFlight = held.track(loadCompletedFullCatalog(main, { refresh: true }));
    await held.entered(inFlight, signal);
    expect(fs.readFileSync(fixture.marker, "utf8")).toBe(`${completed}start\n`);
    const nextConfig = configWithSiblingPolicy("always");
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      ...options,
      agentIds: new Set(["sibling"]),
    });
    const retained = getPreparedModelRuntimeSnapshot({ ...mainInput, config: nextConfig })!;
    expect(buildCounts).toEqual([2, 1]);
    expect(retained.modelCatalog).toBe(main.modelCatalog);
    expect(retained.metadataSnapshot).toBe(main.metadataSnapshot);
    expect(retained.readFullModelCatalog!()).toBe(catalog);
    await expect(requestAuth(sibling)).rejects.toThrow("superseded");
    await expect(sibling.loadFullModelCatalog!()).rejects.toThrow("superseded");

    held.release();
    const refreshed = await inFlight;
    expect(refreshed).not.toBe(catalog);
    expect(retained.readFullModelCatalog!()).toBe(refreshed);
    expect(refreshed.entries).toContainEqual(proofEntry(heldInvocation));
    const replaced = getPreparedModelRuntimeSnapshot({ ...siblingInput, config: nextConfig })!;
    await loadCompletedFullCatalog(replaced);
    fs.writeFileSync(fixture.externalAuthPath, "B", "utf8");
    expect(await refreshProfile(retained)).toMatchObject({ access: "v1:B" });
    const refreshedInvocation = nextInvocation();
    const renewed = await loadCompletedFullCatalog(retained, { refresh: true });
    expect(renewed.entries).toContainEqual(proofEntry(refreshedInvocation));
    expect(await refreshProfile(replaced)).toMatchObject({ access: "v1:B" });
  });

  it("keeps activated metadata discovery scope with auth refresh first", async () => {
    const fixture = await createStaticSnapshot(0, {}, { metadataWorkspace: "activation" });
    expect(await refreshProfile(fixture.snapshot)).toMatchObject({ access: "v1:A" });
    const catalog = await loadCompletedFullCatalog(fixture.snapshot);
    expect(catalog.entries).toContainEqual(catalogEntry("plugin-generation-v1"));
  });

  it("pairs full catalog native routes with exact-generation async auth", async () => {
    const fixture = await createStaticSnapshot(
      0,
      {},
      {
        metadataWorkspace: "none",
        provideMetadataToWorker: true,
        asyncSyntheticAuth: true,
      },
    );
    expect(fixture.snapshot.authModes[HARNESS_ID]).toBe("api_key");
    for (const id of [DISCOVERED_HARNESS_ID, MISSING_AUTH_HARNESS_ID, PROVIDER_ID]) {
      expect(fixture.snapshot.authModes[id]).toBeUndefined();
    }
    await requestAuth(fixture.snapshot, []);

    const catalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true, wait: true });
    const fullAuth = getPreparedModelFullCatalogAuth(catalog!);

    expect(fullAuth?.credentials?.[DISCOVERED_HARNESS_ID]).toEqual({
      type: "api_key",
      key: "discovered-native-login-not-real",
    });
    expect(catalog).not.toHaveProperty("credentials");

    expect(
      fs
        .readFileSync(path.join(fixture.root, "synthetic-auth-owner.txt"), "utf8")
        .trim()
        .split("\n"),
    ).toContain("parent");
    expect(fullAuth?.authModes).toMatchObject({
      [HARNESS_ID]: "api_key",
      [DISCOVERED_HARNESS_ID]: "api_key",
      [PROVIDER_ID]: "oauth",
    });
    expect(fullAuth?.authModes[MISSING_AUTH_HARNESS_ID]).toBeUndefined();
  });

  it.for([
    { retirement: "superseded", request: "catalog" },
    { retirement: "process close", request: "catalog" },
    { retirement: "process close", request: "auth" },
  ])(
    "aborts and joins parent $request preparation before $retirement completes",
    async ({ retirement, request }, { signal }) => {
      const fixture = await createStaticSnapshot(0, {}, { asyncSyntheticAuth: true });
      await requestAuth(fixture.snapshot, []);
      const hold = path.join(fixture.root, "synthetic-auth-hold");
      const started = path.join(fixture.root, "synthetic-auth-owner.txt");
      const cancelled = path.join(fixture.root, "synthetic-auth-cancel.txt");
      fs.rmSync(started, { force: true });
      fs.writeFileSync(hold, "");
      const auth = observeSyntheticAuth(fixture.root);
      let settled = false;
      const catalog = (
        request === "auth"
          ? requestAuth(fixture.snapshot, [])
          : fixture.snapshot.loadFullModelCatalog!({ refresh: true, wait: true })
      ).finally(() => {
        settled = true;
      });
      void catalog.catch(() => {});
      let closing: Promise<void> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(auth.entered, catalog, `Timed out waiting for ${started}`),
          signal,
        );
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
        await withinTest(
          awaitGateBeforeSettlement(auth.aborted, catalog, `Timed out waiting for ${cancelled}`),
          signal,
        );
        expect(settled).toBe(false);
        fs.rmSync(hold);
        await expect(catalog).rejects.toThrow(
          retirement === "superseded" ? "superseded" : "closed",
        );
        await closing;
        expect(fs.readFileSync(cancelled, "utf8")).toBe("abort\njoined\n");
        await waitForWorkers();
      } finally {
        auth.close();
        fs.rmSync(hold, { force: true });
        fixture.supersede();
        await Promise.allSettled([catalog, closing]);
      }
    },
  );

  it("settles OAuth rotation before worker retirement", async ({ signal }) => {
    using terminate = vi.spyOn(Worker.prototype, "terminate");
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
  });

  it("preserves a materialized SecretRef when durable auth retains only its descriptor", async () => {
    const fixture = await createStaticSnapshot(0);
    const tokenRef = { source: "env", provider: "default", id: "SHARED_SECRET_REF" } as const;
    saveProfiles(fixture.agentDir, {
      [PROFILE_ID]: {
        type: "token",
        provider: SHARED_AUTH_PROVIDER_ID,
        tokenRef,
      },
    });

    const catalog = await loadCompletedFullCatalog(fixture.snapshot);

    expect(catalog?.entries).toContainEqual(proofEntry(1));
    expect(profileFrom(getPreparedModelFullCatalogAuth(catalog!), PROFILE_ID)).toMatchObject({
      token: MATERIALIZED_SECRET,
      tokenRef,
    });
  });

  it("refreshes durable auth additions, updates and removals", async ({ signal }) => {
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
        entries: { main: { agentDir: fixture.agentDir, workspace: fixture.workspaceDir } },
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
      const authStore = expectDefined(
        getPreparedModelRuntimeAuthStore(materialized),
        "catalog auth",
      );
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
    const profileId = `${DURABLE_AUTH_PROVIDER_ID}:default`;
    const writeDurableProfile = (key?: string, usageStats?: AuthProfileStore["usageStats"]) => {
      const profiles: AuthProfileStore["profiles"] = {};
      if (key) {
        profiles[profileId] = { type: "api_key", provider: DURABLE_AUTH_PROVIDER_ID, key };
      }
      saveProfiles(fixture.agentDir, profiles, usageStats);
    };

    writeDurableProfile(DURABLE_AUTH_KEY);
    const added = await projectModels();
    const addedCatalog = fixture.snapshot.readFullModelCatalog!();
    expect(addedCatalog?.entries).toContainEqual(catalogEntry("post-startup-auth-model"));
    expect(profileFrom(getPreparedModelFullCatalogAuth(addedCatalog!), profileId)).toMatchObject({
      key: DURABLE_AUTH_KEY,
    });
    expectCatalogAuth(fixture.snapshot, DURABLE_AUTH_PROVIDER_ID).toContain("post-sta...not-real");
    expectDurableAvailability(added.result, true);
    expect(added.projected.authStore?.profiles[profileId]).toMatchObject({ key: DURABLE_AUTH_KEY });

    writeDurableProfile("second-key-not-real");
    const updated = await project();
    expectCatalogAuth(fixture.snapshot, DURABLE_AUTH_PROVIDER_ID).toContain("second-k...not-real");
    expect(updated.authStore?.profiles[profileId]).toMatchObject({ key: "second-key-not-real" });

    const fullCatalog = expectDefined(
      fixture.snapshot.readFullModelCatalog?.(),
      "published catalog",
    );
    const fullAuth = getPreparedModelFullCatalogAuth(fullCatalog)!;
    const discoveryBeforeUsage = fs.readFileSync(fixture.marker, "utf8");
    for (const cooldownUntil of [Date.now() + 60_000, undefined, Date.now() + 120_000]) {
      writeDurableProfile(
        "second-key-not-real",
        cooldownUntil === undefined ? {} : { [profileId]: { cooldownUntil } },
      );
      const current = await projectModels(false);
      expectDurableAvailability(current.result, cooldownUntil === undefined);
      const currentAuth = getPreparedModelFullCatalogAuth(fullCatalog)!;
      expect(currentAuth.authStore.profiles).toBe(fullAuth.authStore.profiles);
      expect(currentAuth.authModes).toBe(fullAuth.authModes);
      expect(currentAuth.providerAuthLabels).toBe(fullAuth.providerAuthLabels);
      expect(currentAuth.credentials).toBe(fullAuth.credentials);
    }
    expect(fs.readFileSync(fixture.marker, "utf8")).toBe(discoveryBeforeUsage);

    await using held = heldDiscovery(fixture);
    const pending = held.track(loadCompletedFullCatalog(fixture.snapshot, { refresh: true }));
    await held.entered(pending, signal);
    expect(fs.readFileSync(fixture.marker, "utf8")).not.toBe(discoveryBeforeUsage);
    writeDurableProfile("second-key-not-real", {});
    held.release();
    await pending;
    const recovered = await projectModels(false);
    expectDurableAvailability(recovered.result, true);

    writeDurableProfile();
    const removed = await projectModels();
    expectCatalogAuth(fixture.snapshot, DURABLE_AUTH_PROVIDER_ID).toBe("missing");
    expectDurableAvailability(removed.result, false);
    expect(removed.projected.authStore).toBeDefined();
    expect(removed.projected.authStore?.profiles[profileId]).toBeUndefined();
    fixture.supersede();
    await waitForWorkers({ requireCreated: true });
    expect(getPreparedModelFullCatalogAuth(fullCatalog)?.authStore).toBe(fullAuth.authStore);
  });

  it("refreshes plugin external auth without changing the prepared plugin generation", async () => {
    const fixture = await createStaticSnapshot(0);
    fs.rmSync(fixture.externalAuthPath);
    expect(await refreshProfile(fixture.snapshot)).toBeUndefined();

    fs.writeFileSync(fixture.externalAuthPath, "A", "utf8");
    expect(await refreshProfile(fixture.snapshot)).toMatchObject({ access: "v1:A" });

    writeFixturePlugin({ root: fixture.root, spinMs: 0, pluginVersion: "v2" });
    fs.writeFileSync(fixture.externalAuthPath, "B", "utf8");

    expect(await refreshProfile(fixture.snapshot)).toMatchObject({ access: "v1:B" });

    const catalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true });
    expect(catalog?.entries).toContainEqual(catalogEntry("plugin-generation-v1"));
    expect(catalog?.entries).not.toContainEqual(catalogEntry("plugin-generation-v2"));
    expect(profileFrom(getPreparedModelFullCatalogAuth(catalog!))).toMatchObject({
      access: "v1:B",
    });

    fs.rmSync(fixture.externalAuthPath);
    expect(await refreshProfile(fixture.snapshot)).toBeUndefined();
  });

  it.each([
    [false, undefined],
    [true, "agent"],
    [true, "user"],
  ] as const)(
    "auth-refresh worker request scopes native login/logout to explicit sharing (nativeOwner=%s, homeScope=%s)",
    async (nativeOwner, homeScope) => {
      // Ambient OpenAI auth would make the route available before the staged login.
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
        expect(result.error, result.stderr).toBeUndefined();
        expect(result, result.stderr).toMatchObject({ signal: null, status: 0 });
      };
      const refreshAuth = async () => {
        const refreshed = expectDefined(
          await requestAuth(fixture.snapshot, ["openai"]),
          "auth refresh",
        );
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
      await expect(requestAuth(fixture.snapshot, ["openai"])).rejects.toThrow("superseded");
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

    writeCodexAuth(codexHome, "rotated");
    const rotated = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [],
      profileIds: [OPENAI_CODEX_DEFAULT_PROFILE_ID],
    });
    expect(rotated?.authStore.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toBeUndefined();

    fs.rmSync(path.join(codexHome, "auth.json"));
    const loggedOut = await requestAuth(fixture.snapshot, ["openai"]);
    expect(loggedOut?.authStore.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toBeUndefined();
  });

  it("preserves accepted work and later refresh after overload", async ({ signal }) => {
    const fixture = await createReadyWorkerFixture(0);
    await using work = heldDiscovery(fixture);
    const catalog = work.track(loadCompletedFullCatalog(fixture.snapshot));
    const accepted: ReturnType<typeof loadPreparedModelRuntimeAuth>[] = [];
    await work.entered(catalog, signal);
    // Alternating scopes reach the worker instead of sharing the latest auth request.
    for (let index = 0; index < 127; index += 1) {
      const auth = work.track(
        requestAuth(
          fixture.snapshot,
          index % 2 === 0 ? [PROVIDER_ID] : [PROVIDER_ID, SHARED_AUTH_PROVIDER_ID],
        ),
      );
      accepted.push(auth);
    }
    await expect(
      requestAuth(fixture.snapshot, [PROVIDER_ID, SHARED_AUTH_PROVIDER_ID]),
    ).rejects.toMatchObject({ name: "WorkerTaskError", code: "overloaded" });
    work.release();

    const outcomes = await Promise.allSettled([catalog, ...accepted]);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    expect((await catalog).entries).toContainEqual(catalogEntry("plugin-generation-v1"));
    fs.writeFileSync(fixture.externalAuthPath, "B", "utf8");
    expect(await refreshProfile(fixture.snapshot)).toMatchObject({ access: "v1:B" });
    const refreshedCatalog = await fixture.snapshot.loadFullModelCatalog!({ refresh: true });
    expect(refreshedCatalog.entries).toContainEqual(proofEntry(2));
  });

  it("shares in-flight discovery, caches and refreshes completion", async ({ signal }) => {
    const fixture = await createReadyWorkerFixture(0);
    await using work = heldDiscovery(fixture, fixture.supersede);
    let settled = false;
    const refreshOptions = { refresh: true, wait: true };
    const first = fixture.snapshot.loadFullModelCatalog?.(refreshOptions).finally(() => {
      settled = true;
    });
    const second = fixture.snapshot.loadFullModelCatalog?.(refreshOptions);
    const completion = work.track(Promise.all([first, second]));
    await work.entered(completion, signal);

    expect(settled).toBe(false);
    work.release();
    const [catalog, sharedCatalog] = await completion;
    expect(sharedCatalog).toBe(catalog);
    expect(catalog?.entries).toContainEqual(proofEntry(1));
    await expect(fixture.snapshot.loadFullModelCatalog?.()).resolves.toBe(catalog);
    const refreshedCatalog = await fixture.snapshot.loadFullModelCatalog?.(refreshOptions);
    expect(refreshedCatalog?.entries).toContainEqual(proofEntry(2));
    expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\nstart\ndone\n");
  });

  it("terminates discovery when its owning generation is superseded", async ({ signal }) => {
    const fixture = await createReadyWorkerFixture(10_000);
    await using work = pendingCatalogWork(`${fixture.marker}.hold`, fixture.supersede);
    const entered = observeCatalogEntry(receipts, fixture);
    const catalog = work.track(fixture.snapshot.loadFullModelCatalog!());
    await entered(catalog, signal);
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
  });

  it("preserves ref-only api-key and token profiles through the real worker", async () => {
    const fixture = await createStaticSnapshot(0);
    const authStore: AuthProfileStore = { version: 1, profiles: {} };
    for (const [provider, type, id] of [
      [REF_ONLY_API_PROVIDER_ID, "api_key", REF_ONLY_API_ENV],
      [REF_ONLY_TOKEN_PROVIDER_ID, "token", REF_ONLY_TOKEN_ENV],
    ] as const) {
      const ref = { source: "env", provider: "default", id } as const;
      authStore.profiles[`${provider}:default`] =
        type === "api_key" ? { type, provider, keyRef: ref } : { type, provider, tokenRef: ref };
    }
    const worker = createPreparedModelCatalogWorker({
      agentFacts: makeCatalogAgentFacts(catalogInput(fixture, { inheritedAuthDir: undefined }), {
        authStore,
      }),
      pluginMetadataSnapshot: fixture.pluginMetadataSnapshot,
      isCurrent: fixture.isCurrent,
      retirementSignal: fixture.retirementSignal,
    });
    const { modelCatalog: catalog } = await worker.loadCatalog();

    expect(catalog.entries).toContainEqual(catalogEntry("ref-proof-api-true-token-true"));
  });
});
const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai:default";
