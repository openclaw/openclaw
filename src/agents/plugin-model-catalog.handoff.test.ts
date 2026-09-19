// A one-shot run with fresh state carries operator catalog metadata, not credentials.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { discoverModelsFromCapturedSources } from "./agent-model-discovery.js";
import {
  capturePluginModelCatalogHandoff,
  withPluginModelCatalogHandoff,
} from "./plugin-model-catalog-handoff.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const CACHED_ONLY_MODEL = "cached-only-model";
const CATALOG_PLUGIN_ID = "catalog-owner";

const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [{ id: CATALOG_PLUGIN_ID, providers: ["fixture"] }],
});

const tempDirs: string[] = [];

/** Creates a conventional `<state>/agents/<id>/agent` directory, as a real run does. */
function createAgentDir(agentId = "fixture-agent"): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-plugin-catalog-handoff-"));
  tempDirs.push(root);
  const agentDir = join(root, "agents", agentId, "agent");
  mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

/** Seeds one operator-owned generated catalog, credentials included. */
function seedCatalog(agentDir: string, providers: Record<string, unknown>): string {
  const contents = JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers,
  });
  replacePersistedPluginModelCatalogs({
    agentDir,
    pluginCatalogWrites: { [encodePluginModelCatalogRelativePath(CATALOG_PLUGIN_ID)]: contents },
  });
  return contents;
}

function operatorProviders(): Record<string, unknown> {
  return {
    fixture: {
      api: "openai-completions",
      baseUrl: "https://fixture.example/v1",
      apiKey: "operator-api-key",
      auth: "api-key",
      headers: { authorization: "Bearer operator-token" },
      request: { maxRetries: 3 },
      params: { reasoning: "high" },
      localService: { command: "serve", env: { SERVICE_TOKEN: "operator-token" } },
      models: [
        {
          id: CACHED_ONLY_MODEL,
          name: "Cached only",
          api: "openai-completions",
          contextWindow: 65536,
          maxTokens: 4096,
          reasoning: true,
          input: ["text"],
          headers: { "x-model-header": "operator-token" },
          params: { temperature: 0.2 },
        },
      ],
    },
  };
}

/** Reads the prepared-registry source exactly as lifecycle preparation does. */
function readPreparedCatalogSource(agentDir: string) {
  return discoverModelsFromCapturedSources(AuthStorage.inMemory(), {
    // The static manifest declares no provider rows for this model.
    config: {},
    modelsJsonContents: null,
    pluginCatalogs: loadPersistedPluginModelCatalogsReadOnly(agentDir),
    pluginMetadataSnapshot,
  });
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("request-owned plugin model catalog handoff", () => {
  it("carries provider and model metadata without credentials or request parameters", async () => {
    const operatorDir = createAgentDir();
    seedCatalog(operatorDir, operatorProviders());

    const handoff = await capturePluginModelCatalogHandoff(operatorDir);

    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.pluginId).toBe(CATALOG_PLUGIN_ID);
    const carried = JSON.parse(handoff[0]?.contents ?? "{}") as {
      generatedBy?: string;
      providers?: Record<string, Record<string, unknown>>;
    };
    expect(carried.generatedBy).toBe(PLUGIN_MODEL_CATALOG_GENERATED_BY);
    expect(carried.providers?.fixture).toEqual({
      api: "openai-completions",
      baseUrl: "https://fixture.example/v1",
      models: [
        {
          id: CACHED_ONLY_MODEL,
          name: "Cached only",
          api: "openai-completions",
          contextWindow: 65536,
          maxTokens: 4096,
          reasoning: true,
          input: ["text"],
        },
      ],
    });
    expect(handoff[0]?.contents).not.toContain("operator-api-key");
    expect(handoff[0]?.contents).not.toContain("operator-token");
    expect(handoff[0]?.contents).not.toContain("localService");
  });

  it("fills only plugin ids the run's own agent directory does not retain", async () => {
    const operatorDir = createAgentDir();
    seedCatalog(operatorDir, operatorProviders());
    const freshRunDir = createAgentDir();
    expect(loadPersistedPluginModelCatalogsReadOnly(freshRunDir)).toEqual([]);

    const handoff = await capturePluginModelCatalogHandoff(operatorDir);
    const scoped = withPluginModelCatalogHandoff(handoff, () =>
      loadPersistedPluginModelCatalogsReadOnly(freshRunDir),
    );

    expect(scoped.map((catalog) => catalog.pluginId)).toEqual([CATALOG_PLUGIN_ID]);
    // The scope is request-owned: nothing leaks into the run's own state.
    expect(loadPersistedPluginModelCatalogsReadOnly(freshRunDir)).toEqual([]);
  });

  it("keeps a retained local catalog authoritative, including an empty one", async () => {
    const operatorDir = createAgentDir();
    seedCatalog(operatorDir, operatorProviders());
    const runDir = createAgentDir();
    seedCatalog(runDir, {
      fixture: {
        api: "openai-completions",
        baseUrl: "https://run.example/v1",
        models: [],
      },
    });

    const handoff = await capturePluginModelCatalogHandoff(operatorDir);
    const scoped = withPluginModelCatalogHandoff(handoff, () =>
      loadPersistedPluginModelCatalogsReadOnly(runDir),
    );

    expect(scoped).toHaveLength(1);
    expect(JSON.parse(scoped[0]?.contents ?? "{}")).toMatchObject({
      providers: { fixture: { baseUrl: "https://run.example/v1", models: [] } },
    });
  });

  it("restores cached-only model resolution for a fresh task state directory", async () => {
    const operatorDir = createAgentDir();
    seedCatalog(operatorDir, operatorProviders());
    const freshRunDir = createAgentDir();

    expect(
      readPreparedCatalogSource(freshRunDir).find("fixture", CACHED_ONLY_MODEL),
    ).toBeUndefined();

    const handoff = await capturePluginModelCatalogHandoff(operatorDir);
    const resolved = withPluginModelCatalogHandoff(handoff, () =>
      readPreparedCatalogSource(freshRunDir),
    );

    expect(resolved.getError()).toBeUndefined();
    expect(resolved.find("fixture", CACHED_ONLY_MODEL)).toMatchObject({
      name: "Cached only",
      contextWindow: 65536,
    });
  });
});
