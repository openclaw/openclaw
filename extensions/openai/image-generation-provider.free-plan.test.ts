import { type AuthProfileStore, listProfilesForProvider } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  createChatGPTAccessToken,
  createCodexOAuthAuthStore,
} from "./image-generation-provider.test-support.js";

const { resolveApiKeyForProviderMock, postJsonRequestMock } = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(),
  postJsonRequestMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonRequest: postJsonRequestMock,
}));

vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>()),
  createSubsystemLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStoreAsync: vi.fn(),
  listProfilesForProvider,
  isProviderApiKeyConfiguredAsync: vi.fn(),
});

function generateWithChatGPTPlan(planType: string) {
  resolveApiKeyForProviderMock.mockResolvedValue({
    apiKey: createChatGPTAccessToken(planType),
    source: "profile:openai:default",
    mode: "oauth",
  });
  return provider.generateImage({
    provider: "openai",
    model: "gpt-image-2",
    prompt: "Draw an avatar",
    cfg: {},
    authStore: { version: 1, profiles: {} },
  });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("OpenAI Codex image generation on ChatGPT plans", () => {
  it("fails before any request when the ChatGPT sign-in is on the Free plan", async () => {
    await expect(generateWithChatGPTPlan("free")).rejects.toThrow(
      "OpenAI image generation is not included in the Free ChatGPT plan.",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("names the Free plan when it is the only sign-in and no API key can serve images", async () => {
    resolveApiKeyForProviderMock.mockRejectedValue(
      new Error('No API key found for provider "openai".'),
    );
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          ...createCodexOAuthAuthStore().profiles["openai:default"],
          chatgptPlanType: "free",
        },
      },
    };

    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Draw an avatar",
        cfg: {},
        authStore,
      }),
    ).rejects.toThrow("OpenAI image generation is not included in the Free ChatGPT plan.");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("still sends the Codex image request for paid ChatGPT plans", async () => {
    postJsonRequestMock.mockRejectedValue(new Error("request sent"));

    await expect(generateWithChatGPTPlan("plus")).rejects.toThrow("request sent");
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ model: "gpt-6-astra" }) }),
    );
  });
});
