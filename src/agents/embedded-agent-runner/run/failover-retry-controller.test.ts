import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as diagnosticsTimeline from "../../../infra/diagnostics-timeline.js";

const mocks = vi.hoisted(() => ({
  sleepWithAbort: vi.fn(async (_ms: number, _abortSignal?: AbortSignal): Promise<void> => {}),
}));

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return { ...actual, log: { ...actual.log, warn: vi.fn(), error: vi.fn() } };
});

vi.mock("../../../infra/backoff.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/backoff.js")>(
    "../../../infra/backoff.js",
  );
  return { ...actual, sleepWithAbort: mocks.sleepWithAbort };
});

import {
  createRetryController,
  type RetryRunParams,
} from "./failover-retry-controller.test-support.js";

const { sleepWithAbort: sleep } = mocks;

const rotationContext = {
  failoverProvider: "openai",
  failoverModel: "gpt-5.6-luna",
  logFallbackDecision: () => {},
};

const nativeRuntime = {
  snapshot: () => ({ pluginHarnessOwnsTransport: true, agentHarness: { id: "native" } }),
};

function clock(initialMs = 1_000_000) {
  let nowMs = initialMs;
  let wallOffsetMs = 0;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs + wallOffsetMs);
  vi.spyOn(performance, "now").mockImplementation(() => nowMs - initialMs);
  return (ms: number, wallStepMs = 0) => {
    nowMs += ms;
    wallOffsetMs += wallStepMs;
  };
}
function expectNoRetry() {
  expect(sleep).not.toHaveBeenCalled();
  expect(onRetry).not.toHaveBeenCalled();
}
type Controller = ReturnType<typeof createRetryController>;
type RetryInput = Parameters<Controller["maybeRetryTransient"]>[0];
async function checkRetry(input: RetryInput, expected = true) {
  await expect(controller.maybeRetryTransient(input)).resolves.toBe(expected);
}
async function useRealSleep() {
  const actual = await vi.importActual<typeof import("../../../infra/backoff.js")>(
    "../../../infra/backoff.js",
  );
  sleep.mockImplementation(actual.sleepWithAbort);
  vi.useFakeTimers();
}
const rotate = (reason: Parameters<Controller["advanceAuthProfile"]>[0] = "rate_limit") =>
  controller.advanceAuthProfile(reason, rotationContext);

let controller: Controller;
const onRetry = vi.fn<NonNullable<RetryInput["onRetry"]>>();
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  controller = createRetryController();
  onRetry.mockReset();
  sleep.mockReset().mockResolvedValue(undefined);
});

it("does not announce or schedule a retry after the reply watchdog stops the operation", async () => {
  const abort = new AbortController();
  const error = Object.assign(new Error("Reply operation stalled"), {
    name: "AbortError",
    code: "OPENCLAW_SESSION_WATCHDOG",
  });
  controller = createRetryController({ runParams: { abortSignal: abort.signal } });
  abort.abort(error);
  await expect(controller.maybeRetryTransient({ reason: "timeout", onRetry })).rejects.toBe(error);
  expectNoRetry();
});

it("reports the one output-limit continuation independently of transient attempts", async () => {
  const advanceTime = clock();
  controller = createRetryController({ fallbackConfigured: true });
  await controller.maybeRetryTransient({ reason: "server_error" });
  advanceTime(60_000);
  expect(await controller.maybeRetryTransient({ reason: "output_limit", onRetry })).toBe(true);
  expect(onRetry).toHaveBeenCalledWith(
    expect.objectContaining({ attempt: 1, maxRetries: 1, reason: "output_limit" }),
  );
  expect(await controller.maybeRetryTransient({ reason: "output_limit" })).toBe(false);
});

