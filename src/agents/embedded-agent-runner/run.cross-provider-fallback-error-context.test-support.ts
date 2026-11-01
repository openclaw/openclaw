import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedEnsureAuthProfileStore,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedFormatAssistantErrorText,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedRunEmbeddedAttempt,
  mockedResolveAuthProfileOrder,
  createOverflowRunParams,
} from "./run.overflow-compaction.harness.js";
import {
  createFreshRunIntegrationState,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
const DEEPSEEK_ERROR_MESSAGE = "429 insufficient quota";
const COMPACTION_REMOVED_ERROR_MESSAGE = "current candidate model unavailable";
const makeCandidateAssistant = (overrides: Parameters<typeof makeAssistantMessageFixture>[0]) =>
  makeAssistantMessageFixture({
    provider: "deepseek",
    model: "deepseek-chat",
    content: [],
    ...overrides,
  });
const staleQuotaAssistant = () =>
  makeCandidateAssistant({
    provider: "openai",
    model: "gpt-5.4",
    errorMessage: "You exceeded your current OpenAI quota.",
  });

function makeCrossProviderFallbackConfig() {
  return createModelFallbackConfig("openai/gpt-5.4", [
    "deepseek/deepseek-chat",
    "google/gemini-2.5-flash",
  ]);
}

function makeFallbackRunParams(
  runId: string,
  ownedState = state,
  provider = "deepseek",
  model = "deepseek-chat",
) {
  return {
    ...createOverflowRunParams(ownedState),
    runId,
    config: makeCrossProviderFallbackConfig(),
    agentHarnessRuntimeOverride: "openclaw",
    provider,
    model,
    authProfileId: `${provider}:test`,
    authProfileIdSource: "user",
    modelFallbacksOverride: ["deepseek/deepseek-chat"],
  } satisfies Parameters<typeof runEmbeddedAgent>[0];
}

function useCrossProviderAuthFixture() {
  const store = {
    version: 1 as const,
    profiles: {
      "anthropic:test": createApiKeyCredential("anthropic", "fixture"),
      "deepseek:test": createApiKeyCredential("deepseek", "fixture"),
    },
  };
  mockedEnsureAuthProfileStore.mockReturnValue(store);
  mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(store);
  mockedResolveAuthProfileOrder.mockImplementation((params?: unknown) => {
    const provider = (params as { provider?: string } | undefined)?.provider;
    return provider && `${provider}:test` in store.profiles ? [`${provider}:test`] : [];
  });
}

describe("runEmbeddedAgent cross-provider fallback error handling", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    state = await createFreshRunIntegrationState("run.cross-provider-fallback-error-context");
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot(makeCrossProviderFallbackConfig());
    useCrossProviderAuthFixture();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it.each(["current", "completed"] as const)(
    "attributes fallback errors to the %s attempt assistant, never stale history",
    async (source) => {
      const completed = source === "completed";
      const provider = completed ? "anthropic" : "deepseek";
      const model = completed ? "test-model" : "deepseek-chat";
      const errorMessage = completed ? COMPACTION_REMOVED_ERROR_MESSAGE : DEEPSEEK_ERROR_MESSAGE;
      const current = makeCandidateAssistant({ provider, model, errorMessage });
      const matches = (value: unknown) => value === current;
      mockedIsFailoverAssistantError.mockImplementation(matches);
      if (!completed) {
        mockedIsRateLimitAssistantError.mockImplementation(matches);
      }
      mockedClassifyFailoverReason.mockReturnValue(completed ? "model_not_found" : "rate_limit");
      const result = makeAttemptResult({
        assistantTexts: [],
        lastAssistant: completed
          ? current
          : makeCandidateAssistant({
              provider: "openai",
              model: "gpt-5.4",
              errorMessage: "You have hit your ChatGPT usage limit (plus plan).",
            }),
        currentAttemptAssistant: completed ? undefined : current,
        currentAttemptCompletedAssistant: current,
      });
      // Every credential attempt must preserve the completed-event fallback.
      if (completed) {
        mockedRunEmbeddedAttempt.mockResolvedValue(result);
      } else {
        mockedRunEmbeddedAttempt.mockResolvedValueOnce(result);
      }
      const promise = runEmbeddedAgent(makeFallbackRunParams(source, state, provider, model));
      await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
      expect(mockedFormatAssistantErrorText).toHaveBeenLastCalledWith(current, expect.anything());
      await expect(promise).rejects.toThrow(
        completed
          ? "⚠️ OpenClaw couldn't finish this reply. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal."
          : "deepseek (deepseek-chat) returned a billing error",
      );
    },
  );

  it("does not present a prior provider error as the current timeout", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        lastAssistant: staleQuotaAssistant(),
        currentAttemptAssistant: undefined,
      }),
    );
    const promise = runEmbeddedAgent(makeFallbackRunParams("stale-provider-timeout"));
    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    await expect(promise).rejects.not.toThrow("OpenAI quota");
    expect(mockedFormatAssistantErrorText).not.toHaveBeenCalled();
  });
});
