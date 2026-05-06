import fs from "node:fs";
import { type JsonSchemaObject, validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { describe, expect, it } from "vitest";
import { memoryConfigSchema } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

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

  it("accepts provider-backed embedding config without a plugin apiKey", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.provider-auth",
      value: {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    });

    const parsed = memoryConfigSchema.parse({
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
      },
    });

    expect(manifestResult.ok).toBe(true);
    expect(parsed.embedding.apiKey).toBeUndefined();
    expect(parsed.embedding.provider).toBe("openai");
  });

  it("rejects empty embedding config in the manifest schema and runtime parser", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.empty-embedding",
      value: {
        embedding: {},
      },
    });

    expect(manifestResult.ok).toBe(false);
    if (!manifestResult.ok) {
      expect(manifestResult.errors.map((error) => error.text)).toContain(
        "embedding: must NOT have fewer than 1 properties",
      );
    }

    expect(() => {
      memoryConfigSchema.parse({
        embedding: {},
      });
    }).toThrow("embedding config must include at least one setting");
  });

  it("allows missing embedding config in the manifest so setup can discover fields", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.missing-embedding",
      value: {},
    });

    expect(manifestResult.ok).toBe(true);
    expect(() => {
      memoryConfigSchema.parse({});
    }).toThrow("embedding config required");
  });

  it("rejects empty embedding providers", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          provider: "",
          model: "text-embedding-3-small",
        },
      });
    }).toThrow("embedding.provider must not be empty");
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

  it("accepts valid triggers array", () => {
    const parsed = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test" },
      triggers: ["anota esto", "mi proyecto|remember"],
    });
    expect(parsed.triggers).toEqual(["anota esto", "mi proyecto|remember"]);
  });

  it("rejects triggers that are not an array", () => {
    expect(() =>
      memoryConfigSchema.parse({
        embedding: { apiKey: "sk-test" },
        triggers: "remember",
      }),
    ).toThrow("triggers must be an array of regex strings");
  });

  it("rejects triggers with invalid regex", () => {
    expect(() =>
      memoryConfigSchema.parse({
        embedding: { apiKey: "sk-test" },
        triggers: ["valid", "["],
      }),
    ).toThrow("triggers[1] is not a valid regex");
  });

  it("accepts valid categoryRules object", () => {
    const parsed = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test" },
      categoryRules: {
        entity: "mi jefe|el cliente",
        decision: "decidimos|vamos a usar",
      },
    });
    expect(parsed.categoryRules).toEqual({
      entity: "mi jefe|el cliente",
      decision: "decidimos|vamos a usar",
    });
  });

  it("rejects categoryRules with unknown category key", () => {
    expect(() =>
      memoryConfigSchema.parse({
        embedding: { apiKey: "sk-test" },
        categoryRules: { task: "hacer|pendiente" },
      }),
    ).toThrow('categoryRules key "task" must be one of');
  });

  it("rejects categoryRules with invalid regex value", () => {
    expect(() =>
      memoryConfigSchema.parse({
        embedding: { apiKey: "sk-test" },
        categoryRules: { entity: "[" },
      }),
    ).toThrow("categoryRules.entity is not a valid regex");
  });

  it("rejects categoryRules that is not an object", () => {
    expect(() =>
      memoryConfigSchema.parse({
        embedding: { apiKey: "sk-test" },
        categoryRules: ["entity"],
      }),
    ).toThrow("categoryRules must be an object");
  });

  it("returns undefined triggers and categoryRules when not set", () => {
    const parsed = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test" },
    });
    expect(parsed.triggers).toBeUndefined();
    expect(parsed.categoryRules).toBeUndefined();
  });
});
