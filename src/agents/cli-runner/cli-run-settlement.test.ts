/** Tests native CLI continuity projection and bounded transcript-flush probing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { wrapRunWithTestPreparedAdmission } from "../admitted-run-context.test-support.js";
import {
  isCliBindingFlushed,
  restoreCliRunnerTestDeps,
  runCliAgent,
  setCliRunnerTestDeps,
} from "../cli-runner.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { applyCliSessionBindingResult, getCliSessionBinding } from "../cli-session.js";
import {
  buildBlockedCliRunResult,
  buildCliDeliveredFailure,
  buildCliRunResult,
} from "./cli-run-settlement.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (name: string) => name === "before_agent_reply",
    runBeforeAgentReply: async () => ({ handled: true, reply: { text: "Hook reply" } }),
  }),
}));

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
});

describe("CLI native continuity projection", () => {
  it.each(["blocked", "no-native-id", "native", "stateless"])(
    "projects only explicit native continuity from a %s result",
    (kind) => {
      const context = buildPreparedCliRunContext({ provider: "claude-cli" });
      context.params.modelProvider = "anthropic";
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

describe.each(["anthropic", undefined])(
  "CLI result provider (modelProvider=%s)",
  (modelProvider) => {
    it.each(["completed", "blocked", "delivered-failure", "hook-handled"] as const)(
      "preserves the logical model provider and backend identity for a %s result",
      async (kind) => {
        const context = buildPreparedCliRunContext({ provider: "claude-cli" });
        if (modelProvider !== undefined) {
          context.params.modelProvider = modelProvider;
        }
        const result =
          kind === "hook-handled"
            ? await wrapRunWithTestPreparedAdmission(runCliAgent)({
                sessionId: context.params.sessionId,
                sessionFile: context.params.sessionFile,
                sessionKey: context.params.sessionKey,
                workspaceDir: context.workspaceDir,
                prompt: "Hook-owned reply",
                provider: context.params.provider,
                ...(modelProvider !== undefined ? { modelProvider } : {}),
                model: context.modelId,
                timeoutMs: 30_000,
                runId: context.params.runId,
                trigger: "user",
              })
            : kind === "blocked"
              ? buildBlockedCliRunResult({
                  context,
                  message: "Blocked by the test policy",
                  preparedContextAgentMeta: {},
                  sessionBindingDisabled: false,
                })
              : kind === "delivered-failure"
                ? buildCliDeliveredFailure({
                    context,
                    error: new Error("synthetic failure"),
                    evidence: { didSendViaMessagingTool: true },
                    preparedContextAgentMeta: {},
                    sessionBindingDisabled: false,
                  })
                : buildCliRunResult({
                    context,
                    output: { text: "done" },
                    effectiveCliSessionId: "next-native-session",
                    bindingFlushOk: true,
                    usedHistoryPrompt: false,
                    userTurnHandled: true,
                    sessionBindingDisabled: false,
                    preparedContextAgentMeta: {},
                  });

        expect(result.meta.agentMeta?.provider).toBe(modelProvider ?? "claude-cli");
        if (kind === "hook-handled") {
          expect(result.meta.executionTrace).toBeUndefined();
        } else {
          expect(result.meta.executionTrace).toMatchObject({
            winnerProvider: "claude-cli",
            attempts: [expect.objectContaining({ provider: "claude-cli" })],
          });
        }
      },
    );
  },
);

it("preserves completed result boundaries for independent final delivery", async () => {
  const context = buildPreparedCliRunContext({ provider: "claude-cli" });
  const result = buildCliRunResult({
    context,
    output: { text: "First answer.\nLast answer.", textParts: ["First answer.", "Last answer."] },
    usedHistoryPrompt: false,
    userTurnHandled: true,
    sessionBindingDisabled: true,
    preparedContextAgentMeta: {},
    assistantTranscriptOwned: true,
    assistantTranscriptIdempotencyKey: "synthetic-turn",
  });
  expect(result.payloads).toEqual([{ text: "First answer." }, { text: "Last answer." }]);
  const { getReplyPayloadMetadata } = await import("../../auto-reply/reply-payload.js");
  for (const [assistantMessageIndex, payload] of (result.payloads ?? []).entries()) {
    expect(getReplyPayloadMetadata(payload)).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "synthetic-turn",
      assistantMessageIndex,
    });
  }
});
