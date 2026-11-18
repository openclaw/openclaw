import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { vi, expect, it } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createConfigIO } from "../config/io.factory.js";
import { getConfigResolutionFacts } from "../config/resolution-facts.js";
import * as configRuntime from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { captureTemplateInstallSchemaVersionFacts } from "../templates/provenance-runtime-read.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { MINIMAX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
import { isPendingOAuthRefreshFence } from "./auth-profiles/oauth-refresh-marker.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { prepareModelCatalogWorkerContext } from "./prepared-model-catalog-fingerprints.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import {
  catalogEntry,
  writeFixtureFiles,
  HARNESS_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import {
  loadPublishedPreparedModelCatalogOwnerSnapshot,
  refreshExpiredPreparedModelCatalog,
} from "./prepared-model-catalog.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
import { CREDENTIAL_ONLY_PROVIDER_ID } from "./test-helpers/prepared-model-catalog-credential-only.test-support.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import { createCatalogInspectionPool } from "./test-helpers/prepared-model-catalog-inspection.js";
import { withHeldCatalogOAuthRefresh } from "./test-helpers/prepared-model-catalog-oauth-fixture.js";
import { createStaticCatalogSnapshotFixture } from "./test-helpers/prepared-model-catalog-static-fixture.js";
import {
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();
const profileId = `${PROVIDER_ID}:oauth`;

it.for(["empty", "matching"] as const)(
  "refreshes shared OAuth from a real catalog worker with %s historical peers and empty agent databases",
  async (peers, { signal }) => {
    await withHeldCatalogOAuthRefresh(
      { makeTempDir, signal, sharedStatePeers: peers },
      async (fixture) => {
        await withinTest(fixture.waitForRefresh(), signal);
        const ownerFence = fixture.readCredential();
        expect(ownerFence?.type === "oauth" && isPendingOAuthRefreshFence(ownerFence)).toBe(true);
        if (peers === "matching") {
          expect(fixture.readPeerStore()?.profiles[profileId]).toEqual(ownerFence);
        }
        expect(fixture.readEmptyStore()).toBeNull();
        expect(fixture.refreshCalls()).toBe(1);

        expect(fixture.discoveryStarted()).toBe(true);
        fixture.releaseResponse();
        const result = await withinTest(fixture.pending, signal);
        expect(result.status).toBe("ok");
        if (result.status !== "ok" || result.kind !== "catalog") {
          throw new Error("Expected the real worker to finish catalog discovery");
        }
        expect(result.snapshot.entries).toContainEqual(
          expect.objectContaining({ provider: PROVIDER_ID, id: "oauth-model" }),
        );
        expect(fixture.readCredential()).toEqual(fixture.rotated);
        expect(result.authCredentials).toContainEqual(
          expect.objectContaining({
            facts: new Map([
              [
                "store",
                {
                  kind: "postimage",
                  value: expect.objectContaining({ profiles: { [profileId]: fixture.rotated } }),
                },
              ],
            ]),
          }),
        );
        // The shared owner supplies the rotated credential; historical local copies are removed.
        expect(fixture.readPeerStore()?.profiles[profileId]).toBeUndefined();
        expect(fixture.readEmptyStore()).toBeNull();
        expect(fixture.refreshCalls()).toBe(1);
      },
    );
  },
);

it("rolls back shared and historical OAuth claims when a later peer blocks catalog refresh admission", async ({
  signal,
}) => {
  await withHeldCatalogOAuthRefresh(
    { makeTempDir, signal, sharedStatePeers: "conflicting" },
    async (fixture) => {
      const result = await withinTest(fixture.pending, signal);
      expect(fixture.discoveryStarted()).toBe(true);
      expect(fixture.readRefreshFailure()).toContain("already claimed by another owner");
      if (result.status === "ok" && result.kind === "catalog") {
        expect(result.snapshot.entries).not.toContainEqual(
          expect.objectContaining({ provider: PROVIDER_ID, id: "oauth-model" }),
        );
      } else if (result.status === "failed") {
        expect(result.error).toMatch(/historical OAuth refresh peer|already claimed/);
      }
      expect(fixture.refreshCalls()).toBe(0);
      expect(fixture.readCredential()).toEqual(fixture.original);
      expect(fixture.readPeerStore()?.profiles[profileId]).toEqual(fixture.original);
      expect(fixture.readEmptyStore()).toBeNull();
      expect(fixture.readConflictingCredential()).toEqual(fixture.conflictingFence);
      expect(result.authCredentials).toContainEqual(
        expect.objectContaining({
          facts: new Map([
            [
              "store",
              {
                kind: "postimage",
                value: expect.objectContaining({ profiles: { [profileId]: fixture.original } }),
              },
            ],
          ]),
        }),
      );
    },
  );
});

const createRenewalFleetFixture = createCatalogFleetFixture(makeTempDir);
const UNSEEN_NATIVE_PROVIDER = "native-only-fixture";
const nativeRow = (revision: number) => ({
  provider: revision === 3 ? UNSEEN_NATIVE_PROVIDER : PROVIDER_ID,
  id: `native-${revision}`,
  nativeRuntime: HARNESS_ID,
});
it("preserves native and provider renewals and explicitly refreshes scoped warm catalogs", async ({
  signal,
}) => {
  let revision = 0;
  let clock = Date.now();
  let held: ReturnType<typeof createDeferred<void>> | undefined;
  let entered: ReturnType<typeof createDeferred<void>> | undefined;
  let nativeEntered: ReturnType<typeof createDeferred<void>> | undefined;
  let nativeHeld: ReturnType<typeof createDeferred<void>> | undefined;
  let nativeTarget: { agent: string; revision: number } | undefined;
  const requests: Array<{ agent: string; revision: number; authorization: string | undefined }> =
    [];
  const work: Promise<unknown>[] = [];
  const publications: Promise<unknown>[] = [];
  const server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture.invalid");
        const agent = url.searchParams.get("agent")!;
        const send = (value: unknown) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(value));
        };
        if (url.pathname === "/metadata") {
          send({ revision });
          return;
        }
        const native = url.pathname === "/native";
        const currentRevision = revision;
        const release = native ? nativeHeld : held;
        if (native) {
          if (agent === nativeTarget?.agent && currentRevision === nativeTarget.revision) {
            nativeEntered?.resolve();
          }
        } else if (url.pathname === "/catalog") {
          requests.push({
            agent,
            revision: currentRevision,
            authorization: request.headers.authorization,
          });
          entered?.resolve();
        } else {
          response.writeHead(404).end();
          return;
        }
        const pending = (async () => {
          await release?.promise;
          send(
            native
              ? currentRevision
                ? [{ ...nativeRow(currentRevision), name: "Native model" }]
                : []
              : {
                  provider: {
                    api: "openai-completions",
                    baseUrl: "https://fleet.invalid/v1",
                    models: [{ id: `provider-${currentRevision}`, name: "Provider model" }],
                  },
                },
          );
        })();
        work.push(pending);
        void pending.catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : new Error(String(error))),
        );
      }),
  });
  let restoreClock: (() => void) | undefined;
  let pendingNative: Promise<unknown> | undefined;
  try {
    const endpoint = `http://127.0.0.1:${server.claim.port}`;
    const date = vi.spyOn(Date, "now").mockImplementation(() => clock);
    restoreClock = () => date.mockRestore();
    const fixture = await createRenewalFleetFixture(
      (seed) => {
        const clockFile = path.join(seed.root, "catalog-clock.txt");
        fs.writeFileSync(clockFile, String(clock));
        writeFixtureFiles(path.join(seed.root, "plugin"), {
          "openclaw.plugin.json": {
            id: PROVIDER_ID,
            providers: [PROVIDER_ID],
            cliBackends: [HARNESS_ID],
            providerCatalogEntry: "./provider-discovery.cjs",
            modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" }, runtimeAugment: true },
            configSchema: { type: "object", additionalProperties: false },
          },
          "index.cjs": `
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  api.registerAgentHarness({
    id: ${JSON.stringify(HARNESS_ID)}, label: "Native fleet proof", authBootstrap: "harness",
    supports: () => ({ supported: true }), runAttempt: async () => ({ ok: false, error: "unused" }),
    loadModelCatalog: async (params) => (await fetch(${JSON.stringify(endpoint + "/native?agent=")} + encodeURIComponent(params.agentId))).json(),
  });
  api.registerProvider(require("./provider-discovery.cjs"));
} };\n`,
          "provider-discovery.cjs": `
const fs = require("node:fs");
const { getCachedLiveCatalogValue } = require("openclaw/plugin-sdk/provider-catalog-shared");
module.exports = {
    id: ${JSON.stringify(PROVIDER_ID)}, label: "Fleet proof", auth: [],
    catalog: { async run(ctx) {
      const credential = ctx.resolveProviderAuth(${JSON.stringify(PROVIDER_ID)}).discoveryApiKey;
      const cached = (keyParts, ttlMs, load) => getCachedLiveCatalogValue({ keyParts, ttlMs, load,
        now: () => Number(fs.readFileSync(${JSON.stringify(clockFile)}, "utf8")),
      });
      await cached(["fleet-public-metadata", ${JSON.stringify(endpoint)}], 60_000,
        async () => (await fetch(${JSON.stringify(endpoint + "/metadata")})).json());
      return cached([ctx.agentDir, credential], 1000,
        async () => (await fetch(${JSON.stringify(endpoint + "/catalog?agent=")} + encodeURIComponent(require("node:path").basename(require("node:path").dirname(ctx.agentDir))), {
          headers: { authorization: "Bearer " + credential },
        })).json());
    } },
};\n`,
        });
      },
      true,
      { agentCount: 2 },
    );
    const snapshots = fixture.snapshots;
    const waitForCatalogs = (expectedRevision: number) => {
      const completed = createDeferred();
      const check = () => {
        if (
          snapshots.every((snapshot) =>
            snapshot
              .readFullModelCatalog?.()
              ?.entries.some((entry) => entry.id === `provider-${expectedRevision}`),
          )
        ) {
          completed.resolve();
        }
      };
      const stop = registerPreparedModelRuntimePublicationListener(check);
      check();
      return withinTest(completed.promise, signal).finally(stop);
    };
    await Promise.all(snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
    for (const snapshot of snapshots) {
      expect(snapshot.readFullModelCatalog?.()?.entries).toContainEqual(catalogEntry("provider-0"));
    }
    for (revision of [2, 3]) {
      const nativeProvider = revision === 3 ? UNSEEN_NATIVE_PROVIDER : PROVIDER_ID;
      const nativeEntry = nativeRow(revision);
      clock += 1001;
      fs.writeFileSync(path.join(fixture.root, "catalog-clock.txt"), String(clock));
      held = createDeferred();
      entered = createDeferred();
      nativeEntered = createDeferred();
      nativeTarget = { agent: fixture.agentIds[0]!, revision };
      nativeHeld = revision === 2 ? createDeferred() : undefined;
      const publication = waitForCatalogs(revision);
      publications.push(publication);
      // The admission barrier can fail first; the original publication is still awaited below.
      void publication.catch(() => undefined);
      // Resolve the published owner before explicit inventory demand, as Gateway requests do.
      await Promise.all(
        snapshots.map(async (snapshot) => {
          const params = {
            agentId: snapshot.agentId,
            agentDir: snapshot.agentDir,
            config: fixture.config,
            readOnly: true,
          };
          await loadPublishedPreparedModelCatalogOwnerSnapshot(params);
          refreshExpiredPreparedModelCatalog(params);
        }),
      );
      await withinTest(entered.promise, signal);
      pendingNative = snapshots[0]!.loadNativeModelCatalog!({
        provider: nativeProvider,
        modelId: `native-${revision}`,
        runtime: HARNESS_ID,
      });
      await withinTest(nativeEntered.promise, signal);
      if (nativeHeld) {
        // Exercise both completion orders; late native results must retain newer provider rows.
        held.resolve();
        held = undefined;
        await publication;
        nativeHeld.resolve();
        nativeHeld = undefined;
      }
      const native = await withinTest(pendingNative, signal);
      expect(native).toMatchObject({
        entries: expect.arrayContaining([expect.objectContaining(nativeEntry)]),
      });
      held?.resolve();
      held = undefined;
      await publication;
      const published = snapshots[0]!.readFullModelCatalog!()!;
      expect(published.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: `provider-${revision}` }),
          expect.objectContaining(nativeEntry),
        ]),
      );
      for (const [index, snapshot] of snapshots.entries()) {
        const auth = getPreparedModelFullCatalogAuth(snapshot.readFullModelCatalog!()!)!;
        expect(auth.authStore.profiles[`${PROVIDER_ID}:default`]).toMatchObject({
          key: `synthetic-catalog-${fixture.agentIds[index]}`,
        });
        if (revision === 3) {
          expect({
            credential: auth.credentials?.[UNSEEN_NATIVE_PROVIDER],
            mode: auth.authModes[UNSEEN_NATIVE_PROVIDER],
            profile: Object.values(auth.authStore.profiles).some(
              (profile) => profile.provider === UNSEEN_NATIVE_PROVIDER,
            ),
          }).toEqual({ credential: undefined, mode: undefined, profile: false });
        }
      }
    }
    // The worker and its SDK cache stay alive after TTL renewal. Explicit refresh must
    // carry its intent across that boundary without expiring another agent's credential key.
    revision = 4;
    const selected = snapshots[0]!;
    await selected.loadFullModelCatalog!();
    await selected.loadFullModelCatalog!({ changedOnly: true });
    const refreshed = createDeferred();
    const stopObservingRefresh = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "catalog-published") {
        refreshed.resolve();
      }
    });
    try {
      await selected.loadFullModelCatalog!({ refresh: true, providerIds: [PROVIDER_ID] });
      await withinTest(refreshed.promise, signal);
    } finally {
      stopObservingRefresh();
    }
    expect(requests.at(-1)).toMatchObject({ agent: fixture.agentIds[0], revision: 4 });
    expect(selected.readFullModelCatalog!()!.entries).toContainEqual(catalogEntry("provider-4"));
    expect(snapshots[1]!.readFullModelCatalog!()!.entries).toContainEqual(
      catalogEntry("provider-3"),
    );
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer synthetic-catalog-${request.agent}`);
    }
  } finally {
    held?.resolve();
    nativeHeld?.resolve();
    await Promise.allSettled([...work, pendingNative, ...publications]);
    restoreClock?.();
    server.listener.closeAllConnections();
    await server.releaseListener();
    await server.claim.release();
  }
}, 120_000);

const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });
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
  expect(retained.authStore.runtimePersistedProfileIds ?? []).not.toContain(MINIMAX_CLI_PROFILE_ID);
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

type CatalogCredentialCase = [
  owner: "config" | "profile",
  value: string,
  loader?: { authored: string; env?: NodeJS.ProcessEnv; pending?: boolean; resolved?: boolean },
];
it.each<CatalogCredentialCase>([
  ["config", "synthetic-worker-config-key"],
  ["profile", "synthetic-worker-profile-key"],
  [
    "config",
    "${LITERAL_KEY}",
    { authored: "${SOURCE_KEY}", env: { SOURCE_KEY: "${LITERAL_KEY}" }, resolved: true },
  ],
  ["config", "$PENDING_KEY", { authored: "$PENDING_KEY", pending: true }],
])(
  "preserves %s credential %s (%j) through discovery and the writable plan",
  async (owner, value, loader) => {
    const provider = "worker-secret-fixture";
    const state = await createOpenClawTestState({ label: "catalog-worker-secrets" });
    async function loadConfig(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
      await state.writeConfig(config);
      const snapshot = await createConfigIO({ env, observe: false }).readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      return snapshot;
    }
    try {
      await state.writeAuthProfiles({ version: 1, profiles: {} });
      const requests: boolean[] = [];
      const server = createServer((request, response) => {
        requests.push(
          request.url === "/v1/models" && request.headers.authorization === `Bearer ${value}`,
        );
        response.setHeader("content-type", "application/json");
        response.end('{"data":[{"id":"discovered-model","name":"Discovered model"}]}');
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected loopback catalog server");
      }
      try {
        const baseUrl = `http://127.0.0.1:${address.port}/v1`;
        const pluginFile = await state.writeText(
          "catalog-plugin/index.cjs",
          `
module.exports = {
  id: ${JSON.stringify(provider)},
  register(api) {
    const baseUrl = ${JSON.stringify(baseUrl)};
    api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Worker secret fixture", auth: [],
      staticCatalog: { run: async () => ({ provider: { baseUrl, api: "openai-completions", models: [] } }) },
      catalog: { run: async (context) => {
        const auth = context.resolveProviderApiKey(${JSON.stringify(provider)});
        if (!auth.discoveryApiKey) return null;
        const response = await fetch(baseUrl + "/models", { headers: { authorization: "Bearer " + auth.discoveryApiKey } });
        const body = await response.json();
        return { provider: { baseUrl, api: "openai-completions", apiKey: auth.apiKey, models: body.data } };
      } },
    });
  },
};
`,
        );
        await state.writeJson("catalog-plugin/openclaw.plugin.json", {
          id: provider,
          providers: [provider],
          providerCatalogEntry: "./index.cjs",
          modelCatalog: { discovery: { [provider]: "runtime" } },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        });
        const ref = { source: "store", provider: "default", id: "WORKER_CONFIG_KEY" } as const;
        const makeConfig = (apiKey: ModelProviderConfig["apiKey"]): OpenClawConfig => ({
          plugins: {
            allow: [provider],
            load: { paths: [pluginFile] },
            slots: { memory: "none" },
          },
          agents: { defaults: { modelPolicy: { allow: [`${provider}/*`] } } },
          models: {
            providers: {
              [provider]: {
                baseUrl,
                api: "openai-completions",
                models: [],
                ...(apiKey === undefined ? {} : { apiKey }),
              },
            },
          },
        });
        const source = makeConfig(owner === "config" ? (loader?.authored ?? ref) : undefined);
        let runtime = makeConfig(owner === "config" ? value : undefined);
        const env = {
          ...state.env,
          LITERAL_KEY: undefined,
          PENDING_KEY: undefined,
          ...loader?.env,
        };
        let runtimeSource: OpenClawConfig = source;
        if (loader) {
          ({ config: runtime, sourceConfig: runtimeSource } = await loadConfig(source, env));
          expect(getConfigResolutionFacts(runtime)).not.toBeNull();
        }
        configRuntime.setRuntimeConfigSnapshot(runtime, runtimeSource);
        const prepared = await prepareWorkspaceBuildGroup(
          [
            {
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              config: runtime,
              env,
              skipCredentials: true,
            },
          ],
          "static",
        );
        expect(requests).toEqual([]);
        const facts = prepared.agentFacts[0]!;
        const authStore = facts.authStore;
        if (owner === "profile") {
          authStore.profiles[`${provider}:fixture`] = {
            type: "api_key",
            provider,
            keyRef: ref,
            key: value,
          };
        }
        const params = {
          agentFacts: {
            ...facts,
            input: { ...facts.input, config: captureRuntimeConfig(runtime) },
          },
          pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
        };
        const expectedAuth = loader?.pending ? undefined : value;
        const nativeRuntimeFacts = getConfigResolutionFacts(runtime);
        const nativeSourceFacts = getConfigResolutionFacts(runtimeSource);
        const serialized = structuredClone(createPreparedModelCatalogWorkerInput(params));
        // Workers inherit neither the parent's source snapshot nor its WeakMap resolution facts.
        configRuntime.clearRuntimeConfigSnapshot();
        clearRuntimeAuthProfileStoreSnapshots();
        const request = async (failCatalog = false) => {
          const { pool, captureDirectory } = createCatalogInspectionPool(env);
          try {
            const result = await pool.run(
              {
                context: prepareModelCatalogWorkerContext(serialized),
                value: serialized,
                request: {
                  kind: "catalog",
                  syntheticAuth: [],
                  templateInstallSchemaVersions: captureTemplateInstallSchemaVersionFacts({ env }),
                },
                inspection: { provider, expectedCredential: expectedAuth, failCatalog },
              },
              { timeoutMs: 30_000 },
            );
            if (failCatalog) {
              expect(fs.readdirSync(captureDirectory)).toEqual([]);
            }
            return result;
          } finally {
            await pool.close();
            expect(fs.existsSync(captureDirectory)).toBe(false);
          }
        };
        const { inspection, ...result } = await request();
        expect(result.status).toBe("ok");
        expect(inspection).toMatchObject({
          runtimeFactsAbsent: nativeRuntimeFacts === null,
          sourceFactsAbsent: nativeSourceFacts === null,
          sameResolutionFacts: nativeRuntimeFacts === nativeSourceFacts,
        });
        if (loader) {
          expect(requests).toEqual(loader.pending ? [] : [true]);
          expect(inspection.credentialMatches).toBe(true);
          expect(inspection.authoredRef).toEqual(
            loader.pending ? { source: "env", provider: "default", id: "PENDING_KEY" } : null,
          );
          expect(inspection.resolvedEnvRef).toEqual(
            loader.resolved ? { source: "env", provider: "default", id: "SOURCE_KEY" } : null,
          );
          if (loader.pending) {
            return;
          }
        }
        expect(requests).toEqual([true]);
        expect(result).toHaveProperty(
          "snapshot.entries",
          expect.arrayContaining([expect.objectContaining({ provider, id: "discovered-model" })]),
        );
        expect(inspection.plans).toHaveLength(1);
        const catalog = inspection.plans[0]!.pluginCatalogs.find(
          (entry) => entry.pluginId === provider,
        );
        expect(JSON.parse(catalog!.contents)).toMatchObject({
          providers: { [provider]: { apiKey: loader ? value : NON_ENV_SECRETREF_MARKER } },
        });
        const planText = JSON.stringify(inspection.plans);
        expect(planText).not.toContain("discoveryApiKey");
        if (!loader && value !== NON_ENV_SECRETREF_MARKER) {
          expect(planText).not.toContain(value);
        }
        if (value === "synthetic-worker-config-key") {
          const { inspection: _inspection, ...failure } = await request(true);
          expect(failure).toEqual({
            status: "failed",
            authCredentials: [],
            error: "synthetic catalog construction failure",
          });
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      configRuntime.clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  },
);
