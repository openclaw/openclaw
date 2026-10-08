// Direct Images API auth failures must name the route and credential that were sent.
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { ProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  createCodexOAuthAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

const { assertOkOrThrowHttpErrorMock, postJsonRequestMock } = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(),
  postJsonRequestMock: vi.fn(async () => ({
    response: new Response("{}"),
    release: async () => {},
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "openai-key",
    mode: "api-key",
    source: "env: OPENAI_API_KEY",
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
}));

const authStore = createCodexOAuthAuthStore();
const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStore: () => authStore,
  listProfilesForProvider: (store: AuthProfileStore, providerId: string) =>
    Object.keys(store.profiles).filter((id) => store.profiles[id]?.provider === providerId),
  isProviderApiKeyConfigured: () => true,
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpenAI direct image route auth errors", () => {
  it.each([
    [
      "the resolved credential",
      {},
      "credential=api-key source=env: OPENAI_API_KEY; a ChatGPT/Codex OAuth profile exists but " +
        "explicit models.providers.openai settings select the direct Images API. To use that " +
        'profile, set baseUrl "https://chatgpt.com/backend-api/codex" and api ' +
        '"openai-chatgpt-responses", without apiKey, auth "api-key", or auth headers)',
    ],
    [
      "a configured auth header",
      { headers: { Authorization: "Bearer header-key" } },
      "credential=configured-header source=models.providers.openai; a ChatGPT/Codex OAuth",
    ],
  ])("names the route and %s on a scope error", async (_label, extra, expected) => {
    const scopeError = new ProviderHttpError(
      "OpenAI image generation failed (HTTP 401): Missing scopes: api.model.images.request",
      { status: 401 },
    );
    assertOkOrThrowHttpErrorMock.mockRejectedValueOnce(scopeError);

    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Scope error",
        cfg: openAIImageConfig({
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          ...extra,
        }),
        authStore,
      }),
    ).rejects.toBe(scopeError);
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    expect(scopeError.status).toBe(401);
    expect(scopeError.message).toContain(
      "Missing scopes: api.model.images.request " +
        "(route=images-api url=https://api.openai.com/v1/images/generations " +
        expected,
    );
  });
});
