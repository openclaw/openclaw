import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import * as diagnosticsTimeline from "../../../infra/diagnostics-timeline.js";
import { FailoverError } from "../../failover-error.js";
import { resolveRetryAfterMs } from "../../failover/retry-evidence.js";

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

import {
  createRetryController,
  type RetryRunParams,
} from "./failover-retry-controller.test-support.js";

const { sleepWithAbort: sleep, warn } = mocks;

type ControllerOptions = Partial<
  Pick<
    RetryRunParams,
    "abortSignal" | "onRetryWait" | "isFinalFallbackAttempt" | "retryTransientErrors"
  >
> & {
  advanceAuthProfile?: () => Promise<boolean>;
  fallbackConfigured?: boolean;
  budget?: number;
};
function createController({
  advanceAuthProfile = vi.fn(async () => false),
  fallbackConfigured = false,
  budget,
  ...runParams
}: ControllerOptions = {}) {
  const controller = createRetryController({
    runParams,
    fallbackConfigured,
    runtime: { advanceAttemptAuthProfile: advanceAuthProfile },
  });
  if (budget !== undefined) {
    controller.observeAttempt({ providerRetryMaxRetries: budget });
  }
  return controller;
}

const rotationContext = {
  failoverProvider: "openai",
  failoverModel: "gpt-5.6-luna",
  logFallbackDecision: vi.fn(),
};

function clock(initialMs = 1_000_000) {
  let nowMs = initialMs;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  return (ms: number) => {
    nowMs += ms;
  };
}
function expectNoRetry() {
  expect(sleep).not.toHaveBeenCalled();
  expect(onRetry).not.toHaveBeenCalled();
  expect(controller.transientRetryCount).toBe(0);
}
type Controller = ReturnType<typeof createController>;
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
  controller = createController();
  onRetry.mockReset();
  sleep.mockReset().mockResolvedValue(undefined);
  warn.mockClear();
  rotationContext.logFallbackDecision.mockClear();
});

it("reports the one output-limit continuation independently of transient attempts", async () => {
  await controller.maybeRetryTransient({ reason: "server_error" });
  expect(await controller.maybeRetryTransient({ reason: "output_limit", onRetry })).toBe(true);
  expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("output-limit continuation 1/1"));
  expect(onRetry).toHaveBeenCalledWith(
    expect.objectContaining({ attempt: 1, maxRetries: 1, reason: "output_limit" }),
  );
  expect(await controller.maybeRetryTransient({ reason: "output_limit" })).toBe(false);
});

it("omits provider and credential metadata from retry decisions", async () => {
  const emit = vi.spyOn(diagnosticsTimeline, "emitDiagnosticsTimelineEvent");
  await checkRetry({ reason: "auth", message: "private-error", retryAfterMs: 1000 }, false);
  const message = "weekly usage limit exhausted private-error";
  await checkRetry({ reason: "rate_limit", message }, false);
  controller = createController({ fallbackConfigured: true });
  await checkRetry(
    {
      reason: "rate_limit",
      message: "private-error",
      retryAfterMs: 200,
      maxRetryDelayMs: 100,
    },
    false,
  );
  controller.observeAttempt({ providerRetryMaxRetries: 1 });
  await checkRetry({ reason: "timeout" });
  await checkRetry({ reason: "timeout" }, false);
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
  expect(events.every((event) => event.runId === "run:retry-test")).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/private-error|openai:p1|modelId|provider|sessionId/);
});

it.each([
  {
    jitter: 0,
    delays: [
      500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000,
      30000,
    ],
  },
  {
    jitter: 0.999,
    delays: [
      1499, 2998, 5996, 11992, 23984, 47968, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000,
      60000,
    ],
  },
])("caps sixteen-attempt rate-limit backoff (jitter=$jitter)", async ({ jitter, delays }) => {
  vi.spyOn(Math, "random").mockReturnValue(jitter);
  for (let attempt = 2; attempt <= 16; attempt++) {
    await checkRetry({ reason: "rate_limit", onRetry });
    expect(onRetry.mock.lastCall?.[0]).toEqual({
      reason: "rate_limit",
      attempt: attempt - 1,
      maxRetries: 15,
      delayMs: expect.any(Number),
    });
  }
  await checkRetry({ reason: "rate_limit" }, false);
  expect(controller.rateLimitRetriesExhausted).toBe(15);
  expect(sleep.mock.calls.map(([delay]) => delay)).toEqual(delays);
  expect(onRetry).toHaveBeenCalledTimes(15);
});

it.each([
  [undefined, 3, 15],
  [3, 0, 3],
  [30, 0, 15],
] as const)(
  "shares retry ceilings (budget=%s, prior=%s, limit=%s)",
  async (budget, prior, limit) => {
    controller = createController({ budget });
    for (let retry = 0; retry < limit; retry++) {
      await checkRetry({ reason: retry < prior ? "server_error" : "rate_limit" });
    }
    await checkRetry({ reason: "rate_limit" }, false);
    await checkRetry({ reason: "server_error" }, false);
    expect(controller.transientRetryCount).toBe(limit);
    expect(sleep).toHaveBeenCalledTimes(limit);
  },
);

