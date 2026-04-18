import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const readAcpSessionEntryMock = vi.fn();
const resolveSessionFilePathMock = vi.fn();
const resolveSessionFilePathOptionsMock = vi.fn();
const sendMessageMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

// Phase 3.5 Discord Surface Overhaul: mock the outbound message seam so F3's
// direct-to-thread final_reply POST is observable without hitting the gateway.
vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
    }),
  );
});

vi.mock("../acp/runtime/session-meta.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../acp/runtime/session-meta.js")>(
      "../acp/runtime/session-meta.js",
    ),
    () => ({
      readAcpSessionEntry: (...args: unknown[]) => readAcpSessionEntryMock(...args),
    }),
  );
});

vi.mock("../config/sessions/paths.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../config/sessions/paths.js")>(
      "../config/sessions/paths.js",
    ),
    () => ({
      resolveSessionFilePath: (...args: unknown[]) => resolveSessionFilePathMock(...args),
      resolveSessionFilePathOptions: (...args: unknown[]) =>
        resolveSessionFilePathOptionsMock(...args),
    }),
  );
});

let emitAgentEvent: typeof import("../infra/agent-events.js").emitAgentEvent;
let resolveAcpSpawnStreamLogPath: typeof import("./acp-spawn-parent-stream.js").resolveAcpSpawnStreamLogPath;
let startAcpSpawnParentStreamRelay: typeof import("./acp-spawn-parent-stream.js").startAcpSpawnParentStreamRelay;

