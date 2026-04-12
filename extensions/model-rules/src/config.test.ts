import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../../src/plugins/schema-validator.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: Record<string, unknown> };

describe("model-rules manifest config schema", () => {
  it("accepts an empty config", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "model-rules.manifest.empty",
      value: {},
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a fully specified config", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "model-rules.manifest.full",
      value: {
        enabled: true,
        modelsFile: "RULES.md",
        disabledModels: ["gpt-5.3", "deepseek-r1"],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts enabled: false", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "model-rules.manifest.disabled",
      value: { enabled: false },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown properties", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "model-rules.manifest.unknown",
      value: { unknownField: "bad" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects wrong types", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "model-rules.manifest.wrong-type",
      value: { enabled: "yes" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-string items in disabledModels", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "model-rules.manifest.bad-array",
      value: { disabledModels: [123] },
    });
    expect(result.ok).toBe(false);
  });
});
