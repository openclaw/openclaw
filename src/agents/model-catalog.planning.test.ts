import { normalizeModelCatalogProviderRows } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import { finalizePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { buildPreparedModelCatalogSnapshot, loadManifestModelCatalog } from "./model-catalog.js";

vi.mock("../model-catalog/index.js", { spy: true });
vi.mock("@openclaw/model-catalog-core/model-catalog-normalize", { spy: true });
const augment = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: augment,
}));
let config: OpenClawConfig;

function catalog(discovery: "static" | "runtime", ...modelIds: string[]) {
  const provider = "catalog-fixture";
  const models = modelIds.map((id) => ({ id, name: id }));
  const modelCatalog = {
    providers: { [provider]: { api: "openai-responses" as const, models } },
    discovery: { [provider]: discovery },
  };
  const metadataSnapshot = finalizePluginMetadataSnapshot(
    createPluginMetadataSnapshotFixture({
      plugins: [{ id: provider, origin: "bundled", providers: [provider], modelCatalog }],
    }),
  );
  const params = { config, metadataSnapshot };
  const agentDir = "/tmp/model-catalog-planning-test";
  return {
    load: () => loadManifestModelCatalog(params),
    build: () =>
      buildPreparedModelCatalogSnapshot({
        ...params,
        agentDir,
        authCredentials: {},
        readOnly: true,
        models: [],
      }),
    scope: (run: () => Promise<void>) => withPluginRuntimeGenerationScope(params, run),
  };
}
const plan = vi.mocked(planEffectiveModelCatalogRows);
const normalize = vi.mocked(normalizeModelCatalogProviderRows);

beforeEach(() => {
  config = { plugins: { enabled: false } };
  augment.mockClear();
  plan.mockReset();
  normalize.mockReset();
});

it("plans manifest rows once without expanding entitlement", async () => {
  const runtime = catalog("runtime", "allowed", "denied");
  config.models = { catalogRefresh: { enabled: false } };
  await runtime.scope(async () => {
    plan.mockClear();
    normalize.mockClear();
    const snapshot = await runtime.build();
    expect([snapshot.entries, snapshot.routeVariants]).toEqual([[], []]);
    const firstRead = runtime.load();
    expect(firstRead.map((row) => row.id)).toEqual(["allowed", "denied"]);
    expect(runtime.load()).toBe(firstRead);
    expect(augment).not.toHaveBeenCalled();
    expect(planEffectiveModelCatalogRows).toHaveBeenCalledTimes(1);
    expect(
      normalize.mock.results.map(({ type, value }) => (type === "return" ? value.length : type)),
    ).toEqual([2]);
  });
});

it("keeps the old declaration cache when replacement planning fails", async () => {
  const initial = catalog("static", "initial");
  const replacement = catalog("static", "replacement");
  const planningError = new Error("catalog planning failed");
  const originalRows = initial.load();
  await replacement.scope(async () => {
    plan.mockImplementationOnce(() => {
      throw planningError;
    });
    await expect(replacement.build()).rejects.toBe(planningError);
    expect(initial.load()).toBe(originalRows);
    const snapshot = await replacement.build();
    expect(snapshot.entries.map((row) => row.id)).toEqual(["replacement"]);
    const replacementRows = replacement.load();
    expect(replacementRows.map((row) => row.id)).toEqual(["replacement"]);
    expect(replacementRows).not.toBe(originalRows);
    expect(replacement.load()).toBe(replacementRows);
    expect(originalRows.map((row) => row.id)).toEqual(["initial"]);
  });
});
