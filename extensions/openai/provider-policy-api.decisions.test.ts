import { describe, expect, it } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveModelRoutes } from "./provider-policy-api.js";

describe("OpenAI capability route policy", () => {
  it("selects Decisions independently of the unchanged dual chat route", () => {
    const chat = resolveModelRoutes({ provider: "openai", modelId: "gpt-6-luna", env: {} });
    expect(chat).toMatchObject({
      kind: "routes",
      routes: [
        { api: "openai-responses", authRequirement: "api-key" },
        { api: "openai-chatgpt-responses", authRequirement: "subscription" },
      ],
    });
    const decision = resolveModelRoutes({
      provider: "openai",
      modelId: "gpt-6-luna",
      capability: "decision",
      env: {},
      routeIntent: { runtimeId: "codex", source: "explicit" },
    });
    expect(decision).toEqual({
      kind: "routes",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          inference: manifest.modelCatalog.providers.openai.models.find(
            (row) => row.id === "gpt-6-luna",
          )!.inference,
        },
      ],
    });
  });

  it.each([
    {
      configuredModel: { baseUrl: "https://model.example/v1" },
      configuredProvider: { baseUrl: "https://provider.example/v1" },
      expected: "https://model.example/v1",
    },
    {
      configuredProvider: { baseUrl: "https://provider.example/v1" },
      expected: "https://provider.example/v1",
    },
    { expected: "https://env.example/v1" },
  ])("honors authored destination precedence ($expected)", ({ expected, ...configured }) => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-6-luna",
        capability: "decision",
        env: { OPENAI_BASE_URL: "https://env.example/v1" },
        ...configured,
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ baseUrl: expected, authRequirement: "api-key" }],
    });
  });

  it.each(["https://chatgpt.com/backend-api/codex", "http://api.openai.com/v1", "invalid"])(
    "refuses incompatible authored endpoint %s",
    (baseUrl) => {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-6-luna",
          capability: "decision",
          configuredProvider: { baseUrl },
          env: {},
        }),
      ).toMatchObject({ kind: "incompatible", code: "unsupported-openai-decision-route" });
    },
  );

  it("does not invent Decision support for another chat model", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-6-astra",
        capability: "decision",
        env: {},
      }),
    ).toMatchObject({ kind: "incompatible" });
  });
});
