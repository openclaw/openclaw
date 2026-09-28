import {
  isProviderApiKeyConfigured,
  listProfilesForProvider,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  createCodexOAuthAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

const ensureAuthProfileStoreMock = vi.fn<() => AuthProfileStore>(() => ({
  version: 1,
  profiles: {},
}));
const isProviderApiKeyConfiguredMock = vi.fn<typeof isProviderApiKeyConfigured>(() => false);
const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStore: ensureAuthProfileStoreMock,
  listProfilesForProvider,
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
});

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
  isProviderApiKeyConfiguredMock.mockReturnValue(false);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAI image generation auth availability", () => {
  it("uses capability-aware credential availability before checking the image route", () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(true);
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(true);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "openai",
      agentDir: "/tmp/agent",
      cfg: undefined,
      capability: "image-generation",
    });

    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(false);
  });

  it("reports configured from a config apiKey (gateway-routed openai) with no env/profile creds", () => {
    isProviderApiKeyConfiguredMock.mockImplementation(isProviderApiKeyConfigured);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });

    expect(
      provider.isConfigured?.({
        cfg: openAIImageConfig({
          baseUrl: "https://gateway.example.test/openai/v1",
          apiKey: "gateway-token",
        }),
      }),
    ).toBe(true);
  });

  it("honors canonical auth rejection even when another Codex profile exists", () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockReturnValue(createCodexOAuthAuthStore());
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(false);
  });

  it.each([["whitespace-only", "   "]])(
    "treats a %s config apiKey as not configured",
    (_label, apiKey) => {
      // Blank placeholders resolve to no usable credential in the generate
      // path, so readiness must not count them either.
      isProviderApiKeyConfiguredMock.mockReturnValue(false);
      ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });

      expect(
        provider.isConfigured?.({
          agentDir: "/tmp/agent",
          cfg: openAIImageConfig({
            baseUrl: "https://gateway.example.test/openai/v1",
            apiKey,
          }),
        }),
      ).toBe(false);
    },
  );

  it("reports ChatGPT OAuth image auth as configured for ChatGPT routes", () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(true);
    ensureAuthProfileStoreMock.mockReturnValue(createCodexOAuthAuthStore());

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      }),
    ).toBe(true);

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          api: "openai-chatgpt-responses",
          baseUrl: "https://openai-compatible.example.test/v1",
        }),
      }),
    ).toBe(true);
  });

  it("does not report OpenAI OAuth image auth as configured for custom OpenAI endpoints", () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(true);
    ensureAuthProfileStoreMock.mockReturnValue({
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
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://openai-compatible.example.test/v1",
        }),
      }),
    ).toBe(false);
  });

  it("does not report Codex OAuth image auth as configured for non-exact public OpenAI URLs", () => {
    isProviderApiKeyConfiguredMock.mockReturnValue(true);
    ensureAuthProfileStoreMock.mockReturnValue(createCodexOAuthAuthStore());

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://api.openai.com/v1?proxy=1",
        }),
      }),
    ).toBe(false);
  });
});