it("omits provider and credential metadata from retry decisions", async () => {
  const emit = vi.spyOn(diagnosticsTimeline, "emitDiagnosticsTimelineEvent");
  await checkRetry({ reason: "auth", message: "private-error", retryAfterMs: 1000 }, false);
  const events = emit.mock.calls
    .map(([event]) => event)
    .filter((event) => event.name === "model.retry.decision");
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).not.toMatch(/private-error|openai:p1|modelId|provider|sessionId/);
});

it.each([
  [0, [500, 1000, 2000, 4000, 8000, 16000], 30000],
  [0.999, [1499, 2998, 5996, 11992, 23984, 47968], 60000],
] as const)(
  "caps sixteen-attempt rate-limit backoff (jitter=%s)",
  async (jitter, initialDelays, cap) => {
    vi.spyOn(Math, "random").mockReturnValue(jitter);
    for (let attempt = 2; attempt <= 16; attempt++) {
      await checkRetry({ reason: "rate_limit", retryAfterMs: 200 });
    }
    await checkRetry({ reason: "rate_limit" }, false);
    expect(controller.rateLimitRetriesExhausted).toBe(15);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
      ...initialDelays,
      ...Array.from({ length: 9 }, () => cap),
    ]);
  },
);

it.each([
  [undefined, 3, 15],
  [3, 0, 3],
  [30, 0, 15],
  [0, 0, 0],
] as const)(
  "shares retry ceilings (budget=%s, prior=%s, limit=%s)",
  async (budget, prior, limit) => {
    controller.observeAttempt({ providerRetryMaxRetries: budget });
    for (let retry = 0; retry < limit; retry++) {
      await checkRetry({ reason: retry < prior ? "server_error" : "rate_limit", onRetry });
    }
    await checkRetry({ reason: "rate_limit" }, false);
    expect(controller.rateLimitRetriesExhausted).toBe(limit);
    await checkRetry({ reason: "server_error" }, false);
    if (limit) {
      expect(onRetry).toHaveBeenLastCalledWith(expect.objectContaining({ maxRetries: limit }));
    } else {
      expectNoRetry();
    }
  },
);

it("retains the non-rate retry window after a long rate-limit wait", async () => {
  const advanceTime = clock();
  await checkRetry({ reason: "rate_limit", retryAfterMs: 120000 });
  expect(sleep).toHaveBeenCalledWith(120000, undefined);
  advanceTime(120000);
  await checkRetry({ reason: "server_error" }, false);
});

it.each([
  [
    true,
    3,
    'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."}}',
  ],
  [false, undefined, "429 daily request limit reached"],
] as const)("rejects exhausted usage windows (%s, %s, %s)", async (fallback, budget, message) => {
  controller = createRetryController({ fallbackConfigured: fallback });
  controller.observeAttempt({ providerRetryMaxRetries: budget });
  await checkRetry({ reason: "rate_limit", message, onRetry }, false);
  expectNoRetry();
});

it("waits for the provider floor before exhausting recovery and rotating credentials", async () => {
  const advance = vi.fn(async () => true);
  controller = createRetryController({
    runtime: { advanceAttemptAuthProfile: advance },
    fallbackConfigured: true,
  });
  controller.observeAttempt({ providerRetryMaxRetries: 1 });
  const retry = { reason: "rate_limit" as const, retryAfterMs: 2000 };
  await checkRetry(retry);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(2000, undefined);
  await checkRetry(retry, false);
  expect(controller.rateLimitRetriesExhausted).toBe(1);
  await expect(rotate()).resolves.toBe(true);
  await expect(rotate()).rejects.toMatchObject({
    name: "FailoverError",
    reason: "rate_limit",
    status: 429,
  });
  expect(advance).toHaveBeenCalledTimes(1);
});

