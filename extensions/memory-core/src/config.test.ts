import fs from "node:fs";
import { type JsonSchemaObject, validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { describe, expect, it } from "vitest";

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

  it("accepts session rollup configuration block", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-core.manifest.rollup-config",
      value: {
        memoryRollups: {
          enabled: true,
          outputDir: "memory/session-rollups",
          maxMessages: 120,
          maxSummaryChars: 2000,
          redactSecrets: true,
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("allows omitted memoryRollups config block", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-core.manifest.rollup-config-omitted",
      value: {},
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid memoryRollup maxSummaryChars values", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-core.manifest.rollup-config-invalid",
      value: {
        memoryRollups: {
          maxSummaryChars: 150,
        },
      },
    });

    expect(result.ok).toBe(false);
  });
});
