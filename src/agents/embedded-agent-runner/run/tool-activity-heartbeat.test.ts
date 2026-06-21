import { describe, expect, it, vi } from "vitest";
import { clearToolActivityRun, getLastToolActivityMs, notifyToolActivity, onToolActivity } from "./tool-activity-heartbeat.js";

const RUN = "test-run";

describe("tool-activity-heartbeat", () => {
  it("fires registered listener when notifyToolActivity is called", () => {
    const listener = vi.fn();

    const unsubscribe = onToolActivity(RUN, listener);
    notifyToolActivity(RUN);

    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("does not fire listener after unsubscribe", () => {
    const listener = vi.fn();

    const unsubscribe = onToolActivity(RUN, listener);
    unsubscribe();
    notifyToolActivity(RUN);

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple listeners", () => {
    const a = vi.fn();
    const b = vi.fn();

    const unsubA = onToolActivity(RUN, a);
    onToolActivity(RUN, b);
    notifyToolActivity(RUN);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
  });

  it("broadcasts to all listeners on the same run", () => {
    const a = vi.fn();
    const b = vi.fn();

    onToolActivity(RUN, a);
    onToolActivity(RUN, b);
    notifyToolActivity(RUN);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not bother listeners for notifyToolActivity without registered listeners", () => {
    expect(() => notifyToolActivity("empty-run")).not.toThrow();
  });

  it("scopes listeners per run — does not cross-fire", () => {
    const runAListener = vi.fn();
    const runBListener = vi.fn();

    onToolActivity("run-a", runAListener);
    onToolActivity("run-b", runBListener);
    notifyToolActivity("run-a");

    expect(runAListener).toHaveBeenCalledTimes(1);
    expect(runBListener).not.toHaveBeenCalled();
  });

  it("clearToolActivityRun removes listeners and last-activity timestamp", () => {
    const listener = vi.fn();
    onToolActivity(RUN, listener);
    notifyToolActivity(RUN);
    expect(getLastToolActivityMs(RUN)).toBeGreaterThan(0);

    clearToolActivityRun(RUN);
    expect(getLastToolActivityMs(RUN)).toBe(0);

    notifyToolActivity(RUN);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
