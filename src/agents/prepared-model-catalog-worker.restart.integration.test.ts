import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
} from "./auth-profiles/oauth-refresh-marker.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { apiKey, authStore } from "./model-catalog-fixtures.test-support.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  EXTERNAL_AUTH_PATH_ENV,
  PROVIDER_ID,
  catalogInput,
  createCatalogFixture,
  startCatalogBuild,
} from "./prepared-model-catalog-worker.test-support.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

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
