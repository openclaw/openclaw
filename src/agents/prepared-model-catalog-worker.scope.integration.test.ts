import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot as loadPublicCatalog,
  loadPreparedGatewayModelCatalogSnapshot,
} from "../gateway/server-model-catalog.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { MINIMAX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { model } from "./model-catalog-fixtures.test-support.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
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
  UNRELATED_SYNTHETIC_AUTH_ID,
  writeFixturePlugin,
  writeFixtureFiles,
  writeUnrelatedFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import { materializePreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeCatalog,
} from "./prepared-model-runtime.js";
import { CREDENTIAL_ONLY_PROVIDER_ID } from "./test-helpers/prepared-model-catalog-credential-only.test-support.js";
import { createStaticCatalogSnapshotFixture } from "./test-helpers/prepared-model-catalog-static-fixture.js";
import {
  observeSyntheticAuth,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers } = usePreparedCatalogWorkerFixtures();

const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });

function createWorkspace(prefix: string) {
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

function expectModelResponse(
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

describe("prepared model catalog worker plugin scope", () => {
  it("admits deferred discovery using manifest-only synthetic auth", async () => {
    const fixture = createWorkspace("openclaw-manifest-synthetic-auth-");
    const { root, agentDir, workspaceDir } = fixture;
    const provider = "manifest-local-fixture";
    const pluginDir = path.join(root, "extensions", provider);
    fs.mkdirSync(pluginDir, { recursive: true });
    writeFixtureFiles(pluginDir, {
      "package.json": {
        name: provider,
        version: "1.0.0",
        type: "commonjs",
        openclaw: {
          extensions: ["./index.cjs"],
          build: { bundledDist: false, runtimeFormat: "cjs" },
        },
      },
      "index.cjs": `module.exports = {
        id: "${provider}",
        register(api) { api.registerProvider(require("./discovery.cjs")); },
      };`,
      "discovery.cjs": `module.exports = {
        id: "${provider}", label: "Local fixture", auth: [],
        resolveSyntheticAuth: ({ providerConfig }) => providerConfig
          ? { apiKey: "local-fixture-not-real", source: "local fixture", mode: "api-key" }
          : undefined,
        catalog: { run: () => ({ provider: {
          baseUrl: "http://127.0.0.1:1234/v1", api: "openai-completions",
          models: [{ id: "discovered", name: "Discovered model" }],
        } }) },
      };`,
      "openclaw.plugin.json": {
        id: provider,
        providers: [provider],
        syntheticAuthRefs: [provider],
        activation: { onStartup: false },
        providerCatalogEntry: "./discovery.cjs",
        modelCatalog: { discovery: { [provider]: "refreshable" } },
        configSchema: { type: "object", properties: {} },
      },
    });
    const config: OpenClawConfig = {
      models: {
        providers: {
          [provider]: {
            baseUrl: "http://127.0.0.1:1234/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
      plugins: {
        allow: [provider],
        entries: { [provider]: { enabled: true } },
      },
    };
    const env = {
      ...fixture.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    };
    const snapshot = await publishPreparedModelRuntimeSnapshot(
      catalogInput({ agentDir, workspaceDir, config, env }),
      { provenance: "configured", catalogMode: "static" },
    );

    const catalog = expectDefined(
      await snapshot.loadFullModelCatalog?.({ refresh: true, providerIds: [provider], wait: true }),
      "expected a completed catalog",
    );

    expect(catalog.entries).toContainEqual(catalogEntry("discovered", { provider }));
    expect(getPreparedModelFullCatalogAuth(catalog)?.authModes[provider]).toBe("api_key");
  });

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
    const cliCredentialsDir = path.join(cliHome, ".minimax");
    fs.mkdirSync(cliCredentialsDir, { recursive: true });
    writeFixtureFiles(cliCredentialsDir, {
      "oauth_creds.json": {
        access_token: "refreshed-cli-access-not-real",
        refresh_token: "same-cli-login-not-real",
        expiry_date: Date.now() + 3_600_000,
      },
    });

    const refreshed = await fixture.snapshot.loadFullModelCatalog!({
      refresh: true,
      providerIds: [provider],
      wait: true,
    });
    const expected = getPreparedModelFullCatalogAuth(refreshed)!;
    const localIds = {
      runtimeLocalProfileIds: expect.arrayContaining([MINIMAX_CLI_PROFILE_ID]),
      runtimeLocalOrderProviderIds: expect.arrayContaining([provider]),
    };
    expect(expected).toMatchObject({
      credentials: { [provider]: { access: "refreshed-cli-access-not-real" } },
      authStore: {
        ...localIds,
        profiles: { [MINIMAX_CLI_PROFILE_ID]: { access: "refreshed-cli-access-not-real" } },
      },
    });

    const unrelated = await fixture.snapshot.loadFullModelCatalog!({
      refresh: true,
      providerIds: [PROVIDER_ID],
      wait: true,
    });
    expect(unrelated.entries).toContainEqual(catalogEntry("plugin-generation-v1"));
    const retained = getPreparedModelFullCatalogAuth(unrelated)!;
    expect(retained.credentials?.[provider]).toEqual(expected.credentials?.[provider]);
    expect(retained.authStore.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
      expected.authStore.profiles[MINIMAX_CLI_PROFILE_ID],
    );
    expect(retained.authStore).toMatchObject(localIds);
    expect(retained.authStore.runtimePersistedProfileIds ?? []).not.toContain(
      MINIMAX_CLI_PROFILE_ID,
    );
    expect(retained.authStore.order?.[provider]).toEqual(expected.authStore.order?.[provider]);
    expect(fixture.snapshot.isCurrent()).toBe(true);
  });

  it("captures runtime synthetic auth for credential-only providers before full refresh", async () => {
    const fixture = await createStaticSnapshot(0, {}, { credentialOnlySyntheticAuth: true });

    const catalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true, wait: true });

    // The provider's catalog emits this row only when its stored token resolves.
    expect(catalog?.entries).toContainEqual(
      catalogEntry("credential-only-model", { provider: CREDENTIAL_ONLY_PROVIDER_ID }),
    );
    // The worker read the parent's captured answer; it never ran the hook itself.
    expect(
      fs.readFileSync(path.join(fixture.root, "credential-only-auth-owner.txt"), "utf8"),
    ).toMatch(/^(parent\n)+$/u);
  });

  it.for([
    { first: "full", slot: "memory", asyncSyntheticAuth: false, syntheticAuthAvailable: true },
    {
      first: "scoped",
      slot: "contextEngine",
      asyncSyntheticAuth: true,
      syntheticAuthAvailable: false,
    },
    { first: "held", slot: "none", asyncSyntheticAuth: true, syntheticAuthAvailable: false },
  ])("keeps models.list scoped with $first discovery and $slot selected", async (selection, t) => {
    const { signal } = t;
    const fixture = createWorkspace("openclaw-model-catalog-scope-worker-");
    const { root, agentDir, workspaceDir } = fixture;
    const marker = path.join(root, "worker-marker.txt");
    const catalogHold = `${marker}.hold`;
    if (selection.first === "scoped") {
      fs.writeFileSync(catalogHold, "");
    }
    const unrelatedMarker = path.join(root, "unrelated-worker-plugin.txt");

    const pluginFile = writeFixturePlugin({ root, spinMs: 0, ...selection });
    const slot =
      selection.slot === "contextEngine"
        ? "context-engine"
        : selection.slot === "memory"
          ? "memory"
          : undefined;
    const unrelatedPluginFile = writeUnrelatedFixturePlugin(root, slot);
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
        models: {
          providers: {
            "published-fixture": {
              api: "openai-completions",
              baseUrl: "https://published-fixture.invalid/v1",
              apiKey: "published-fixture-key-not-real",
              models: [model("published-model", "Published model")],
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
    const waitForPublication = (previous: ModelCatalogSnapshot | undefined) =>
      expect
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
    const listModels = (
      id: string,
      params: Record<string, unknown>,
      response: RespondFn = respond,
    ) =>
      handler({
        req: { type: "req", id, method: "models.list", params },
        params,
        respond: response,
        client: null,
        isWebchatConnect: () => false,
        context,
      });
    if (selection.first !== "full") {
      expect(snapshot.authModes[HARNESS_ID]).toBeUndefined();
      const probePath = path.join(root, "synthetic-auth-probes.txt");
      const ownerPath = path.join(root, "synthetic-auth-owner.txt");
      fs.writeFileSync(probePath, "");
      fs.writeFileSync(ownerPath, "");
      const hold = path.join(root, "synthetic-auth-hold");
      const auth = observeSyntheticAuth(root);
      if (selection.first === "held") {
        fs.writeFileSync(hold, "");
      }
      // The first worker operation must enter through the registered scoped refresh.
      const params = { view: "all", provider: PROVIDER_ID, refresh: true };
      const previousCatalog = snapshot.readFullModelCatalog?.();
      const refresh = Promise.resolve(listModels("models-list-cold-scoped", params));
      if (selection.first === "held") {
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
          const readStarted = performance.now();
          const readRespond = vi.fn();
          await listModels("models-list-during-refresh", { view: "all" }, readRespond);
          const readMs = performance.now() - readStarted;
          expect(settled).toBe(false);
          const publicationStarted = performance.now();
          const replacementInput = { ...input, config: makeConfig("Updated agent") };
          const publishedReplacement = await publishPreparedModelRuntimeSnapshot(replacementInput, {
            force: true,
            provenance: "configured",
            catalogMode: "static",
          });
          const publicationMs = performance.now() - publicationStarted;
          expect(readMs).toBeLessThan(5_000);
          expect(publicationMs).toBeLessThan(5_000);
          expectModelResponse(readRespond, "published-fixture", "published-model");
          expect(getPreparedModelRuntimeSnapshot(replacementInput)).toBe(publishedReplacement);
          expect(snapshot.isCurrent()).toBe(false);
          console.info("held models.list responsiveness", {
            readMs,
            publicationMs,
            responseBoundMs: 5_000,
          });
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
        auth.close();
        fs.rmSync(catalogHold, { force: true });
      }
      await waitForPublication(previousCatalog);
      respond.mockClear();
      await listModels("models-list-scoped-published", { view: "all", provider: PROVIDER_ID });
      expectModelResponse(respond);
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
    await listModels("models-list-worker-scope", { view: "all", refresh: true });
    await waitForPublication(previousCatalog);
    respond.mockClear();
    await listModels("models-list-full-published", { view: "all" });
    expectModelResponse(respond);
    expect(fs.existsSync(unrelatedMarker)).toBe(false);
  });
});
