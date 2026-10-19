import { beforeEach, expect, it, vi } from "vitest";
import type { Model } from "../../../llm/types.js";
import { createEmbeddedRunAuthController, type EmbeddedRunAuthState } from "./auth-controller.js";

const mocks = vi.hoisted(() => ({ resolveCredential: vi.fn(), exchangeCredential: vi.fn() }));
vi.mock("../../model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../model-auth.js")>()),
  getApiKeyForModelCore: mocks.resolveCredential,
}));
vi.mock("../../../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/provider-runtime.js")>()),
  prepareProviderRuntimeAuth: mocks.exchangeCredential,
}));

beforeEach(() => vi.clearAllMocks());

it.each([false, true])(
  "observes canonical ownership after credential resolution (replaced: %s)",
  async (replaced) => {
    const events: string[] = [];
    const model: Model = {
      id: "gpt-4.1",
      name: "Synthetic admission",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1024,
    };
    const state: EmbeddedRunAuthState = {
      models: { runtime: model, effective: model },
      apiKeyInfo: null,
      lastProfileId: undefined,
      runtimeAuthState: null,
      runtimeAuthRefreshCancelled: false,
      profileIndex: 0,
      thinkLevel: "off",
    };
    mocks.resolveCredential.mockImplementation(async () => {
      events.push("credential");
      return {
        apiKey: "synthetic-resolved-key",
        mode: "api-key",
        profileId: "openai:bound",
        source: "profile",
      };
    });
    mocks.exchangeCredential.mockImplementation(async () => {
      events.push("exchange");
      return undefined;
    });
    const install = vi.fn(() => events.push("install"));
    const revalidate = vi.fn(async () => {
      events.push("canonical-owner");
      if (replaced) {
        throw new Error("Synthetic authorization was replaced");
      }
    });
    const controller = createEmbeddedRunAuthController({
      config: undefined,
      agentDir: "/synthetic/agent",
      workspaceDir: "/synthetic/workspace",
      authStore: { version: 1, profiles: {} },
      authStorage: { setRuntimeApiKey: install },
      authProfileBinding: {
        profileId: "openai:bound",
        authRequirement: "api-key",
        assertCurrent() {},
        revalidate,
      },
      profileCandidates: ["openai:bound"],
      lockedProfileId: "openai:bound",
      initialThinkLevel: "off",
      attemptedThinking: new Set(),
      fallbackConfigured: false,
      allowTransientCooldownProbe: false,
      provider: "openai",
      modelId: model.id,
      state,
      log: { debug() {}, info() {}, warn() {} },
    });
    if (replaced) {
      await expect(controller.initializeAuthProfile()).rejects.toThrow(
        /authorization was replaced/,
      );
      expect(mocks.exchangeCredential).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      expect(events).toEqual(["credential", "canonical-owner"]);
    } else {
      await controller.initializeAuthProfile();
      expect(events).toEqual(["credential", "canonical-owner", "exchange", "install"]);
      expect(state.lastProfileId).toBe("openai:bound");
    }
    expect(revalidate).toHaveBeenCalledOnce();
  },
);
