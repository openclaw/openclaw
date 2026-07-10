// Openai tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveModelRoutes, resolveThinkingProfile } from "./provider-policy-api.js";

describe("OpenAI provider policy artifact", () => {
  it("keeps OpenAI thinking policy for openai refs", () => {
    const codexProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
    });
    const openaiProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3",
    });
    const openaiMiniProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });

    expect(codexProfile?.levels.map((level) => level.id)).toContain("xhigh");
    expect(openaiProfile?.levels.map((level) => level.id)).not.toContain("xhigh");
    expect(openaiMiniProfile?.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("exposes max for the GPT-5.6 series", () => {
    const solLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
    })?.levels.map((level) => level.id);
    const terraLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-terra",
    })?.levels.map((level) => level.id);
    const lunaLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-luna",
    })?.levels.map((level) => level.id);

    expect(solLevels).toContain("max");
    expect(terraLevels).toContain("xhigh");
    expect(terraLevels).toContain("max");
    expect(lunaLevels).toContain("xhigh");
    expect(lunaLevels).toContain("max");
  });

  it.each([
    ["gpt-5.6-sol", "codex", "low"],
    ["gpt-5.6-sol", "openclaw", "low"],
    ["gpt-5.6-terra", "codex", "medium"],
    ["gpt-5.6-terra", "openclaw", "medium"],
    ["gpt-5.6-luna", "codex", "medium"],
    ["gpt-5.6-luna", "openclaw", "medium"],
  ])("uses the model default for %s on %s", (modelId, agentRuntime, expected) => {
    const profile = resolveThinkingProfile({
      provider: "openai",
      modelId,
      agentRuntime,
    });

    expect(profile?.defaultLevel).toBe(expected);
  });

  it.each(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "exposes logical Ultra for %s on the OpenClaw runtime",
    (modelId) => {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "openclaw",
      })?.levels.map((level) => level.id);

      expect(levels).toContain("ultra");
    },
  );

  it.each(["gpt-5.6-sol", "gpt-5.6-terra"])(
    "uses native Ultra fallback for %s when model/list metadata is unavailable",
    (modelId) => {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "codex",
      })?.levels.map((level) => level.id);

      expect(levels).toContain("ultra");
    },
  );

  it.each(["gpt-5.6-sol", "gpt-5.6-terra"])(
    "keeps native Ultra fallback for %s with direct OpenAI API metadata",
    (modelId) => {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "codex",
        compat: {
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        },
      })?.levels.map((level) => level.id);

      expect(levels).toContain("ultra");
    },
  );

  it("does not invent native Ultra support for bare or suffixed GPT-5.6 refs", () => {
    for (const modelId of ["gpt-5.6", "gpt-5.6-sol-oai"]) {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "codex",
      })?.levels.map((level) => level.id);

      expect(levels).not.toContain("max");
      expect(levels).not.toContain("ultra");
    }
  });

  it("lets authoritative Codex model/list metadata override native fallbacks", () => {
    const solLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    })?.levels.map((level) => level.id);
    const terraLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-terra",
      agentRuntime: "codex",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    })?.levels.map((level) => level.id);

    expect(solLevels).not.toContain("ultra");
    expect(terraLevels).toContain("ultra");
  });

  it.each([
    { efforts: [], expected: ["off"] },
    { efforts: ["high"], expected: ["off", "high"] },
  ])("uses the complete authoritative Codex effort list for $efforts", ({ efforts, expected }) => {
    const profile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      compat: { supportedReasoningEfforts: efforts },
    });

    expect(profile?.levels.map((level) => level.id)).toEqual(expected);
    expect(profile?.defaultLevel).toBeUndefined();
  });

  it("keeps Codex Luna capped at Max without authoritative Ultra metadata", () => {
    const levels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      agentRuntime: "codex",
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    })?.levels.map((level) => level.id);

    expect(levels).toContain("max");
    expect(levels).not.toContain("ultra");
  });
  it("orders Platform before ChatGPT for unconfigured routable models", () => {
    const expected = {
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
        },
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
        },
      ],
    } as const;
    for (const observed of [
      { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    ] as const) {
      expect(resolveModelRoutes({ provider: "openai", modelId: "gpt-5.5", observed })).toEqual(
        expected,
      );
    }
  });

  it("keeps the exact dual-route roster explicit", () => {
    for (const modelId of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-codex",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
    ]) {
      const resolution = resolveModelRoutes({ provider: "openai", modelId });
      expect(
        resolution.kind === "routes" ? resolution.routes.map((route) => route.api) : [],
      ).toEqual(["openai-responses", "openai-chatgpt-responses"]);
    }
  });

  it("lets authored model routes lock provider, environment, and observed facts", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: {
          api: "openai-responses",
          baseUrl: "https://model.example.test/v1",
        },
        configuredProvider: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://provider.example.test/v1",
        },
        environment: { baseUrl: "https://env.example.test/v1" },
        observed: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://model.example.test/v1",
          authRequirement: "api-key",
        },
      ],
    });
  });

  it("preserves custom ChatGPT relays as subscription routes", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://proxy.example.test/v1",
        },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://proxy.example.test/v1",
          authRequirement: "subscription",
        },
      ],
    });
  });

  it("preserves configured versus environment custom transport defaults", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredProvider: { baseUrl: "https://configured.example.test/v1" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-completions", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        environment: { baseUrl: "https://env.example.test/v1" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
  });

  it("uses only API-key observed adapters for independently authored custom endpoints", () => {
    for (const [configured, observedApi] of [
      [
        { configuredProvider: { baseUrl: "https://configured.example.test/v1" } },
        "openai-completions",
      ],
      [{ environment: { baseUrl: "https://env.example.test/v1" } }, "openai-responses"],
    ] as const) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          ...configured,
          observed: { api: observedApi },
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "openclaw",
        routes: [{ api: observedApi, authRequirement: "api-key" }],
      });
    }
  });

  it("requires authored ChatGPT intent before sending subscription auth to a custom endpoint", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        configuredProvider: { baseUrl: "https://configured.example.test/v1" },
        observed: { api: "openai-chatgpt-responses" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-completions", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        environment: { baseUrl: "https://env.example.test/v1" },
        observed: { api: "openai-chatgpt-responses" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        observed: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://observed-relay.example.test/v1",
        },
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
        environment: { baseUrl: "https://api.openai.com/v1" },
        observed: { api: "openai-chatgpt-responses" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
        environment: { baseUrl: "https://api.openai.com/v1" },
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
        observed: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
        },
      ],
    });
  });

  it("rejects explicitly authored Platform Spark routes", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
        configuredProvider: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "subscription-only-model-on-platform",
    });
  });

  it("rejects conflicting official APIs and endpoints", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredProvider: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "conflicting-official-openai-route",
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

  it("lets partial model official facts outrank lower provider facts", () => {
    const chatGPT = {
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
        },
      ],
    } as const;
    const platform = {
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
        },
      ],
    } as const;

    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: { api: "openai-chatgpt-responses" },
        configuredProvider: { baseUrl: "https://api.openai.com/v1" },
      }),
    ).toEqual(chatGPT);
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: { baseUrl: "https://chatgpt.com/backend-api/codex" },
        configuredProvider: { api: "openai-responses" },
      }),
    ).toEqual(chatGPT);
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: { api: "openai-responses" },
        configuredProvider: { baseUrl: "https://chatgpt.com/backend-api/codex" },
      }),
    ).toEqual(platform);
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: { baseUrl: "https://api.openai.com/v1" },
        configuredProvider: { api: "openai-chatgpt-responses" },
      }),
    ).toEqual(platform);
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

  it("does not combine authored ChatGPT facts with an observed Platform row", () => {
    const observed = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as const;
    for (const configuredModel of [
      { api: "openai-chatgpt-responses" },
      { baseUrl: "https://chatgpt.com/backend-api/v1" },
    ] as const) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredModel,
          observed,
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [
          {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authRequirement: "subscription",
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
        observed: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toMatchObject({ kind: "incompatible", code: "conflicting-official-openai-route" });
    expect(
      resolveModelRoutes({
        provider: "openai",
        observed: { baseUrl: { url: "https://api.openai.com/v1" } },
      }),
    ).toMatchObject({ kind: "incompatible", code: "invalid-openai-base-url" });
    for (const baseUrl of [
      "not a URL",
      "http://api.openai.com/v1",
      "https://api.openai.com:8443/v1",
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1?proxy=1",
      "https://chatgpt.com/backend-api/codex#fragment",
      "http://chatgpt.com./backend-api/codex",
    ]) {
      expect(resolveModelRoutes({ provider: "openai", observed: { baseUrl } })).toMatchObject({
        kind: "incompatible",
        code: "invalid-openai-base-url",
      });
    }
    expect(
      resolveModelRoutes({
        provider: "openai",
        configuredModel: { api: "openai-responses" },
        configuredProvider: { baseUrl: "http://api.openai.com/v1" },
      }),
    ).toMatchObject({ kind: "incompatible", code: "invalid-openai-base-url" });
  });

  it("canonicalizes official completions and keeps Platform-only models on OpenClaw", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "chat-latest",
        configuredProvider: {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
        },
      ],
    });
    for (const modelId of ["chat-latest", "gpt-5.6"]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId,
          observed: {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "openclaw",
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

  it("preserves explicit ChatGPT routes for its static catalog rows", () => {
    for (const modelId of ["gpt-5.3-chat-latest", "gpt-5.4-nano"]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId,
          configuredProvider: { api: "openai-chatgpt-responses" },
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [{ api: "openai-chatgpt-responses", authRequirement: "subscription" }],
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
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5-unknown",
        observed: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      }),
    ).toMatchObject({ kind: "routes", routes: [{ api: "openai-responses" }] });
    const unknown = resolveModelRoutes({
      provider: "openai",
      modelId: "gpt-5.5-unknown",
      observed: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
    });
    expect(unknown.kind === "routes" ? unknown.routes : []).toHaveLength(1);
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5-unknown",
        observed: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-chatgpt-responses", authRequirement: "subscription" }],
    });
  });

  it("allows custom endpoints to expose Spark-like ids", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
        configuredModel: {
          api: "openai-responses",
          baseUrl: "https://relay.example.test/v1",
        },
      }),
    ).toMatchObject({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [{ authRequirement: "api-key" }],
    });
  });
});
