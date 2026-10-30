import http from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../../packages/ai/src/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
} from "../../../llm/types.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import { createApiKeyCredential } from "../../auth-profiles/credential-fixtures.test-support.js";
import { classifyAssistantFailoverReason } from "../../embedded-agent-helpers/assistant-message-failures.js";
import { FailoverError } from "../../failover-error.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import { resolveAgentRunErrorLifecycleFields } from "../../run-termination.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createModelFallbackConfig } from "../../test-helpers/model-fallback-config-fixture.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import {
  makeAssistantFailureInput,
  type AssistantFailureInput,
} from "./assistant-failure.test-support.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(),
}));

vi.mock("../../../plugins/provider-failover.js", () => providerRuntimeMocks);

const CREDENTIAL_FILE_ENOENT_MESSAGE =
  "ENOENT: no such file or directory, open '/home/operator/.claude/.credentials.json'";
const INCOMPLETE_TERMINAL_STREAM_MESSAGE = "Bedrock stream ended before messageStop";

function makeExhaustedCredentialFailureInput() {
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "anthropic",
    model: "mock-1",
    stopReason: "error",
    errorMessage: CREDENTIAL_FILE_ENOENT_MESSAGE,
  });
  const input = makeAssistantFailureInput(assistant);
  Object.assign(input.runInput.runParams, {
    sessionId: "session:credential-enoent",
    runId: "run:credential-enoent",
  });
  input.runInput.agentDir = "/tmp/openclaw-assistant-failure-test";
  input.preparedRuntime.attemptedThinking = new Set(["off"]);
  input.preparedRuntime.attemptAuthProfileStore = {
    version: 1,
    profiles: {
      "anthropic:p1": createApiKeyCredential("anthropic", "test-key"),
    },
  };
  input.runtime.thinkLevel = "off";
  input.runtime.lastProfileId = "anthropic:p1";
  input.getThinkLevel = () => "off";
  input.emptyErrorRetries = 3;
  input.failover.advanceAuthProfile = vi.fn(async () => true);
  input.failover.overloadProfileRotationLimit = 1;
  input.suspensionSessionId = "session:credential-enoent";
  return {
    input,
    advanceAuthProfile: input.failover.advanceAuthProfile,
    maybeMarkAuthProfileFailure: input.failover.maybeMarkAuthProfileFailure,
    traceAttempts: input.traceAttempts,
  };
}

function setAttempt(
  input: AssistantFailureInput,
  assistant: AssistantMessage,
  overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  },
) {
  const attempt = makeEmbeddedRunnerAttempt({
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    ...overrides,
  });
  Object.assign(input.normalizedAttempt, {
    attempt,
    attemptAssistant: assistant,
    currentAttemptAssistant: assistant,
    terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
  });
}

function makeToolRejectionInput(model = "claude-opus-5") {
  const fixture = makeExhaustedCredentialFailureInput();
  setAttempt(
    fixture.input,
    buildEmbeddedRunnerAssistant({
      api: "anthropic-messages",
      provider: "anthropic",
      model,
      stopReason: "error",
      errorMessage: "Provider completed tool call with malformed JSON arguments",
      content: [],
      usage: createMockUsage(640, 1329),
    }),
  );
  return fixture;
}

function expectNoRecovery(fixture: ReturnType<typeof makeExhaustedCredentialFailureInput>) {
  expect(fixture.input.preparedRuntime.maybeRefreshRuntimeAuthForAuthError).not.toHaveBeenCalled();
  expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
  expect(fixture.traceAttempts).toEqual([]);
}

function setRuntimeModel(input: AssistantFailureInput, provider: string, model: string) {
  input.preparedRuntime.provider = provider;
  input.preparedRuntime.modelId = model;
  input.preparedRuntime.model.id = model;
  input.normalizedAttempt.activeErrorContext = { provider, model };
}

