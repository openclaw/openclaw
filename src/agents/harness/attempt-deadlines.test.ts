import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentHarnessAttemptDeadlineController } from "../../plugin-sdk/agent-harness-attempt-runtime.js";

const SETTLEMENT_TIMEOUT_MS = 2 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function createController(
  overrides: Partial<Parameters<typeof createAgentHarnessAttemptDeadlineController>[0]> = {},
) {
  const callbacks = { onTimeout: vi.fn(), onDeadlineChanged: vi.fn() };
  const controller = createAgentHarnessAttemptDeadlineController({
    startedAtMs: 0,
    startedAtMonotonicMs: 0,
    timeoutMs: 60_000,
    settlementTimeoutMs: SETTLEMENT_TIMEOUT_MS,
    signal: new AbortController().signal,
    ...callbacks,
    ...overrides,
  });
  return { controller, ...callbacks };
}

function expectTimeout(onTimeout: ReturnType<typeof vi.fn>, kind: "execution" | "settlement") {
  const timeoutMs = kind === "execution" ? 60_000 : SETTLEMENT_TIMEOUT_MS;
  expect(onTimeout).toHaveBeenCalledExactlyOnceWith({ kind, elapsedMs: timeoutMs, timeoutMs });
}

it.each([
  ["timer", 0, false],
  ["timer", 0, true],
  ["clock", 0, false],
  ["timer", 90_000, false],
  ["timer", -90_000, false],
] as const)("expires via %s across a %ims clock jump (legacy: %s)", (expiry, jumpMs, legacy) => {
  vi.advanceTimersByTime(20_000);
  vi.setSystemTime(20_000 + jumpMs);
  const { controller, onTimeout, onDeadlineChanged } = createController({
    startedAtMonotonicMs: legacy ? undefined : 0,
  });
  expect(onDeadlineChanged).toHaveBeenCalledWith({ kind: "bounded", deadlineAtMs: 60_000 });

  if (expiry === "clock") {
    vi.spyOn(performance, "now").mockReturnValue(60_000);
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    controller.dispose();
    return;
  }

  vi.advanceTimersByTime(39_999);
  expect(onTimeout).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + jumpMs);
  expect(controller.ownsExecutionWait()).toBe(true);
  vi.advanceTimersByTime(1);

  expectTimeout(onTimeout, "execution");
  expect(controller.ownsExecutionWait()).toBe(false);
  controller.beginSettlement(Date.now());
  vi.advanceTimersByTime(SETTLEMENT_TIMEOUT_MS);
  expect(onTimeout).toHaveBeenCalledOnce();
});

it.each([
  ["native receipt", 60_000, 59_000, 59_000],
  ["blocked projection", 600_000, 90_000, 30_000],
  ["unlimited execution", MAX_TIMER_TIMEOUT_MS, 49 * 60 * 60_000, 49 * 60 * 60_000],
] as const)("bounds settlement from the original %s", (_label, timeout, now, receipt) => {
  const { controller, onTimeout, onDeadlineChanged } = createController({ timeoutMs: timeout });
  if (timeout === MAX_TIMER_TIMEOUT_MS) {
    expect(onDeadlineChanged).toHaveBeenCalledExactlyOnceWith({ kind: "unlimited" });
  }
  vi.advanceTimersByTime(now);
  expect(controller.ownsExecutionWait()).toBe(true);
  controller.beginSettlement(receipt);
  expect(controller.ownsExecutionWait()).toBe(false);
  expect(onDeadlineChanged).toHaveBeenLastCalledWith({
    kind: "bounded",
    deadlineAtMs: receipt + SETTLEMENT_TIMEOUT_MS,
  });

  const elapsedBeforeRepeat = timeout === 60_000 ? 60_000 : 0;
  vi.advanceTimersByTime(elapsedBeforeRepeat);
  controller.beginSettlement(Date.now());
  vi.advanceTimersByTime(receipt + SETTLEMENT_TIMEOUT_MS - now - elapsedBeforeRepeat - 1);
  expect(onTimeout).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);

  expectTimeout(onTimeout, "settlement");
  expect(onDeadlineChanged).toHaveBeenCalledTimes(2);
});

it.each(["abort", "dispose", "already aborted"] as const)(
  "cannot revive a deadline after %s",
  (closure) => {
    const abort = new AbortController();
    if (closure === "already aborted") {
      abort.abort("cancelled");
    }
    const { controller, onTimeout, onDeadlineChanged } = createController({ signal: abort.signal });
    controller.beginSettlement(0);
    if (closure === "abort") {
      abort.abort("cancelled");
    } else if (closure === "dispose") {
      controller.dispose();
    }
    controller.beginSettlement(Date.now());
    vi.advanceTimersByTime(SETTLEMENT_TIMEOUT_MS + 60_000);
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onDeadlineChanged).toHaveBeenCalledTimes(closure === "already aborted" ? 0 : 2);
  },
);
