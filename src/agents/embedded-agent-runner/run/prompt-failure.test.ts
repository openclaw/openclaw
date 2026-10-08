import { CompactionReplayRefreshRequiredError } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import {
  buildExternalRunFailureReply,
  buildKnownAgentRunFailureReplyPayload,
} from "../../../auto-reply/reply/agent-runner-failure-reply.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import { FailoverError } from "../../failover-error.js";
import { AgentHarnessPreflightError } from "../../harness/errors.js";
import { recordModelFallbackStop } from "../../model-fallback-stop.js";
import { resolveAgentRunErrorLifecycleFields } from "../../run-termination.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import { handleEmbeddedPromptFailure } from "./prompt-failure.js";

type Params = Parameters<typeof handleEmbeddedPromptFailure>[0];

type FixtureOptions = Partial<
  Params["terminal"] &
    Pick<Params["runtime"], "pluginHarnessOwnsTransport" | "thinkLevel"> &
    Pick<
      Params["preparedRuntime"],
      "provider" | "modelId" | "maybeRefreshRuntimeAuthForAuthError" | "attemptedThinking"
    > &
    Pick<Params["runInput"], "fallbackConfigured"> &
    Pick<Params["normalizedAttempt"], "activeErrorContext">
> & { failover?: Partial<Params["failover"]> };

function makeParams(overrides: FixtureOptions = {}): Params {
  const provider = overrides.provider ?? "openai";
  const modelId = overrides.modelId ?? "gpt-5";
  return {
    runInput: {
      runParams: {
        config: undefined,
        runId: "run:prompt-failure-test",
      } as Params["runInput"]["runParams"],
      globalLane: "test",
      agentDir: "/tmp/openclaw-prompt-failure-test",
      suspendForFailure: vi.fn(),
      startedAtMs: 0,
      fallbackConfigured: overrides.fallbackConfigured ?? true,
    },
    normalizedAttempt: {
      attempt: {
        terminal: { kind: "ok" },
        replayMetadata: { replaySafe: true },
      } as Params["normalizedAttempt"]["attempt"],
      activeErrorContext: overrides.activeErrorContext ?? { provider, model: modelId },
      sessionIdUsed: "session:prompt-failure-test",
      resolveReplayInvalidForAttempt: vi.fn(() => false),
      setTerminalLifecycleMeta: vi.fn(),
    },
    terminal: {
      promptError: overrides.promptError ?? new Error("rate limit exceeded"),
      promptErrorSource: overrides.promptErrorSource ?? "prompt",
      aborted: overrides.aborted ?? false,
      externalAbort: overrides.externalAbort ?? false,
      timedOutByRunBudget: overrides.timedOutByRunBudget ?? false,
    },
    preparedRuntime: {
      provider,
      modelId,
      attemptAuthProfileStore: { version: 1, profiles: {} },
      maybeRefreshRuntimeAuthForAuthError:
        overrides.maybeRefreshRuntimeAuthForAuthError ?? vi.fn(async () => false),
      attemptedThinking: overrides.attemptedThinking ?? new Set(),
    },
    runtime: {
      lastProfileId: "openai:p1",
      thinkLevel: overrides.thinkLevel ?? "low",
      pluginHarnessOwnsTransport: overrides.pluginHarnessOwnsTransport ?? false,
    },
    suspensionSessionId: "session:prompt-failure-test",
    runtimeAuthRetry: false,
    buildErrorAgentMeta: vi.fn(),
    failover: {
      resolveAuthProfileFailureReason: vi.fn<Params["failover"]["resolveAuthProfileFailureReason"]>(
        () => "rate_limit",
      ),
      advanceAuthProfile: vi.fn(async () => true),
      advanceRateLimitAuthProfile: vi.fn(async () => true),
      maybeMarkAuthProfileFailure: vi.fn(async () => {}),
      transientRetryCount: 0,
      ...overrides.failover,
    },
    getThinkLevel: () => "low",
    traceAttempts: [],
    previousRetryFailoverReason: null,
  };
}

