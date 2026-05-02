import fs from "node:fs";
import { type JsonSchemaObject, validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

function ok(value: Record<string, unknown>) {
  const result = validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "structured-memory.config-test",
    value,
  });
  return result.ok;
}

describe("structured-memory manifest config schema", () => {
  it("accepts minimal valid config", () => {
    expect(ok({ enabled: true })).toBe(true);
  });

  it("accepts full valid config", () => {
    expect(
      ok({
        enabled: true,
        classification: { model: "openai/gpt-5.4-nano", timeoutMs: 5000 },
        decay: { halfLifeDays: 14, minMaintenanceScore: 0.1 },
        recall: { maxResults: 15 },
      }),
    ).toBe(true);
  });

  it("rejects classification.timeoutMs below minimum", () => {
    expect(ok({ classification: { timeoutMs: 100 } })).toBe(false);
  });

  it("rejects classification.timeoutMs above maximum", () => {
    expect(ok({ classification: { timeoutMs: 40000 } })).toBe(false);
  });

  it("rejects decay.halfLifeDays below 1", () => {
    expect(ok({ decay: { halfLifeDays: 0 } })).toBe(false);
  });

  it("accepts decay.minMaintenanceScore at boundary 0", () => {
    expect(ok({ decay: { minMaintenanceScore: 0 } })).toBe(true);
  });

  it("rejects recall.maxResults above 50", () => {
    expect(ok({ recall: { maxResults: 100 } })).toBe(false);
  });

  it("accepts disabled config", () => {
    expect(ok({ enabled: false })).toBe(true);
  });

  it("accepts classification.timeoutMs at lower boundary", () => {
    expect(ok({ classification: { timeoutMs: 250 } })).toBe(true);
  });

  it("accepts decay.halfLifeDays at upper boundary", () => {
    expect(ok({ decay: { halfLifeDays: 365 } })).toBe(true);
  });
});
