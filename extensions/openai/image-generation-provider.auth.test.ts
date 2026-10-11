import {
  isProviderApiKeyConfiguredAsync,
  listProfilesForProvider,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  createCodexOAuthAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

const ensureAuthProfileStoreAsyncMock = vi.fn<() => Promise<AuthProfileStore>>(async () => ({
  version: 1,
  profiles: {},
}));
const isProviderApiKeyConfiguredAsyncMock = vi.fn<typeof isProviderApiKeyConfiguredAsync>(
  async () => false,
);
const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStoreAsync: ensureAuthProfileStoreAsyncMock,
  listProfilesForProvider,
  isProviderApiKeyConfiguredAsync: isProviderApiKeyConfiguredAsyncMock,
});

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  ensureAuthProfileStoreAsyncMock.mockResolvedValue({ version: 1, profiles: {} });
  isProviderApiKeyConfiguredAsyncMock.mockResolvedValue(false);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAI image generation auth availability", () => {
  it("uses capability-aware credential availability before checking the image route", async () => {
    isProviderApiKeyConfiguredAsyncMock.mockResolvedValue(true);
    expect(await provider.isConfiguredAsync?.({ agentDir: "/tmp/agent" })).toBe(true);
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith({
      provider: "openai",
      agentDir: "/tmp/agent",
      cfg: undefined,
      store: undefined,
      capability: "image-generation",
    });

    isProviderApiKeyConfiguredAsyncMock.mockResolvedValue(false);
    ensureAuthProfileStoreAsyncMock.mockResolvedValue({ version: 1, profiles: {} });
    expect(await provider.isConfiguredAsync?.({ agentDir: "/tmp/agent" })).toBe(false);
  });

  it("reports configured from a config apiKey (gateway-routed openai) with no env/profile creds", async () => {
    isProviderApiKeyConfiguredAsyncMock.mockImplementation(isProviderApiKeyConfiguredAsync);
    ensureAuthProfileStoreAsyncMock.mockResolvedValue({ version: 1, profiles: {} });

    expect(
      await provider.isConfiguredAsync?.({
        cfg: openAIImageConfig({
          baseUrl: "https://gateway.example.test/openai/v1",
          apiKey: "gateway-token",
        }),
      }),
    ).toBe(true);
    expect(ensureAuthProfileStoreAsyncMock).not.toHaveBeenCalled();
  });

  it("honors canonical auth rejection even when another Codex profile exists", async () => {
    isProviderApiKeyConfiguredAsyncMock.mockResolvedValue(false);
    ensureAuthProfileStoreAsyncMock.mockResolvedValue(createCodexOAuthAuthStore());
    expect(await provider.isConfiguredAsync?.({ agentDir: "/tmp/agent" })).toBe(false);
  });

  it.each([["whitespace-only", "   "]])(
    "treats a %s config apiKey as not configured",
    async (_label, apiKey) => {
      // Blank placeholders resolve to no usable credential in the generate
      // path, so readiness must not count them either.
      isProviderApiKeyConfiguredAsyncMock.mockResolvedValue(false);
      ensureAuthProfileStoreAsyncMock.mockResolvedValue({ version: 1, profiles: {} });

      expect(
        await provider.isConfiguredAsync?.({
          agentDir: "/tmp/agent",
          cfg: openAIImageConfig({
            baseUrl: "https://gateway.example.test/openai/v1",
            apiKey,
          }),
        }),
      ).toBe(false);
    },
  );

  it("reports ChatGPT OAuth image auth as configured for ChatGPT routes", async () => {
    isProviderApiKeyConfiguredAsyncMock.mockResolvedValue(true);
    ensureAuthProfileStoreAsyncMock.mockResolvedValue(createCodexOAuthAuthStore());

    expect(
      await provider.isConfiguredAsync?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      }),
    ).toBe(true);

    expect(
      await provider.isConfiguredAsync?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          api: "openai-chatgpt-responses",
          baseUrl: "https://openai-compatible.example.test/v1",
        }),
      }),
    ).toBe(true);
  });

  it("reuses the worker-loaded profile store for custom-route readiness", async () => {
    const store = createCodexOAuthAuthStore();
    ensureAuthProfileStoreAsyncMock.mockResolvedValue(store);
    isProviderApiKeyConfiguredAsyncMock.mockResolvedValue(true);

    expect(
      await provider.isConfiguredAsync?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({ baseUrl: "https://chatgpt.com/backend-api/codex" }),
      }),
    ).toBe(true);
    expect(ensureAuthProfileStoreAsyncMock).toHaveBeenCalledTimes(1);
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ store }),
    );
  });

  it("does not report OpenAI OAuth image auth as configured for custom OpenAI endpoints", async () => {
    isProviderApiKeyConfiguredAsyncMock.mockResolvedValue(true);
    ensureAuthProfileStoreAsyncMock.mockResolvedValue({
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "chatgpt-access",
          refresh: "chatgpt-refresh",
          expires: Date.now() + 60_000,
        },
      },
    });

    expect(
      await provider.isConfiguredAsync?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://openai-compatible.example.test/v1",
        }),
      }),
    ).toBe(false);
  });

  it("does not report Codex OAuth image auth as configured for non-exact public OpenAI URLs", async () => {
    isProviderApiKeyConfiguredAsyncMock.mockResolvedValue(true);
    ensureAuthProfileStoreAsyncMock.mockResolvedValue(createCodexOAuthAuthStore());

    expect(
      await provider.isConfiguredAsync?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://api.openai.com/v1?proxy=1",
        }),
      }),
    ).toBe(false);
  });
});
