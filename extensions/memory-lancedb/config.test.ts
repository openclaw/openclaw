import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";
import { memoryConfigSchema } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: Record<string, unknown> };

describe("memory-lancedb config", () => {
  it("accepts dreaming in the manifest schema and preserves it in runtime parsing", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.dreaming",
      value: {
        embedding: {
          apiKey: "sk-test",
        },
        dreaming: {
          enabled: true,
        },
      },
    });

    const parsed = memoryConfigSchema.parse({
      embedding: {
        apiKey: "sk-test",
      },
      dreaming: {
        enabled: true,
      },
    });

    expect(manifestResult.ok).toBe(true);
    expect(parsed.dreaming).toEqual({
      enabled: true,
    });
  });

  it("still rejects unrelated unknown top-level config keys", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          apiKey: "sk-test",
        },
        dreaming: {
          enabled: true,
        },
        unexpected: true,
      });
    }).toThrow("memory config has unknown keys: unexpected");
  });

  it("rejects non-object dreaming values in runtime parsing", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          apiKey: "sk-test",
        },
        dreaming: true,
      });
    }).toThrow("dreaming config must be an object");
  });

  it("accepts valid timeoutMs and maxRetries", () => {
    const parsed = memoryConfigSchema.parse({
      embedding: {
        apiKey: "sk-test",
        timeoutMs: 15_000,
        maxRetries: 3,
      },
    });
    expect(parsed.embedding.timeoutMs).toBe(15_000);
    expect(parsed.embedding.maxRetries).toBe(3);
  });

  it("accepts boundary values for timeoutMs and maxRetries", () => {
    const low = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", timeoutMs: 1000, maxRetries: 0 },
    });
    expect(low.embedding.timeoutMs).toBe(1000);
    expect(low.embedding.maxRetries).toBe(0);

    const high = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", timeoutMs: 60_000, maxRetries: 5 },
    });
    expect(high.embedding.timeoutMs).toBe(60_000);
    expect(high.embedding.maxRetries).toBe(5);
  });

  it("falls back to undefined for out-of-bounds timeoutMs", () => {
    const tooLow = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", timeoutMs: 500 },
    });
    expect(tooLow.embedding.timeoutMs).toBeUndefined();

    const tooHigh = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", timeoutMs: 120_000 },
    });
    expect(tooHigh.embedding.timeoutMs).toBeUndefined();
  });

  it("falls back to undefined for non-finite or negative timeoutMs", () => {
    const nan = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", timeoutMs: NaN },
    });
    expect(nan.embedding.timeoutMs).toBeUndefined();

    const inf = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", timeoutMs: Infinity },
    });
    expect(inf.embedding.timeoutMs).toBeUndefined();

    const neg = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", timeoutMs: -1000 },
    });
    expect(neg.embedding.timeoutMs).toBeUndefined();
  });

  it("falls back to undefined for out-of-bounds maxRetries", () => {
    const neg = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", maxRetries: -1 },
    });
    expect(neg.embedding.maxRetries).toBeUndefined();

    const tooHigh = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", maxRetries: 10 },
    });
    expect(tooHigh.embedding.maxRetries).toBeUndefined();
  });

  it("falls back to undefined for non-integer or non-finite maxRetries", () => {
    const frac = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", maxRetries: 2.5 },
    });
    expect(frac.embedding.maxRetries).toBeUndefined();

    const nan = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", maxRetries: NaN },
    });
    expect(nan.embedding.maxRetries).toBeUndefined();

    const inf = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", maxRetries: Infinity },
    });
    expect(inf.embedding.maxRetries).toBeUndefined();
  });

  it("accepts timeoutMs and maxRetries through the manifest schema", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.timeout-retries",
      value: {
        embedding: {
          apiKey: "sk-test",
          timeoutMs: 10_000,
          maxRetries: 2,
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects out-of-range timeoutMs in the manifest schema", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.timeout-oob",
      value: {
        embedding: {
          apiKey: "sk-test",
          timeoutMs: 500,
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-range maxRetries in the manifest schema", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.retries-oob",
      value: {
        embedding: {
          apiKey: "sk-test",
          maxRetries: 10,
        },
      },
    });
    expect(result.ok).toBe(false);
  });
});