it.each([200, 1_000])(
  "backs off beyond a short rate-limit floor of %i ms",
  async (retryAfterMs) => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (let retry = 0; retry < 7; retry++) {
      await checkRetry({ reason: "rate_limit", retryAfterMs, onRetry });
    }
    await checkRetry({ reason: "rate_limit", retryAfterMs: 120_000, onRetry });
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 120_000,
    ]);
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
  controller = createController({ fallbackConfigured: fallback, budget });
  await checkRetry({ reason: "rate_limit", message, onRetry }, false);
  expectNoRetry();
});

it.each([
  [true, true, false],
  [false, true, false],
  [true, false, false],
  [true, true, true],
])("paces TPM recovery (fallback=%s, safe=%s, final=%s)", async (fallback, replaySafe, isFinal) => {
  const advance = vi.fn(async () => true);
  controller = createController({
    advanceAuthProfile: advance,
    fallbackConfigured: fallback,
    isFinalFallbackAttempt: isFinal,
    budget: 1,
  });
  const message =
    "429 Rate limit reached for mock-1 in organization org-example on tokens per min (TPM): Limit 10000, Used 9900, Requested 200. Please try again in 2s.";
  const retry = {
    reason: "rate_limit" as const,
    message,
    retryAfterMs: resolveRetryAfterMs(message),
    failoverEligible: replaySafe,
  };
  await checkRetry(retry);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(2000, undefined);
  await checkRetry(retry, false);
  expect(controller.rateLimitRetriesExhausted).toBe(1);
  await expect(rotate()).resolves.toBe(true);
  expect(advance).toHaveBeenCalledOnce();
  expect(controller.transientRetryCount).toBe(1);
});

it.each([
  ["fallback", true, undefined, 30_000, "rate_limit", 9_897_000, false],
  ["no fallback", false, undefined, 30_000, "rate_limit", 9_897_000, false],
  ["replay-unsafe", true, false, 30_000, "rate_limit", 9_897_000, true],
  ["replay-unsafe without fallback", false, false, 30_000, "rate_limit", 9_897_000, true],
  ["disabled cap", true, undefined, 0, "rate_limit", 9_897_000, true],
  ["absent cap", true, undefined, undefined, "rate_limit", 9_897_000, true],
  ["inside cap", true, undefined, 30_000, "rate_limit", 20_000, true],
  ["short floor", true, undefined, 30_000, "rate_limit", 200, true],
  ["non-rate limit", true, undefined, 30_000, "server_error", 60_000, true],
] as const)(
  "handles provider retry floors: %s",
  async (_name, fallback, failoverEligible, maxRetryDelayMs, reason, retryAfterMs, expected) => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // Session-window 429s can carry hours of Retry-After without usage-window keywords.
    const message =
      'HTTP 429: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';
    expect(resolveRetryAfterMs(message, Date.now(), { headers: { "retry-after": "9897" } })).toBe(
      9_897_000,
    );
    controller = createController({ fallbackConfigured: fallback, budget: 3 });
    await checkRetry(
      {
        reason,
        message,
        retryAfterMs,
        maxRetryDelayMs,
        failoverEligible,
        onRetry,
      },
      expected,
    );
    expect(controller.transientRetryCount).toBe(expected ? 1 : 0);
    if (expected) {
      expect(sleep).toHaveBeenCalledWith(Math.max(1_000, retryAfterMs), undefined);
    } else {
      expect(sleep).not.toHaveBeenCalled();
      expect(onRetry).not.toHaveBeenCalled();
      const failoverLog = warn.mock.calls.at(-1)?.[0];
      expect(failoverLog).toContain("rate-limit retry floor 9897000ms");
      expect(failoverLog).toContain("retry.provider.maxRetryDelayMs=30000");
      expect(failoverLog).toContain("failing over");
    }
  },
);

it.each([false, true])("declines unrepresentable floors (projected=%s)", async (projected) => {
  const error = { headers: { "retry-after": "9".repeat(400) } };
  const retryAfterMs = projected
    ? resolveRetryAfterMs(projectProviderError(error).errorMessage)
    : resolveRetryAfterMs(undefined, Date.now(), error);
  await checkRetry({ reason: "rate_limit", retryAfterMs, onRetry }, false);
  expectNoRetry();
});

