import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import manifest from "../../openclaw.plugin.json" with { type: "json" };
import { readCodexPluginConfig } from "./config-parsing.js";
import nativeConfig from "./fixtures/native-plugin-config.json" with { type: "json" };

describe("native Codex config contract", () => {
  it("admits the macOS catalog fixture without requiring supervision", () => {
    // The Swift catalog test consumes these same bytes through its real config reader.
    expect(validateJsonSchemaValue({ schema: manifest.configSchema, value: nativeConfig }).ok).toBe(
      true,
    );
    expect(readCodexPluginConfig(nativeConfig)).toEqual(nativeConfig);
  });
});
