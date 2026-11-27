import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withEnv } from "../test-utils/env.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
} from "./auth-profiles/oauth-refresh-marker.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { apiKey, authStore } from "./model-catalog-fixtures.test-support.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { loadPersistedPluginModelCatalogs } from "./plugin-model-catalog-execution.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import {
  EXTERNAL_AUTH_PATH_ENV,
  PROVIDER_ID,
  PLUGIN_ID,
  makeCatalogAgentFacts,
  catalogInput,
  createCatalogFixture,
  startCatalogBuild,
} from "./prepared-model-catalog-worker.test-support.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, readCatalogWorkers, retireAfterTest } = usePreparedCatalogWorkerFixtures();

it("keeps a discovered model after a restart whose sign-in has ended", async () => {
  const fixture = await createCatalogFixture(
    makeTempDir,
    0,
    { [EXTERNAL_AUTH_PATH_ENV]: "" },
    { catalogControl: true },
  );
  withEnv(fixture.env, () =>
    saveAuthProfileStore(
      authStore({ [`${PROVIDER_ID}:legacy`]: apiKey(PROVIDER_ID, "legacy-worker-key-not-real") }),
      fixture.agentDir,
    ),
  );
  const input = catalogInput(fixture);
  const learned = (catalog: ModelCatalogSnapshot) =>
    catalog.entries.some(({ provider, id }) => provider === PROVIDER_ID && id === "Learned");
  // Each build is a fresh process state: a new owner without the previous in-memory inventory.
  const start = async () => {
    const retirement = new AbortController();
    retireAfterTest(() => retirement.abort());
    const build = (
      await startCatalogBuild(input, retirement, { provenance: "standalone" }).pending
    )[0]!;
    retireAfterTest(retainPreparedPluginGeneration(build.pluginGeneration));
    return { snapshot: build.snapshot, retirement };
  };

  const first = await start();
  expect(learned(await first.snapshot.loadFullModelCatalog!({ refresh: true }))).toBe(true);
  first.retirement.abort();

  // The account's sign-in ends: its refresh was rejected and settled as a failed fence.
  const profileId = `${PROVIDER_ID}:me@example.test`;
  withEnv(fixture.env, () =>
    saveAuthProfileStore(
      authStore({
        [profileId]: createFailedOAuthRefreshFence(
          createOAuthRefreshFence({
            profileId,
            credential: {
              type: "oauth",
              provider: PROVIDER_ID,
              access: "ended-access-not-real",
              refresh: "ended-refresh-not-real",
              expires: 0,
              email: "me@example.test",
            },
          }),
        ),
      }),
      fixture.agentDir,
    ),
  );
  fs.writeFileSync(path.join(fixture.root, "catalog-control.txt"), "auth-rejected", "utf8");
  const restarted = await start();
  const failed = await restarted.snapshot.loadFullModelCatalog!({ refresh: true });
  expect(failed.providerOutcomes).toContainEqual({
    provider: PROVIDER_ID,
    status: "auth-rejected",
  });
  // The rejected sign-in makes the model unavailable; it does not make it unknown.
  expect(learned(failed)).toBe(true);
});

it("loads restored generated JSONC on the first writable catalog request", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0, {}, { catalogControl: true });
  fs.writeFileSync(path.join(fixture.root, "catalog-control.txt"), "configured");
  const emptyProvider = `${PROVIDER_ID}-alias`;
  const contents = `{
    // Imported generated catalogs may use comments and trailing commas.
    "generatedBy": "${PLUGIN_MODEL_CATALOG_GENERATED_BY}",
    "providers": {
      "${PROVIDER_ID}": {
        "baseUrl": "https://worker-catalog.invalid/v1", "api": "openai-completions",
        "models": [{ "id": "restored-only", "name": "Restored model" }],
      },
      "${emptyProvider}": {
        "baseUrl": "https://worker-catalog.invalid/v1", "api": "openai-completions", "models": []
      },
    },
  }`;
  await replacePersistedPluginModelCatalogs({
    agentDir: fixture.agentDir,
    env: fixture.env,
    pluginCatalogWrites: { [encodePluginModelCatalogRelativePath(PLUGIN_ID)]: contents },
  });
  const stateDir = makeTempDir("openclaw-restored-catalog-");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const database = "openclaw-agent.sqlite";
  await createVerifiedSqliteSnapshot({
    sourcePath: path.join(fixture.agentDir, database),
    targetPath: path.join(agentDir, database),
  });
  const env = { ...fixture.env, OPENCLAW_STATE_DIR: stateDir };
  const input = catalogInput({ ...fixture, agentDir, env });
  const retirement = new AbortController();
  retireAfterTest(() => retirement.abort());
  const worker = createPreparedModelCatalogWorker({
    agentFacts: makeCatalogAgentFacts(input),
    pluginMetadataSnapshot: loadPluginMetadataSnapshot({
      config: input.config,
      workspaceDir: input.workspaceDir,
      env,
    }),
    isCurrent: () => !retirement.signal.aborted,
    retirementSignal: retirement.signal,
  });
  const { modelCatalog, runtimeModels } = await worker.loadCatalog();
  expect(readCatalogWorkers()).toHaveLength(1);
  expect(modelCatalog.entries).toContainEqual(
    expect.objectContaining({ provider: PROVIDER_ID, id: "restored-only" }),
  );
  expect(runtimeModels.get(emptyProvider)).toEqual([]);
  // Empty discovery keeps the imported bytes through the writable host's save.
  await expect(loadPersistedPluginModelCatalogs(agentDir, [PLUGIN_ID], env)).resolves.toEqual([
    { pluginId: PLUGIN_ID, contents },
  ]);
});