describe("handleEmbeddedPromptFailure", () => {
  it("preserves terminal preflight identity and public copy despite a retryable diagnostic", async () => {
    const diagnostic = new Error("404 No managed agent resource found: session-fixture");
    const userMessage =
      "The saved session is unavailable. Check the API key's project permissions and retry.";
    const failure = new AgentHarnessPreflightError(diagnostic.message, {
      cause: diagnostic,
      userMessage,
    });
    const params = makeParams({ promptError: failure, pluginHarnessOwnsTransport: true });

    await expect(handleEmbeddedPromptFailure(params)).rejects.toBe(failure);

    expect(params.preparedRuntime.maybeRefreshRuntimeAuthForAuthError).not.toHaveBeenCalled();
    expect(params.failover.advanceAuthProfile).not.toHaveBeenCalled();
    expect(params.traceAttempts).toEqual([]);
    expect(buildExternalRunFailureReply({ message: failure.message, error: failure })).toEqual({
      text: userMessage,
      isGenericRunnerFailure: false,
    });
  });

  it("records local profile absence without an HTTP status in the fallback trace", async () => {
    const code = "selected_auth_profile_unavailable";
    const message = 'Selected auth profile "openai:work" was not found in OpenClaw.';
    const params = makeParams({
      promptError: Object.assign(new Error(message), { code }),
      failover: {
        advanceAuthProfile: vi.fn(async () => false),
        resolveAuthProfileFailureReason: vi.fn(() => null),
      },
    });

    await expect(handleEmbeddedPromptFailure(params)).rejects.toMatchObject({
      code,
      message,
      status: undefined,
    });
    expect(params.traceAttempts).toEqual([
      expect.objectContaining({ result: "fallback_model", reason: "auth", stage: "prompt" }),
    ]);
    expect(params.traceAttempts[0]).not.toHaveProperty("status");
  });

  it.each(["401 invalid API key", "Reasoning is mandatory for this endpoint"])(
    "does not recover a recorded terminal failure despite provider-shaped text: %s",
    async (message) => {
      const committed = Object.freeze(new Error(message));
      recordModelFallbackStop(committed);
      const failure = new Error("metadata view unavailable", { cause: committed });
      const params = makeParams({ promptError: failure });

      await expect(handleEmbeddedPromptFailure(params)).rejects.toBe(failure);

      expect(params.preparedRuntime.maybeRefreshRuntimeAuthForAuthError).not.toHaveBeenCalled();
      expect(params.runInput.suspendForFailure).not.toHaveBeenCalled();
      expect(params.failover.advanceAuthProfile).not.toHaveBeenCalled();
      expect(params.failover.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
      expect(params.failover.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
      expect(params.preparedRuntime.attemptedThinking).toEqual(new Set());
      expect(params.traceAttempts).toEqual([]);
    },
  );

  it.each([false, true])(
    "keeps account-restricted model errors on the model-failure path with fallback=%s",
    async (fallbackConfigured) => {
      const promptError = new Error(
        "400 The 'unavailable-thinking-model' model is not supported when using Codex with a ChatGPT account.",
      );
      const params = makeParams({
        promptError,
        fallbackConfigured,
        pluginHarnessOwnsTransport: true,
        failover: {
          advanceAuthProfile: vi.fn(async () => false),
          resolveAuthProfileFailureReason: vi.fn(() => null),
        },
        thinkLevel: "high",
        attemptedThinking: new Set(["high"]),
      });

      const error = await handleEmbeddedPromptFailure(params).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("message", promptError.message);
      expect(params.traceAttempts).toEqual([
        expect.objectContaining({
          result: fallbackConfigured ? "fallback_model" : "surface_error",
          reason: "model_not_found",
        }),
      ]);
    },
  );

  it.each(
    (["prompt", "compaction", "tool_execution"] as const).flatMap((phase) =>
      [false, true].map((fallbackConfigured) => ({ phase, fallbackConfigured })),
    ),
  )(
    "preserves recorded $phase timeouts with fallback=$fallbackConfigured",
    async ({ phase, fallbackConfigured }) => {
      const params = makeParams({
        promptError: new FailoverError("Provider stopped responding", { reason: "timeout" }),
        fallbackConfigured,
        failover: {
          advanceAuthProfile: vi.fn(async () => false),
          resolveAuthProfileFailureReason: vi.fn(() => null),
        },
      });
      params.normalizedAttempt.attempt.terminal = { kind: "timeout", phase, source: "runtime" };

      const error = await handleEmbeddedPromptFailure(params).catch((failure: unknown) => failure);

      const fields = resolveAgentRunErrorLifecycleFields(error, undefined);
      expect(fields).toEqual({
        stopReason: "timeout",
        ...(phase === "prompt" ? { timeoutPhase: "provider", providerStarted: true } : {}),
      });
      expect(
        buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase: "error", data: fields }).reason,
      ).toBe(phase === "prompt" ? "hard_timeout" : "timed_out");
    },
  );

  it("retains a harness's provider-started timeout without inventing its phase", async () => {
    const params = makeParams({
      promptError: new FailoverError("Harness deadline reached", { reason: "timeout" }),
      failover: {
        advanceAuthProfile: vi.fn(async () => false),
        resolveAuthProfileFailureReason: vi.fn(() => null),
      },
    });
    params.normalizedAttempt.attempt.terminal = {
      kind: "timeout",
      phase: "tool_execution",
      source: "runtime",
    };
    params.normalizedAttempt.attempt.promptTimeoutOutcome = { providerStarted: true };
    const error = await handleEmbeddedPromptFailure(params).catch((failure: unknown) => failure);
    const fields = resolveAgentRunErrorLifecycleFields(error, undefined);
    expect(fields).toEqual({ stopReason: "timeout", providerStarted: true });
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase: "error", data: fields }).reason,
    ).toBe("hard_timeout");
  });

  it.each(["prompt", "compaction", "tool_execution"] as const)(
    "retains an opaque %s watchdog failure without changing its retry routing",
    async (phase) => {
      const params = makeParams({
        promptError: new Error("Opaque provider failure"),
        failover: { resolveAuthProfileFailureReason: vi.fn(() => null) },
      });
      params.normalizedAttempt.attempt.terminal = { kind: "timeout", phase, source: "runtime" };

      const error = await handleEmbeddedPromptFailure(params).catch((failure: unknown) => failure);

      expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
        stopReason: "timeout",
        ...(phase === "prompt" ? { timeoutPhase: "provider", providerStarted: true } : {}),
      });
      expect(params.failover.advanceAuthProfile).not.toHaveBeenCalled();
      expect(error).toHaveProperty("cause", params.terminal.promptError);
    },
  );

  it.each([false, true])(
    "surfaces trusted checkpoint recovery without provider failover (altered message: %s)",
    async (alteredMessage) => {
      const promptError = new CompactionReplayRefreshRequiredError();
      const recoveryText = promptError.message;
      if (alteredMessage) {
        promptError.message = "untrusted provider detail: rate limit exceeded";
      }
      const params = makeParams({ promptError, promptErrorSource: "precheck" });

      const outcome = await handleEmbeddedPromptFailure(params);

      expect(outcome).toMatchObject({
        action: "complete",
        result: {
          payloads: [{ text: recoveryText, isError: true }],
          meta: {
            finalAssistantVisibleText: recoveryText,
            finalAssistantRawText: recoveryText,
            livenessState: "blocked",
            error: { kind: "compaction_replay_refresh_required", message: recoveryText },
          },
        },
      });
      expect(recoveryText).toContain("/compact");
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Verify JSON transport serialization, not an in-memory clone.
      expect(JSON.parse(JSON.stringify(outcome))).toMatchObject({
        result: { payloads: [{ text: recoveryText, isError: true }] },
      });
      expect(JSON.stringify(outcome)).not.toContain("untrusted provider detail");
      expect(params.normalizedAttempt.setTerminalLifecycleMeta).toHaveBeenCalledWith({
        replayInvalid: false,
        livenessState: "blocked",
      });
      for (const callback of [
        params.preparedRuntime.maybeRefreshRuntimeAuthForAuthError,
        params.runInput.suspendForFailure,
        params.failover.resolveAuthProfileFailureReason,
        params.failover.advanceAuthProfile,
        params.failover.advanceRateLimitAuthProfile,
        params.failover.maybeMarkAuthProfileFailure,
      ]) {
        expect(callback).not.toHaveBeenCalled();
      }
      expect(params.traceAttempts).toEqual([]);
    },
  );

  it.each([
    ["plain error", new Error(new CompactionReplayRefreshRequiredError().message), "precheck"],
    [
      "spoofed error name",
      Object.assign(new Error(new CompactionReplayRefreshRequiredError().message), {
        name: "CompactionReplayRefreshRequiredError",
      }),
      "precheck",
    ],
    [
      "serialized error",
      {
        name: "CompactionReplayRefreshRequiredError",
        message: new CompactionReplayRefreshRequiredError().message,
      },
      "precheck",
    ],
    ["provider error", new CompactionReplayRefreshRequiredError(), "prompt"],
  ] satisfies Array<[string, unknown, Params["terminal"]["promptErrorSource"]]>)(
    "does not trust %s as local checkpoint recovery",
    async (_label, promptError, promptErrorSource) => {
      const params = makeParams({
        promptError,
        promptErrorSource,
        failover: { resolveAuthProfileFailureReason: vi.fn(() => null) },
      });

      await expect(handleEmbeddedPromptFailure(params)).rejects.toBeInstanceOf(Error);

      expect(params.normalizedAttempt.setTerminalLifecycleMeta).not.toHaveBeenCalled();
      expect(params.preparedRuntime.maybeRefreshRuntimeAuthForAuthError).toHaveBeenCalledOnce();
    },
  );

  it("never refreshes auth or retries a recorded CLI terminal stop, even with an auth-shaped reason", async () => {
    // The stop message repeats the backend's own terminal_reason; a value like
    // `unauthorized` reads as an auth failure to text classifiers, and a retry
    // would replay tool effects the terminal-stop policy exists to protect.
    const promptError = new FailoverError(
      "Claude CLI ended the turn without a reply (terminal_reason: unauthorized, stop_reason: end_turn). " +
        "Tool actions may already have run; verify their effects before retrying.",
      { reason: "unknown", code: "cli_turn_stopped", provider: "claude-cli", model: "sonnet" },
    );
    const params = makeParams({
      promptError,
      provider: "claude-cli",
      modelId: "sonnet",
      activeErrorContext: { provider: "claude-cli", model: "sonnet" },
      maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => true),
      failover: {
        resolveAuthProfileFailureReason: vi.fn(() => null),
      },
    });

    await expect(handleEmbeddedPromptFailure(params)).rejects.toMatchObject({
      code: "cli_turn_stopped",
    });

    for (const callback of [
      params.preparedRuntime.maybeRefreshRuntimeAuthForAuthError,
      params.failover.advanceAuthProfile,
      params.failover.advanceRateLimitAuthProfile,
    ]) {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(params.traceAttempts).toEqual([
      expect.objectContaining({ result: "surface_error", stage: "prompt" }),
    ]);
  });

  it("returns the profile-rotation retry before failure marking finishes", async () => {
    const events: string[] = [];
    let releaseMark: (() => void) | undefined;
    const markCanFinish = new Promise<void>((resolve) => {
      releaseMark = resolve;
    });
    const maybeMarkAuthProfileFailure = vi.fn(async () => {
      events.push("mark-start");
      await markCanFinish;
      events.push("mark-finish");
    });

    try {
      const outcome = await handleEmbeddedPromptFailure(
        makeParams({
          failover: {
            advanceRateLimitAuthProfile: vi.fn(async () => {
              events.push("advance");
              return true;
            }),
            maybeMarkAuthProfileFailure,
          },
        }),
      );

      expect(outcome).toEqual({
        action: "retry",
        thinkLevel: "low",
        authRetryPending: false,
        lastRetryFailoverReason: "rate_limit",
      });
      expect(events).toEqual(["advance", "mark-start"]);
      expect(maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
        profileId: "openai:p1",
        reason: "rate_limit",
        modelId: "gpt-5",
      });
    } finally {
      releaseMark?.();
    }

    await vi.waitFor(() => expect(events).toEqual(["advance", "mark-start", "mark-finish"]));
  });

  it("keeps a live SessionManager transcript-validation error off shared credential health", async () => {
    let promptError: unknown;
    try {
      await SessionManager.inMemory("/tmp").appendModelChange("", "");
    } catch (error) {
      promptError = error;
    }
    expect(promptError).toBeInstanceOf(Error);
    expect(promptError).toHaveProperty("message", "Invalid session transcript entry: model_change");

    const params = makeParams({
      promptError,
      provider: "openrouter",
      modelId: "gemini-2.5-flash",
      activeErrorContext: { provider: "openrouter", model: "gemini-2.5-flash" },
      failover: {
        resolveAuthProfileFailureReason: (reason, opts) =>
          resolveAuthProfileFailureReason({
            failoverReason: reason,
            providerStarted: opts?.providerStarted,
            transientRateLimit: opts?.transientRateLimit,
            policy: "shared",
          }),
        advanceAuthProfile: vi.fn(async () => false),
      },
    });

    const error = await handleEmbeddedPromptFailure(params).catch((failure: unknown) => failure);

    expect(error).toBe(promptError);
    expect(params.failover.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(params.failover.advanceAuthProfile).not.toHaveBeenCalled();
    expect(params.traceAttempts).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        model: "gemini-2.5-flash",
        result: "surface_error",
        reason: "format",
        stage: "prompt",
      }),
    ]);
    expect(
      buildKnownAgentRunFailureReplyPayload({
        err: error,
        sessionCtx: { ChatType: "direct" },
        resolvedVerboseLevel: "off",
      }),
    ).toMatchObject({
      text: "OpenClaw couldn't read this conversation's history. Try /compact, or start a new conversation with /new.",
      isError: true,
    });
  });
});
