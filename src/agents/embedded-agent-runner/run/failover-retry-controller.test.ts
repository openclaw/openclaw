import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { isReplyRunEvidenceStale } from "../../../auto-reply/reply/reply-run-registry.state.js";
import * as diagnosticsTimeline from "../../../infra/diagnostics-timeline.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resolveRunStaleThresholdMs,
} from "../../../logging/diagnostic-run-activity.js";
import { FailoverError } from "../../failover-error.js";
import { resolveRetryAfterMs } from "../../failover/retry-evidence.js";
import {
  createDeferredEmbeddedRunLifecycleManager,
  createEmbeddedAttemptDeferredLifecycleOwner,
} from "./deferred-lifecycle-owner.js";

const mocks = vi.hoisted(() => ({
  sleepWithAbort: vi.fn(async (_ms: number, _abortSignal?: AbortSignal): Promise<void> => {}),
  warn: vi.fn((_message: string) => {}),
}));

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return { ...actual, log: { ...actual.log, warn: mocks.warn } };
});

vi.mock("../../../infra/backoff.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/backoff.js")>(
    "../../../infra/backoff.js",
  );
  return { ...actual, sleepWithAbort: mocks.sleepWithAbort };
});

import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

type ControllerInput = Parameters<typeof createEmbeddedRunFailoverRetryController>[0];

function createController(
  advanceAuthProfile: ControllerInput["preparedRuntime"]["advanceAttemptAuthProfile"],
  fallbackConfigured = false,
  abortSignal?: AbortSignal,
  onRetryWait?: ControllerInput["runInput"]["runParams"]["onRetryWait"],
) {
  return createEmbeddedRunFailoverRetryController({
    runInput: {
      runParams: {
        runId: "run:failover-retry-controller-test",
        abortSignal,
        onRetryWait,
      } as ControllerInput["runInput"]["runParams"],
      globalLane: "test",
      agentDir: "/tmp/openclaw-failover-retry-controller-test",
      fallbackConfigured,
    },
    preparedRuntime: {
      provider: "openai",
      modelId: "gpt-5.6-luna",
      profileFailureStore: { version: 1, profiles: {} },
      snapshot: () => ({
        lastProfileId: "openai:p1",
        pluginHarnessOwnsTransport: false,
        agentHarness: { id: "embedded" },
      }),
      getApiKeyInfo: () => null,
      advanceAttemptAuthProfile: advanceAuthProfile,
    },
    getSessionId: () => "session:failover-retry-controller-test",
  });
}

const rateLimitContext = {
  failoverProvider: "openai",
  failoverModel: "gpt-5.6-luna",
  logFallbackDecision: vi.fn(),
};

