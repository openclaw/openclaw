import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  preparedModelRuntime,
  registerIsolatedHarness,
  releaseRuntimeLease,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

const { prepareAgentRuntimeAuth } = await vi.importActual<
  typeof import("./runtime-plan/prepare-auth.js")
>("./runtime-plan/prepare-auth.js");

beforeEach(resetIsolatedCompletionTestState);

describe("isolated completion plugin-owned authentication", () => {
  it("dispatches with model bounds while shared credentials and profile pins are unavailable", async () => {
    const rejectSharedAuth = () => {
      throw new Error("Shared provider authentication is unavailable.");
    };
    Object.assign(preparedModelRuntime, {
      config: {
        models: { providers: { openai: { apiKey: "synthetic-responses-key" } } },
      },
      createStores: rejectSharedAuth,
    });
    mocks.ensureAuthProfileStore.mockImplementation(rejectSharedAuth);
    mocks.prepareSimpleCompletionModel.mockImplementation(rejectSharedAuth);
    mocks.resolveCliRuntimeExecutionProvider.mockImplementation(rejectSharedAuth);
    mocks.resolveEmbeddedCliBackendDispatchEligibility.mockImplementation(rejectSharedAuth);
    mocks.prepareAgentRuntimeAuth.mockImplementationOnce(prepareAgentRuntimeAuth);
    const model = {
      provider: "openai",
      id: "gpt-test",
      api: "openai-responses",
      maxTokens: 1_024,
    };
    mocks.resolveModelAsync.mockResolvedValueOnce({
      logicalRef: { provider: model.provider, model: model.id },
      model,
    });
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "Plugin result" }]),
    }));
    registerIsolatedHarness({
      id: "plugin-owner",
      authBootstrap: "plugin",
      runIsolatedCompletionV2,
    });

    await expect(
      runIsolatedCompletion({
        ...isolatedRequest(),
        agentHarnessRuntimeOverride: undefined,
        authProfileId: "openai:unavailable",
        streamParams: { maxTokens: 4_096, temperature: 0.2 },
      }),
    ).resolves.toMatchObject({
      text: "Plugin result",
      owner: { kind: "harness", id: "plugin-owner" },
    });

    expect(mocks.resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "gpt-test",
      "/tmp/agent",
      expect.any(Object),
      expect.objectContaining({ harnessAuthBootstrap: "plugin", skipAgentDiscovery: true }),
    );
    expect(runIsolatedCompletionV2).toHaveBeenCalledOnce();
    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: {
          owner: "harness",
          model,
          plan: {
            providerForAuth: "openai",
            modelId: "gpt-test",
            authProfileProviderForAuth: "openai",
            harnessAuthProvider: "plugin-owner",
            credentialSource: { kind: "none" },
          },
          authProfileStore: { version: 1, profiles: {} },
        },
        streamParams: { maxTokens: 1_024, temperature: 0.2 },
      }),
    );
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
  });

  it("rejects plugin-owned authentication when only the host-auth completion API is implemented", async () => {
    registerIsolatedHarness({
      id: "plugin-owner",
      authBootstrap: "plugin",
      runIsolatedCompletion: async () => {
        throw new Error("Host-auth completion must not run.");
      },
    });

    await expect(runIsolatedCompletion(isolatedRequest())).rejects.toMatchObject({
      code: "unsupported",
      message: "Agent harness plugin-owner does not support isolated completion.",
    });
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
  });
});