function makeIdleTimeoutFailureInput(options?: { replaySafe?: boolean }) {
  const fixture = makeExhaustedCredentialFailureInput();
  const replaySafe = options?.replaySafe === true;
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "anthropic",
    model: "mock-1",
    stopReason: "aborted",
  });
  const replayMetadata = {
    hadPotentialSideEffects: !replaySafe,
    replaySafe,
  };
  setAttempt(fixture.input, assistant, {
    terminal: { kind: "timeout", phase: "prompt", source: "idle" },
    toolMetas: replaySafe ? [] : [{ toolName: "write", replaySafe: false }],
    replayMetadata,
    currentAttemptReplayMetadata: replayMetadata,
  });
  fixture.input.emptyErrorRetries = 0;
  fixture.input.preparedRuntime.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => true);
  return fixture;
}

function makeTerminalStreamFailureInput(assistant: AssistantMessage) {
  const fixture = makeExhaustedCredentialFailureInput();
  const assistantText = assistant.content.find((part) => part.type === "text")?.text;
  setAttempt(fixture.input, assistant, {
    assistantTexts: assistantText ? [assistantText] : [],
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
  setRuntimeModel(fixture.input, assistant.provider, assistant.model);
  fixture.input.runtime.lastProfileId = undefined;
  fixture.input.emptyErrorRetries = 0;
  fixture.input.failover.advanceAuthProfile = vi.fn(async () => false);
  return fixture;
}

async function streamIncompleteMistralResponseOverLoopback() {
  const { streamMistral } = await import("../../../../packages/ai/src/providers/mistral.js");
  const partialText = "Safe partial answer";
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "terminal-stream-recovery-proof",
        object: "chat.completion.chunk",
        created: 1,
        model: "mistral-large-latest",
        choices: [{ index: 0, delta: { content: partialText }, finish_reason: null }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })}\n\n`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const model = makeProviderModelFixture<"mistral-conversations">({
    id: "mistral-large-latest",
    name: "Mistral terminal recovery proof",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: `http://127.0.0.1:${port}`,
    contextWindow: 128_000,
    maxTokens: 8192,
  });
  const context = {
    messages: [{ role: "user", content: "Inspect only", timestamp: 1 }],
  } satisfies Context;

  try {
    const stream = streamMistral(model, context, { apiKey: "redacted-fixture-token" });
    for await (const event of stream) {
      void event;
    }
    return { assistant: await stream.result(), partialText };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("handleEmbeddedAssistantFailure", () => {
  it("surfaces storage failure without replaying the run or rotating credentials", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    fixture.input.normalizedAttempt.attemptAssistant = buildEmbeddedRunnerAssistant({
      provider: "mock",
      model: "model",
      stopReason: "error",
      errorMessage: "database is locked",
    });
    fixture.input.emptyErrorRetries = 0;
    expect(await handleEmbeddedAssistantFailure(fixture.input)).toMatchObject({
      action: "proceed",
      assistantProfileFailureReason: null,
      emptyErrorRetries: 0,
      authRetryPending: false,
      lastRetryFailoverReason: null,
    });
    expect(
      fixture.input.preparedRuntime.maybeRefreshRuntimeAuthForAuthError,
    ).not.toHaveBeenCalled();
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([]);
  });
  beforeEach(() => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReset();
  });

  it.each(["auth", "auth_permanent"] as const)(
    "carries %s profile failures into terminal resolution",
    async (reason) => {
      const fixture = makeExhaustedCredentialFailureInput();
      fixture.input.normalizedAttempt.attemptAssistant.provider = "openai";
      fixture.input.normalizedAttempt.attemptAssistant.model = "gpt-5.6-luna";
      fixture.input.normalizedAttempt.attemptAssistant.errorMessage = undefined;
      setRuntimeModel(fixture.input, "openai", "gpt-5.6-luna");
      fixture.input.runInput.fallbackConfigured = false;
      fixture.input.runtime.lastProfileId = undefined;
      fixture.input.failover.resolveAuthProfileFailureReason = vi.fn(() => reason);
      const outcome = await handleEmbeddedAssistantFailure(fixture.input);

      expect(outcome).toMatchObject({
        action: "proceed",
        assistantProfileFailureReason: reason,
      });
    },
  );

  it("uses prepared OpenRouter ownership for custom-provider billing failures", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    const provider = "custom-openrouter";
    const modelId = "anthropic/claude-sonnet-4";
    const errorMessage = "HTTP 403: API key budget limit exceeded";
    const assistant = buildEmbeddedRunnerAssistant({
      provider,
      model: modelId,
      stopReason: "error",
      errorMessage,
    });
    fixture.input.normalizedAttempt.attemptAssistant = assistant;
    fixture.input.normalizedAttempt.currentAttemptAssistant = assistant;
    setRuntimeModel(fixture.input, provider, modelId);
    fixture.input.runtime.lastProfileId = undefined;
    fixture.input.providerOwner = {
      id: "openrouter",
      classifyFailoverReason: ({ errorMessage: classifiedError }) =>
        classifiedError === errorMessage ? "billing" : undefined,
    };
    fixture.input.failover.resolveAuthProfileFailureReason = vi.fn((reason) =>
      reason === "billing" ? "billing" : null,
    );
    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome).toMatchObject({
      action: "retry",
      lastRetryFailoverReason: "billing",
    });
    expect(fixture.traceAttempts).toEqual([
      {
        provider,
        model: modelId,
        result: "rotate_profile",
        reason: "billing",
        stage: "assistant",
      },
    ]);
  });

  it("uses the prepared OpenAI owner for structured Responses failures", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    const assistant = buildEmbeddedRunnerAssistant({
      provider: "openai",
      model: "gpt-5.6-luna",
      stopReason: "error",
      errorMessage: "server_error: provider failed",
      errorCode: "server_error",
    });
    setAttempt(fixture.input, assistant, {});
    setRuntimeModel(fixture.input, "openai", "gpt-5.6-luna");
    fixture.input.providerOwner = {
      id: "openai",
      classifyFailoverReason: ({ code }) =>
        code?.toUpperCase() === "SERVER_ERROR" ? "server_error" : undefined,
    };

    fixture.input.runtime.lastProfileId = undefined;
    fixture.input.failover.advanceAuthProfile = vi.fn(async () => false);

    await expect(handleEmbeddedAssistantFailure(fixture.input)).rejects.toMatchObject({
      reason: "server_error",
      status: 500,
    });
  });

  it.each([PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE, PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE])(
    "does not rotate profiles or models after replay-unsafe failure %s",
    async (errorCode) => {
      const fixture = makeExhaustedCredentialFailureInput();
      fixture.input.emptyErrorRetries = 0;
      fixture.input.normalizedAttempt.attemptAssistant.errorCode = errorCode;
      fixture.input.normalizedAttempt.attemptAssistant.errorMessage = "reasoning is required";
      fixture.input.failover.resolveAuthProfileFailureReason = vi.fn(() => "timeout" as const);

      const outcome = await handleEmbeddedAssistantFailure(fixture.input);

      expect(outcome).toMatchObject({ action: "proceed", assistantProfileFailureReason: null });
      expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
      expect(fixture.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
      expect(fixture.traceAttempts).toEqual([]);
    },
  );

  it("recovers a real loopback Mistral partial EOF through embedded model fallback", async () => {
    const { assistant, partialText } = await streamIncompleteMistralResponseOverLoopback();
    const classification = classifyAssistantFailoverReason(assistant);
    const config = createModelFallbackConfig("mistral/mistral-large-latest", [
      "google/mock-2",
    ]) satisfies OpenClawConfig;
    const calls: string[] = [];
    let embeddedFailure: { reason: string; rawError?: string } | undefined;
    let embeddedTrace: AssistantFailureInput["traceAttempts"] = [];

    const result = await runWithModelFallback({
      cfg: config,
      provider: "mistral",
      model: "mistral-large-latest",
      sessionId: "session:mistral-terminal-recovery-proof",
      skipAuthProfileRuntime: true,
      run: async (provider, model) => {
        calls.push(`${provider}/${model}`);
        if (provider === "mistral") {
          const fixture = makeTerminalStreamFailureInput(assistant);
          embeddedTrace = fixture.traceAttempts;
          try {
            await handleEmbeddedAssistantFailure(fixture.input);
          } catch (error) {
            if (error instanceof FailoverError) {
              embeddedFailure = { reason: error.reason, rawError: error.rawError };
            }
            throw error;
          }
        }
        return "fallback complete";
      },
    });

    expect(assistant).toMatchObject({
      stopReason: "error",
      errorMessage: "Mistral stream ended without a terminal finish reason",
    });
    expect(assistant.content).toContainEqual({ type: "text", text: partialText });
    expect(classification).toBe("timeout");
    expect(embeddedFailure).toEqual({
      reason: "timeout",
      rawError: "Mistral stream ended without a terminal finish reason",
    });
    expect(embeddedTrace).toEqual([
      {
        provider: "mistral",
        model: "mistral-large-latest",
        result: "timeout",
        reason: "timeout",
        stage: "assistant",
        status: 408,
      },
    ]);
    expect(calls).toEqual(["mistral/mistral-large-latest", "google/mock-2"]);
    expect(result.result).toBe("fallback complete");
    expect(result.result).not.toContain(partialText);
  });

  it("closes every failover retry after an idle timeout commits a write", async () => {
    const fixture = makeIdleTimeoutFailureInput();

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome.action).toBe("proceed");
    expectNoRecovery(fixture);
  });

  it.each([
    ["prompt", false, { timeoutPhase: "provider", providerStarted: false }],
    ["compaction", true, { providerStarted: true }],
  ] as const)(
    "preserves canonical provider-start attribution through %s idle-timeout fallback",
    async (phase, providerStarted, expectedTimeout) => {
      const fixture = makeIdleTimeoutFailureInput({ replaySafe: true });
      fixture.input.normalizedAttempt.attempt.terminal = { kind: "timeout", phase, source: "idle" };
      fixture.input.normalizedAttempt.attempt.promptTimeoutOutcome = { providerStarted };
      fixture.input.normalizedAttempt.terminalState = resolveEmbeddedRunAttemptTerminalState({
        attempt: fixture.input.normalizedAttempt.attempt,
        assistant: fixture.input.normalizedAttempt.currentAttemptAssistant,
      });
      fixture.input.preparedRuntime.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => false);
      fixture.input.failover.advanceAuthProfile = vi.fn(async () => false);

      expect(fixture.input.normalizedAttempt.terminalState.outcome).toMatchObject({
        status: "timeout",
        reason: "hard_timeout",
        ...expectedTimeout,
      });

      const failure = await handleEmbeddedAssistantFailure(fixture.input).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(FailoverError);
      expect(fixture.input.failover.advanceAuthProfile).toHaveBeenCalledOnce();
      const lifecycleFields = resolveAgentRunErrorLifecycleFields(failure, undefined);
      expect(lifecycleFields).toEqual({ stopReason: "timeout", ...expectedTimeout });
      expect(
        buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase: "error",
          data: lifecycleFields,
        }).reason,
      ).toBe("hard_timeout");
    },
  );

  it.each(["HTTP 429 Too Many Requests", INCOMPLETE_TERMINAL_STREAM_MESSAGE])(
    "does not route a caller timeout with %s through failover",
    async (errorMessage) => {
      const fixture = makeExhaustedCredentialFailureInput();
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: "error",
        errorMessage,
      });
      setAttempt(fixture.input, assistant, {
        terminal: { kind: "timeout", phase: "prompt", source: "external" },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      });
      fixture.input.emptyErrorRetries = 0;
      fixture.input.preparedRuntime.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => true);

      const outcome = await handleEmbeddedAssistantFailure(fixture.input);

      expect(outcome.action).toBe("proceed");
      expectNoRecovery(fixture);
    },
  );

  it("retries a replay-safe reasoning-only assistant error before failover", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    const assistant = buildEmbeddedRunnerAssistant({
      provider: "openai",
      model: "gpt-5.6-luna",
      stopReason: "error",
      errorMessage: "provider failed after emitting reasoning",
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs_error_turn", type: "reasoning" }),
        },
      ],
    });
    setAttempt(fixture.input, assistant);
    fixture.input.emptyErrorRetries = 0;
    fixture.input.preparedRuntime.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => true);

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome).toMatchObject({
      action: "retry",
      emptyErrorRetries: 1,
    });
    expectNoRecovery(fixture);
  });

  it("retries a blank runtime failure and advances to fallback when its budget is spent", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    const assistant = buildEmbeddedRunnerAssistant({
      api: "github-copilot",
      provider: "anthropic",
      model: "mock-1",
      stopReason: "error",
      errorMessage: "No API provider registered for api: github-copilot",
      content: [{ type: "text", text: "" }],
      usage: createMockUsage(0, 0),
    });
    setAttempt(fixture.input, assistant);
    fixture.input.emptyErrorRetries = 0;

    await expect(handleEmbeddedAssistantFailure(fixture.input)).resolves.toMatchObject({
      action: "retry",
      emptyErrorRetries: 1,
    });

    fixture.input.emptyErrorRetries = 3;
    await expect(handleEmbeddedAssistantFailure(fixture.input)).rejects.toMatchObject({
      reason: "unknown",
      provider: "anthropic",
      model: "mock-1",
      rawError: assistant.errorMessage,
    });
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["retries discarded content", 0, true, "claude-opus-5", true],
    ["surfaces the exhausted rejection", 3, false, "claude-opus-5", true],
    ["falls back after exhausting retries", 3, true, "mock-1", false],
  ] as const)(
    "%s for a pre-dispatch tool-call rejection",
    async (_name, retries, fallback, model, refresh) => {
      const fixture = makeToolRejectionInput(model);
      fixture.input.emptyErrorRetries = retries;
      fixture.input.runInput.fallbackConfigured = fallback;
      if (refresh) {
        fixture.input.preparedRuntime.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => true);
      }
      if (retries === 0) {
        expect(await handleEmbeddedAssistantFailure(fixture.input)).toMatchObject({
          action: "retry",
          emptyErrorRetries: 1,
        });
        expectNoRecovery(fixture);
      } else if (!fallback) {
        expect(await handleEmbeddedAssistantFailure(fixture.input)).toMatchObject({
          action: "proceed",
          emptyErrorRetries: 3,
        });
      } else {
        await expect(handleEmbeddedAssistantFailure(fixture.input)).rejects.toMatchObject({
          reason: "unknown",
          provider: "anthropic",
          model: "mock-1",
          rawError: "Provider completed tool call with malformed JSON arguments",
        });
        expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
        expect(fixture.traceAttempts).toEqual([
          {
            provider: "anthropic",
            model: "mock-1",
            result: "fallback_model",
            reason: "unknown",
            stage: "assistant",
          },
        ]);
      }
    },
  );

  it("does not cache an exact credential-file failure from a fallback candidate", async () => {
    await withEnvAsync({ OPENCLAW_FALLBACK_SKIP_TTL_MS: "60000" }, async () => {
      const config = createModelFallbackConfig("openai/mock-0", [
        "anthropic/mock-1",
        "groq/mock-2",
      ]) satisfies OpenClawConfig;
      const calls: string[] = [];
      const run = async (provider: string, model: string) => {
        calls.push(`${provider}/${model}`);
        if (provider === "openai") {
          throw new FailoverError("primary rate limited", {
            provider,
            model,
            reason: "rate_limit",
          });
        }
        if (provider === "anthropic") {
          await handleEmbeddedAssistantFailure(makeExhaustedCredentialFailureInput().input);
        }
        return "ok";
      };

      for (let turn = 0; turn < 2; turn += 1) {
        const result = await runWithModelFallback({
          cfg: config,
          provider: "openai",
          model: "mock-0",
          sessionId: "session:credential-enoent-no-skip",
          skipAuthProfileRuntime: true,
          run,
        });
        expect(result.result).toBe("ok");
      }

      expect(calls).toEqual([
        "openai/mock-0",
        "anthropic/mock-1",
        "groq/mock-2",
        "openai/mock-0",
        "anthropic/mock-1",
        "groq/mock-2",
      ]);
    });
  });
});
