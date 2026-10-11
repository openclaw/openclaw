import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import { buildRealtimeVoiceAgentErrorProviderResult } from "../../../talk/agent-run-control.js";
import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { formatBillingErrorMessage } from "../../embedded-agent-helpers.js";
import { FailoverError } from "../../failover-error.js";
import { AUTH_INVALID_TOKEN_USER_TEXT } from "../../failover/user-copy.js";
import { resolveAgentRunErrorLifecycleFields } from "../../run-termination.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { log } from "../logger.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

vi.mock("../../../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(() => null),
}));

type Input = Parameters<typeof handleEmbeddedAssistantFailure>[0];

function makeInput(
  errorMessage: string,
  options: {
    terminal?: AgentRunAttemptTerminal;
    fallbackConfigured?: boolean;
    profileId?: string;
    provider?: string;
  } = {},
): Input {
  const provider = options.provider ?? "anthropic";
  const model = "test-model";
  const assistant = buildEmbeddedRunnerAssistant({
    provider,
    model,
    stopReason: "error",
    errorMessage,
    content: [{ type: "text", text: "Partial answer" }],
  });
  const attempt = makeEmbeddedRunnerAttempt({
    terminal: options.terminal ?? { kind: "ok" },
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
  return {
    runInput: {
      runParams: {
        sessionId: "session:assistant-failover",
        sessionFile: "/tmp/openclaw-assistant-failover-test/session.jsonl",
        runId: "run:assistant-failover",
        workspaceDir: "/tmp/openclaw-assistant-failover-test",
        prompt: "Respond to the user",
        timeoutMs: 60_000,
      },
      fallbackConfigured: options.fallbackConfigured ?? true,
      suspendForFailure: vi.fn(),
      agentDir: "/tmp/openclaw-assistant-failover-test",
      isProbeSession: false,
    },
    normalizedAttempt: {
      attempt,
      attemptAssistant: assistant,
      currentAttemptAssistant: assistant,
      terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
      activeErrorContext: { provider, model },
    },
    preparedRuntime: {
      provider,
      modelId: model,
      model: { id: model },
      attemptedThinking: new Set(["high"]),
      attemptAuthProfileStore: { version: 1, profiles: {} },
      maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
    },
    runtime: {
      thinkLevel: "high",
      lastProfileId: options.profileId,
      pluginHarnessOwnsTransport: false,
    },
    providerOwner: undefined,
    getThinkLevel: () => "low",
    runtimeAuthRetry: false,
    failover: {
      resolveAuthProfileFailureReason: vi.fn(() => null),
      maybeMarkAuthProfileFailure: vi.fn(async () => {}),
      advanceAuthProfile: vi.fn(async () => false),
      transientRetryCount: 0,
      overloadProfileRotationLimit: 3,
    },
    emptyErrorRetries: 0,
    overloadProfileRotations: 0,
    previousRetryFailoverReason: null,
    traceAttempts: [],
    suspensionSessionId: "session:assistant-failover",
  };
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

  it("selects the next profile before marking failure and retries without waiting for the mark", async () => {
    const input = makeInput("rate limit exceeded", { profileId: "anthropic:p1" });
    const events: string[] = [];
    let releaseMark: (() => void) | undefined;
    const markPending = new Promise<void>((resolve) => {
      releaseMark = resolve;
    });
    input.failover.resolveAuthProfileFailureReason = () => "rate_limit";
    input.failover.advanceAuthProfile = vi.fn(async () => {
      events.push("advance");
      return true;
    });
    input.failover.maybeMarkAuthProfileFailure = vi.fn(async () => {
      events.push("mark-start");
      await markPending;
      events.push("mark-finish");
    });
    try {
      const outcome = await handleEmbeddedAssistantFailure(input);
      expect(outcome).toMatchObject({ action: "retry", thinkLevel: "low" });
      expect(events).toEqual(["advance", "mark-start"]);
      expect(input.failover.maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
        profileId: "anthropic:p1",
        reason: "rate_limit",
        modelId: "test-model",
      });
    } finally {
      releaseMark?.();
    }
    await vi.waitFor(() => expect(events).toEqual(["advance", "mark-start", "mark-finish"]));
  });

  it.each([undefined])(
    "records billing failures for profile %s before surfacing",
    async (profileId) => {
      const input = makeInput("credit balance is too low", { profileId });
      input.failover.resolveAuthProfileFailureReason = () => "billing";
      const failure = await expectFailure(input);
      expect(failure).toMatchObject({ reason: "billing", status: 402 });
      expect(failure.message).toBe(formatBillingErrorMessage("anthropic", "test-model"));
      expect(input.failover.maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
        profileId,
        reason: "billing",
        modelId: "test-model",
      });
      expect(input.runInput.suspendForFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "manual" }),
      );
    },
  );

  it("preserves the provider failure when profile bookkeeping rejects", async () => {
    const input = makeInput("credit balance is too low");
    input.failover.resolveAuthProfileFailureReason = () => "billing";
    input.failover.maybeMarkAuthProfileFailure = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    expect(await expectFailure(input)).toMatchObject({ reason: "billing", status: 402 });
    expect(log.warn).toHaveBeenCalledWith(
      "profile failure mark failed: Error: storage unavailable",
    );
  });

  it.each(["rotation-exhausted", "overload-cap"])(
    "waits for failure bookkeeping before surfacing %s",
    async (path) => {
      const input = makeInput(
        path === "overload-cap" ? "529 overloaded" : "credit balance is too low",
      );
      input.overloadProfileRotations = path === "overload-cap" ? 3 : 0;
      input.failover.resolveAuthProfileFailureReason = () =>
        path === "overload-cap" ? "overloaded" : "billing";
      let releaseMark: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        releaseMark = resolve;
      });
      input.failover.maybeMarkAuthProfileFailure = vi.fn(async () => {
        markStarted?.();
        await pending;
      });
      let settled = false;
      const failure = expectFailure(input).finally(() => {
        settled = true;
      });
      try {
        await started;
        expect(settled).toBe(false);
        expect(input.traceAttempts).toEqual([]);
      } finally {
        releaseMark?.();
      }
      await failure;
      expect(settled).toBe(true);
      expect(input.traceAttempts).toHaveLength(1);
    },
  );

  it("lets a rate-limit rotation error propagate without assistant bookkeeping", async () => {
    const input = makeInput("rate limit exceeded");
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
    const input = makeInput("request timed out", {
      terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
    });
    input.normalizedAttempt.attempt.cloudCodeAssistFormatError = true;
    input.failover.resolveAuthProfileFailureReason = () => "timeout";
    input.failover.advanceAuthProfile = vi.fn(async () => true);
    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("retry");
    expect(input.failover.maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
      profileId: undefined,
      reason: "timeout",
      modelId: "test-model",
    });
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("Profile "));
  });

  it.each([false])(
    "retains provider error details with model fallback=%s",
    async (fallbackConfigured) => {
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
        const input = makeInput(message, { fallbackConfigured });
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
    },
  );

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
      const input = makeInput("500 injected provider failure", { terminal });
      const failure = await expectFailure(input);
      expect(failure.status).toBe(500);
      expect(resolveAgentRunErrorLifecycleFields(failure, undefined)).toEqual(expected);
    },
  );

  it.each(["timeout"])("ignores stale %s text on a successful assistant", async (errorMessage) => {
    const input = makeInput(errorMessage);
    if (!input.normalizedAttempt.attemptAssistant) {
      throw new Error("missing test assistant");
    }
    input.normalizedAttempt.attemptAssistant.stopReason = "stop";
    input.normalizedAttempt.terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt: input.normalizedAttempt.attempt,
      assistant: input.normalizedAttempt.attemptAssistant,
    });
    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("proceed");
    expect(input.failover.advanceAuthProfile).not.toHaveBeenCalled();
  });

  it("keeps harness-owned timeout handling inside the harness", async () => {
    const input = makeInput("request timed out");
    input.runtime.pluginHarnessOwnsTransport = true;
    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("proceed");
    expect(input.failover.advanceAuthProfile).not.toHaveBeenCalled();
  });

  it.each([new Error("provider connection failed")])(
    "keeps provider $name failures visible to realtime voice",
    async (error) => {
      const signal = new AbortController().signal;
      const input = makeInput(error.message);
      if (!input.normalizedAttempt.attemptAssistant) {
        throw new Error("missing test assistant");
      }
      Object.assign(input.normalizedAttempt.attemptAssistant, projectProviderError(error, signal));
      input.normalizedAttempt.attemptAssistant.content = [];
      input.emptyErrorRetries = 3;
      const failure = await expectFailure(input);
      expect(failure.rawError).toBe(error.message);
      expect(buildRealtimeVoiceAgentErrorProviderResult(failure)).toEqual({
        error: failure.message,
      });
      expect(signal.aborted).toBe(false);
    },
  );
});
