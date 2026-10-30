import { beforeEach, expect, it, vi } from "vitest";
import type { Model } from "../../../llm/types.js";
import { getProviderRequestAuth } from "../../../plugins/provider-auth-authority.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
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

// This suite substitutes resolution/preparation; canonical lifetime publication is
// exercised with real stores in auth-controller.request-auth.test.ts.
vi.mock("../../auth-profiles/authorization.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auth-profiles/authorization.js")>()),
  captureAuthProfileAuthorization: vi.fn(async () => ({
    authorizationId: "synthetic-authorization",
    assertCurrent() {},
    async revalidate() {},
    dispose() {},
  })),
}));

beforeEach(() => vi.clearAllMocks());

it.each([false, true])(
  "observes canonical ownership after credential resolution (replaced: %s)",
  async (replaced) => {
    const events: string[] = [];
    const model: Model = makeProviderModelFixture({
      id: "gpt-4.1",
      name: "Synthetic admission",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      maxTokens: 1024,
    });
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

it.each([
  "closed",
  "aborted",
  "closed-during-prepare",
  "aborted-during-prepare",
  "run-revoked-during-prepare",
  "binding-revoked-during-prepare",
  "profile-advanced",
  "resolution-error",
  "closed-after-resolve",
] as const)("refuses retained request credentials when %s", async (scenario) => {
  const model: Model = {
    id: "chat",
    name: "Synthetic request",
    provider: "fixture",
    api: "fixture",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16000,
    maxTokens: 1024,
  };
  const profileId = "fixture:selected";
  const state: EmbeddedRunAuthState = {
    models: { runtime: model, effective: model },
    apiKeyInfo: null,
    lastProfileId: undefined,
    runtimeAuthState: null,
    runtimeAuthRefreshCancelled: false,
    profileIndex: 0,
    thinkLevel: "off",
  };
  const auth = { apiKey: "synthetic-access", mode: "oauth", profileId, source: "profile" };
  mocks.resolveCredential.mockResolvedValue(auth);
  mocks.exchangeCredential.mockResolvedValue(undefined);
  const install = vi.fn();
  const abort = new AbortController();
  let current = true;
  let bindingCurrent = true;
  const assertBinding = () => {
    if (!bindingCurrent) {
      throw new Error("binding revoked");
    }
  };
  const controller = createEmbeddedRunAuthController({
    config: undefined,
    agentDir: "/synthetic/agent",
    workspaceDir: "/synthetic/workspace",
    authStore: {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "fixture",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 4102444800000,
          accountId: "account-a",
        },
      },
    },
    authStorage: { setRuntimeApiKey: install },
    authProfileBinding: {
      profileId,
      authRequirement: "subscription",
      assertCurrent: assertBinding,
      revalidate: async () => assertBinding(),
    },
    profileCandidates: [profileId],
    initialThinkLevel: "off",
    attemptedThinking: new Set(),
    fallbackConfigured: false,
    allowTransientCooldownProbe: false,
    provider: model.provider,
    modelId: model.id,
    state,
    signal: abort.signal,
    assertCurrent: () => {
      if (!current) {
        throw new Error("run revoked");
      }
    },
    log: { debug() {}, info() {}, warn() {} },
  });
  await controller.initializeAuthProfile();
  const capability = getProviderRequestAuth(state.models.effective);
  if (!capability) {
    throw new Error("Missing request auth capability");
  }
  install.mockClear();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const during = scenario.includes("during");
  if (during) {
    mocks.exchangeCredential.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { apiKey: "late-token" };
    });
  }
  if (scenario === "closed") {
    controller.stopRuntimeAuthRefreshTimer();
  }
  if (scenario === "aborted") {
    abort.abort(new Error("request canceled"));
  }
  if (scenario === "profile-advanced") {
    await controller.applyAuthProfileCandidate(profileId);
    install.mockClear();
  }
  if (scenario === "resolution-error") {
    mocks.resolveCredential.mockRejectedValue(new Error("owner lookup failed"));
  }
  if (scenario === "closed-after-resolve") {
    const result = await capability.resolve({});
    controller.stopRuntimeAuthRefreshTimer();
    expect(() => result.assertCurrent()).toThrow(/closed/);
    return;
  }
  const result = capability.resolve({});
  const assertion = expect(result).rejects.toThrow(/closed|canceled|revoked|lookup failed/);
  if (during) {
    await entered.promise;
    if (scenario === "closed-during-prepare") {
      controller.stopRuntimeAuthRefreshTimer();
    }
    if (scenario === "aborted-during-prepare") {
      abort.abort(new Error("request canceled"));
    }
    if (scenario === "run-revoked-during-prepare") {
      current = false;
    }
    if (scenario === "binding-revoked-during-prepare") {
      bindingCurrent = false;
    }
    release.resolve();
  }
  await assertion;
  expect(install).not.toHaveBeenCalled();
  controller.stopRuntimeAuthRefreshTimer();
});
