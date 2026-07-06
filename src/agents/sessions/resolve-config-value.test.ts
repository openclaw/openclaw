// Tests for resolve-config-value empty-string edge cases.
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { resolveConfigValue, resolveConfigValueUncached } from "./resolve-config-value.js";

const EMPTY_KEY = "OPENCLAW_TEST_EMPTY_CONFIG_KEY";
const TEST_PROVIDER = "openclaw-test-provider";
const TEST_ENV_KEY = "OPENCLAW_TEST_MODEL_KEY";

describe("resolveConfigValue", () => {
  afterEach(() => {
    delete process.env[EMPTY_KEY];
  });

  it("returns the literal config key when no env var is set", () => {
    const result = resolveConfigValue(EMPTY_KEY);
    expect(result).toBe(EMPTY_KEY);
  });

  it("returns the env var value when set to a real value", () => {
    process.env[EMPTY_KEY] = "sk-real-api-key";
    const result = resolveConfigValue(EMPTY_KEY);
    expect(result).toBe("sk-real-api-key");
  });

  it("returns empty string when env var is set to empty string", () => {
    process.env[EMPTY_KEY] = "";
    const result = resolveConfigValue(EMPTY_KEY);
    expect(result).toBe("");
  });
});

describe("resolveConfigValueUncached", () => {
  afterEach(() => {
    delete process.env[EMPTY_KEY];
  });

  it("returns the literal config key when no env var is set", () => {
    const result = resolveConfigValueUncached(EMPTY_KEY);
    expect(result).toBe(EMPTY_KEY);
  });

  it("returns the env var value when set to a real value", () => {
    process.env[EMPTY_KEY] = "sk-real-api-key";
    const result = resolveConfigValueUncached(EMPTY_KEY);
    expect(result).toBe("sk-real-api-key");
  });

  it("returns empty string when env var is set to empty string", () => {
    process.env[EMPTY_KEY] = "";
    const result = resolveConfigValueUncached(EMPTY_KEY);
    expect(result).toBe("");
  });
});

describe("ModelRegistry.getProviderAuthStatus with env apiKey", () => {
  let modelsPath: string;

  function writeTestModelsJson(apiKey?: string, auth?: string) {
    const path = join(tmpdir(), `openclaw-test-models-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          [TEST_PROVIDER]: {
            baseUrl: "https://test.example/v1",
            api: "openai-completions",
            ...(auth !== undefined ? { auth } : {}),
            ...(apiKey !== undefined ? { apiKey } : {}),
            models: [{ id: "test-model" }],
          },
        },
      }),
    );
    return path;
  }

  beforeEach(() => {
    delete process.env[TEST_ENV_KEY];
  });

  afterEach(() => {
    delete process.env[TEST_ENV_KEY];
    if (modelsPath) {
      try {
        unlinkSync(modelsPath);
      } catch {}
    }
  });

  it("reports configured with env source when env var has a real value", () => {
    process.env[TEST_ENV_KEY] = "sk-test-key";
    modelsPath = writeTestModelsJson(TEST_ENV_KEY);
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    expect(registry.getProviderAuthStatus(TEST_PROVIDER)).toEqual({
      configured: true,
      source: "environment",
      label: TEST_ENV_KEY,
    });
  });

  it("reports not configured when env var is set to empty string", () => {
    process.env[TEST_ENV_KEY] = "";
    modelsPath = writeTestModelsJson(TEST_ENV_KEY);
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    expect(registry.getProviderAuthStatus(TEST_PROVIDER)).toEqual({
      configured: false,
    });
  });

  it("falls back to models_json_key when env var is absent", () => {
    modelsPath = writeTestModelsJson(TEST_ENV_KEY);
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    expect(registry.getProviderAuthStatus(TEST_PROVIDER)).toEqual({
      configured: true,
      source: "models_json_key",
    });
  });

  it("reports configured when apiKey is a shell command", () => {
    modelsPath = writeTestModelsJson("!echo sk-test");
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    expect(registry.getProviderAuthStatus(TEST_PROVIDER)).toEqual({
      configured: true,
      source: "models_json_command",
    });
  });
});

describe("ModelRegistry availability with env apiKey", () => {
  let modelsPath: string;

  function writeTestModelsJson(apiKey?: string, auth?: string) {
    const path = join(tmpdir(), `openclaw-test-models-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          [TEST_PROVIDER]: {
            baseUrl: "https://test.example/v1",
            api: "openai-completions",
            ...(auth !== undefined ? { auth } : {}),
            ...(apiKey !== undefined ? { apiKey } : {}),
            models: [{ id: "test-model" }],
          },
        },
      }),
    );
    return path;
  }

  beforeEach(() => {
    delete process.env[TEST_ENV_KEY];
  });

  afterEach(() => {
    delete process.env[TEST_ENV_KEY];
    if (modelsPath) {
      try {
        unlinkSync(modelsPath);
      } catch {}
    }
  });

  it("excludes provider from getAvailable when env var is empty", () => {
    process.env[TEST_ENV_KEY] = "";
    modelsPath = writeTestModelsJson(TEST_ENV_KEY);
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    expect(registry.getAvailable()).toEqual([]);
    expect(registry.find(TEST_PROVIDER, "test-model")).toBeDefined();
  });

  it("includes provider in getAvailable when env var has a real value", () => {
    process.env[TEST_ENV_KEY] = "sk-test-key";
    modelsPath = writeTestModelsJson(TEST_ENV_KEY);
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const model = registry.find(TEST_PROVIDER, "test-model")!;
    expect(registry.getAvailable()).toEqual([model]);
    expect(registry.hasConfiguredAuth(model)).toBe(true);
  });

  it("includes provider in getAvailable when env var is absent (literal key)", () => {
    modelsPath = writeTestModelsJson(TEST_ENV_KEY);
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const model = registry.find(TEST_PROVIDER, "test-model")!;
    expect(registry.getAvailable()).toEqual([model]);
    expect(registry.hasConfiguredAuth(model)).toBe(true);
  });

  it("includes provider in getAvailable when runtime API key override is set", () => {
    process.env[TEST_ENV_KEY] = "";
    modelsPath = writeTestModelsJson(TEST_ENV_KEY);
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(TEST_PROVIDER, "sk-runtime-override");
    const registry = ModelRegistry.create(authStorage, modelsPath);
    const model = registry.find(TEST_PROVIDER, "test-model")!;
    expect(registry.getAvailable()).toEqual([model]);
    expect(registry.hasConfiguredAuth(model)).toBe(true);
  });

  it("includes provider in getAvailable when apiKey is a shell command", () => {
    modelsPath = writeTestModelsJson("!echo sk-test");
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const model = registry.find(TEST_PROVIDER, "test-model")!;
    expect(registry.getAvailable()).toEqual([model]);
    expect(registry.hasConfiguredAuth(model)).toBe(true);
  });
});