describe("createEmbeddedRunFailoverRetryController", () => {
  beforeEach(() => {
    mocks.sleepWithAbort.mockReset().mockResolvedValue(undefined);
    mocks.warn.mockClear();
    rateLimitContext.logFallbackDecision.mockClear();
  });

  it("reports the one output-limit continuation independently of transient attempts", async () => {
    const controller = createController(vi.fn(async () => false));
    await controller.maybeRetryTransient({ reason: "server_error" });
    const onRetry = vi.fn();
    expect(await controller.maybeRetryTransient({ reason: "output_limit", onRetry })).toBe(true);
    expect(mocks.warn).toHaveBeenLastCalledWith(
      expect.stringContaining("output-limit continuation 1/1"),
    );
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, maxRetries: 1, reason: "output_limit" }),
    );
    expect(await controller.maybeRetryTransient({ reason: "output_limit" })).toBe(false);
  });

  it("reports bounded retry-owner reasons without provider or credential metadata", async () => {
    const emit = vi.spyOn(diagnosticsTimeline, "emitDiagnosticsTimelineEvent");
    try {
      const controller = createController(vi.fn(async () => false));
      await expect(
        controller.maybeRetryTransient({
          reason: "auth",
          message: "private-error",
          retryAfterMs: 1000,
        }),
      ).resolves.toBe(false);
      await expect(
        controller.maybeRetryTransient({
          reason: "rate_limit",
          message: "weekly usage limit exhausted private-error",
        }),
      ).resolves.toBe(false);
      const cappedController = createController(
        vi.fn(async () => false),
        true,
      );
      await expect(
        cappedController.maybeRetryTransient({
          reason: "rate_limit",
          message: "private-error",
          retryAfterMs: 200,
          maxRetryDelayMs: 100,
        }),
      ).resolves.toBe(false);
      controller.observeAttempt({ providerRetryMaxRetries: 1 });
      await expect(controller.maybeRetryTransient({ reason: "timeout" })).resolves.toBe(true);
      await expect(controller.maybeRetryTransient({ reason: "timeout" })).resolves.toBe(false);
      const events = emit.mock.calls
        .map(([event]) => event)
        .filter((event) => event.name === "model.retry.decision");
      expect(events.map((event) => event.attributes)).toEqual([
        { decision: "rejected", reason: "non_transient", retryCount: 0 },
        { decision: "rejected", reason: "long_window_rate_limit", retryCount: 0 },
        { decision: "rejected", reason: "retry_delay_exceeds_cap", retryCount: 0 },
        { decision: "accepted", reason: "backoff_completed", retryCount: 0 },
        { decision: "rejected", reason: "retry_budget_exhausted", retryCount: 1 },
      ]);
      expect(events.every((event) => event.runId === "run:failover-retry-controller-test")).toBe(
        true,
      );
      expect(JSON.stringify(events)).not.toMatch(
        /private-error|openai:p1|modelId|provider|sessionId/,
      );
    } finally {
      emit.mockRestore();
    }
  });

  it.each([{ budget: undefined, earlierRetries: 3, expectedRetries: 9 }])(
    "shares the retry ceiling across reasons ($budget, $earlierRetries)",
    async ({ budget, earlierRetries, expectedRetries }) => {
      const controller = createController(vi.fn(async () => false));
      controller.observeAttempt({ providerRetryMaxRetries: budget });
      for (let retry = 0; retry < expectedRetries; retry++) {
        await expect(
          controller.maybeRetryTransient({
            reason: retry < earlierRetries ? "server_error" : "rate_limit",
          }),
        ).resolves.toBe(true);
      }
      await expect(controller.maybeRetryTransient({ reason: "rate_limit" })).resolves.toBe(false);
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
      expect(controller.transientRetryCount).toBe(expectedRetries);
      expect(mocks.sleepWithAbort).toHaveBeenCalledTimes(expectedRetries);
    },
  );

  it("allows local retries for replay-unsafe organization TPM exhaustion", async () => {
    const advanceAuthProfile = vi.fn(async () => true);
    const controller = createController(advanceAuthProfile, true);
    const message =
      "429 Rate limit reached for mock-1 in organization org-example on tokens per min (TPM): Limit 10000, Used 9900, Requested 200. Please try again in 1s.";
    await expect(
      controller.maybeRetryTransient({
        reason: "rate_limit",
        message,
        failoverEligible: false,
      }),
    ).resolves.toBe(true);
    expect(mocks.sleepWithAbort).toHaveBeenCalledOnce();
    await expect(controller.advanceAuthProfile("rate_limit", rateLimitContext)).resolves.toBe(true);
    expect(advanceAuthProfile).toHaveBeenCalledOnce();
  });

  it("skips credential rotation even when the classifier has already ruled out same-model retry", async () => {
    const advanceAuthProfile = vi.fn(async () => true);
    const controller = createController(advanceAuthProfile, true);
    await expect(
      controller.maybeRetryTransient({
        reason: "rate_limit",
        sameModelRetry: false,
        message:
          "429 Rate limit reached for mock-1 in organization org-example on tokens per min (TPM). Please try again in 90s.",
      }),
    ).resolves.toBe(false);
    await expect(controller.advanceAuthProfile("rate_limit", rateLimitContext)).resolves.toBe(
      false,
    );
    expect(advanceAuthProfile).not.toHaveBeenCalled();
    expect(mocks.sleepWithAbort).not.toHaveBeenCalled();
  });

  it.each([
    ["replay-unsafe", false, 9_897_000],
    ["inside cap", undefined, 20_000],
  ] as const)(
    "handles provider retry floors: %s",
    async (_name, failoverEligible, retryAfterMs) => {
      // Session-window 429s can carry hours of Retry-After without usage-window keywords.
      const message =
        'HTTP 429: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';
      expect(resolveRetryAfterMs(message, Date.now(), { headers: { "retry-after": "9897" } })).toBe(
        9_897_000,
      );
      const controller = createController(
        vi.fn(async () => false),
        true,
      );
      controller.observeAttempt({ providerRetryMaxRetries: 3 });
      const onRetry = vi.fn();
      await expect(
        controller.maybeRetryTransient({
          reason: "rate_limit",
          message,
          retryAfterMs,
          maxRetryDelayMs: 30_000,
          failoverEligible,
          onRetry,
        }),
      ).resolves.toBe(true);
      expect(controller.transientRetryCount).toBe(1);
      expect(mocks.sleepWithAbort).toHaveBeenCalledWith(retryAfterMs, undefined);
    },
  );

  it("declines an unrepresentable projected provider floor", async () => {
    const controller = createController(vi.fn(async () => false));
    const onRetry = vi.fn();
    const error = { headers: { "retry-after": "9".repeat(400) } };
    const retryAfterMs = resolveRetryAfterMs(projectProviderError(error).errorMessage);
    await expect(
      controller.maybeRetryTransient({ reason: "rate_limit", retryAfterMs, onRetry }),
    ).resolves.toBe(false);
    expect(mocks.sleepWithAbort).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(controller.transientRetryCount).toBe(0);
  });

  it.each([false, true])(
    "honors a floor beyond the native timer limit (abort=%s)",
    async (abort) => {
      const { sleepWithAbort } = await vi.importActual<typeof import("../../../infra/backoff.js")>(
        "../../../infra/backoff.js",
      );
      vi.useFakeTimers();
      mocks.sleepWithAbort.mockImplementation(sleepWithAbort);
      const cancellation = new AbortController();
      const dayMs = 24 * 60 * 60 * 1000;
      const retryAfterMs = 30 * dayMs;
      const ref = {
        sessionId: "retry-wait-session",
        runId: "retry-wait-run",
        sessionKey: "agent:main:retry-wait",
      };
      const operation = createReplyOperation({
        ...ref,
        turnKind: "visible",
        resetTriggered: false,
      });
      const diagnosticOwner = createDiagnosticEmbeddedRunOwner(ref);
      markDiagnosticEmbeddedRunStarted({ ...ref, owner: diagnosticOwner });
      const lifecycle = createDeferredEmbeddedRunLifecycleManager(ref);
      lifecycle.adopt(
        createEmbeddedAttemptDeferredLifecycleOwner({
          ...ref,
          diagnosticOwner,
          isCurrent: () => true,
          onRetryWaitCompleted: () => operation.recordActivity(),
          trajectoryRecorder: null,
          clearActiveRun: () => closeDiagnosticEmbeddedRunOwner(diagnosticOwner),
        }),
      );
      const deadlineAtMs = Date.now() + retryAfterMs;
      try {
        const controller = createController(
          vi.fn(async () => false),
          false,
          cancellation.signal,
          lifecycle.beginRetryWait,
        );
        let retried = false;
        const retry = controller
          .maybeRetryTransient({ reason: "rate_limit", retryAfterMs })
          .then((result) => {
            retried = result;
            return result;
          });
        await vi.advanceTimersByTimeAsync(dayMs + 1);
        const activity = getDiagnosticSessionActivitySnapshot(ref);
        expect(activity.activeWorkKind).toBe("embedded_run");
        expect(activity.activeRetryWaitDeadlineAtMs).toBe(deadlineAtMs);
        expect(activity.lastProgressAgeMs).toBe(dayMs + 1);
        expect(resolveRunStaleThresholdMs(activity)).toBe(retryAfterMs);
        expect(isReplyRunEvidenceStale(operation)).toBe(false);
        if (abort) {
          const rejected = expect(retry).rejects.toMatchObject({ name: "AbortError" });
          cancellation.abort();
          expect(
            getDiagnosticSessionActivitySnapshot(ref).activeRetryWaitDeadlineAtMs,
          ).toBeUndefined();
          await rejected;
          expect(controller.transientRetryCount).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        } else {
          await vi.advanceTimersByTimeAsync(retryAfterMs - dayMs - 2);
          expect(retried).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          await expect(retry).resolves.toBe(true);
          expect(controller.transientRetryCount).toBe(1);
          expect(
            getDiagnosticSessionActivitySnapshot(ref).activeRetryWaitDeadlineAtMs,
          ).toBeUndefined();
          expect(getDiagnosticSessionActivitySnapshot(ref).lastProgressAgeMs).toBe(0);
          expect(getDiagnosticSessionActivitySnapshot(ref).lastProgressReason).toBe(
            "retry_wait:ended",
          );
          expect(isReplyRunEvidenceStale(operation)).toBe(false);
        }
      } finally {
        await lifecycle.complete();
        operation.complete();
        vi.useRealTimers();
        mocks.sleepWithAbort.mockImplementation(async () => {});
      }
    },
  );

  it("does not truncate a provider wait to fit the remaining outage window", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      const controller = createController(vi.fn(async () => false));
      await expect(controller.maybeRetryTransient({ reason: "timeout" })).resolves.toBe(true);
      nowMs += 89_000;
      const retryAfterMs = resolveRetryAfterMs(
        "HTTP 503: temporary failure; Retry-After: Thu, 01 Jan 2026 00:01:31 GMT",
        nowMs,
      );
      expect(retryAfterMs).toBe(2000);
      await expect(
        controller.maybeRetryTransient({ reason: "timeout", retryAfterMs }),
      ).resolves.toBe(false);
      expect(mocks.sleepWithAbort).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
  });

  it("honors a saved zero rate-limit retry budget", async () => {
    const controller = createController(vi.fn(async () => false));
    controller.observeAttempt({ providerRetryMaxRetries: 0 });
    const onRetry = vi.fn();
    await expect(controller.maybeRetryTransient({ reason: "rate_limit", onRetry })).resolves.toBe(
      false,
    );
    expect(controller.transientRetryCount).toBe(0);
    expect(onRetry).not.toHaveBeenCalled();
    expect(mocks.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("reports the scheduled recovery before waiting for backoff", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.sleepWithAbort.mockImplementation(
      (delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }),
    );
    try {
      const controller = createController(vi.fn(async () => false));
      const onRetry = vi.fn();
      const retry = controller.maybeRetryTransient({ reason: "server_error", onRetry });
      expect(onRetry).toHaveBeenCalledWith({
        attempt: 1,
        maxRetries: 8,
        delayMs: 500,
        reason: "server_error",
      });
      expect(controller.transientRetryCount).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      await expect(retry).resolves.toBe(true);
      expect(mocks.sleepWithAbort).toHaveBeenCalledWith(500, undefined);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("continues transient recovery when the retry status callback rejects", async () => {
    const closeRetryWait = vi.fn();
    const onRetryWait = vi.fn(() => closeRetryWait);
    const controller = createController(
      vi.fn(async () => false),
      false,
      undefined,
      onRetryWait,
    );
    controller.observeAttempt({ providerRetryMaxRetries: 1 });
    const onRetry = vi.fn(async () => {
      throw new Error("event sink disconnected");
    });

    await expect(controller.maybeRetryTransient({ reason: "server_error", onRetry })).resolves.toBe(
      true,
    );

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetryWait).toHaveBeenCalledOnce();
    expect(mocks.sleepWithAbort).toHaveBeenCalledOnce();
    expect(closeRetryWait).toHaveBeenCalledWith(true);
    expect(controller.transientRetryCount).toBe(1);
  });

  it("escalates after one successful rate-limit rotation without advancing again", async () => {
    const advanceAuthProfile = vi.fn(async () => true);
    const controller = createController(advanceAuthProfile, true);

    await expect(controller.advanceAuthProfile("rate_limit", rateLimitContext)).resolves.toBe(true);
    await expect(
      controller.advanceAuthProfile("rate_limit", rateLimitContext),
    ).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    } satisfies Partial<FailoverError>);
    await expect(
      controller.advanceAuthProfile("rate_limit", rateLimitContext),
    ).rejects.toBeInstanceOf(FailoverError);

    expect(advanceAuthProfile).toHaveBeenCalledTimes(1);
    expect(rateLimitContext.logFallbackDecision).toHaveBeenCalledTimes(2);
    expect(rateLimitContext.logFallbackDecision).toHaveBeenNthCalledWith(1, "fallback_model", {
      status: 429,
    });
  });
});
