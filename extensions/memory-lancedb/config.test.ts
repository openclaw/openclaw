import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { memoryConfigSchema } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject; uiHints?: Record<string, unknown> };

function validateManifest(value: unknown) {
  return validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "memory-lancedb.manifest",
    value,
  });
}

function configWith(overrides: Record<string, unknown> = {}) {
  return { embedding: { apiKey: "sk-test" }, ...overrides };
}

describe("memory-lancedb config", () => {
  it("keeps config presentation metadata manifest-owned", () => {
    expect(memoryConfigSchema).not.toHaveProperty("uiHints");
    expect(manifest.uiHints?.["embedding.apiKey"]).toMatchObject({
      label: "Embedding API Key",
      sensitive: true,
    });
  });

  it("accepts dreaming in the manifest schema and preserves it in runtime parsing", () => {
    const config = configWith({ dreaming: { enabled: true } });
    expect(validateManifest(config).ok).toBe(true);
    expect(memoryConfigSchema.parse(config).dreaming).toEqual({ enabled: true });
  });

  it("accepts provider-backed embedding config without a plugin apiKey", () => {
    const config = { embedding: { provider: "openai" } };
    expect(validateManifest(config).ok).toBe(true);
    const parsed = memoryConfigSchema.parse(config);
    expect(parsed.embedding.apiKey).toBeUndefined();
    expect(parsed.embedding.provider).toBe("openai");
    expect(parsed.embedding.model).toBe("text-embedding-3-small");
  });

  it("rejects empty embedding config in the manifest schema and runtime parser", () => {
    const config = { embedding: {} };
    const result = validateManifest(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.text)).toContain(
        "embedding: must not have fewer than 1 properties",
      );
    }
    expect(() => memoryConfigSchema.parse(config)).toThrow(
      "embedding config must include at least one setting",
    );
  });

  it("allows missing embedding config in the manifest so setup can discover fields", () => {
    expect(validateManifest({}).ok).toBe(true);
    expect(() => memoryConfigSchema.parse({})).toThrow("embedding config required");
  });

  it("rejects empty embedding providers", () => {
    expect(() =>
      memoryConfigSchema.parse({ embedding: { provider: "", model: "text-embedding-3-small" } }),
    ).toThrow("embedding.provider must not be empty");
  });

  it("defaults non-finite character budgets and rejects invalid dimensions", () => {
    const parsed = memoryConfigSchema.parse(
      configWith({ captureMaxChars: Number.NaN, recallMaxChars: Number.POSITIVE_INFINITY }),
    );
    expect(parsed.captureMaxChars).toBe(500);
    expect(parsed.recallMaxChars).toBe(1000);
    expect(validateManifest({ embedding: { apiKey: "sk-test", dimensions: 1024.5 } }).ok).toBe(
      false,
    );
    for (const dimensions of [Number.NaN, 1024.5]) {
      expect(() =>
        memoryConfigSchema.parse({ embedding: { apiKey: "sk-test", dimensions } }),
      ).toThrow("embedding.dimensions must be a positive integer");
    }
  });

  it("still rejects unrelated unknown top-level config keys", () => {
    expect(() =>
      memoryConfigSchema.parse(configWith({ dreaming: { enabled: true }, unexpected: true })),
    ).toThrow("memory config has unknown keys: unexpected");
  });

  it("accepts custom trigger literals in the manifest schema and runtime parser", () => {
    expect(validateManifest(configWith({ customTriggers: ["记住", "important project"] })).ok).toBe(
      true,
    );
    expect(
      memoryConfigSchema.parse(configWith({ customTriggers: ["  记住  ", "important project"] }))
        .customTriggers,
    ).toEqual(["记住", "important project"]);
  });

  it("rejects unsafe custom trigger config values", () => {
    expect(() => memoryConfigSchema.parse(configWith({ customTriggers: ["记住", ""] }))).toThrow(
      "customTriggers.1 must not be empty",
    );
    expect(() =>
      memoryConfigSchema.parse(configWith({ customTriggers: ["x".repeat(101)] })),
    ).toThrow("customTriggers.0 must be at most 100 characters");
  });

  it("rejects non-object dreaming values in runtime parsing", () => {
    expect(() => memoryConfigSchema.parse(configWith({ dreaming: true }))).toThrow(
      "dreaming config must be an object",
    );
  });
});
