// Openai tests cover provider policy api plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isResponseModelEquivalent,
  normalizeModelCatalogId,
  resolveModelRoutes,
  resolveThinkingProfile,
} from "./provider-policy-api.js";

describe("OpenAI provider policy artifact", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["openai", "gpt-5.6", "gpt-5.6-terra", false],
    ["openai", "gpt-5.6", "gpt-5.6-sol-2026-08-01", true],
    ["anthropic", "gpt-5.6-luna", "gpt-5.6-luna-2026-08-02", false],
  ])(
    "declares response-model equivalence for %s/%s -> %s as %s",
    (provider, requestedModelId, responseModelId, expected) => {
      expect(isResponseModelEquivalent({ provider, requestedModelId, responseModelId })).toBe(
        expected,
      );
    },
  );

  it("normalizes the legacy Codex model alias at the provider boundary", () => {
    expect(normalizeModelCatalogId({ provider: " OpenAI ", modelId: "openai/GPT-5.4-CODEX" })).toBe(
      "gpt-5.4",
    );
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "openai/gpt-5.4-codex",
        env: {},
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses" }, { api: "openai-chatgpt-responses" }],
    });
    expect(normalizeModelCatalogId({ provider: "openai", modelId: "openai/acme-model" })).toBe(
      "openai/acme-model",
    );
  });

  it.each([{ name: "empty efforts", compat: { supportedReasoningEfforts: [] } }])(
    "suppresses scalar controls with $name",
    ({ compat }) => {
      for (const agentRuntime of ["openclaw", "codex"] as const) {
        const profile = resolveThinkingProfile({
          provider: "openai",
          modelId: "gpt-5.6-luna",
          agentRuntime,
          api: agentRuntime === "codex" ? "openai-chatgpt-responses" : "openai-responses",
          compat,
        });

        expect(profile?.levels).toEqual([]);
        expect(profile?.defaultLevel).toBeUndefined();
      }
    },
  );

  it.each(["native-test"])("does not borrow binary transport controls for %s", (agentRuntime) => {
    expect(
      resolveThinkingProfile({
        provider: "openai",
        modelId: "binary-model",
        agentRuntime,
        api: "openai-completions",
        compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: false },
      })?.levels,
    ).toEqual([]);
  });

  it.each([["gpt-6-astra", "codex", "medium"]])(
    "uses the model default for %s on %s",
    (modelId, agentRuntime, expected) => {
      const profile = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime,
      });

      expect(profile?.defaultLevel).toBe(expected);
    },
  );

  it.each(["gpt-5.6"])("exposes logical Ultra for %s on the OpenClaw runtime", (modelId) => {
    const levels = resolveThinkingProfile({
      provider: "openai",
      modelId,
      agentRuntime: "openclaw",
    })?.levels.map((level) => level.id);

    expect(levels).toContain("ultra");
  });

  it.each(["gpt-future-observed"])(
    "groups reversed physical routes for unknown logical model %s",
    (modelId) => {
      const platform = {
        api: "openai-responses" as const,
        baseUrl: "https://api.openai.com/v1",
      };
      const chatGPT = {
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      };
      const forward = resolveModelRoutes({
        provider: "openai",
        modelId,
        observedRoutes: [platform, chatGPT],
      });
      const reversed = resolveModelRoutes({
        provider: "openai",
        modelId,
        observedRoutes: [chatGPT, platform],
      });

      expect(reversed).toEqual(forward);
      expect(forward).toMatchObject({
        kind: "routes",
        routes: [
          { api: "openai-responses", authRequirement: "api-key" },
          { api: "openai-chatgpt-responses", authRequirement: "subscription" },
        ],
      });
    },
  );

  it("deduplicates equivalent custom URLs independently of observation order", () => {
    const withoutSlash = {
      api: "openai-responses" as const,
      baseUrl: "https://relay.example.test:443/v1",
    };
    const withSlash = {
      api: "openai-responses" as const,
      baseUrl: "https://relay.example.test/v1/",
    };
    const forward = resolveModelRoutes({
      provider: "openai",
      modelId: "gpt-future-observed",
      observedRoutes: [withoutSlash, withSlash],
    });
    const reversed = resolveModelRoutes({
      provider: "openai",
      modelId: "gpt-future-observed",
      observedRoutes: [withSlash, withoutSlash],
    });

    expect(reversed).toEqual(forward);
    expect(forward).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
    expect(forward.kind === "routes" ? forward.routes : []).toHaveLength(1);
  });

  it("rejects plaintext observations beside HTTPS routes", () => {
    const httpsRoute = {
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const httpRoute = {
      api: "openai-chatgpt-responses" as const,
      baseUrl: "http://chatgpt.com/backend-api/codex",
    };
    for (const observedRoutes of [
      [httpsRoute, httpRoute],
      [httpRoute, httpsRoute],
    ]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-future-observed",
          observedRoutes,
        }),
      ).toMatchObject({ kind: "incompatible", code: "invalid-openai-base-url" });
    }
  });

  it("rejects unsupported observed adapters for authored custom endpoints", () => {
    for (const observedRoutes of [
      [{ api: "anthropic-messages" as const }],
      [{ api: "openai-responses" as const }, { api: "anthropic-messages" as const }],
    ]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredProvider: { baseUrl: "https://configured.example.test/v1" },
          observedRoutes,
        }),
      ).toMatchObject({
        kind: "incompatible",
        code: "unsupported-custom-openai-api",
      });
    }
  });

  it("rejects conflicting observed Platform adapters regardless of order", () => {
    for (const observedRoutes of [
      [{ api: "openai-responses" as const }, { api: "openai-completions" as const }],
      [{ api: "openai-completions" as const }, { api: "openai-responses" as const }],
    ]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredProvider: { baseUrl: "https://configured.example.test/v1" },
          observedRoutes,
        }),
      ).toMatchObject({
        kind: "incompatible",
        code: "ambiguous-openai-route-group",
      });
    }
  });

  it("uses only API-key observed adapters for independently authored custom endpoints", () => {
    for (const [configured, observedApi] of [
      [
        { configuredProvider: { baseUrl: "https://configured.example.test/v1" } },
        "openai-completions",
      ],
      [{ env: { OPENAI_BASE_URL: "https://env.example.test/v1" } }, "openai-responses"],
    ] as const) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          ...configured,
          observedRoutes: [{ api: observedApi }],
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "openclaw",
        routes: [{ api: observedApi, authRequirement: "api-key" }],
      });
    }
  });

  it("ignores unrelated observed adapter conflicts for complete authored routes", () => {
    const observedRoutes = [
      { api: "openai-responses" as const },
      { api: "openai-completions" as const },
    ];

    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: { api: "openai-chatgpt-responses" },
        observedRoutes,
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-chatgpt-responses", authRequirement: "subscription" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
        observedRoutes,
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
  });

  it("requires authored ChatGPT intent before sending subscription auth to a custom endpoint", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        configuredProvider: { baseUrl: "https://configured.example.test/v1" },
        observedRoutes: [{ api: "openai-chatgpt-responses" }],
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-completions", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        env: { OPENAI_BASE_URL: "https://env.example.test/v1" },
        observedRoutes: [{ api: "openai-chatgpt-responses" }],
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        observedRoutes: [
          {
            api: "openai-chatgpt-responses",
            baseUrl: "https://observed-relay.example.test/v1",
          },
        ],
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "custom-chatgpt-relay-requires-configuration",
    });
  });

  it("treats an environment Platform URL as an explicit route lock", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "subscription-only-model-on-platform",
    });
  });

  it("routes unconfigured Spark only through ChatGPT", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
    });
  });

  it("rejects the wrong provider and unsupported official adapters", () => {
    expect(resolveModelRoutes({ provider: "anthropic", modelId: "gpt-5.5" })).toMatchObject({
      kind: "incompatible",
      code: "openai-route-provider-mismatch",
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        configuredProvider: {
          api: "anthropic-messages",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "unsupported-official-openai-api",
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        configuredProvider: {
          api: "anthropic-messages",
          baseUrl: "https://relay.example.test/v1",
        },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "unsupported-custom-openai-api",
    });
  });

  it("inherits lower custom endpoints without changing the model adapter", () => {
    for (const [api, authRequirement] of [
      ["openai-chatgpt-responses", "subscription"],
      ["openai-responses", "api-key"],
    ] as const) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredModel: { api },
          configuredProvider: { baseUrl: "https://relay.example.test/v1" },
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "openclaw",
        routes: [
          {
            api,
            baseUrl: "https://relay.example.test/v1",
            authRequirement,
          },
        ],
      });
    }
  });

  it("rejects internally contradictory observed routes", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        observedRoutes: [
          {
            api: "openai-chatgpt-responses",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
      }),
    ).toMatchObject({ kind: "incompatible", code: "conflicting-official-openai-route" });
    expect(
      resolveModelRoutes({
        provider: "openai",
        observedRoutes: [{ baseUrl: { url: "https://api.openai.com/v1" } }],
      }),
    ).toMatchObject({ kind: "incompatible", code: "invalid-openai-base-url" });
    for (const baseUrl of [
      "not a URL",
      "https://api.openai.com:8443/v1",
      "http://api.openai.com:443/v1",
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1?proxy=1",
      "https://chatgpt.com/backend-api/codex#fragment",
    ]) {
      expect(
        resolveModelRoutes({ provider: "openai", observedRoutes: [{ baseUrl }] }),
      ).toMatchObject({
        kind: "incompatible",
        code: "invalid-openai-base-url",
      });
    }
  });

  it("keeps explicit API route intent on official Completions", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredProvider: {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
        },
        routeIntent: { authRequirement: "api-key", source: "explicit" },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
      ],
    });
    for (const modelId of ["chat-latest", "gpt-5.6"]) {
      expect(resolveModelRoutes({ provider: "openai", modelId })).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [{ api: "openai-responses", authRequirement: "api-key" }],
      });
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId,
          configuredProvider: { api: "openai-chatgpt-responses" },
        }),
      ).toMatchObject({
        kind: "incompatible",
        code: "platform-only-model-on-chatgpt",
      });
    }
  });

  it("canonicalizes equivalent Platform URLs and keeps unknown variants single-route", () => {
    for (const baseUrl of [
      "https://api.openai.com",
      "https://api.openai.com/v1/",
      "https://api.openai.com:443/v1",
      "https://api.openai.com./v1",
    ]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredProvider: { baseUrl },
        }),
      ).toMatchObject({
        kind: "routes",
        routes: [{ baseUrl: "https://api.openai.com/v1" }],
      });
    }
    const unknown = resolveModelRoutes({
      provider: "openai",
      modelId: "gpt-5.5-unknown",
      observedRoutes: [{ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
    });
    expect(unknown).toMatchObject({ kind: "routes", routes: [{ api: "openai-responses" }] });
    expect(unknown.kind === "routes" ? unknown.routes : []).toHaveLength(1);
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5-unknown",
        observedRoutes: [
          {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        ],
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-chatgpt-responses", authRequirement: "subscription" }],
    });
    expect(resolveModelRoutes({ provider: "openai", modelId: "gpt-5.5-unknown" })).toEqual({
      kind: "indeterminate",
      defaultRuntimeId: "codex",
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5-unknown",
        requestTransportOverrides: "present",
      }),
    ).toEqual({ kind: "indeterminate", defaultRuntimeId: "openclaw" });
  });
});
