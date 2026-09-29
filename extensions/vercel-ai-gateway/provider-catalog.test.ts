import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

import {
  discoverVercelAiGatewayModels,
  VERCEL_AI_GATEWAY_BASE_URL,
  VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
  VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS,
} from "./api.js";
import {
  buildStaticVercelAiGatewayProvider,
  buildVercelAiGatewayProvider,
  resolveVercelAiGatewayModel,
} from "./provider-catalog.js";

function mockCatalog(payload: unknown, status = 200) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: jsonResponse(payload, status),
    release,
    finalUrl: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
  });
  return release;
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
});

describe("vercel ai gateway provider catalog", () => {
  it.each([503, 200])(
    "preserves the public advisory builder for HTTP %s with no rows",
    async (status) => {
      const release = mockCatalog({ data: [] }, status);
      await expect(buildVercelAiGatewayProvider()).resolves.toEqual(
        buildStaticVercelAiGatewayProvider(),
      );
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("preserves provider thinking metadata for known live-only upstream models", () => {
    expect(resolveVercelAiGatewayModel("openai/gpt-5.5")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
    });
    expect(resolveVercelAiGatewayModel("anthropic/claude-sonnet-4-6")).toMatchObject({
      input: ["text", "image"],
    });
  });

  it("excludes non-language models while preserving vision and legacy catalog rows", async () => {
    mockCatalog({
      data: [
        {
          id: "alibaba/qwen3-235b-a22b-thinking",
          type: "language",
          tags: ["vision", "reasoning"],
        },
        { id: "alibaba/qwen3-embedding-0.6b", type: "embedding" },
        { id: "custom/legacy-model" },
      ],
    });

    expect((await buildVercelAiGatewayProvider()).models).toMatchObject([
      {
        id: "alibaba/qwen3-235b-a22b-thinking",
        reasoning: true,
        input: ["text", "image"],
      },
      { id: "custom/legacy-model", input: ["text"] },
    ]);
  });

  it("preserves fully filtered catalogs", async () => {
    mockCatalog({ data: [{ id: "fixture/embedding-model", type: "embedding" }] });
    await expect(discoverVercelAiGatewayModels({ discoveryMode: "strict" })).resolves.toEqual([]);
  });

  it("propagates a malformed model list row", async () => {
    const release = mockCatalog({ data: [null] });
    await expect(discoverVercelAiGatewayModels({ discoveryMode: "strict" })).rejects.toThrow(
      "Vercel AI Gateway model list: malformed JSON response",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("falls back from malformed live token metadata", async () => {
    mockCatalog({
      data: [
        {
          id: "anthropic/claude-opus-4.6",
          name: "Claude Opus 4.6",
          context_window: -1,
          max_tokens: 128_000.5,
          tags: ["vision", "reasoning"],
        },
        {
          id: "custom/provider-model",
          name: "Custom model",
          context_window: Number.POSITIVE_INFINITY,
          max_tokens: 0,
          tags: ["reasoning"],
        },
      ],
    });

    const models = await discoverVercelAiGatewayModels();

    expect(models[0]).toMatchObject({
      id: "anthropic/claude-opus-4.6",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(models[1]).toMatchObject({
      id: "custom/provider-model",
      contextWindow: VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
      maxTokens: VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS,
    });
  });

  it("uses the trusted environment proxy for the official live catalog", async () => {
    const release = mockCatalog({ data: [{ id: "custom/live-model" }] });

    const models = await discoverVercelAiGatewayModels();

    expect(models.map((model) => model.id)).toStrictEqual(["custom/live-model"]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
