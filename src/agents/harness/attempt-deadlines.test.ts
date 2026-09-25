import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentHarnessAttemptDeadlineController } from "./attempt-deadlines.js";

const SETTLEMENT_TIMEOUT_MS = 2 * 60_000;

describe("agent harness attempt deadlines", () => {
  // Performance.now spy aliased to Date.now in beforeEach so existing wall-clock
  // assertions hold; the clock-jump regression below restores it. Kept on the
  // describe scope so `typescript(unbound-method)` does not flag a bare
  // `performance.now` reference when restoring.
  let performanceNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Production deadlines measure elapsed budget with performance.now() (monotonic)
    // while tests drive time with vi.setSystemTime/advanceTimersByTime, which only
    // advance Date.now(). Alias performance.now to Date.now so the existing assertions
    // about elapsed budgets hold; the clock-jump regression below decouples them.
    performanceNowSpy = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function createController(
    timeoutMs = 60_000,
    startedAtMs = Date.now(),
    startedAtMonotonicMs = startedAtMs,
  ) {
    const abort = new AbortController();
    const onTimeout = vi.fn();
    const onDeadlineChanged = vi.fn();
    const controller = createAgentHarnessAttemptDeadlineController({
      startedAtMs,
      startedAtMonotonicMs,
      timeoutMs,
      settlementTimeoutMs: SETTLEMENT_TIMEOUT_MS,
      signal: abort.signal,
      onTimeout,
      onDeadlineChanged,
    });
    return { controller, abort, onTimeout, onDeadlineChanged };
  }

  it("expires the elapsed execution budget from attempt admission, not controller creation", () => {
    vi.setSystemTime(20_000);
    const { controller, onTimeout, onDeadlineChanged } = createController(60_000, 0);
    expect(controller.ownsExecutionWait()).toBe(true);
    expect(onDeadlineChanged).toHaveBeenCalledWith({ kind: "bounded", deadlineAtMs: 60_000 });

    vi.advanceTimersByTime(39_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "execution",
      elapsedMs: 60_000,
      timeoutMs: 60_000,
    });
    expect(controller.ownsExecutionWait()).toBe(false);
    controller.beginSettlement(Date.now());
    vi.advanceTimersByTime(SETTLEMENT_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("stops claiming native liveness at expiry even before the timer callback runs", () => {
    const { controller, onTimeout } = createController();
    vi.setSystemTime(60_000);
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("replaces execution with one absolute settlement deadline at native terminal receipt", () => {
    const { controller, onTimeout, onDeadlineChanged } = createController();
    vi.advanceTimersByTime(59_000);
    controller.beginSettlement(Date.now());
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onDeadlineChanged).toHaveBeenLastCalledWith({
      kind: "bounded",
      deadlineAtMs: 59_000 + SETTLEMENT_TIMEOUT_MS,
    });

    vi.advanceTimersByTime(60_000);
    controller.beginSettlement(Date.now());
    vi.advanceTimersByTime(SETTLEMENT_TIMEOUT_MS - 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "settlement",
      elapsedMs: SETTLEMENT_TIMEOUT_MS,
      timeoutMs: SETTLEMENT_TIMEOUT_MS,
    });
    expect(onDeadlineChanged).toHaveBeenCalledTimes(2);
  });

  it("charges time already spent behind a blocked projection against settlement", () => {
    const { controller, onTimeout } = createController(10 * 60_000);
    vi.advanceTimersByTime(90_000);
    controller.beginSettlement(30_000);
    vi.advanceTimersByTime(59_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "settlement",
      elapsedMs: SETTLEMENT_TIMEOUT_MS,
      timeoutMs: SETTLEMENT_TIMEOUT_MS,
    });
  });

  it("keeps the execution timeout bounded when the wall clock rewinds", () => {
    // Drop the beforeEach alias so performance.now() (driven by advanceTimersByTime)
    // and Date.now() (driven by setSystemTime) can diverge, modeling a clock jump.
    performanceNowSpy.mockRestore();
    // Attempt admitted at fake-time 0: performance.now() reads 0 here.
    const { controller, onTimeout, onDeadlineChanged } = createController(60_000, 0, 0);
    // deadlineAtMs is wall-clock (queue owners compare against Date.now()).
    expect(onDeadlineChanged).toHaveBeenCalledWith({ kind: "bounded", deadlineAtMs: 60_000 });
    vi.advanceTimersByTime(30_000);
    expect(controller.ownsExecutionWait()).toBe(true);
    // A clock correction rewinds the wall clock by 90s while the monotonic clock
    // (driven by advanceTimersByTime) keeps running. A wall-clock-based remaining
    // budget would grow to 120s; the monotonic budget must still expire at 60s
    // of real elapsed time.
    vi.setSystemTime(-60_000);
    vi.advanceTimersByTime(29_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "execution",
      elapsedMs: 60_000,
      timeoutMs: 60_000,
    });
    expect(controller.ownsExecutionWait()).toBe(false);
    controller.dispose();
  });

  it("charges a delayed controller construction against the admission budget", () => {
    // Models a caller (e.g. Agents API) that captures startedAtMs earlier than
    // controller construction and passes the matching monotonic seed. Without
    // the seed the controller would sample performance.now() at construction and
    // grant the admission-to-construction gap back to the execution timer,
    // diverging from the queue's wall-clock deadline.
    performanceNowSpy.mockRestore();
    // Admission happened 20s ago (wall-clock startedAtMs=0, monotonic seed=0);
    // the controller is constructed only now, after 20s of monotonic time.
    vi.setSystemTime(0);
    vi.advanceTimersByTime(20_000);
    const { controller, onTimeout, onDeadlineChanged } = createController(60_000, 0, 0);
    // The published deadline is wall-clock and reflects the admission start.
    expect(onDeadlineChanged).toHaveBeenCalledWith({ kind: "bounded", deadlineAtMs: 60_000 });
    // Only 40s of budget remain: the 20s spent before construction is charged
    // against the admission budget, not re-granted.
    vi.advanceTimersByTime(39_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "execution",
      elapsedMs: 60_000,
      timeoutMs: 60_000,
    });
    expect(controller.ownsExecutionWait()).toBe(false);
    controller.dispose();
  });

  it("leaves normalized unlimited execution unbounded but still bounds local settlement", () => {
    const { controller, onTimeout, onDeadlineChanged } = createController(MAX_TIMER_TIMEOUT_MS);
    expect(onDeadlineChanged).toHaveBeenCalledExactlyOnceWith({ kind: "unlimited" });
    vi.advanceTimersByTime(49 * 60 * 60_000);
    expect(controller.ownsExecutionWait()).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();

    controller.beginSettlement(Date.now());
    expect(controller.ownsExecutionWait()).toBe(false);
    vi.advanceTimersByTime(SETTLEMENT_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "settlement",
      elapsedMs: SETTLEMENT_TIMEOUT_MS,
      timeoutMs: SETTLEMENT_TIMEOUT_MS,
    });
  });

  it.each(["abort", "dispose"] as const)("cannot revive a deadline after %s", (closure) => {
    const { controller, abort, onTimeout, onDeadlineChanged } = createController();
    controller.beginSettlement(Date.now());
    if (closure === "abort") {
      abort.abort("cancelled");
    } else {
      controller.dispose();
    }
    controller.beginSettlement(Date.now());
    vi.advanceTimersByTime(SETTLEMENT_TIMEOUT_MS + 60_000);
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onDeadlineChanged).toHaveBeenCalledTimes(2);
  });

  it("does not schedule work for an already-aborted attempt", () => {
    const abort = new AbortController();
    abort.abort("cancelled");
    const onTimeout = vi.fn();
    const onDeadlineChanged = vi.fn();
    const controller = createAgentHarnessAttemptDeadlineController({
      startedAtMs: 0,
      timeoutMs: 60_000,
      settlementTimeoutMs: SETTLEMENT_TIMEOUT_MS,
      signal: abort.signal,
      onTimeout,
      onDeadlineChanged,
    });
    controller.beginSettlement(0);
    vi.advanceTimersByTime(SETTLEMENT_TIMEOUT_MS);
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onDeadlineChanged).not.toHaveBeenCalled();
  });
});
