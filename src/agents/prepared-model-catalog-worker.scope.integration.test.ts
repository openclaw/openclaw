import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import type { PreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog-auth.js";
import { loadPreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { MINIMAX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { RuntimeAuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  HARNESS_ID,
  PLUGIN_ID,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
  UNRELATED_PLUGIN_ID,
  UNRELATED_PLUGIN_WORKER_MARKER_ENV,
  UNRELATED_SYNTHETIC_AUTH_ID,
  writeFixturePlugin,
  writeUnrelatedFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import { materializePreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeCatalog,
} from "./prepared-model-runtime.js";
import { createStaticCatalogSnapshotFixture } from "./test-helpers/prepared-model-catalog-static-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForMarker, waitForWorkers } =
  usePreparedCatalogWorkerFixtures();

const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });

describe("prepared model catalog worker plugin scope", () => {
  it("retains refreshed CLI auth while acquiring an unrelated provider catalog", async () => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
    const cliHome = makeTempDir("openclaw-catalog-cli-auth-home-");
    const fixture = await createStaticSnapshot(0, { HOME: cliHome });
    const provider = "minimax-portal";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [MINIMAX_CLI_PROFILE_ID]: {
            type: "oauth",
            provider,
            access: "expired-cli-access-not-real",
            refresh: "same-cli-login-not-real",
            expires: 1,
          },
        },
        order: { [provider]: [MINIMAX_CLI_PROFILE_ID] },
      },
      fixture.agentDir,
    );
    const cliCredentials = path.join(cliHome, ".minimax", "oauth_creds.json");
    fs.mkdirSync(path.dirname(cliCredentials), { recursive: true });
    fs.writeFileSync(
      cliCredentials,
      JSON.stringify({
        access_token: "refreshed-cli-access-not-real",
        refresh_token: "same-cli-login-not-real",
        expiry_date: Date.now() + 3_600_000,
      }),
    );

    const refreshed = await fixture.snapshot.loadFullModelCatalog!({
      refresh: true,
      providerIds: [provider],
    });
    const expected = getPreparedModelFullCatalogAuth(refreshed)!;
    expect(expected.credentials?.[provider]).toMatchObject({
      access: "refreshed-cli-access-not-real",
    });
    expect(expected.authStore.profiles[MINIMAX_CLI_PROFILE_ID]).toMatchObject({
      access: "refreshed-cli-access-not-real",
    });
    const expectedStore: RuntimeAuthProfileStore = expected.authStore;
    expect(expectedStore.runtimeLocalProfileIds).toContain(MINIMAX_CLI_PROFILE_ID);
    expect(expectedStore.runtimeLocalOrderProviderIds).toContain(provider);

    const unrelated = await fixture.snapshot.loadFullModelCatalog!({
      refresh: true,
      providerIds: [PROVIDER_ID],
    });
    expect(unrelated.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
    );
    const retained = getPreparedModelFullCatalogAuth(unrelated)!;
    expect(retained.credentials?.[provider]).toEqual(expected.credentials?.[provider]);
    expect(retained.authStore.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
      expected.authStore.profiles[MINIMAX_CLI_PROFILE_ID],
    );
    const retainedStore: RuntimeAuthProfileStore = retained.authStore;
    expect(retainedStore.runtimeLocalProfileIds).toContain(MINIMAX_CLI_PROFILE_ID);
    expect(retainedStore.runtimeLocalOrderProviderIds).toContain(provider);
    expect(retainedStore.runtimePersistedProfileIds ?? []).not.toContain(MINIMAX_CLI_PROFILE_ID);
    expect(retainedStore.order?.[provider]).toEqual(expectedStore.order?.[provider]);
    expect(fixture.snapshot.isCurrent()).toBe(true);
  });

  it.each([
    { first: "full", slot: "memory", asyncSyntheticAuth: false, syntheticAuthAvailable: true },
    {
      first: "scoped",
      slot: "contextEngine",
      asyncSyntheticAuth: true,
      syntheticAuthAvailable: false,
    },
    { first: "held", slot: "none", asyncSyntheticAuth: true, syntheticAuthAvailable: false },
  ])("keeps models.list scoped with $first discovery and $slot selected", async (selection) => {
    const root = makeTempDir("openclaw-model-catalog-scope-worker-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(root, "workspace");
    const marker = path.join(root, "worker-marker.txt");
    const catalogHold = `${marker}.hold`;
    if (selection.first === "scoped") {
      fs.writeFileSync(catalogHold, "");
    }
    const unrelatedMarker = path.join(root, "unrelated-worker-plugin.txt");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const pluginFile = writeFixturePlugin({ root, spinMs: 0, ...selection });
    const unrelatedPluginFile = writeUnrelatedFixturePlugin(
      root,
      selection.slot === "memory"
        ? "memory"
        : selection.slot === "contextEngine"
          ? "context-engine"
          : undefined,
    );
    const config = {
      agents: {
        defaults: {
          model: `${PROVIDER_ID}/sqlite-model`,
          models: {
            [`${PROVIDER_ID}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } },
            "published-fixture/published-model": { agentRuntime: { id: "openclaw" } },
          },
        },
        list: [{ id: "main", default: true, agentDir, workspace: workspaceDir }],
      },
      models: {
        providers: {
          "published-fixture": {
            api: "openai-completions",
            baseUrl: "https://published-fixture.invalid/v1",
            apiKey: "published-fixture-key-not-real",
            models: [
              {
                id: "published-model",
                name: "Published model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 1_024,
              },
            ],
          },
        },
      },
      plugins: {
        allow: [PLUGIN_ID, UNRELATED_PLUGIN_ID],
        ...(selection.slot === "memory"
          ? { slots: { memory: UNRELATED_PLUGIN_ID } }
          : selection.slot === "contextEngine"
            ? { slots: { contextEngine: UNRELATED_PLUGIN_ID } }
            : {}),
        load: { paths: [pluginFile, unrelatedPluginFile] },
        entries: {
          [PLUGIN_ID]: { enabled: true },
          [UNRELATED_PLUGIN_ID]: { enabled: true },
        },
      },
    } satisfies OpenClawConfig;
    const env = {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKER_CATALOG_MARKER: marker,
      [UNRELATED_PLUGIN_WORKER_MARKER_ENV]: unrelatedMarker,
      [REF_ONLY_API_ENV]: "ref-only-api-secret-not-real",
      [REF_ONLY_TOKEN_ENV]: "ref-only-token-secret-not-real",
    };
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: { version: 1, profiles: {} } }]);

    const input = {
      agentId: "main",
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir,
      config,
      env,
    };
    retireAfterTest(() => {
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env });
    });
    const snapshot = await publishPreparedModelRuntimeSnapshot(input, {
      provenance: "configured",
      catalogMode: "static",
    });
    const projectSnapshot = async (
      full: boolean,
      providerIds?: readonly string[],
      refresh?: boolean,
    ): Promise<PreparedGatewayModelCatalogSnapshot> => {
      const modelCatalog = full
        ? await refreshPreparedModelRuntimeCatalog(snapshot, { providerIds, refresh })
        : snapshot.readFullModelCatalog?.();
      const owner = materializePreparedModelCatalogOwner(snapshot, modelCatalog);
      return await loadPreparedGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot: async () => owner,
      });
    };
    const waitForPublication = async (previous: ModelCatalogSnapshot | undefined) => {
      await expect
        .poll(
          () => {
            const catalog = snapshot.readFullModelCatalog?.();
            return Boolean(
              catalog &&
              catalog !== previous &&
              !catalog.pendingProviders?.length &&
              !catalog.refreshFailed,
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    };
    const loadGatewayModelCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] =
      async (params) => {
        const {
          authModes: _authModes,
          authStore: _authStore,
          metadataSnapshot: _metadataSnapshot,
          authMaterializations: _authMaterializations,
          observationConfig: _observationConfig,
          isCurrent: _isCurrent,
          pluginRegistry: _pluginRegistry,
          ...publicSnapshot
        } = await projectSnapshot(params?.readOnly === false);
        return publicSnapshot;
      };
    registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
      loadDeferred: async (params) =>
        await projectSnapshot(
          params?.readOnly === false,
          params?.providerDiscoveryProviderIds,
          params?.refreshFullCatalog === true,
        ),
      readPrepared: async () => await projectSnapshot(false),
    });
    const respond = vi.fn();
    const context = Object.assign({} as GatewayRequestContext, {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn(), warn: vi.fn() },
    });
    if (selection.first !== "full") {
      expect(snapshot.authModes[HARNESS_ID]).toBeUndefined();
      const probePath = path.join(root, "synthetic-auth-probes.txt");
      const ownerPath = path.join(root, "synthetic-auth-owner.txt");
      fs.writeFileSync(probePath, "");
      fs.writeFileSync(ownerPath, "");
      const hold = path.join(root, "synthetic-auth-hold");
      if (selection.first === "held") {
        fs.writeFileSync(hold, "");
      }
      // The first worker operation must enter through the registered scoped refresh.
      const params = { view: "all", provider: PROVIDER_ID, refresh: true };
      const previousCatalog = snapshot.readFullModelCatalog?.();
      const refresh = Promise.resolve(
        expectDefined(
          modelsHandlers["models.list"],
          "models.list test invariant",
        )({
          req: { type: "req", id: "models-list-cold-scoped", method: "models.list", params },
          params,
          respond: respond as RespondFn,
          client: null,
          isWebchatConnect: () => false,
          context,
        }),
      );
      if (selection.first === "held") {
        let settled = false;
        const observedRefresh = refresh.finally(() => {
          settled = true;
        });
        void observedRefresh.catch(() => {});
        try {
          await vi.waitFor(() => expect(fs.readFileSync(ownerPath, "utf8")).toContain("parent\n"));
          // The entered probe stays pending until abort; later publication probes may proceed.
          fs.rmSync(hold);
          const readStarted = performance.now();
          const readRespond = vi.fn();
          await expectDefined(
            modelsHandlers["models.list"],
            "models.list test invariant",
          )({
            req: { type: "req", id: "models-list-during-refresh", method: "models.list" },
            params: { view: "all" },
            respond: readRespond as RespondFn,
            client: null,
            isWebchatConnect: () => false,
            context,
          });
          const readMs = performance.now() - readStarted;
          expect(settled).toBe(false);
          const publicationStarted = performance.now();
          const replacementInput = {
            ...input,
            config: {
              ...config,
              agents: {
                ...config.agents,
                list: [
                  {
                    id: "main",
                    default: true,
                    agentDir,
                    workspace: workspaceDir,
                    name: "Updated agent",
                  },
                ],
              },
            },
          };
          const publishedReplacement = await publishPreparedModelRuntimeSnapshot(replacementInput, {
            force: true,
            provenance: "configured",
            catalogMode: "static",
          }).then((replacement) => ({
            snapshot: replacement,
            elapsedMs: performance.now() - publicationStarted,
          }));
          expect(readMs).toBeLessThan(5_000);
          expect(publishedReplacement.elapsedMs).toBeLessThan(5_000);
          expect(readRespond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              models: expect.arrayContaining([
                expect.objectContaining({ provider: "published-fixture", id: "published-model" }),
              ]),
            }),
            undefined,
          );
          expect(getPreparedModelRuntimeSnapshot(replacementInput)).toBe(
            publishedReplacement.snapshot,
          );
          expect(snapshot.isCurrent()).toBe(false);
          console.info("held models.list responsiveness", {
            readMs,
            publicationMs: publishedReplacement.elapsedMs,
            responseBoundMs: 5_000,
          });
          const cancelled = path.join(root, "synthetic-auth-cancel.txt");
          await waitForMarker(cancelled);
          await observedRefresh;
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
          expect(fs.readFileSync(cancelled, "utf8")).toBe("abort\njoined\n");
          await waitForWorkers();
        } finally {
          fs.rmSync(hold, { force: true });
          await drainGlobalSingletonLifecycleState("close");
          await Promise.allSettled([observedRefresh]);
        }
        return;
      }
      try {
        await refresh;
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({ pendingProviders: [PROVIDER_ID] }),
          undefined,
        );
      } finally {
        fs.rmSync(catalogHold, { force: true });
      }
      await waitForPublication(previousCatalog);
      respond.mockClear();
      await expectDefined(
        modelsHandlers["models.list"],
        "models.list test invariant",
      )({
        req: { type: "req", id: "models-list-scoped-published", method: "models.list" },
        params: { view: "all", provider: PROVIDER_ID },
        respond: respond as RespondFn,
        client: null,
        isWebchatConnect: () => false,
        context,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          models: expect.arrayContaining([
            expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
          ]),
        }),
        undefined,
      );
      const probes = fs.readFileSync(probePath, "utf8").trim().split("\n");
      expect(probes).toContain(HARNESS_ID);
      expect(probes).not.toContain(UNRELATED_SYNTHETIC_AUTH_ID);
      expect(new Set(fs.readFileSync(ownerPath, "utf8").trim().split("\n"))).toEqual(
        new Set(["parent"]),
      );
      expect(fs.existsSync(unrelatedMarker)).toBe(false);
      respond.mockClear();
    }
    const previousCatalog = snapshot.readFullModelCatalog?.();
    await expectDefined(
      modelsHandlers["models.list"],
      'modelsHandlers["models.list"] test invariant',
    )({
      req: {
        type: "req",
        id: "models-list-worker-scope",
        method: "models.list",
        params: { view: "all", refresh: true },
      },
      params: { view: "all", refresh: true },
      respond: respond as RespondFn,
      client: null,
      isWebchatConnect: () => false,
      context,
    });
    await waitForPublication(previousCatalog);
    respond.mockClear();
    await expectDefined(
      modelsHandlers["models.list"],
      "models.list test invariant",
    )({
      req: { type: "req", id: "models-list-full-published", method: "models.list" },
      params: { view: "all" },
      respond: respond as RespondFn,
      client: null,
      isWebchatConnect: () => false,
      context,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        models: expect.arrayContaining([
          expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
        ]),
      }),
      undefined,
    );
    expect(fs.existsSync(unrelatedMarker)).toBe(false);
  });
});
