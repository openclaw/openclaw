import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import type { PreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog-auth.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
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
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForMarker, waitForWorkers } =
  usePreparedCatalogWorkerFixtures();

describe("prepared model catalog worker plugin scope", () => {
  it.each([
    { first: "full", asyncSyntheticAuth: false, syntheticAuthAvailable: true },
    { first: "scoped", asyncSyntheticAuth: true, syntheticAuthAvailable: false },
    { first: "held", asyncSyntheticAuth: true, syntheticAuthAvailable: false },
  ])("keeps models.list scoped with $first catalog discovery first", async (selection) => {
    const root = makeTempDir("openclaw-model-catalog-scope-worker-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(root, "workspace");
    const marker = path.join(root, "worker-marker.txt");
    const unrelatedMarker = path.join(root, "unrelated-worker-plugin.txt");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const pluginFile = writeFixturePlugin({ root, spinMs: 0, ...selection });
    const unrelatedPluginFile = writeUnrelatedFixturePlugin(root);
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
    const authStore = getPreparedModelRuntimeAuthStore(snapshot);
    if (!authStore) {
      throw new Error("prepared runtime produced no auth store");
    }
    const projectSnapshot = async (
      full: boolean,
      providerIds?: readonly string[],
      refresh?: boolean,
    ): Promise<PreparedGatewayModelCatalogSnapshot> => {
      const modelCatalog = full
        ? await snapshot.loadFullModelCatalog!({ providerIds, refresh })
        : snapshot.modelCatalog;
      return {
        ...modelCatalog,
        agentId: "main",
        agentDir,
        workspaceDir,
        config,
        observationConfig: snapshot.observationConfig,
        isCurrent: snapshot.isCurrent,
        pluginRegistry: snapshot.pluginRegistry,
        catalogComplete: full,
        authModes: snapshot.authModes,
        authStore,
        metadataSnapshot: snapshot.metadataSnapshot,
        authMaterializations: [],
      };
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
    let published = await projectSnapshot(false);
    registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
      loadDeferred: async (params) =>
        (published = await projectSnapshot(
          params?.readOnly === false,
          params?.providerDiscoveryProviderIds,
          params?.refreshFullCatalog === true,
        )),
      readPrepared: async () => published,
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
          await expect(observedRefresh).rejects.toThrow("superseded");
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
      await refresh;
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
