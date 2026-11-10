import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { discoverModelCatalog } from "./agent-model-catalog.js";
import {
  discoverAuthStorageFacts,
  discoverModelsAsync,
  discoverModelsFromCapturedSources,
} from "./agent-model-discovery.js";
import { createReadonlyAuthStorage } from "./sessions/auth-storage-readonly.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";
import * as credentialExecutor from "./sessions/resolve-config-value.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Keep authored API assertions independent of ambient plugin build artifacts.
beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function writeModelsJson(agentDir: string, modelId: string): void {
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        custom: {
          baseUrl: "https://example.test/v1",
          apiKey: "sk-test",
          api: "openai",
          models: [{ id: modelId, name: modelId }],
        },
      },
    }),
  );
}

describe("discoverModels", () => {
  it("lists command-backed routes without executing credentials until a session request", async () => {
    const agentDir = tempDirs.make("openclaw-catalog-auth-");
    const resolveValue = vi.spyOn(credentialExecutor, "resolveConfigValueOrThrow");
    const source = {
      modelsJsonContents: JSON.stringify({
        providers: {
          custom: {
            baseUrl: "https://example.test/v1",
            api: "openai-completions",
            apiKey: "!echo catalog-key",
            headers: { "X-Catalog": "!echo catalog-header" },
            models: [{ id: "model", name: "Model" }],
          },
        },
      }),
      pluginCatalogs: [],
      normalizeModels: false,
    };
    const catalog = discoverModelCatalog(createReadonlyAuthStorage({}), agentDir, source);
    const row = catalog.find("custom", "model")!;
    expect(catalog.getAll()).toContain(row);
    expect(catalog.getAvailable()).toContain(row);
    expect(catalog.hasConfiguredAuth(row)).toBe(true);
    expect(resolveValue).not.toHaveBeenCalled();
    const registry = ModelRegistry.fromCapturedSources(AuthStorage.inMemory(), "captured", source);
    expect(resolveValue).not.toHaveBeenCalled();
    await expect(registry.getApiKeyAndHeaders(registry.find("custom", "model")!)).resolves.toEqual({
      ok: true,
      apiKey: "catalog-key",
      headers: { "X-Catalog": "catalog-header" },
    });
    expect(resolveValue).toHaveBeenCalled();
  });

  it("uses a directory-independent source label for lifecycle-captured catalogs", async () => {
    const firstAgentDir = tempDirs.make("openclaw-agent-models-first-");
    const secondAgentDir = tempDirs.make("openclaw-agent-models-second-");
    const createRegistry = async (agentDir: string) =>
      discoverModelsFromCapturedSources(
        (await discoverAuthStorageFacts(agentDir, { skipCredentials: true })).authStorage,
        {
          includePluginCatalogs: true,
          modelsJsonContents: "not valid json",
          pluginCatalogs: [],
        },
      );

    const firstError = (await createRegistry(firstAgentDir)).getError();
    const secondError = (await createRegistry(secondAgentDir)).getError();

    expect(firstError).toBe(secondError);
    expect(firstError).toContain("captured:models.json");
    expect(firstError).not.toContain(firstAgentDir);
    expect(secondError).not.toContain(secondAgentDir);
  });

  it("clears cached find results when the agent model registry refreshes", async () => {
    const agentDir = tempDirs.make("openclaw-agent-models-");
    writeModelsJson(agentDir, "old-model");
    const { authStorage } = await discoverAuthStorageFacts(agentDir, { skipCredentials: true });
    const registry = await discoverModelsAsync(authStorage, agentDir, { normalizeModels: false });

    expect(registry.find("CUSTOM", "old-model")).toBeUndefined();
    expect(registry.find("custom", "old-model")?.id).toBe("old-model");
    expect(registry.find("custom", "new-model")).toBeUndefined();

    writeModelsJson(agentDir, "new-model");
    await registry.refreshAsync();

    expect(registry.getAll().some((model) => model.id === "new-model")).toBe(true);
    expect(registry.find("custom", "new-model")?.id).toBe("new-model");
    expect(registry.find("CUSTOM", "new-model")).toBeUndefined();
  });

  it("preserves authored OpenAI Completions while normalizing models.json entries", async () => {
    const agentDir = tempDirs.make("openclaw-agent-models-");
    const provider = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions" as const,
      models: [{ id: "gpt-5.5", name: "GPT-5.5", baseUrl: "https://api.openai.com/v1" }],
    };
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { openai: { ...provider, apiKey: "sk-test" } } }),
    );
    const config = { models: { providers: { openai: provider } } } as unknown as OpenClawConfig;
    const { authStorage } = await discoverAuthStorageFacts(agentDir, { skipCredentials: true });
    const registry = await discoverModelsAsync(authStorage, agentDir, { config });

    expect(registry.find("openai", "gpt-5.5")?.api).toBe("openai-completions");
  });
});
