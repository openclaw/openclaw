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

let authStore: AuthProfileStore = { version: 1, profiles: {} };
let authConfigured = false;
const ensureAuthProfileStoreAsyncMock = vi.fn(async () => authStore);
const isProviderApiKeyConfiguredAsyncMock = vi.fn<typeof isProviderApiKeyConfiguredAsync>(
  async () => authConfigured,
);
const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStoreAsync: ensureAuthProfileStoreAsyncMock,
  listProfilesForProvider,
  isProviderApiKeyConfiguredAsync: isProviderApiKeyConfiguredAsyncMock,
});

async function expectConfigured(
  expected: boolean,
  config?: Parameters<typeof openAIImageConfig>[0],
) {
  const cfg = config && openAIImageConfig(config);
  expect(await provider.isConfiguredAsync?.({ agentDir: "/tmp/agent", cfg })).toBe(expected);
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  authStore = { version: 1, profiles: {} };
  authConfigured = false;
  ensureAuthProfileStoreAsyncMock.mockImplementation(async () => authStore);
  isProviderApiKeyConfiguredAsyncMock.mockImplementation(async () => authConfigured);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAI image generation auth availability", () => {
  it("uses capability-aware credential availability before checking the image route", async () => {
    authConfigured = true;
    await expectConfigured(true);
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", capability: "image-generation" }),
    );

    authConfigured = false;
    authStore = createCodexOAuthAuthStore();
    await expectConfigured(false);
  });

  it("reports configured from a config apiKey (gateway-routed openai) with no env/profile creds", async () => {
    isProviderApiKeyConfiguredAsyncMock.mockImplementation(isProviderApiKeyConfiguredAsync);

    await expectConfigured(true, {
      baseUrl: "https://gateway.example.test/openai/v1",
      apiKey: "gateway-token",
    });
    expect(ensureAuthProfileStoreAsyncMock).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only config apiKey as not configured", async () => {
    await expectConfigured(false, {
      baseUrl: "https://gateway.example.test/openai/v1",
      apiKey: "   ",
    });
  });

  it.each([
    [{ baseUrl: "https://chatgpt.com/backend-api/codex" }, true],
    [
      { baseUrl: "https://openai-compatible.example.test/v1", api: "openai-chatgpt-responses" },
      true,
    ],
    [{ baseUrl: "https://openai-compatible.example.test/v1" }, false],
    [{ baseUrl: "https://api.openai.com/v1?proxy=1" }, false],
  ] as const)("gates OAuth availability for %j: %s", async (config, expected) => {
    authConfigured = true;
    authStore = createCodexOAuthAuthStore();
    await expectConfigured(expected, config);
  });
});
