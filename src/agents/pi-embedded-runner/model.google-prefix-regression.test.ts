import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { discoverAuthStorageMock, discoverModelsMock } = vi.hoisted(() => ({
  discoverAuthStorageMock: vi.fn(() => ({ mocked: true })),
  discoverModelsMock: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: discoverAuthStorageMock,
  discoverModels: discoverModelsMock,
}));

import type { OpenClawConfig } from "../../config/config.js";
import { normalizeGoogleModelId } from "../models-config.providers.js";
import { geminiAnalyzePdf } from "../tools/pdf-native-providers.js";
import { resolveModel } from "./model.js";

function buildGoogleConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        google: {
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com",
          models: [
            {
              id: "gemini-2.5-pro",
              name: "gemini-2.5-pro",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_048_576,
              maxTokens: 65_536,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  discoverAuthStorageMock.mockReturnValue({ mocked: true });
  discoverModelsMock.mockReturnValue({
    find: vi.fn(() => null),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("google model prefix regression", () => {
  it("strips google and models prefixes before applying Google model aliases", () => {
    expect(normalizeGoogleModelId("google/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(normalizeGoogleModelId("models/google/gemini-3.1-flash")).toBe("gemini-3-flash-preview");
  });

  it("normalizes split google provider/model input during model resolution", () => {
    const result = resolveModel(
      "google",
      "google/gemini-2.5-pro",
      "/tmp/agent",
      buildGoogleConfig(),
    );

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
      id: "gemini-2.5-pro",
      name: "gemini-2.5-pro",
    });
  });

  it("uses the stripped Google model id in native Gemini PDF requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "ok" }],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await geminiAnalyzePdf({
      apiKey: "test-key", // pragma: allowlist secret
      modelId: "google/gemini-2.5-pro",
      prompt: "test",
      pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
      baseUrl: "https://example.com",
    });

    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://example.com/v1beta/models/gemini-2.5-pro:generateContent?key=test-key",
    );
  });
});
