import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import { authStore, evaluate } from "./model-auth-availability.test-support.js";

const config = {
  models: {
    providers: {
      openai: {
        auth: "native-command",
        api: "openai-responses",
        baseUrl: "https://example.test/api/autodev/llm/v1",
        models: [],
      },
    },
  },
} as OpenClawConfig;
const route = {
  kind: "routes" as const,
  routes: [
    {
      api: "openai-responses" as const,
      baseUrl: "https://example.test/api/autodev/llm/v1",
      authRequirement: "api-key" as const,
      requestTransportOverrides: "none" as const,
      runtimePolicy: {
        compatibleIds: ["openclaw", "codex"],
        requiresEndpointBinding: true as const,
      },
    },
  ] as const,
};
const autodevBaseUrl = "https://example.test/api/autodev/llm/v1";
const autodevConfig = {
  models: {
    providers: {
      autodev: {
        auth: "native-command",
        api: "openai-responses",
        baseUrl: autodevBaseUrl,
        models: [
          {
            id: "gpt-56-reasoning-sol",
            name: "Sol",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 16384,
            agentRuntime: { id: "codex" },
          },
        ],
      },
    },
  },
} as OpenClawConfig;

describe("native command model availability", () => {
  it("admits a declared custom Responses route only for Codex native command auth", () => {
    const resolver = createModelAuthAvailabilityResolver({
      cfg: autodevConfig,
      authStore: authStore(),
      env: {},
      syntheticAuthProviderRefs: ["codex"],
    });
    const ref = {
      runtimeId: "codex",
      modelId: "gpt-56-reasoning-sol",
      api: "openai-responses",
      baseUrl: autodevBaseUrl,
    };

    expect(resolver.evaluateRuntimeModelAuth("autodev", ref)).toMatchObject({
      availability: true,
      availabilityAuthoritative: true,
      selectedAuthMode: "native-command",
      runtimeAuth: { id: "codex", source: "native" },
    });
    expect(
      resolver.evaluateRuntimeModelAuth("autodev", { ...ref, runtimeId: "openclaw" }).availability,
    ).not.toBe(true);
    expect(
      resolver.evaluateRuntimeModelAuth("autodev", { ...ref, baseUrl: "https://other.test/v1" })
        .availability,
    ).not.toBe(true);
    expect(
      resolver.evaluateRuntimeModelAuth("autodev", { ...ref, pinnedProfileId: "other" })
        .availability,
    ).not.toBe(true);
    const noCodex = createModelAuthAvailabilityResolver({
      cfg: autodevConfig,
      authStore: authStore(),
      env: {},
      syntheticAuthProviderRefs: [],
    });
    expect(noCodex.evaluateRuntimeModelAuth("autodev", ref).availability).not.toBe(true);
  });

  it("selects Codex without importing an ambient or stored API key", () => {
    const result = evaluate({
      cfg: config,
      env: { OPENAI_API_KEY: "ambient-key" },
      resolution: route,
      syntheticAuthProviderRefs: ["codex"],
      ref: { runtimeId: "codex", modelId: "gpt-56-reasoning-sol" },
    });
    expect(result).toMatchObject({
      availability: true,
      selectedAuthMode: "native-command",
      selectedRoute: route.routes[0],
      runtimeAuth: { id: "codex", source: "native" },
    });
  });

  it("does not authorize host OpenClaw execution", () => {
    const result = evaluate({
      cfg: config,
      resolution: route,
      syntheticAuthProviderRefs: ["codex"],
      ref: { runtimeId: "openclaw", modelId: "gpt-56-reasoning-sol" },
    });
    expect(result.availability).toBe(false);
  });
});
