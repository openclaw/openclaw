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

  it("does not exceed ~200ms of delay across the bounded retry", async () => {
    // 0 + 50 + 150 = 200ms of scheduled delay if all three probes return false.
    // We allow a generous 400ms ceiling for CI scheduling jitter.
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    const start = Date.now();
    await isCliBindingFlushed("sid-bounded", "claude-cli");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(400);
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
