import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __piDiscoveryTesting, discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";

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

describe("discoverModels cache", () => {
  beforeEach(() => {
    __piDiscoveryTesting.clear();
  });
  afterEach(() => {
    delete process.env.OPENCLAW_DISABLE_MODEL_DISCOVERY_CACHE;
    __piDiscoveryTesting.clear();
  });

  it("returns the same registry instance for repeat calls with identical inputs", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pi-disc-cache-"));
    writeModelsJson(agentDir, "alpha-model");
    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });

    const first = discoverModels(authStorage, agentDir, { normalizeModels: false });
    const second = discoverModels(authStorage, agentDir, { normalizeModels: false });

    expect(second).toBe(first);
    expect(__piDiscoveryTesting.size()).toBe(1);
  });

  it("returns a fresh registry when models.json changes (cache key keyed on fingerprint)", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pi-disc-cache-mtime-"));
    writeModelsJson(agentDir, "alpha-model");
    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });

    const first = discoverModels(authStorage, agentDir, { normalizeModels: false });

    // Force a different mtime/size before re-querying.
    await new Promise((r) => setTimeout(r, 25));
    writeModelsJson(agentDir, "alpha-model-and-beta");
    const second = discoverModels(authStorage, agentDir, { normalizeModels: false });

    expect(second).not.toBe(first);
  });

  it("uses distinct cache entries for different option sets", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pi-disc-cache-opts-"));
    writeModelsJson(agentDir, "alpha-model");
    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });

    const a = discoverModels(authStorage, agentDir, { normalizeModels: false });
    const b = discoverModels(authStorage, agentDir, { normalizeModels: true });

    expect(b).not.toBe(a);
    expect(__piDiscoveryTesting.size()).toBeGreaterThanOrEqual(2);
  });

  it("skips the cache when OPENCLAW_DISABLE_MODEL_DISCOVERY_CACHE=1", () => {
    process.env.OPENCLAW_DISABLE_MODEL_DISCOVERY_CACHE = "1";
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pi-disc-cache-off-"));
    writeModelsJson(agentDir, "alpha-model");
    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });

    const first = discoverModels(authStorage, agentDir, { normalizeModels: false });
    const second = discoverModels(authStorage, agentDir, { normalizeModels: false });

    expect(second).not.toBe(first);
    expect(__piDiscoveryTesting.size()).toBe(0);
  });
});
