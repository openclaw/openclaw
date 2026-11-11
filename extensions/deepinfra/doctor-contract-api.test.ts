import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function migratedProvider(cfg: OpenClawConfig): Record<string, unknown> {
  const providers = cfg.models?.providers as Record<string, Record<string, unknown>> | undefined;
  return providers?.deepinfra ?? {};
}

const nativeUrl = "https://api.deepinfra.com/v1/inference";
const baseUrl = "https://api.deepinfra.com/v1/openai";
const deepinfraConfig = (provider: Record<string, unknown>): OpenClawConfig =>
  ({ models: { providers: { deepinfra: provider } } }) as unknown as OpenClawConfig;
const migrate = (provider: Record<string, unknown>) =>
  normalizeCompatibilityConfig({ cfg: deepinfraConfig(provider) });
// Assemble credential-shaped fixture URLs at runtime to avoid scanner false positives.
const credentialUrl = (rest: string) => ["https://user", `password@${rest}`].join(":");

describe("DeepInfra doctor contract", () => {
  it("flags legacy nativeBaseUrl and /v1/inference baseUrl values", () => {
    const nativeRule = legacyConfigRules.find((rule) => rule.path.at(-1) === "nativeBaseUrl");
    const baseUrlRule = legacyConfigRules.find((rule) => rule.path.at(-1) === "baseUrl");
    expect(nativeRule?.message).toContain("openclaw doctor --fix");
    expect([baseUrlRule?.match?.(nativeUrl), baseUrlRule?.match?.(baseUrl)]).toEqual([true, false]);
  });

  it.each([{ models: { providers: {} } }, {}])("preserves absent provider config: %j", (cfg) => {
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });

  it.each([
    [
      "nativeBaseUrl",
      `${nativeUrl}/`,
      "nativeBaseUrl -> models.providers.deepinfra.baseUrl (OpenAI-compatible /v1/openai endpoint)",
    ],
    ["baseUrl", nativeUrl, "baseUrl: /v1/inference -> /v1/openai"],
  ])("migrates %s to the canonical endpoint", (key, url, change) => {
    expect(migrate({ apiKey: "key", [key]: url })).toEqual({
      config: deepinfraConfig({ apiKey: "key", baseUrl }),
      changes: [`models.providers.deepinfra.${change}`],
    });
  });

  it("retires a custom-host nativeBaseUrl without rewriting its protocol", () => {
    const cfg = deepinfraConfig({ nativeBaseUrl: "https://gw.example.com/v1/inference" });
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([
      "models.providers.deepinfra.nativeBaseUrl: removed retired custom native endpoint; using https://api.deepinfra.com/v1/openai - set models.providers.deepinfra.baseUrl manually if your host serves an OpenAI-compatible videos API",
    ]);
    expect(migratedProvider(result.config)).toEqual({
      baseUrl: "https://api.deepinfra.com/v1/openai",
    });
  });

  it("prefers an existing baseUrl over a custom nativeBaseUrl", () => {
    const cfg = deepinfraConfig({
      baseUrl: "https://gw.example.com/v1/openai",
      nativeBaseUrl: "https://other.example.com/v1/inference",
    });
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([
      "models.providers.deepinfra.nativeBaseUrl: removed (baseUrl is already configured)",
    ]);
    expect(migratedProvider(result.config)).toEqual({
      baseUrl: "https://gw.example.com/v1/openai",
    });
  });

  it("preserves a custom host's inference endpoint", () => {
    const cfg = deepinfraConfig({ baseUrl: "https://gw.example.com/v1/inference" });
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });

  it("never echoes credentials from legacy endpoint URLs in change messages", () => {
    const nativeChanges = migrate({
      nativeBaseUrl: credentialUrl("gw.example.com/v1/inference?token=secret"),
    }).changes.join("\n");
    expect(nativeChanges).not.toMatch(/password|secret|gw\.example\.com/);
    const url = credentialUrl("api.deepinfra.com/v1/inference?token=secret");
    const result = migrate({ baseUrl: url, nativeBaseUrl: url });
    expect(result.changes.join("\n")).not.toMatch(/password|secret/);
    // Redact messages, not the operator's migrated URL.
    const migratedUrl = credentialUrl("api.deepinfra.com/v1/openai?token=secret");
    expect(result.config).toEqual(deepinfraConfig({ baseUrl: migratedUrl }));
  });
  it("does not mutate the input config", () => {
    const provider = { nativeBaseUrl: "https://gw.example.com/v1/inference" };
    const cfg = deepinfraConfig(provider);
    normalizeCompatibilityConfig({ cfg });
    expect(provider).toEqual({ nativeBaseUrl: "https://gw.example.com/v1/inference" });
  });
});