it.each([false, true])("honors a floor beyond the native timer limit (abort=%s)", async (abort) => {
  await useRealSleep();
  const cancellation = new AbortController();
  const dayMs = 24 * 60 * 60 * 1000;
  const retryAfterMs = 30 * dayMs;
  controller = createController({ abortSignal: cancellation.signal });
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
    expect(controller.transientRetryCount).toBe(0);
  } else {
    await vi.advanceTimersByTimeAsync(retryAfterMs - dayMs - 2);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(retry).resolves.toBe(true);
    expect(controller.transientRetryCount).toBe(1);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("does not truncate a provider wait to fit the remaining outage window", async () => {
  const advanceTime = clock(Date.parse("2026-01-01T00:00:00.000Z"));
  await checkRetry({ reason: "timeout" });
  advanceTime(89_000);
  const retryAfterMs = resolveRetryAfterMs(
    "HTTP 503: temporary failure; Retry-After: Thu, 01 Jan 2026 00:01:31 GMT",
    Date.now(),
  );
  expect(retryAfterMs).toBe(2000);
  await checkRetry({ reason: "timeout", retryAfterMs }, false);
  expect(sleep).toHaveBeenCalledOnce();
});

it("bounds transient retries across reasons and honors Retry-After", async () => {
  // Retry exhaustion includes sleep time.
  const advanceTime = clock();
  sleep.mockImplementation(async (delayMs: number) => {
    advanceTime(delayMs);
  });
  await checkRetry({ reason: "server_error", retryAfterMs: 60_000 });
  await checkRetry({ reason: "timeout", retryAfterMs: 30_000 });
  await checkRetry({ reason: "overloaded" }, false);
  expect(controller.transientRetryCount).toBe(2);
  const truncationLog = warn.mock.calls.at(-1)?.[0];
  expect(truncationLog).toContain("transient retry window elapsed");
  expect(truncationLog).toContain("after 2/8 retries");
  expect(sleep.mock.calls).toEqual([
    [60_000, undefined],
    [30_000, undefined],
  ]);
});

it("allows eight transient retries across failure reasons when the ceiling has room", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const reason of ["rate_limit", "overloaded", "timeout", "server_error"] as const) {
      await checkRetry({ reason });
    }
  }
  await checkRetry({ reason: "server_error" }, false);
  expect(controller.transientRetryCount).toBe(8);
});

it("lets auxiliary runs defer provider failures without sleeping or replaying", async () => {
  const advance = vi.fn(async () => true);
  controller = createController({
    advanceAuthProfile: advance,
    retryTransientErrors: false,
    budget: 9,
  });
  for (const reason of ["rate_limit", "overloaded", "timeout", "server_error"] as const) {
    await checkRetry({ reason, onRetry }, false);
    await expect(rotate(reason)).resolves.toBe(false);
  }
  expect(advance).not.toHaveBeenCalled();
  expectNoRetry();
});

it.each([
  ["server_error", 0],
  ["server_error", 1],
  ["rate_limit", 0],
  ["rate_limit", 1],
] as const)("honors the saved %s retry budget of %i", async (reason, budget) => {
  controller.observeAttempt({ providerRetryMaxRetries: budget });
  for (let retry = 0; retry < budget; retry++) {
    await checkRetry({ reason, onRetry });
    expect(onRetry).toHaveBeenLastCalledWith(expect.objectContaining({ maxRetries: budget }));
  }
  await checkRetry({ reason, onRetry }, false);
  expect(controller.transientRetryCount).toBe(budget);
  expect(onRetry).toHaveBeenCalledTimes(budget);
  expect(sleep).toHaveBeenCalledTimes(budget);
});

it("reports the scheduled recovery before waiting for backoff", async () => {
  await useRealSleep();
  vi.spyOn(Math, "random").mockReturnValue(0);
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
  expect(sleep).toHaveBeenCalledWith(500, undefined);
});

it("continues transient recovery when the retry status callback rejects", async () => {
  const closeRetryWait = vi.fn();
  const onRetryWait = vi.fn(() => closeRetryWait);
  controller = createController({ onRetryWait, budget: 1 });
  onRetry.mockRejectedValue(new Error("event sink disconnected"));
  await checkRetry({ reason: "server_error", onRetry });
  expect(onRetry).toHaveBeenCalledOnce();
  expect(onRetryWait).toHaveBeenCalledOnce();
  expect(sleep).toHaveBeenCalledOnce();
  expect(closeRetryWait).toHaveBeenCalledWith(true);
  expect(controller.transientRetryCount).toBe(1);
});

it("escalates after one successful rate-limit rotation without advancing again", async () => {
  const advance = vi.fn(async () => true);
  controller = createController({ advanceAuthProfile: advance, fallbackConfigured: true });
  await expect(rotate()).resolves.toBe(true);
  await expect(rotate()).rejects.toMatchObject({
    name: "FailoverError",
    reason: "rate_limit",
    status: 429,
  });
  await expect(rotate()).rejects.toBeInstanceOf(FailoverError);
  expect(advance).toHaveBeenCalledTimes(1);
  expect(rotationContext.logFallbackDecision).toHaveBeenCalledTimes(2);
  expect(rotationContext.logFallbackDecision).toHaveBeenNthCalledWith(1, "fallback_model", {
    status: 429,
  });
});
