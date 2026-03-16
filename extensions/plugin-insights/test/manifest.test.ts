import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../src/types.js";

const MANIFEST_PATH = path.resolve(__dirname, "../openclaw.plugin.json");
const PACKAGE_PATH = path.resolve(__dirname, "../package.json");

describe("Plugin Manifest (openclaw.plugin.json)", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf-8"));

  it("should have required fields", () => {
    expect(manifest.id).toBe("plugin-insights");
    expect(manifest.name).toBeTruthy();
    expect(manifest.version).toBeTruthy();
    expect(manifest.description).toBeTruthy();
    expect(manifest.main).toBe("dist/index.js");
  });

  it("should have version matching package.json", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("should have a valid configSchema", () => {
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.properties).toBeDefined();
  });

  it("configSchema defaults should match DEFAULT_CONFIG", () => {
    const schema = manifest.configSchema.properties;

    expect(schema.enabled.default).toBe(DEFAULT_CONFIG.enabled);
    expect(schema.dbPath.default).toBe(DEFAULT_CONFIG.dbPath);
    expect(schema.retentionDays.default).toBe(DEFAULT_CONFIG.retentionDays);

    const judgeSchema = schema.llmJudge.properties;
    expect(judgeSchema.enabled.default).toBe(DEFAULT_CONFIG.llmJudge.enabled);
    expect(judgeSchema.baseUrl.default).toBe(DEFAULT_CONFIG.llmJudge.baseUrl);
    expect(judgeSchema.model.default).toBe(DEFAULT_CONFIG.llmJudge.model);
    expect(judgeSchema.maxEvalPerDay.default).toBe(DEFAULT_CONFIG.llmJudge.maxEvalPerDay);
  });

  it("configSchema should not allow additional properties", () => {
    expect(manifest.configSchema.additionalProperties).toBe(false);
  });
});
