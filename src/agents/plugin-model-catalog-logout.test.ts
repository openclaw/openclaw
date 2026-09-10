import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  removePersistedPluginModelCatalogCredentials,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
const tempDirs: string[] = [];
function createAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-catalog-credential-"));
  tempDirs.push(dir);
  return dir;
}
function catalogContents(provider: string, apiKey: string) {
  return JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers: {
      [provider]: {
        baseUrl: "https://openai.example/v1",
        api: "openai-completions",
        apiKey,
        models: [],
      },
    },
  });
}
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
describe("credential-scoped generated catalog cleanup", () => {
  it("preserves a same-provider survivor and another owner's identical profile reference", () => {
    const agentDir = createAgentDir();
    const otherDir = createAgentDir();
    const catalogPath = encodePluginModelCatalogRelativePath("openai");
    const content = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        openai: {
          baseUrl: "https://openai.example/v1",
          api: "openai-completions",
          apiKey: "auth-profile:openai:account",
          headers: { Authorization: "Bearer synthetic-retired", "X-Routing": "retained" },
          models: [
            {
              id: "retired-route",
              name: "Retired route",
              headers: { "X-Api-Key": "synthetic-retired" },
            },
            {
              id: "surviving-route",
              name: "Surviving route",
              headers: { "X-Api-Key": "synthetic-survivor" },
            },
          ],
        },
      },
    });
    const otherContent = catalogContents("openai", "auth-profile:openai:account");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { [catalogPath]: content },
    });
    replacePersistedPluginModelCatalogs({
      agentDir: otherDir,
      pluginCatalogWrites: { [catalogPath]: otherContent },
    });
    removePersistedPluginModelCatalogCredentials({
      agentDirs: [agentDir, otherDir],
      profileReferenceAgentDirs: [agentDir],
      profileId: "openai:account",
      credential: { type: "api_key", provider: "openai", key: "synthetic-retired" },
    });
    const remaining = loadPersistedPluginModelCatalogsReadOnly(agentDir)[0]?.contents;
    expect(JSON.parse(remaining ?? "{}").providers.openai).toEqual({
      baseUrl: "https://openai.example/v1",
      api: "openai-completions",
      headers: { "X-Routing": "retained" },
      models: [
        { id: "retired-route", name: "Retired route", headers: {} },
        {
          id: "surviving-route",
          name: "Surviving route",
          headers: { "X-Api-Key": "synthetic-survivor" },
        },
      ],
    });
    expect(loadPersistedPluginModelCatalogsReadOnly(otherDir)[0]?.contents).toBe(otherContent);
  });
  it("does not remove an unmarked catalog owned by a provider", () => {
    const agentDir = createAgentDir();
    const contents = JSON.stringify({
      providers: { openai: { apiKey: "user-authored-provider-test-key" } },
    });
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { [encodePluginModelCatalogRelativePath("openai")]: contents },
    });

    expect(
      removePersistedPluginModelCatalogCredentials({
        agentDirs: [agentDir],
        profileId: "openai:retired",
        profileReferenceAgentDirs: [agentDir],
        credential: { type: "api_key", provider: "openai", key: "user-authored-provider-test-key" },
      }),
    ).toBe(0);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)[0]?.contents).toBe(contents);
  });
});
