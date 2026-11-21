// Verifies model catalog lookup scope for custom and manifest-owned models.
import { describe, expect, it } from "vitest";
import {
  isProviderCatalogSourceAllowed,
  resolveModelCatalogScope,
} from "../plugins/provider-config-owner.js";
import { configFor, modelDefinition } from "./model-auth.fixtures.test-support.js";

describe("isProviderCatalogSourceAllowed", () => {
  it.each<{
    source?: string;
    discovery: "runtime" | "static";
    allowed: boolean;
    provider?: string;
  }>([
    { source: "https://custom.example/v1", discovery: "runtime", allowed: true },
    {
      source: "https://custom.example/v1",
      discovery: "runtime",
      allowed: true,
      provider: "fixture-alias",
    },
    { source: "https://custom.example/catalog", discovery: "runtime", allowed: true },
    { source: "https://foreign.example/v1", discovery: "runtime", allowed: false },
    { source: "http://custom.example/v1", discovery: "runtime", allowed: false },
    { source: "https://custom.example:8443/v1", discovery: "runtime", allowed: false },
    { source: "invalid url", discovery: "runtime", allowed: false },
    { source: undefined, discovery: "runtime", allowed: false },
    { source: "https://custom.example/v1", discovery: "static", allowed: false },
  ])(
    "checks $discovery source $source against the configured origin",
    ({ source, discovery, allowed, provider = "fixture" }) => {
      expect(
        isProviderCatalogSourceAllowed({
          provider,
          config: {
            models: {
              providers: { [provider]: { baseUrl: "https://custom.example", models: [] } },
            },
          },
          plugin: {
            modelCatalog: {
              discovery: { fixture: discovery },
              configuredEndpointDiscovery: ["fixture"],
              aliases: { "fixture-alias": { provider: "fixture" } },
              providers: { fixture: { baseUrl: "https://native.example/v1", models: [] } },
            },
          },
          sourceBaseUrl: source,
        }),
      ).toBe(allowed);
    },
  );

  it.each(["https://chatgpt.com/backend-api/codex", "https://proxy.example/v1"])(
    "preserves OpenAI runtime sources without configured-origin opt-in: %s",
    (sourceBaseUrl) => {
      expect(
        isProviderCatalogSourceAllowed({
          provider: "openai",
          config: {},
          plugin: {
            modelCatalog: {
              discovery: { openai: "runtime" },
              providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } },
            },
          },
          sourceBaseUrl,
        }),
      ).toBe(true);
    },
  );
});

describe("resolveModelCatalogScope", () => {
  it("keeps explicit custom provider models scoped to that provider", () => {
    // Custom provider model ids may collide with built-ins, so lookup should
    // not fall through to bare manifest refs.
    const cfg = configFor("tui-pty-mock", "http://127.0.0.1:64087/v1", {
      api: "openai-responses",
      models: [modelDefinition("gpt-5.5", { contextWindow: 128_000 })],
    });

    expect(
      resolveModelCatalogScope({
        cfg,
        provider: "tui-pty-mock",
        model: "gpt-5.5",
      }),
    ).toEqual(["tui-pty-mock/gpt-5.5"]);
  });

  it("keeps bare model refs for manifest-owned model lookup", () => {
    expect(
      resolveModelCatalogScope({
        cfg: {},
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toEqual(["openai/gpt-5.4", "gpt-5.4"]);
  });
});
