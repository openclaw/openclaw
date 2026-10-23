import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import { buildKnownAgentRunFailureReplyPayload } from "../../../auto-reply/reply/agent-runner-failure-reply.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { buildRealtimeVoiceAgentErrorProviderResult } from "../../../talk/agent-run-control.js";
import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { FailoverError } from "../../failover-error.js";
import {
  AUTH_INVALID_TOKEN_USER_TEXT,
  formatBillingErrorMessage,
} from "../../failover/user-copy.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import { resolveAgentRunErrorLifecycleFields } from "../../run-termination.js";
import { log } from "../logger.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import {
  makeAssistantFailureInput as makeInput,
  type AssistantFailureInput as Input,
} from "./assistant-failure.test-support.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

vi.mock("../../../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(() => null),
}));

function expectProfileFailure(input: Input, reason: string, profileId?: string) {
  expect(input.failover.maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
    profileId,
    reason,
    modelId: "test-model",
  });
}

async function expectFailure(input: Input): Promise<FailoverError> {
  const failure: unknown = await handleEmbeddedAssistantFailure(input).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(FailoverError);
  if (!(failure instanceof FailoverError)) {
    throw new Error("Expected an assistant failover error");
  }
  return failure;
}

describe("assistant failure recovery", () => {
  beforeEach(() => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("explains retry exhaustion without replacing the raw provider failure", async () => {
    const providerError = "429 rate limit exceeded. Please try again in 221ms.";
    const input = makeInput({ errorMessage: providerError });
    input.rateLimitRetriesExhausted = 9;
    const failure = await expectFailure(input);
    expect(failure).toMatchObject({
      message: expect.stringContaining("9 automatic retries"),
      rateLimitRetriesExhausted: 9,
      reason: "rate_limit",
      status: 429,
      rawError: providerError,
    });
    expect(input.normalizedAttempt.attemptAssistant?.errorMessage).toBe(providerError);
    expect(
      buildKnownAgentRunFailureReplyPayload({
        err: failure,
        sessionCtx: {},
        resolvedVerboseLevel: "off",
      })?.text,
    ).toContain("9 automatic retries");
  });

  it.each([
    { errorMessage: "Pending input is no longer active in its admitted transcript" },
    { errorMessage: "400 malformed input item", errorType: "invalid_request_error" },
    { errorMessage: "Request rejected by content policy", errorType: "invalid_request_error" },
    {
      errorMessage: "invalid_prompt: rejected",
      errorType: "invalid_request_error",
      errorCode: "invalid_prompt",
    },
  ])("stops unchanged retries and model fallback for $errorMessage", async (fields) => {
    const run = vi.fn(async () => {
      const input = makeInput({ ...fields, content: [] });
      for (;;) {
        const outcome = await handleEmbeddedAssistantFailure(input);
        if (outcome.action !== "retry") {
          throw new Error("failure was not surfaced");
        }
        input.emptyErrorRetries = outcome.emptyErrorRetries;
      }
    });
    await expect(
      runWithModelFallback({
        cfg: undefined,
        provider: "anthropic",
        model: "test-model",
        manifestPlugins: [],
        fallbacksOverride: ["openai/fixture-next", "groq/fixture-last"],
        skipAuthProfileRuntime: true,
        run,
      }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      "Assistant attempt failed",
      expect.objectContaining({
        message: fields.errorMessage,
      }),
    );
  });

  it("selects the next profile before marking failure and retries without waiting for the mark", async () => {
    const input = makeInput({ errorMessage: "rate limit exceeded" }, { profileId: "anthropic:p1" });
    const events: string[] = [];
    const mark = createDeferredCore();
    input.failover.resolveAuthProfileFailureReason = () => "rate_limit";
    input.failover.advanceAuthProfile = vi.fn(async () => {
      events.push("advance");
      return true;
    });
    input.failover.maybeMarkAuthProfileFailure = vi.fn(async () => {
      events.push("mark-start");
      await mark.promise;
      events.push("mark-finish");
    });
    try {
      const outcome = await handleEmbeddedAssistantFailure(input);
      expect(outcome).toMatchObject({ action: "retry", thinkLevel: "low" });
      expect(events).toEqual(["advance", "mark-start"]);
      expectProfileFailure(input, "rate_limit", "anthropic:p1");
    } finally {
      mark.resolve();
    }
    await vi.waitFor(() => expect(events).toEqual(["advance", "mark-start", "mark-finish"]));
  });

  it.each([false, true])(
    "preserves billing failures when bookkeeping rejects=%s",
    async (rejects) => {
      const input = makeInput({ errorMessage: "credit balance is too low" });
      input.failover.resolveAuthProfileFailureReason = () => "billing";
      if (rejects) {
        input.failover.maybeMarkAuthProfileFailure = vi.fn(async () => {
          throw new Error("storage unavailable");
        });
      }
      const failure = await expectFailure(input);
      expect(failure).toMatchObject({ reason: "billing", status: 402 });
      if (rejects) {
        expect(log.warn).toHaveBeenCalledWith(
          "profile failure mark failed: Error: storage unavailable",
        );
      } else {
        expect(failure.message).toBe(formatBillingErrorMessage("anthropic", "test-model"));
        expectProfileFailure(input, "billing");
        expect(input.runInput.suspendForFailure).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "manual" }),
        );
      }
    },
  );

  it.each(["rotation-exhausted", "overload-cap"])(
    "waits for failure bookkeeping before surfacing %s",
    async (path) => {
      const input = makeInput({
        errorMessage: path === "overload-cap" ? "529 overloaded" : "credit balance is too low",
      });
      input.overloadProfileRotations = path === "overload-cap" ? 3 : 0;
      input.failover.resolveAuthProfileFailureReason = () =>
        path === "overload-cap" ? "overloaded" : "billing";
      const started = createDeferredCore();
      const mark = createDeferredCore();
      input.failover.maybeMarkAuthProfileFailure = vi.fn(async () => {
        started.resolve();
        await mark.promise;
      });
      let settled = false;
      const failure = expectFailure(input).finally(() => {
        settled = true;
      });
      try {
        await started.promise;
        expect(settled).toBe(false);
        expect(input.traceAttempts).toEqual([]);
      } finally {
        mark.resolve();
      }
      await failure;
      expect(settled).toBe(true);
      expect(input.traceAttempts).toHaveLength(1);
    },
  );

  it("lets a rate-limit rotation error propagate without assistant bookkeeping", async () => {
    const input = makeInput({ errorMessage: "rate limit exceeded" });
    const error = new FailoverError("Rate-limit rotation exhausted", { reason: "rate_limit" });
    input.failover.resolveAuthProfileFailureReason = () => "rate_limit";
    input.failover.advanceAuthProfile = vi.fn(async () => {
      throw error;
    });
    await expect(handleEmbeddedAssistantFailure(input)).rejects.toBe(error);
    expect(input.failover.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(input.runInput.suspendForFailure).not.toHaveBeenCalled();
    expect(input.traceAttempts).toEqual([]);
  });

  it("records timeout rotations against the failed profile without inventing profile ids", async () => {
    const input = makeInput(
      { errorMessage: "request timed out" },
      {
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
      },
    );
    input.normalizedAttempt.attempt.cloudCodeAssistFormatError = true;
    input.failover.resolveAuthProfileFailureReason = () => "timeout";
    input.failover.advanceAuthProfile = vi.fn(async () => true);
    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("retry");
    expectProfileFailure(input, "timeout");
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("Profile "));
  });

  it("retains provider error details with model fallback=false", async () => {
    for (const [message, reason, status] of [
      ['  400 {"error":{"message":"credit balance is too low"}}  ', "billing", 400],
      // An untyped 500 is a provider-side server error; only 408/499/504/522/524 are timeouts.
      ["500 provider returned HTTP 500", "server_error", 500],
      ["503 service unavailable", "overloaded", 503],
      ["request timed out", "timeout", 408],
      ["401 invalid api key", "auth", 401],
      ["429 rate limit exceeded", "rate_limit", 429],
      [
        '{"type":"error","error":{"type":"invalid_request_error","message":"thinking blocks cannot be modified"}}',
        "format",
        400,
      ],
    ] as const) {
      const input = makeInput({ errorMessage: message }, { fallbackConfigured: false });
      const failure = await expectFailure(input);
      expect(failure).toMatchObject({
        reason,
        status,
        rawError: message.trim(),
        provider: "anthropic",
        model: "test-model",
      });
      if (reason === "auth") {
        expect(failure.message).toBe(AUTH_INVALID_TOKEN_USER_TEXT);
      } else if (reason === "rate_limit") {
        expect(failure.message).toBe(
          "⚠️ The AI service needs a short break. Please try again in a few minutes.",
        );
      }
      expect(input.traceAttempts[0]?.status).toBe(status);
    }
  });

  it.each([
    [{ kind: "timeout", phase: "compaction", source: "observation" }, {}],
    [{ kind: "timeout", phase: "tool_execution", source: "runtime" }, { stopReason: "timeout" }],
    [
      { kind: "timeout", phase: "prompt", source: "idle" },
      { stopReason: "timeout", timeoutPhase: "provider", providerStarted: true },
    ],
  ] satisfies Array<readonly [AgentRunAttemptTerminal, object]>)(
    "keeps recorded timeout facts independent of provider status: %s",
    async (terminal, expected) => {
      const input = makeInput({ errorMessage: "500 injected provider failure" }, { terminal });
      const failure = await expectFailure(input);
      expect(failure.status).toBe(500);
      expect(resolveAgentRunErrorLifecycleFields(failure, undefined)).toEqual(expected);
    },
  );

  it.each([false, true])(
    "keeps %s harness-owned or successful timeouts out of failover",
    async (harnessOwned) => {
      const input = makeInput({ errorMessage: harnessOwned ? "request timed out" : "timeout" });
      if (harnessOwned) {
        input.runtime.pluginHarnessOwnsTransport = true;
      } else {
        const assistant = input.normalizedAttempt.attemptAssistant;
        assistant.stopReason = "stop";
        input.normalizedAttempt.terminalState = resolveEmbeddedRunAttemptTerminalState({
          attempt: input.normalizedAttempt.attempt,
          assistant,
        });
      }
      expect((await handleEmbeddedAssistantFailure(input)).action).toBe("proceed");
      expect(input.failover.advanceAuthProfile).not.toHaveBeenCalled();
    },
  );

  it("keeps provider Error failures visible to realtime voice", async () => {
    const error = new Error("provider connection failed");

    const signal = new AbortController().signal;
    const input = makeInput({ errorMessage: error.message });
    Object.assign(input.normalizedAttempt.attemptAssistant, projectProviderError(error, signal));
    input.normalizedAttempt.attemptAssistant.content = [];
    input.emptyErrorRetries = 3;
    const failure = await expectFailure(input);
    expect(failure.rawError).toBe(error.message);
    expect(buildRealtimeVoiceAgentErrorProviderResult(failure)).toEqual({
      error: failure.message,
    });
    expect(signal.aborted).toBe(false);
  });
});
