import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  catalogInput,
  createCatalogFixture,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import { withPreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
afterEach(() => setRemoteModelCatalogOverlaySourcesForTest());

const sourceUrl = "https://hosted-metadata.invalid/catalog.json";
const route = { api: "openai-completions", baseUrl: "https://worker-catalog.invalid/v1" } as const;

function storedHostedCatalog() {
  const generatedAt = 100;
  return {
    id: 1,
    source_url: sourceUrl,
    generated_at: generatedAt,
    min_version: null,
    etag: null,
    last_modified: null,
    checked_at: generatedAt,
    bundle_json: JSON.stringify({
      schemaVersion: 1,
      sourceCommit: "hosted-metadata-fixture",
      generatedAt,
      providers: {
        [PROVIDER_ID]: {
          ...route,
          models: [
            { id: "sqlite-model", name: "SQLite model", contextWindow: 524288, maxTokens: 65536 },
            { id: "hosted-only", name: "Hosted only", contextWindow: 262144, maxTokens: 32768 },
          ],
        },
      },
      pricing: {},
    }),
  };
}

// A standalone process (CLI without a Gateway) has published no hosted catalog yet.
async function readStandaloneRows(discovery: "runtime" | "static") {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const manifestPath = path.join(fixture.root, "plugin/openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.modelCatalog.providers = {
    [PROVIDER_ID]: { ...route, models: [{ id: "sqlite-model" }] },
  };
  manifest.modelCatalog.discovery = { [PROVIDER_ID]: discovery };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const config: OpenClawConfig = {
    ...fixture.config,
    models: { catalogRefresh: { url: sourceUrl } },
  };
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 1,
    readStoredCatalog: storedHostedCatalog,
  });
  return await withEnvAsync(fixture.env, () =>
    withPreparedModelCatalogOwner(
      { ...catalogInput({ ...fixture, config }), readOnly: true },
      (snapshot) => snapshot.modelCatalog.entries.filter((row) => row.provider === PROVIDER_ID),
    ),
  );
}

it("describes a listed model with the saved hosted catalog and keeps unlisted rows hidden", async () => {
  const rows = await readStandaloneRows("runtime");
  expect(rows.find((row) => row.id === "sqlite-model")?.contextWindow).toBe(524288);
  expect(rows.some((row) => row.id === "hosted-only")).toBe(false);
});

it("lists a static provider's hosted-only row before any Gateway ran", async () => {
  const rows = await readStandaloneRows("static");
  expect(rows.find((row) => row.id === "hosted-only")?.contextWindow).toBe(262144);
});
