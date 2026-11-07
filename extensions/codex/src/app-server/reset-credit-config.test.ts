import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import manifest from "../../openclaw.plugin.json" with { type: "json" };
import { readCodexPluginConfig } from "./config-parsing.js";

describe("earned Codex reset-credit config", () => {
  it("defaults to disabled when unconfigured", () => {
    expect(readCodexPluginConfig({}).resetCreditRecovery?.enabled).not.toBe(true);
  });

  it("accepts an explicitly bounded opt-in in the manifest and parser", () => {
    const config = { resetCreditRecovery: { enabled: true, maxPer24Hours: 1 } };
    expect(validateJsonSchemaValue({ schema: manifest.configSchema, value: config }).ok).toBe(true);
    expect(readCodexPluginConfig(config).resetCreditRecovery).toEqual(config.resetCreditRecovery);
  });

  it.each([0, -1, 1.5, 11])("refuses invalid spending cap %s", (maxPer24Hours) => {
    const config = { resetCreditRecovery: { enabled: true, maxPer24Hours } };
    expect(validateJsonSchemaValue({ schema: manifest.configSchema, value: config }).ok).toBe(false);
    expect(readCodexPluginConfig(config).resetCreditRecovery).toBeUndefined();
  });
});
