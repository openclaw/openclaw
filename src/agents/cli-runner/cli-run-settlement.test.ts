/** Tests native CLI continuity projection and bounded transcript-flush probing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  isCliBindingFlushed,
  restoreCliRunnerTestDeps,
  setCliRunnerTestDeps,
} from "../cli-runner.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { applyCliSessionBindingResult, getCliSessionBinding } from "../cli-session.js";
import { renderBillingReplyCopy } from "../failover/user-copy.js";
import {
  buildBlockedCliRunResult,
  buildCliRunResult,
  settleCliBackendOutcome,
} from "./cli-run-settlement.js";

describe("isCliBindingFlushed", () => {
  const workspaceDir = "/tmp/openclaw-workspace";

  beforeEach(() => {
    vi.useRealTimers();
    restoreCliRunnerTestDeps();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
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

    expect(await isCliBindingFlushed("sid-fresh", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({ sessionId: "sid-fresh", workspaceDir });
  });

  it("retries up to three times before giving up", async () => {
    const delay = vi.fn(async () => undefined);
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-cold", "claude-cli", workspaceDir)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 50);
    expect(delay).toHaveBeenNthCalledWith(2, 150);
  });

  it("succeeds when the transcript becomes visible on a later retry", async () => {
    const delay = vi.fn(async () => undefined);
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return calls >= 2;
    });
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-late", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledExactlyOnceWith(50);
  });

  it("schedules at most 0 + 50 + 150ms of delay across the bounded retry", async () => {
    vi.useFakeTimers();
    try {
      // Fake timers enforce the retry contract without introducing wall-clock
      // sleeps into this import-heavy agent test.
      const probe = vi.fn(async () => false);
      setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

      const settled = vi.fn();
      const errored = vi.fn();
      isCliBindingFlushed("sid-bounded", "claude-cli", workspaceDir).then(settled, errored);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(150);

      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled.mock.calls[0]?.[0]).toBe(false);
      expect(errored).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("returns true without probing for non-claude-cli providers", async () => {
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

  it("returns true without probing when the caller owns continuity outside native transcripts", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-warm", "claude-cli", workspaceDir, {
        skipTranscriptProbe: true,
      }),
    ).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("still probes when transcript-probe skipping is disabled", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-probe", "claude-cli", workspaceDir, {
        skipTranscriptProbe: false,
      }),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("CLI native continuity projection", () => {
  it.each(["blocked", "no-native-id", "native", "stateless"])(
    "projects only explicit native continuity from a %s result",
    (kind) => {
      const context = buildPreparedCliRunContext({ provider: "claude-cli" });
      const result =
        kind === "blocked"
          ? buildBlockedCliRunResult({
              context,
              message: "Blocked by the test policy",
              preparedContextAgentMeta: {},
              sessionBindingDisabled: false,
            })
          : buildCliRunResult({
              context,
              output: { text: "done" },
              effectiveCliSessionId: kind === "native" ? "next-native-session" : undefined,
              bindingFlushOk: kind !== "no-native-id",
              usedHistoryPrompt: false,
              userTurnHandled: true,
              sessionBindingDisabled: kind === "stateless",
              preparedContextAgentMeta: {},
            });
      const entry: SessionEntry = {
        sessionId: context.params.sessionId,
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "previous-native-session" } },
      };

      applyCliSessionBindingResult(entry, "claude-cli", result.meta.agentMeta);

      expect(entry.sessionId).toBe(context.params.sessionId);
      expect(result.meta.agentMeta?.sessionId).toBe(
        kind === "native" ? "next-native-session" : context.params.sessionId,
      );
      expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe(
        kind === "native"
          ? "next-native-session"
          : kind === "stateless"
            ? undefined
            : "previous-native-session",
      );
    },
  );
});

describe("settleCliBackendOutcome failover auth mode", () => {
  const billingRunError = new Error("Credit balance is too low");

  const settle = (failoverContext: {
    provider: string;
    model: string;
    sessionId: string;
    authMode?: string;
  }): unknown => {
    try {
      settleCliBackendOutcome({
        runResult: undefined,
        runError: billingRunError,
        runFailed: true,
        cleanupError: undefined,
        deliveredMessagingSideEffect: false,
        failoverContext,
      });
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it("carries the selected credential's auth mode into the thrown failover error", () => {
    expect(
      settle({
        provider: "claude-cli",
        model: "claude-sonnet-5",
        sessionId: "sess-1",
        authMode: "oauth",
      }),
    ).toMatchObject({ reason: "billing", authMode: "oauth" });
  });

  it("leaves the auth mode unset for unprofiled runs", () => {
    expect(
      settle({
        provider: "claude-cli",
        model: "claude-sonnet-5",
        sessionId: "sess-1",
      }),
    ).toMatchObject({ reason: "billing", authMode: undefined });
  });

  it("renders subscription billing copy for a subscription-auth CLI run", () => {
    // The settled error carries authMode ("carries..." case above); the reply
    // copy selects it from the attempt record, so build that record directly.
    expect(
      renderBillingReplyCopy({
        attempts: [
          {
            provider: "claude-cli",
            model: "claude-sonnet-5",
            reason: "billing",
            error: "Credit balance is too low",
            authMode: "oauth",
          },
        ],
      }),
    ).toContain("check your account for subscription or usage limits");
  });
});
