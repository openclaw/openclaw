// Tests for resolve-config-value empty-string edge cases.
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfigValue, resolveConfigValueUncached } from "./resolve-config-value.js";

const EMPTY_KEY = "OPENCLAW_TEST_EMPTY_CONFIG_KEY";

describe("resolveConfigValue", () => {
  afterEach(() => {
    delete process.env[EMPTY_KEY];
  });

  it("returns the literal config key when no env var is set", () => {
    const result = resolveConfigValue(EMPTY_KEY);
    expect(result).toBe(EMPTY_KEY);
  });

  it("returns the env var value when set to a real value", () => {
    process.env[EMPTY_KEY] = "sk-real-api-key";
    const result = resolveConfigValue(EMPTY_KEY);
    expect(result).toBe("sk-real-api-key");
  });

  it("returns empty string when env var is set to empty string", () => {
    process.env[EMPTY_KEY] = "";
    const result = resolveConfigValue(EMPTY_KEY);
    expect(result).toBe("");
  });
});

describe("resolveConfigValueUncached", () => {
  afterEach(() => {
    delete process.env[EMPTY_KEY];
  });

  it("returns the literal config key when no env var is set", () => {
    const result = resolveConfigValueUncached(EMPTY_KEY);
    expect(result).toBe(EMPTY_KEY);
  });

  it("returns the env var value when set to a real value", () => {
    process.env[EMPTY_KEY] = "sk-real-api-key";
    const result = resolveConfigValueUncached(EMPTY_KEY);
    expect(result).toBe("sk-real-api-key");
  });

  it("returns empty string when env var is set to empty string", () => {
    process.env[EMPTY_KEY] = "";
    const result = resolveConfigValueUncached(EMPTY_KEY);
    expect(result).toBe("");
  });
});
