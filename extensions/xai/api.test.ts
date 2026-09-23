// Xai tests cover api plugin behavior.
import { describe, expect, it } from "vitest";
import {
  normalizeXaiModelId,
  resolveXaiForwardCompatModel,
  resolveXaiTransport,
  XAI_BASE_URL,
} from "./api.js";
import { normalizeXaiModelId as normalizeXaiModelIdDirect } from "./model-id.js";

describe("xai api helpers", () => {
  it("re-exports the model normalizer", () => {
    expect(normalizeXaiModelId).toBe(normalizeXaiModelIdDirect);
  });

  it("uses shared endpoint classification for native xAI transports", () => {
    expect(
      resolveXaiTransport({
        provider: "custom-xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      }),
    ).toEqual({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it.each([
    ["xai", "openai-completions"],
    ["x-ai", "openai-completions"],
    ["xai", "openai-responses"],
    ["x-ai", "openai-responses"],
  ])("keeps default-route xAI transport for %s with %s", (provider, api) => {
    expect(
      resolveXaiTransport({
        provider,
        api,
      }),
    ).toEqual({
      api: "openai-responses",
      baseUrl: XAI_BASE_URL,
    });
  });

  it.each(["openai-completions", "openai-responses"])(
    "preserves explicit foreign proxy routing for %s",
    (api) => {
      expect(
        resolveXaiTransport({
          provider: "x-ai",
          api,
          baseUrl: "https://proxy.example.test/v1",
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    {
      provider: "xai",
      modelId: "grok-4.5",
      cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
    },
    {
      provider: "x-ai",
      modelId: "grok-4.5",
      cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
    },
    {
      provider: "xai",
      modelId: "grok-fixture-next",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ])(
    "resolves materialized $provider/$modelId with its own known or unknown pricing",
    ({ provider, modelId, cost }) => {
      const model = resolveXaiForwardCompatModel({
        providerId: "xai",
        ctx: {
          provider,
          modelId,
          modelRegistry: { find: () => null } as never,
          providerConfig: { baseUrl: "", models: [] },
        },
      });

      expect(model?.baseUrl).toBe(XAI_BASE_URL);
      expect(model?.reasoning).toBe(true);
      expect(model?.cost).toEqual(cost);
    },
  );
});