function collectedTexts() {
  return enqueueSystemEventMock.mock.calls.map((call) => String(call[0] ?? ""));
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeAll(async () => {
    ({ emitAgentEvent } = await import("../infra/agent-events.js"));
    ({ resolveAcpSpawnStreamLogPath, startAcpSpawnParentStreamRelay } =
      await import("./acp-spawn-parent-stream.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue({});
    readAcpSessionEntryMock.mockReset();
    resolveSessionFilePathMock.mockReset();
    resolveSessionFilePathOptionsMock.mockReset();
    resolveSessionFilePathOptionsMock.mockImplementation((value: unknown) => value);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("relays assistant progress and completion to the parent session", () => {
    // No deliveryContext here: without threadBound the final_reply flush goes
    // through enqueueSystemEvent (not the F3 direct-post path), so we can
    // keep asserting on collectedTexts().
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-1",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-1",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    // G5a: phase-less deltas DEFER timer flushes until lifecycle-end. Tag
    // this codex-style delta with phase=final_answer to match real codex
    // behavior and to exercise the immediate flush + final_reply emission.
    emitAgentEvent({
      runId: "run-1",
      stream: "assistant",
      data: {
        delta: "hello from child",
        phase: "final_answer",
      },
    });
    vi.advanceTimersByTime(15);

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 3_100,
      },
    });

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("Started codex session"))).toBe(true);
    // Production bug fix: final_reply emissions no longer carry the "codex: "
    // relay-label prefix — the webhook persona conveys identity, and for the
    // enqueue fallback path the child's full reply is preferred verbatim.
    expect(texts.some((text) => text.includes("hello from child"))).toBe(true);
    expect(texts.some((text) => text.startsWith("codex: hello from child"))).toBe(false);
    expect(texts.some((text) => text.includes("codex run completed in 2s"))).toBe(true);
    expect(
      enqueueSystemEventMock.mock.calls.every(
        (call) => (call[1] as { trusted?: boolean } | undefined)?.trusted === false,
      ),
    ).toBe(true);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        trusted: false,
      }),
    );
    // Phase 2 Discord Surface Overhaul: every relayed emission carries an
    // explicit MessageClass. Start notice → progress, final_answer delta →
    // final_reply, lifecycle end → completion.
    const classes = enqueueSystemEventMock.mock.calls.map(
      (call) => (call[1] as { messageClass?: string } | undefined)?.messageClass,
    );
    expect(classes).toContain("progress");
    expect(classes).toContain("final_reply");
    expect(classes).toContain("completion");
    expect(classes.every((cls) => cls !== "internal_narration")).toBe(true);
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      }),
    );
    relay.dispose();
  });

  it("classifies final_answer-phase assistant deltas as final_reply", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-final-class",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-final-class",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    // Commentary deltas are suppressed upstream (covered elsewhere); emit a
    // final_answer phase delta. The flushed snippet MUST carry MessageClass
    // "final_reply" so the surface-policy predicate treats it as the user-
    // visible reply rather than mid-turn progress.
    emitAgentEvent({
      runId: "run-final-class",
      stream: "assistant",
      data: { delta: "This is the final answer.", phase: "final_answer" },
    });
    vi.advanceTimersByTime(15);

    const finalCalls = enqueueSystemEventMock.mock.calls.filter(
      (call) => (call[1] as { messageClass?: string } | undefined)?.messageClass === "final_reply",
    );
    expect(finalCalls.length).toBeGreaterThan(0);
    // Production bug fix: final_reply no longer prefixes the relay label.
    expect(String(finalCalls[0][0])).toContain("This is the final answer.");
    expect(String(finalCalls[0][0]).startsWith("codex:")).toBe(false);
    relay.dispose();
  });

  it("sanitizes leaky content on progress emissions before enqueueing", () => {
    // Phase 3 Discord Surface Overhaul: progress-class text passes through
    // the stricter leak-scrub profile. Absolute home paths, sk-* tokens, and
    // Bearer secrets are redacted BEFORE the text reaches enqueueSystemEvent.
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-leak",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-leak",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    // G5a: phase-less deltas defer timer flushes. Use a trailing paragraph
    // break ("\n\n") to trigger the immediate flush path (delta boundary),
    // which still emits as `progress` for phase-less streams. This preserves
    // the exact sanitization-profile test intent.
    emitAgentEvent({
      runId: "run-leak",
      stream: "assistant",
      data: {
        delta:
          "Loading /home/alice/project/secret.env with Bearer abcd1234efgh5678 and sk-live-XYZABC123456789012.\n\n",
      },
    });
    vi.advanceTimersByTime(15);

    const emissions = enqueueSystemEventMock.mock.calls
      .map((call) => String(call[0] ?? ""))
      .filter((text) => text.startsWith("codex:"));
    expect(emissions.length).toBeGreaterThan(0);
    const leaked = emissions[0];
    // Absolute path stripped to ~/...
    expect(leaked).not.toContain("/home/alice/");
    expect(leaked).toContain("~/project/secret.env");
    // Bearer secret redacted (the word Bearer may remain, but the token must
    // not).
    expect(leaked).not.toMatch(/Bearer\s+abcd1234/);
    expect(leaked).toContain("Bearer [redacted]");
    // sk-* API key redacted.
    expect(leaked).not.toContain("sk-live-XYZABC123456789012");
    expect(leaked).toContain("[redacted-api-key]");
    relay.dispose();
  });

  it("emits a no-output notice and a resumed notice when output returns", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-2",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-2",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    vi.advanceTimersByTime(1_500);
    expect(collectedTexts().some((text) => text.includes("has produced no output for 1s"))).toBe(
      true,
    );

    emitAgentEvent({
      runId: "run-2",
      stream: "assistant",
      data: {
        // G5a: phase-less deltas defer timer-flush; tag as final_answer so
        // the resumed-output delta flushes as a final_reply emission. The
        // test asserts both the "resumed output." lifecycle notice AND the
        // relayed delta text reach the parent session.
        delta: "resumed output",
        phase: "final_answer",
      },
    });
    vi.advanceTimersByTime(5);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("resumed output."))).toBe(true);
    // Production bug fix: final_reply no longer prefixes the relay label.
    expect(texts.some((text) => text.includes("resumed output"))).toBe(true);

    emitAgentEvent({
      runId: "run-2",
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "boom",
      },
    });
    expect(collectedTexts().some((text) => text.includes("run failed: boom"))).toBe(true);
    relay.dispose();
  });

  it("auto-disposes stale relays after max lifetime timeout", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-3",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-3",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 0,
      maxRelayLifetimeMs: 1_000,
    });

    vi.advanceTimersByTime(1_001);
    expect(collectedTexts().some((text) => text.includes("stream relay timed out after 1s"))).toBe(
      true,
    );

    const before = enqueueSystemEventMock.mock.calls.length;
    emitAgentEvent({
      runId: "run-3",
      stream: "assistant",
      data: {
        delta: "late output",
      },
    });
    vi.advanceTimersByTime(5);

    expect(enqueueSystemEventMock.mock.calls).toHaveLength(before);
    relay.dispose();
  });

  it("supports delayed start notices", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-4",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-4",
      agentId: "codex",
      emitStartNotice: false,
    });

    expect(collectedTexts().some((text) => text.includes("Started codex session"))).toBe(false);

    relay.notifyStarted();

    expect(collectedTexts().some((text) => text.includes("Started codex session"))).toBe(true);
    relay.dispose();
  });

  it("can keep background relays out of the parent session while still logging", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-quiet",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-quiet",
      agentId: "codex",
      surfaceUpdates: false,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    relay.notifyStarted();
    emitAgentEvent({
      runId: "run-quiet",
      stream: "assistant",
      data: {
        delta: "hello from child",
      },
    });
    vi.advanceTimersByTime(15);
    emitAgentEvent({
      runId: "run-quiet",
      stream: "lifecycle",
      data: {
        phase: "end",
      },
    });

    expect(collectedTexts()).toEqual([]);
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
    relay.dispose();
  });

  it("preserves delta whitespace boundaries in progress relays", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-5",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-5",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    // G5a: phase-less deltas defer timer-flush. Tag with phase=final_answer
    // so the timer flush fires as expected; we're only testing that the
    // delta concatenation preserves interior whitespace across buffer
    // accumulation.
    emitAgentEvent({
      runId: "run-5",
      stream: "assistant",
      data: {
        delta: "hello",
        phase: "final_answer",
      },
    });
    emitAgentEvent({
      runId: "run-5",
      stream: "assistant",
      data: {
        delta: " world",
        phase: "final_answer",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    // Production bug fix: final_reply no longer prefixes the relay label.
    expect(texts.some((text) => text.includes("hello world"))).toBe(true);
    expect(texts.some((text) => text.startsWith("codex: hello world"))).toBe(false);
    relay.dispose();
  });

  it("suppresses commentary-phase assistant relay text", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-commentary",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-commentary",
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("checking thread context"))).toBe(false);
    expect(texts.some((text) => text.includes("post a tight progress reply here"))).toBe(false);
    relay.dispose();
  });

  it("still relays final_answer assistant text after suppressed commentary", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-final",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-final",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-final",
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    emitAgentEvent({
      runId: "run-final",
      stream: "assistant",
      data: {
        delta: "final answer ready",
        phase: "final_answer",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expect(texts.some((text) => text.includes("checking thread context"))).toBe(false);
    // Production bug fix: final_reply no longer prefixes the relay label.
    expect(texts.some((text) => text.includes("final answer ready"))).toBe(true);
    expect(texts.some((text) => text.startsWith("codex: final answer ready"))).toBe(false);
    relay.dispose();
  });

  it("resolves ACP spawn stream log path from session metadata", () => {
    readAcpSessionEntryMock.mockReturnValue({
      storePath: "/tmp/openclaw/agents/codex/sessions/sessions.json",
      entry: {
        sessionId: "sess-123",
        sessionFile: "/tmp/openclaw/agents/codex/sessions/sess-123.jsonl",
      },
    });
    resolveSessionFilePathMock.mockReturnValue(
      "/tmp/openclaw/agents/codex/sessions/sess-123.jsonl",
    );

    const resolved = resolveAcpSpawnStreamLogPath({
      childSessionKey: "agent:codex:acp:child-1",
    });

    expect(resolved).toBe("/tmp/openclaw/agents/codex/sessions/sess-123.acp-stream.jsonl");
    expect(readAcpSessionEntryMock).toHaveBeenCalledWith({
      sessionKey: "agent:codex:acp:child-1",
    });
    expect(resolveSessionFilePathMock).toHaveBeenCalledWith(
      "sess-123",
      expect.objectContaining({
        sessionId: "sess-123",
      }),
      expect.objectContaining({
        storePath: "/tmp/openclaw/agents/codex/sessions/sessions.json",
      }),
    );
  });

  // Phase 2.5/3.5 Discord Surface Overhaul — F3 + F4 atomic fix coverage.
  it("F3: direct-posts final_reply to the bound thread instead of enqueuing a system event", () => {
    const deliveryContext = {
      channel: "discord",
      to: "channel:parent-channel",
      accountId: "default",
      threadId: "child-thread-999",
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-f3",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:f3",
      agentId: "codex",
      deliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-f3",
      stream: "assistant",
      data: { delta: "Final verdict: ship it.", phase: "final_answer" },
    });
    vi.advanceTimersByTime(15);

    // F3: final_reply + thread-bound deliveryContext triggers sendMessage with
    // the thread id as the routing target, NOT enqueueSystemEvent for prompt
    // insertion on the parent.
    expect(sendMessageMock).toHaveBeenCalled();
    const postArgs = sendMessageMock.mock.calls.at(-1)?.[0] as
      | {
          channel?: string;
          to?: string;
          threadId?: string | number;
          content?: string;
        }
      | undefined;
    expect(postArgs?.channel).toBe("discord");
    expect(postArgs?.threadId).toBe("child-thread-999");
    expect(postArgs?.content).toContain("Final verdict: ship it.");

    // Crucially, the final_reply must NOT have been enqueued as a system event
    // (which would splice it as prompt text on the parent's next turn).
    const finalReplyEnqueues = enqueueSystemEventMock.mock.calls.filter(
      (call) => (call[1] as { messageClass?: string } | undefined)?.messageClass === "final_reply",
    );
    expect(finalReplyEnqueues.length).toBe(0);

    relay.dispose();
  });

  it("F3: falls back to enqueue when deliveryContext has no threadId (non-thread-bound)", () => {
    const deliveryContext = {
      channel: "discord",
      to: "channel:parent-channel",
      accountId: "default",
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-f3-fallback",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:f3f",
      agentId: "codex",
      deliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-f3-fallback",
      stream: "assistant",
      data: { delta: "Final: ok.", phase: "final_answer" },
    });
    vi.advanceTimersByTime(15);

    // Not thread-bound → legacy enqueue path remains.
    expect(sendMessageMock).not.toHaveBeenCalled();
    const finalReplyEnqueues = enqueueSystemEventMock.mock.calls.filter(
      (call) => (call[1] as { messageClass?: string } | undefined)?.messageClass === "final_reply",
    );
    expect(finalReplyEnqueues.length).toBeGreaterThan(0);
    relay.dispose();
  });

  it("F4: promotes the terminal assistant flush to final_reply when lifecycle phase=end fires", () => {
    // Claude ACP deltas omit `phase`. Prior to F4 every delta (including the
    // terminal one) classified as `progress`, leaving the final answer
    // invisible on thread surfaces. On lifecycle-end the pending buffer MUST
    // flush as final_reply.
    const deliveryContext = {
      channel: "discord",
      to: "channel:parent-channel",
      accountId: "default",
      threadId: "thread-f4",
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-f4",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:f4",
      agentId: "codex",
      deliveryContext,
      streamFlushMs: 5_000, // intentionally longer than the test window
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-f4",
      stream: "assistant",
      data: { delta: "Claude's terminal answer without phase." },
    });
    // Lifecycle end fires before the flush timer — F4 must flush as
    // final_reply, which triggers F3's direct POST for thread-bound surfaces.
    emitAgentEvent({
      runId: "run-f4",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
    });

    expect(sendMessageMock).toHaveBeenCalled();
    const postArgs = sendMessageMock.mock.calls.at(-1)?.[0] as
      | { threadId?: string | number; content?: string }
      | undefined;
    expect(postArgs?.threadId).toBe("thread-f4");
    expect(postArgs?.content).toContain("Claude's terminal answer");
    relay.dispose();
  });

  it("G5a: defers timer-initiated flush for phase-less (Claude-style) streams until lifecycle-end", () => {
    // G5a (R2 fix, Phase 10 Discord Surface Overhaul): Claude ACP deltas omit
    // the `phase` field. When the scheduleFlush timer fires BEFORE
    // lifecycle-end (real production race — lifecycle-end can arrive 14+s
    // after the first delta), F4's terminal promotion had nothing buffered to
    // promote. The deferral must keep the buffer alive across timer ticks so
    // the terminal flush can classify as final_reply.
    const deliveryContext = {
      channel: "discord",
      to: "channel:parent-channel",
      accountId: "default",
      threadId: "thread-g5a",
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-g5a",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:g5a",
      agentId: "claude",
      deliveryContext,
      streamFlushMs: 100, // short timer so we can race it below
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    // Claude-style delta: no phase field.
    emitAgentEvent({
      runId: "run-g5a",
      stream: "assistant",
      data: { delta: "Claude's in-progress answer fragment" },
    });
    // Advance PAST the flush timer multiple times. Pre-G5a this would drain
    // the buffer as `progress` and the later lifecycle-end would find nothing
    // to promote.
    vi.advanceTimersByTime(350);

    // Crucially: no final_reply should have been enqueued yet, because the
    // timer-initiated flush must be deferred for phase-less streams.
    const midStreamFinalReplies = enqueueSystemEventMock.mock.calls.filter(
      (call) => (call[1] as { messageClass?: string } | undefined)?.messageClass === "final_reply",
    );
    expect(midStreamFinalReplies.length).toBe(0);
    // The direct-post seam also must not have fired yet.
    expect(sendMessageMock).not.toHaveBeenCalled();

    // Lifecycle-end arrives. The buffered text MUST now promote to
    // final_reply — exactly F4's behavior, but now also surviving the
    // intervening timer ticks that would otherwise have drained the buffer.
    emitAgentEvent({
      runId: "run-g5a",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 1_000, endedAt: 15_000 },
    });

    expect(sendMessageMock).toHaveBeenCalled();
    const postArgs = sendMessageMock.mock.calls.at(-1)?.[0] as
      | { threadId?: string | number; content?: string }
      | undefined;
    expect(postArgs?.threadId).toBe("thread-g5a");
    expect(postArgs?.content).toContain("Claude's in-progress answer fragment");
    relay.dispose();
  });

  // Production bug fix (Phase 2.5/3.5 follow-up): the operator report was that
  // long-form assistant replies never reached the thread. Before the fix,
  // flushPending squashed ALL assistant deltas to a 220-char snippet + relay-
  // label prefix, so the direct-post webhook path received a truncated preview
  // instead of the real reply.
  it("preserves full assistant text on final_reply flush (no 220-char snippet truncation)", () => {
    const deliveryContext = {
      channel: "discord",
      to: "channel:parent-channel",
      accountId: "default",
      threadId: "thread-long",
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-long",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:claude:acp:long",
      agentId: "claude",
      deliveryContext,
      streamFlushMs: 5_000,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    // 600-char assistant answer — comfortably longer than STREAM_SNIPPET_MAX_CHARS
    // (220) but well under the per-Discord-message chunk budget (~1900).
    const longReply = `Here is the full analysis you asked for. ${"Detail ".repeat(80)}Conclusion.`;
    emitAgentEvent({
      runId: "run-long",
      stream: "assistant",
      data: { delta: longReply },
    });
    emitAgentEvent({
      runId: "run-long",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const postArgs = sendMessageMock.mock.calls[0]?.[0] as
      | { threadId?: string | number; content?: string }
      | undefined;
    expect(postArgs?.threadId).toBe("thread-long");
    // Full body survives end-to-end — no "…" truncation suffix, no relay label.
    expect(postArgs?.content?.length ?? 0).toBeGreaterThan(500);
    expect(postArgs?.content).toContain("Here is the full analysis");
    expect(postArgs?.content).toContain("Conclusion.");
    expect(postArgs?.content?.startsWith("claude:")).toBe(false);
    relay.dispose();
  });

  it("splits very long final_reply content across multiple webhook posts under the Discord 2000-char limit", async () => {
    const deliveryContext = {
      channel: "discord",
      to: "channel:parent-channel",
      accountId: "default",
      threadId: "thread-split",
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-split",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:claude:acp:split",
      agentId: "claude",
      deliveryContext,
      streamFlushMs: 5_000,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    // ~300-char paragraph; 8 paragraphs + intro + final = ~2700 chars, well
    // under STREAM_BUFFER_MAX_CHARS (4000) and well over the 1900-char chunk
    // budget, so we expect 2 output chunks. Pieces carry paragraph breaks as
    // leading/trailing "\n" baked into each content delta — whitespace-only
    // deltas are dropped by the relay's early-exit, so "\n\n" must
    // accumulate across consecutive non-empty deltas.
    const paragraph = "Lorem ipsum ".repeat(25); // ~300 chars
    const pieces = [
      "Intro paragraph.\n",
      `\n${paragraph}\n`,
      `\n${paragraph}\n`,
      `\n${paragraph}\n`,
      `\n${paragraph}\n`,
      `\n${paragraph}\n`,
      `\n${paragraph}\n`,
      `\n${paragraph}\n`,
      `\n${paragraph}\n`,
      "\nFinal paragraph.",
    ];
    for (const piece of pieces) {
      emitAgentEvent({
        runId: "run-split",
        stream: "assistant",
        data: { delta: piece },
      });
    }
    emitAgentEvent({
      runId: "run-split",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    // Flush microtasks so the sequential awaits inside directPostFinalReply's
    // async dispatcher complete before we assert on the mock's call count.
    vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Multiple sequential sendMessage posts, each under the hard Discord limit.
    expect(sendMessageMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMessageMock.mock.calls) {
      const args = call[0] as { content?: string; threadId?: string | number };
      expect(args.threadId).toBe("thread-split");
      expect(args.content?.length ?? 0).toBeLessThanOrEqual(2_000);
    }
    // Concatenated chunks should include both the intro and final paragraphs.
    const combined = sendMessageMock.mock.calls
      .map((c) => (c[0] as { content?: string } | undefined)?.content ?? "")
      .join("\n");
    expect(combined).toContain("Intro paragraph.");
    expect(combined).toContain("Final paragraph.");
    relay.dispose();
  });

  it("keeps progress-class flushes snippet-formatted with the relay-label prefix", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-progress",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:progress",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    // Phase-less delta under STREAM_SNIPPET_MAX_CHARS (220) with a trailing
    // "\n\n" paragraph-boundary trigger. Size-based deferral does not apply
    // (sizeTriggered=false), so the boundary-triggered flush still ships as
    // progress for phase-less streams — mirroring the real-world case where
    // a mid-stream paragraph completes and we surface a snippet summary.
    const shortProgress = `${"A".repeat(180)}\n\n`;
    emitAgentEvent({
      runId: "run-progress",
      stream: "assistant",
      data: { delta: shortProgress },
    });
    vi.advanceTimersByTime(15);

    const progressEmissions = enqueueSystemEventMock.mock.calls.filter(
      (call) => (call[1] as { messageClass?: string } | undefined)?.messageClass === "progress",
    );
    expect(progressEmissions.length).toBeGreaterThan(0);
    const body = String(progressEmissions[0][0]);
    // progress stays prefixed AND bounded by the snippet length (label + up
    // to 220 chars) so parent session-queue summaries stay compact.
    expect(body.startsWith("codex: ")).toBe(true);
    expect(body.length).toBeLessThanOrEqual("codex: ".length + 220);
    relay.dispose();
  });

  it("preserves newlines in final_reply bodies (does not squash paragraph breaks)", () => {
    const deliveryContext = {
      channel: "discord",
      to: "channel:parent-channel",
      accountId: "default",
      threadId: "thread-fmt",
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-fmt",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:claude:acp:fmt",
      agentId: "claude",
      deliveryContext,
      streamFlushMs: 5_000,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    // Stream the reply so no single delta contains "\n\n" (which would
    // trigger the phase-less boundary-flush-as-progress path) AND each delta
    // has some non-whitespace content (deltas that trim to "" are dropped by
    // the relay early-exit). The buffered text accumulates, and lifecycle-end
    // promotes it to final_reply with paragraph breaks intact.
    for (const piece of ["First line.\n", "\nSecond line.\n", "\nThird line."]) {
      emitAgentEvent({
        runId: "run-fmt",
        stream: "assistant",
        data: { delta: piece },
      });
    }
    emitAgentEvent({
      runId: "run-fmt",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(sendMessageMock).toHaveBeenCalled();
    const postArgs = sendMessageMock.mock.calls.at(-1)?.[0] as { content?: string } | undefined;
    // Paragraph breaks survive — compactWhitespace would have collapsed these
    // into single spaces, which is unusable for Discord rendering.
    expect(postArgs?.content).toContain("First line.\n\nSecond line.");
    expect(postArgs?.content).toContain("Third line.");
    relay.dispose();
  });
});
