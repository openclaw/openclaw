import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPENCLAW_MANAGED_AUTH_MARKER } from "./model-auth-markers.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";

function writeModelsJson(agentDir: string, modelId: string, apiKey = "sk-test"): void {
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        custom: {
          baseUrl: "https://example.test/v1",
          apiKey,
          api: "openai",
          models: [{ id: modelId, name: modelId }],
        },
      },
    }),
  );
}

describe("discoverModels", () => {
  it("clears cached find results when the PI registry refreshes", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pi-models-"));
    writeModelsJson(agentDir, "old-model");
    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });
    const registry = discoverModels(authStorage, agentDir, { normalizeModels: false });

    expect(registry.find("custom", "new-model")).toBeUndefined();

    writeModelsJson(agentDir, "new-model");
    registry.refresh();

    expect(registry.getAll().some((model) => model.id === "new-model")).toBe(true);
    expect(registry.find("custom", "new-model")?.id).toBe("new-model");
  });

  it("accepts OpenClaw-managed auth markers for custom model entries", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pi-models-"));
    writeModelsJson(agentDir, "custom-model", OPENCLAW_MANAGED_AUTH_MARKER);
    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });
    const registry = discoverModels(authStorage, agentDir, { normalizeModels: false });

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("custom", "custom-model")?.id).toBe("custom-model");
  });
});
