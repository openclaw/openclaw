// Full-entry coverage for handing Codex server_error turns to model fallback.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedFormatAssistantErrorText,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import {
  createFreshRunIntegrationState,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent Codex server_error fallback handoff", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    state = await createFreshRunIntegrationState("run.codex-server-error-fallback");
    useOpenAIPlatformAuthFixture();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("throws FailoverError for persistent Codex server_error after transient retries", async () => {
    // Codex server_error is a provider failure, not a normal assistant reply.
    // An explicit retry budget allows the full same-model recovery before
    // configured fallbacks receive the persistent failure.
    const rawCodexError =
      'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}';

    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedIsFailoverAssistantError.mockReturnValue(true);
    mockedFormatAssistantErrorText.mockReturnValue(
      "LLM error server_error: An error occurred while processing your request.",
    );
    const currentAttemptAssistant = makeAssistantMessageFixture({
      stopReason: "error",
      errorMessage: rawCodexError,
      provider: "openai",
      model: "gpt-5.4",
    });
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        providerRetryMaxRetries: 8,
        assistantTexts: [],
        lastAssistant: currentAttemptAssistant,
        currentAttemptAssistant,
      }),
    );

    const config = createModelFallbackConfig("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]);
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot(config);
    const promise = runEmbeddedAgent({
      ...createOverflowRunParams(state),
      runId: "run-codex-server-error-fallback",
      agentHarnessRuntimeOverride: "openclaw",
      config,
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow(
      "⚠️ The AI service is having trouble. Please try again in a moment.",
    );
    // Initial attempt plus the full same-model transient retry budget.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(9);
  });
});
