import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCliBindingFlushed,
  restoreCliRunnerTestDeps,
  setCliRunnerTestDeps,
} from "./cli-runner.js";

describe("isCliBindingFlushed", () => {
  beforeEach(() => {
    restoreCliRunnerTestDeps();
  });

  afterEach(() => {
    restoreCliRunnerTestDeps();
  });

  it("returns false when no sessionId is provided", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed(undefined, "claude-cli")).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true when the transcript has content on the first probe", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-fresh", "claude-cli")).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({ sessionId: "sid-fresh" });
  });

  it("retries up to three times before giving up", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-cold", "claude-cli")).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("succeeds when the transcript becomes visible on a later retry", async () => {
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return calls >= 2;
    });
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-late", "claude-cli")).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("schedules at most 0 + 50 + 150ms of delay across the bounded retry", async () => {
    // 0 + 50 + 150 = 200ms of scheduled delay if all three probes return false.
    // Using fake timers so the assertion measures *scheduled* delay rather
    // than wall-clock elapsed time (the latter is flaky under CI threadpool
    // load — the probe itself can spend tens of ms before the first sleep).
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => false);
      setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

      const settled = vi.fn();
      const errored = vi.fn();
      isCliBindingFlushed("sid-bounded", "claude-cli").then(settled, errored);

      // Drain any synchronous probe calls and the queued setTimeouts.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(150);

      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled.mock.calls[0]?.[0]).toBe(false);
      expect(errored).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns true without probing for non-claude-cli providers", async () => {
    // The transcript probe walks `~/.claude/projects` and only knows about
    // claude-cli sessions. For codex / openai / anthropic-api / etc., probing
    // would always return false and incorrectly strip valid binding metadata,
    // so we must skip the probe entirely.
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-codex", "codex-cli")).toBe(true);
    expect(await isCliBindingFlushed("sid-anthropic", "anthropic")).toBe(true);
    expect(await isCliBindingFlushed("sid-openai", "openai")).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when provider is undefined", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-x", undefined)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});