it.each([-90_000, 0, 90_000])(
  "bounds shared TPM recovery across a %sms wall-clock step by retries and elapsed waiting",
  async (wallStepMs) => {
    const advanceTime = clock();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    sleep.mockImplementation(async (delayMs) => advanceTime(delayMs));
    const advance = vi.fn(async () => true);
    controller = createRetryController({
      fallbackConfigured: true,
      runtime: { advanceAttemptAuthProfile: advance },
    });
    const retry = {
      reason: "rate_limit" as const,
      message: "429 Rate limit reached in organization org-example on tokens per min (TPM).",
      retryAfterMs: 48,
    };
    await checkRetry(retry);
    advanceTime(0, wallStepMs);
    const queuedRetry = { ...retry, message: "429 Shared organization token rate limit budget." };
    await checkRetry(queuedRetry);
    await checkRetry(queuedRetry, false);
    await expect(rotate()).resolves.toBe(false);
    expect(advance).not.toHaveBeenCalled();
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1_000, 2_000]);
    // A later attempt that cannot safely switch models retains ordinary recovery.
    await checkRetry({ ...retry, failoverEligible: false });
    expect(sleep).toHaveBeenLastCalledWith(4_000, undefined);

    controller.observeAttempt({ hasSuccessfulModelResponse: true });
    await checkRetry({ ...retry, retryAfterMs: 10_000 });
    await checkRetry({ ...retry, retryAfterMs: 10_000 }, false);
    expect(sleep).toHaveBeenCalledTimes(4);
  },
);

it.each([
  ["fallback", undefined, 30_000, "rate_limit", 9_897_000, false],
  ["replay-unsafe", false, 30_000, "rate_limit", 9_897_000, true],
  ["disabled cap", undefined, 0, "rate_limit", 9_897_000, true],
  ["absent cap", undefined, undefined, "rate_limit", 9_897_000, true],
  ["inside cap", undefined, 30_000, "rate_limit", 20_000, true],
  ["non-rate limit", undefined, 30_000, "server_error", 60_000, true],
  ["unrepresentable", undefined, undefined, "rate_limit", Infinity, false],
] as const)(
  "handles provider retry floors: %s",
  async (_name, failoverEligible, maxRetryDelayMs, reason, retryAfterMs, expected) => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    controller = createRetryController({
      fallbackConfigured: true,
      runParams: { timeoutMs: 2_147_483_647 },
    });
    await checkRetry(
      {
        reason,
        retryAfterMs,
        maxRetryDelayMs,
        failoverEligible,
        onRetry,
      },
      expected,
    );
    if (expected) {
      expect(sleep).toHaveBeenCalledWith(Math.max(1_000, retryAfterMs), undefined);
    } else {
      expect(sleep).not.toHaveBeenCalled();
      expect(onRetry).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])("honors a floor beyond the native timer limit (abort=%s)", async (abort) => {
  await useRealSleep();
  const cancellation = new AbortController();
  const dayMs = 24 * 60 * 60 * 1000;
  const retryAfterMs = 30 * dayMs;
  controller = createRetryController({ runParams: { abortSignal: cancellation.signal } });
  const settled = vi.fn((result: boolean) => result);
  const retry = controller
    .maybeRetryTransient({ reason: "rate_limit", retryAfterMs })
    .then(settled);
  await vi.advanceTimersByTimeAsync(dayMs + 1);
  expect(settled).not.toHaveBeenCalled();
  if (abort) {
    const rejected = expect(retry).rejects.toMatchObject({ name: "AbortError" });
    cancellation.abort();
    await rejected;
  } else {
    await vi.advanceTimersByTimeAsync(retryAfterMs - dayMs - 2);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(retry).resolves.toBe(true);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("does not truncate a provider wait to fit the remaining outage window", async () => {
  const advanceTime = clock();
  await checkRetry({ reason: "timeout" });
  advanceTime(89_000);
  await checkRetry({ reason: "timeout", retryAfterMs: 2000 }, false);
  expect(sleep).toHaveBeenCalledOnce();
});

it.each([
  ["default", true, {}, {}, {}, false],
  ["larger budget", true, { timeoutMs: 360_000 }, {}, {}, true],
  ["explicit retries", true, {}, { providerRetryMaxRetries: 8 }, {}, true],
  ["explicit request timeout", true, {}, { providerRequestTimeoutExplicit: true }, {}, true],
  ["no fallback", false, {}, {}, {}, true],
  ["final fallback", true, { isFinalFallbackAttempt: true }, {}, {}, true],
  ["unlimited", true, { timeoutMs: 2_147_483_647 }, {}, {}, true],
  ["replay unsafe", true, {}, {}, { failoverEligible: false }, true],
  ["native", true, {}, {}, {}, true, nativeRuntime],
] as const)(
  "reserves bounded recovery time for fallback across a wall-clock step: %s",
  async (_name, fallback, params, settings, retryOptions, again, runtime?) => {
    const advanceTime = clock();
    controller = createRetryController({
      fallbackConfigured: fallback,
      runParams: { timeoutMs: 180_000, ...params },
      runtime,
    });
    controller.observeAttempt(settings);
    advanceTime(60_000);
    await checkRetry({ reason: "timeout", ...retryOptions });
    advanceTime(61_000, 90_000);
    await checkRetry({ reason: "timeout", ...retryOptions }, again);
    expect(sleep).toHaveBeenCalledTimes(again ? 2 : 1);
  },
);

it("bounds transient retries across reasons and honors Retry-After", async () => {
  const advanceTime = clock();
  sleep.mockImplementation(async (delayMs) => advanceTime(delayMs));
  await checkRetry({ reason: "server_error", retryAfterMs: 60_000 });
  await checkRetry({ reason: "timeout", retryAfterMs: 30_000 });
  await checkRetry({ reason: "overloaded" }, false);
  expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([60_000, 30_000]);
});

it("allows eight transient retries across failure reasons when the ceiling has room", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const reason of ["rate_limit", "overloaded", "timeout", "server_error"] as const) {
      await checkRetry({ reason });
    }
  }
  await checkRetry({ reason: "server_error" }, false);
});

