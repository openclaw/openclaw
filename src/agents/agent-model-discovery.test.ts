import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  discoverAuthStorageFacts,
  discoverModelsAsync,
  discoverModelsFromCapturedSources,
} from "./agent-model-discovery.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Keep authored API assertions independent of ambient plugin build artifacts.
beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => vi.unstubAllEnvs());

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
