import type { ImageGenerationProviderConfiguredContext } from "openclaw/plugin-sdk/image-generation";
import {
  isProviderApiKeyConfigured,
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

let authStore: AuthProfileStore = { version: 1, profiles: {} };
let authConfigured = false;
const ensureAuthProfileStoreMock = vi.fn(() => authStore);
const ensureAuthProfileStoreAsyncMock = vi.fn(async () => authStore);
const isProviderApiKeyConfiguredMock = vi.fn<typeof isProviderApiKeyConfigured>(
  () => authConfigured,
);
const isProviderApiKeyConfiguredAsyncMock = vi.fn<typeof isProviderApiKeyConfiguredAsync>(
  async () => authConfigured,
);
const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStore: ensureAuthProfileStoreMock,
  ensureAuthProfileStoreAsync: ensureAuthProfileStoreAsyncMock,
  listProfilesForProvider,
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
  isProviderApiKeyConfiguredAsync: isProviderApiKeyConfiguredAsyncMock,
});

async function expectConfigured(
  context: ImageGenerationProviderConfiguredContext,
  configured: boolean,
) {
  expect(provider.isConfigured?.(context)).toBe(configured);
  expect(await provider.isConfiguredAsync?.(context)).toBe(configured);
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  authStore = { version: 1, profiles: {} };
  authConfigured = false;
  ensureAuthProfileStoreMock.mockImplementation(() => authStore);
  ensureAuthProfileStoreAsyncMock.mockImplementation(async () => authStore);
  isProviderApiKeyConfiguredMock.mockImplementation(() => authConfigured);
  isProviderApiKeyConfiguredAsyncMock.mockImplementation(async () => authConfigured);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAI image generation auth availability", () => {
  it("uses capability-aware credential availability before checking the image route", async () => {
    authConfigured = true;
    await expectConfigured({ agentDir: "/tmp/agent" }, true);
    const authInput = {
      provider: "openai",
      agentDir: "/tmp/agent",
      cfg: undefined,
      store: undefined,
      capability: "image-generation",
    };
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith(authInput);
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith(authInput);

    authConfigured = false;
    await expectConfigured({ agentDir: "/tmp/agent" }, false);
  });

  it("reports configured from a config apiKey (gateway-routed openai) with no env/profile creds", async () => {
    isProviderApiKeyConfiguredMock.mockImplementation(isProviderApiKeyConfigured);
    isProviderApiKeyConfiguredAsyncMock.mockImplementation(isProviderApiKeyConfiguredAsync);

    await expectConfigured(
      {
        cfg: openAIImageConfig({
          baseUrl: "https://gateway.example.test/openai/v1",
          apiKey: "gateway-token",
        }),
      },
      true,
    );
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
    expect(ensureAuthProfileStoreAsyncMock).not.toHaveBeenCalled();
  });

  it("honors canonical auth rejection even when another Codex profile exists", async () => {
    authStore = createCodexOAuthAuthStore();
    await expectConfigured({ agentDir: "/tmp/agent" }, false);
  });

  it.each([["whitespace-only", "   "]])(
    "treats a %s config apiKey as not configured",
    async (_label, apiKey) => {
      // Blank placeholders resolve to no usable credential in the generate
      // path, so readiness must not count them either.
      await expectConfigured(
        {
          agentDir: "/tmp/agent",
          cfg: openAIImageConfig({
            baseUrl: "https://gateway.example.test/openai/v1",
            apiKey,
          }),
        },
        false,
      );
    },
  );

  it("reports ChatGPT OAuth image auth as configured for ChatGPT routes", async () => {
    authConfigured = true;
    authStore = createCodexOAuthAuthStore();

    await expectConfigured(
      {
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      },
      true,
    );

    await expectConfigured(
      {
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          api: "openai-chatgpt-responses",
          baseUrl: "https://openai-compatible.example.test/v1",
        }),
      },
      true,
    );
  });

  it("reuses the worker-loaded profile store for custom-route readiness", async () => {
    const store = createCodexOAuthAuthStore();
    authStore = store;
    authConfigured = true;

    expect(
      await provider.isConfiguredAsync?.({
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({ baseUrl: "https://chatgpt.com/backend-api/codex" }),
      }),
    ).toBe(true);
    expect(ensureAuthProfileStoreAsyncMock).toHaveBeenCalledTimes(1);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
    expect(isProviderApiKeyConfiguredMock).not.toHaveBeenCalled();
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ store }),
    );
  });

  it("does not report OpenAI OAuth image auth as configured for custom OpenAI endpoints", async () => {
    authConfigured = true;
    authStore = {
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
    };

    await expectConfigured(
      {
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://openai-compatible.example.test/v1",
        }),
      },
      false,
    );
  });

  it("does not report Codex OAuth image auth as configured for non-exact public OpenAI URLs", async () => {
    authConfigured = true;
    authStore = createCodexOAuthAuthStore();

    await expectConfigured(
      {
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://api.openai.com/v1?proxy=1",
        }),
      },
      false,
    );
  });
});