it("lets auxiliary runs defer provider failures without sleeping or replaying", async () => {
  const advance = vi.fn(async () => true);
  controller = createRetryController({
    runtime: { advanceAttemptAuthProfile: advance },
    runParams: { retryTransientErrors: false },
  });
  for (const reason of ["rate_limit", "overloaded", "timeout", "server_error"] as const) {
    await checkRetry({ reason, onRetry }, false);
    await expect(rotate(reason)).resolves.toBe(false);
  }
  expect(advance).not.toHaveBeenCalled();
  expectNoRetry();
});

it.each([false, true])(
  "reports and closes the scheduled retry even when status rejects (%s)",
  async (rejects) => {
    await useRealSleep();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const closeRetryWait = vi.fn();
    controller = createRetryController({ runParams: { onRetryWait: () => closeRetryWait } });
    if (rejects) {
      onRetry.mockRejectedValue(new Error("event sink disconnected"));
    }
    const retry = controller.maybeRetryTransient({ reason: "server_error", onRetry });
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxRetries: 8,
      delayMs: 500,
      reason: "server_error",
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(retry).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledWith(500, undefined);
    expect(closeRetryWait).toHaveBeenCalledWith(true);
  },
);

it("hands the watchdog rate-limit copy for the retries already completed", async () => {
  const onRetryWait = vi.fn<NonNullable<RetryRunParams["onRetryWait"]>>(() => vi.fn());
  controller = createRetryController({ runParams: { onRetryWait } });
  await checkRetry({ reason: "rate_limit" });
  await checkRetry({ reason: "rate_limit" });
  await checkRetry({ reason: "server_error" });
  expect(onRetryWait.mock.calls.map((call) => call[2]?.rateLimitStopMessage)).toEqual([
    "Rate-limit recovery stopped without a completed model response. Check completed work before trying again.",
    "Rate-limit recovery stopped after 1 automatic retry without a completed model response. Check completed work before trying again.",
    undefined,
  ]);
});
