import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../../src/plugins/schema-validator.js";
import type { JsonSchemaObject } from "../../../src/shared/json-schema.types.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

describe("memory-core manifest config schema", () => {
  it("accepts dreaming phase thresholds used by QA and runtime", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-core.manifest.dreaming-phase-thresholds",
      value: {
        dreaming: {
          enabled: true,
          timezone: "Europe/London",
          verboseLogging: true,
          storage: {
            mode: "inline",
            separateReports: false,
          },
          phases: {
            light: {
              enabled: true,
              lookbackDays: 2,
              limit: 20,
              dedupeSimilarity: 0.9,
            },
            deep: {
              enabled: true,
              limit: 10,
              minScore: 0,
              minRecallCount: 3,
              minUniqueQueries: 3,
              recencyHalfLifeDays: 14,
              maxAgeDays: 30,
            },
            rem: {
              enabled: true,
              lookbackDays: 7,
              limit: 10,
              minPatternStrength: 0.75,
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts dreaming.model for all-phase model override", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-core.manifest.dreaming-model",
      value: {
        dreaming: {
          enabled: true,
          model: "google/gemini-2.5-flash",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts per-phase execution.model overrides", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-core.manifest.dreaming-per-phase-execution-model",
      value: {
        dreaming: {
          enabled: true,
          phases: {
            light: { execution: { model: "google/gemini-2.5-flash" } },
            deep: { execution: { model: "anthropic/claude-sonnet-4-6" } },
            rem: { execution: { model: "google/gemini-2.5-flash" } },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects unknown keys on dreaming", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-core.manifest.dreaming-unknown-key",
      value: {
        dreaming: {
          unknownKey: "value",
        },
      },
    });

    expect(result.ok).toBe(false);
  });
});
