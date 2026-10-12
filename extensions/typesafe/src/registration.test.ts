import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { ConfigSchema } from "./config.js";
import { resolveRuntimeConfig } from "./credentials.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));

it("accepts only bounded source configuration and validates before reading credentials", () => {
  for (const source of ["store", "env", "file", "exec"]) {
    expect(
      Check(ConfigSchema, { apiKey: { source, provider: "default", id: "TYPESAFE_API_KEY" } }),
    ).toBe(true);
  }
  for (const config of [
    { apiKey: "synthetic-plaintext" },
    { apiKey: { source: "other", provider: "default", id: "key" } },
    { timeoutMs: 60001 },
    { model: "jev-latest" },
  ]) {
    expect(Check(ConfigSchema, config)).toBe(false);
  }
  expect(Check(ConfigSchema, {})).toBe(true);
  vi.mocked(getPreparedPluginSecretInput).mockClear();
  expect(() =>
    resolveRuntimeConfig({
      plugins: { entries: { typesafe: { config: { timeoutMs: -1 } } } },
    }),
  ).toThrow("Invalid TypeSafe configuration");
  expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
});
