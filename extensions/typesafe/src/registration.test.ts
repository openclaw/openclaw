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

it.each(["typesafe", "TypeSafe"])(
  "keeps %s provider credentials separate from the legacy hosted plugin key",
  (providerId) => {
    vi.mocked(getPreparedPluginSecretInput).mockClear();
    const provider = {
      baseUrl: "https://decision.example.com/v1",
      apiKey: "synthetic-server-key",
      models: [],
      timeoutSeconds: 90,
    };
    const result = resolveRuntimeConfig({
      models: { providers: { [providerId]: provider } },
      plugins: {
        entries: {
          typesafe: {
            config: {
              get apiKey(): never {
                throw new Error("hosted credential read");
              },
            },
          },
        },
      },
    });
    expect(result).toMatchObject({
      baseUrl: "https://decision.example.com/v1",
      apiKey: "synthetic-server-key",
      timeoutMs: 90000,
      providerConfig: provider,
    });
    expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
    expect(
      resolveRuntimeConfig({
        models: {
          providers: {
            typesafe: {
              ...provider,
              apiKey: { source: "store", provider: "default", id: "UNAVAILABLE" },
            },
          },
        },
      }),
    ).toMatchObject({ credentialsUnavailable: true, apiKey: undefined });
  },
);

it("uses the shared missing-versus-unavailable credential classification", () => {
  const result = resolveRuntimeConfig({
    models: {
      providers: {
        typesafe: { baseUrl: "https://decision.example.com/v1", models: [], apiKey: " " },
      },
    },
  });
  expect(result).toMatchObject({ apiKey: undefined, credentialsUnavailable: false });
});
