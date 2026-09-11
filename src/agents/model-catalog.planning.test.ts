import { normalizeModelCatalogProviderRows } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import { finalizePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { buildPreparedModelCatalogSnapshot, loadManifestModelCatalog } from "./model-catalog.js";
import type { ModelRegistry } from "./sessions/index.js";

vi.mock("../model-catalog/index.js", { spy: true });
vi.mock("@openclaw/model-catalog-core/model-catalog-normalize", { spy: true });
const augment = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: augment,
}));

function fixture(discovery: "static" | "runtime", ...modelIds: string[]) {
  return finalizePluginMetadataSnapshot(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "catalog-fixture",
          origin: "bundled",
          providers: ["catalog-fixture"],
          modelCatalog: {
            providers: {
              "catalog-fixture": {
                api: "openai-responses",
                models: modelIds.map((id) => ({ id, name: id })),
              },
            },
            discovery: { "catalog-fixture": discovery },
          },
        },
      ],
    }),
  );
}

async function build(
  params: { config: OpenClawConfig; metadataSnapshot: PluginMetadataSnapshot },
  observed: string[] = [],
) {
  return await buildPreparedModelCatalogSnapshot({
    ...params,
    agentDir: "/tmp/model-catalog-planning-test",
    authCredentials: {},
    readOnly: true,
    modelRegistry: {
      getAll: () => observed.map((id) => ({ provider: "catalog-fixture", id, name: id })),
    } as ModelRegistry,
  });
}

describe("prepared catalog planning and declaration cache", () => {
  beforeEach(() => {
    augment.mockClear();
    vi.mocked(planEffectiveModelCatalogRows).mockReset();
    vi.mocked(normalizeModelCatalogProviderRows).mockReset();
  });

  it.each([
    { warm: false, prepare: true, observed: [] },
    { warm: false, prepare: true, observed: ["allowed"] },
    { warm: true, prepare: true, observed: [] },
    { warm: true, prepare: true, observed: ["allowed"] },
    { warm: true, prepare: false, observed: [] },
  ])(
    "plans manifest rows once without expanding entitlement (warm=$warm, prepare=$prepare, observed=$observed)",
    async ({ warm, prepare, observed }) => {
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        models: { catalogRefresh: { enabled: false } },
      };
      const metadataSnapshot = fixture("runtime", "allowed", "denied");
      const params = { config, metadataSnapshot };
      const declared = warm ? loadManifestModelCatalog(params) : undefined;
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        vi.mocked(planEffectiveModelCatalogRows).mockClear();
        vi.mocked(normalizeModelCatalogProviderRows).mockClear();
        if (prepare) {
          const snapshot = await build(params, observed);
          for (const rows of [snapshot.entries, snapshot.routeVariants]) {
            expect(rows.map((row) => row.id)).toEqual(observed);
            expect(rows.every((row) => row.provider === "catalog-fixture")).toBe(true);
          }
        }
        const firstRead = loadManifestModelCatalog(params);
        expect(firstRead.map((row) => row.id)).toEqual(["allowed", "denied"]);
        expect(loadManifestModelCatalog(params)).toBe(firstRead);
        if (warm) {
          expect(firstRead).toBe(declared);
        }
        expect(augment).not.toHaveBeenCalled();
        expect(planEffectiveModelCatalogRows).toHaveBeenCalledTimes(prepare ? 1 : 0);
        const normalizations = vi.mocked(normalizeModelCatalogProviderRows).mock.results;
        expect(
          normalizations.map(({ type, value }) => (type === "return" ? value.length : type)),
        ).toEqual(prepare ? [2] : []);
      });
    },
  );

  it("keeps the old declaration cache when replacement planning fails", async () => {
    const config: OpenClawConfig = { plugins: { enabled: false } };
    const initial = fixture("static", "initial");
    const replacement = fixture("static", "replacement");
    const planningError = new Error("catalog planning failed");
    const originalRows = loadManifestModelCatalog({ config, metadataSnapshot: initial });
    const params = { config, metadataSnapshot: replacement };
    await withPluginRuntimeGenerationScope({ metadataSnapshot: replacement }, async () => {
      vi.mocked(planEffectiveModelCatalogRows).mockImplementationOnce(() => {
        throw planningError;
      });
      await expect(build(params)).rejects.toBe(planningError);
      expect(loadManifestModelCatalog({ config, metadataSnapshot: initial })).toBe(originalRows);
      const snapshot = await build(params);
      expect(snapshot.entries.map((row) => row.id)).toEqual(["replacement"]);
      const replacementRows = loadManifestModelCatalog(params);
      expect(replacementRows.map((row) => row.id)).toEqual(["replacement"]);
      expect(replacementRows).not.toBe(originalRows);
      expect(loadManifestModelCatalog(params)).toBe(replacementRows);
      expect(originalRows.map((row) => row.id)).toEqual(["initial"]);
    });
  });
});
