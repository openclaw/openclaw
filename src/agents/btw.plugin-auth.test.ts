import "./btw.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_DIR,
  DEFAULT_PROVIDER,
  createSessionEntry,
  ensureAuthProfileStoreMock,
  ensureAuthProfileStoreWithoutExternalProfilesMock,
  getApiKeyForModelMock,
  preparedRuntimeSnapshotState,
  registerAgentHarness,
  registerCodexSideQuestionHarness,
  resolveModelAsyncMock,
  resolveSessionAuthSelectionMock,
  runSideQuestion,
  setupBtwTestHooks,
  supportsPreparedOpenAIAuth,
} from "./btw.test-support.js";

function createOpenAIModel(subscription = false) {
  return {
    provider: "openai",
    id: "gpt-5.5",
    api: subscription ? ("openai-chatgpt-responses" as const) : ("openai-responses" as const),
    baseUrl: subscription ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
  };
}

function createPluginRuntimeConfig() {
  return {
    agents: {
      defaults: {
        models: { "openai/gpt-5.5": { agentRuntime: { id: "plugin-auth" } } },
      },
    },
  };
}

describe("runBtwSideQuestion plugin-owned authentication", () => {
  setupBtwTestHooks();

  it("runs plugin-auth side questions when shared provider credentials are unavailable", async () => {
    const runPluginSideQuestion = vi.fn().mockResolvedValue({ text: "Plugin side answer." });
    registerAgentHarness({
      id: "plugin-auth",
      label: "Plugin-owned auth test harness",
      authBootstrap: "plugin",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
      runSideQuestion: runPluginSideQuestion,
    });
    const sharedAuthUnavailable = () => {
      throw new Error("Shared provider credentials are unavailable");
    };
    resolveSessionAuthSelectionMock.mockImplementation(sharedAuthUnavailable);
    ensureAuthProfileStoreMock.mockImplementation(sharedAuthUnavailable);
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockImplementation(sharedAuthUnavailable);
    getApiKeyForModelMock.mockImplementation(sharedAuthUnavailable);
    preparedRuntimeSnapshotState.snapshot = {
      ...(preparedRuntimeSnapshotState.snapshot as object),
      createStoresOverride: sharedAuthUnavailable,
    };
    const platformModel = createOpenAIModel();
    resolveModelAsyncMock.mockResolvedValue({ model: platformModel });

    await expect(
      runSideQuestion({
        cfg: createPluginRuntimeConfig(),
        provider: "openai",
        model: "gpt-5.5",
        sessionEntry: createSessionEntry({ authProfileOverride: "openai:unavailable" }),
      }),
    ).resolves.toEqual({ text: "Plugin side answer." });

    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "openai",
      "gpt-5.5",
      DEFAULT_AGENT_DIR,
      expect.any(Object),
      expect.objectContaining({ harnessAuthBootstrap: "plugin" }),
    );
    expect(runPluginSideQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeModel: platformModel,
        preparedRuntimeAuth: expect.objectContaining({
          plan: {
            providerForAuth: "openai",
            modelId: "gpt-5.5",
            authProfileProviderForAuth: "openai",
            harnessAuthProvider: "plugin-auth",
            credentialSource: { kind: "none" },
          },
          authProfileStore: { version: 1, profiles: {} },
        }),
      }),
    );
  });

  it.each(["initial", "resolved"])(
    "rejects a plugin-auth harness without side questions after %s selection",
    async (selection) => {
      registerAgentHarness({
        id: "plugin-auth",
        label: "Plugin-owned auth test harness",
        authBootstrap: "plugin",
        supports: (ctx) =>
          ctx.provider === "openai"
            ? { supported: true, priority: 100 }
            : { supported: false, reason: "Unsupported provider" },
        runAttempt: vi.fn(),
      });
      resolveModelAsyncMock.mockResolvedValue({ model: createOpenAIModel() });

      await expect(
        runSideQuestion({
          cfg: createPluginRuntimeConfig(),
          provider: selection === "initial" ? "openai" : DEFAULT_PROVIDER,
          model: "gpt-5.5",
        }),
      ).rejects.toThrow(
        'Selected agent harness "plugin-auth" does not support /btw side questions.',
      );
    },
  );

  it("resolves the session auth pin when model metadata selects a host-auth harness", async () => {
    const codexSideQuestionMock = registerCodexSideQuestionHarness({
      supports: supportsPreparedOpenAIAuth,
    });
    registerAgentHarness({
      id: "plugin-auth",
      label: "Plugin-owned auth test harness",
      authBootstrap: "plugin",
      supports: (ctx) =>
        ctx.modelProvider?.preparedAuth
          ? { supported: false, reason: "Prepared model requires another harness" }
          : { supported: true, priority: 200 },
      runAttempt: vi.fn(),
      runSideQuestion: vi.fn(),
    });
    const subscriptionModel = createOpenAIModel(true);
    resolveModelAsyncMock.mockResolvedValue({ model: subscriptionModel });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai:pinned",
      source: "user",
      routeRequirement: "subscription",
    });
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:pinned": {
          type: "token",
          provider: "openai",
          token: "subscription-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "token",
      source: "profile:openai:pinned",
      profileId: "openai:pinned",
    });

    await expect(
      runSideQuestion({
        provider: DEFAULT_PROVIDER,
        model: "gpt-5.5",
        sessionEntry: createSessionEntry({ authProfileOverride: "openai:pinned" }),
      }),
    ).resolves.toEqual({ text: "Codex side answer." });

    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      DEFAULT_PROVIDER,
      "gpt-5.5",
      DEFAULT_AGENT_DIR,
      expect.any(Object),
      expect.objectContaining({ harnessAuthBootstrap: "plugin" }),
    );
    expect(resolveSessionAuthSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ harnessRuntime: "codex" }),
    );
    expect(codexSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:pinned",
        authProfileIdSource: "user",
        preparedRuntimeAuth: expect.objectContaining({
          plan: expect.objectContaining({
            forwardedAuthProfileId: "openai:pinned",
            forwardedAuthProfileSource: "user",
          }),
        }),
      }),
    );
  });
});
