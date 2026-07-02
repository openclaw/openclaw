/** Tests agent model discovery registry refresh and lookup cache behavior. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { discoverAuthStorage, discoverModels } from "./agent-model-discovery.js";

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-agent-models-" });

async function makeTempDir(): Promise<string> {
  return suiteTempDirs.make("temp");
}

beforeAll(async () => {
  await suiteTempDirs.setup();
});

afterAll(async () => {
  await suiteTempDirs.cleanup();
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
  it("clears cached find results when the agent model registry refreshes", async () => {
    const agentDir = await makeTempDir();
    writeModelsJson(agentDir, "old-model");
    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });
    const registry = discoverModels(authStorage, agentDir, { normalizeModels: false });

    expect(registry.find("custom", "new-model")).toBeUndefined();

    writeModelsJson(agentDir, "new-model");
    registry.refresh();

    expect(registry.getAll().some((model) => model.id === "new-model")).toBe(true);
    expect(registry.find("custom", "new-model")?.id).toBe("new-model");
  });
});
