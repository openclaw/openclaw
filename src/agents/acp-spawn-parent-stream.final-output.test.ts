import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
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

let emitAgentEvent: typeof import("../infra/agent-events.js").emitAgentEvent;
let startAcpSpawnParentStreamRelay: typeof import("./acp-spawn-parent-stream.js").startAcpSpawnParentStreamRelay;

function collectedTexts(): string[] {
  return enqueueSystemEventMock.mock.calls.map((call) => String(call[0] ?? ""));
}

function findText(predicate: (text: string) => boolean): string | undefined {
  return collectedTexts().find(predicate);
}

describe("startAcpSpawnParentStreamRelay final-answer formatting", () => {
  beforeAll(async () => {
    ({ emitAgentEvent } = await import("../infra/agent-events.js"));
    ({ startAcpSpawnParentStreamRelay } = await import("./acp-spawn-parent-stream.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Reproduces the parent-visible bug where Codex-style multi-line k/v output
  // arriving as separate deltas was collapsed into one line by compactWhitespace
  // and then truncated, e.g. `cwd: /home/ubuntu/clawdpackage_version: missing...`.
  it("preserves newlines across multi-delta key/value output in the final emit", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-final-kv",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:final-kv",
      agentId: "codex",
      streamFlushMs: 1_000,
      noOutputNoticeMs: 120_000,
    });

    // Each delta as a separate line, mirroring how Codex tends to stream lines.
    emitAgentEvent({
      runId: "run-final-kv",
      stream: "assistant",
      data: { delta: "cwd: /home/ubuntu/clawd\n" },
    });
    emitAgentEvent({
      runId: "run-final-kv",
      stream: "assistant",
      data: { delta: "package_version: missing\n" },
    });
    emitAgentEvent({
      runId: "run-final-kv",
      stream: "assistant",
      data: { delta: "node: v22.5.1\n" },
    });

    emitAgentEvent({
      runId: "run-final-kv",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 0, endedAt: 1_000 },
    });

    const finalEmit = findText((text) => text.startsWith("codex final:"));
    expect(
      finalEmit,
      `expected a 'codex final:' emit, got ${JSON.stringify(collectedTexts())}`,
    ).toBeDefined();
    // Must NOT collapse adjacent lines into one.
    expect(finalEmit).not.toContain("clawdpackage_version");
    // Each k/v line must survive on its own line.
    expect(finalEmit).toContain("cwd: /home/ubuntu/clawd");
    expect(finalEmit).toContain("package_version: missing");
    expect(finalEmit).toContain("node: v22.5.1");
    // The structure is multi-line.
    expect(finalEmit?.split("\n").length).toBeGreaterThanOrEqual(4);

    expect(findText((text) => text.includes("run completed in 1s"))).toBeDefined();
    relay.dispose();
  });

  it("does not double up final emit when commentary precedes final_answer", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-cmt-then-final",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:cmt-then-final",
      agentId: "codex",
      streamFlushMs: 5,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-cmt-then-final",
      stream: "assistant",
      data: { delta: "thinking about the request...", phase: "commentary" },
    });
    emitAgentEvent({
      runId: "run-cmt-then-final",
      stream: "assistant",
      data: { delta: "Result: 42\n", phase: "final_answer" },
    });
    vi.advanceTimersByTime(20);
    emitAgentEvent({
      runId: "run-cmt-then-final",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    const finalEmit = findText((text) => text.startsWith("codex final:"));
    expect(finalEmit).toBeDefined();
    expect(finalEmit).toContain("Result: 42");
    // Commentary must not appear in the final.
    expect(finalEmit).not.toContain("thinking about the request");
    relay.dispose();
  });

  it("hard-caps the final emit and adds a marker when output is huge", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-huge",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:huge",
      agentId: "codex",
      streamFlushMs: 10_000,
      noOutputNoticeMs: 120_000,
    });

    // 8000 chars of valid lines — exceeds the 6000-char cap.
    const lines: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      lines.push(`line ${i}: ${"x".repeat(30)}`);
    }
    emitAgentEvent({
      runId: "run-huge",
      stream: "assistant",
      data: { delta: `${lines.join("\n")}\n` },
    });
    emitAgentEvent({
      runId: "run-huge",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    const finalEmit = findText((text) => text.startsWith("codex final:"));
    expect(finalEmit).toBeDefined();
    // Final emit body (after the "codex final:\n" prefix) must not exceed
    // the configured cap by more than the trailing "…" marker line.
    const body = finalEmit!.replace(/^codex final:\n/, "");
    expect(body.length).toBeLessThanOrEqual(6_000 + 4);
    expect(body.endsWith("…")).toBe(true);
    relay.dispose();
  });

  it("surfaces partial child output before an error so the parent isn't left blind", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-err-partial",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:err-partial",
      agentId: "codex",
      streamFlushMs: 10_000,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-err-partial",
      stream: "assistant",
      data: { delta: "step 1: ok\nstep 2: ok\n" },
    });
    emitAgentEvent({
      runId: "run-err-partial",
      stream: "lifecycle",
      data: { phase: "error", error: "sandbox blocked write" },
    });

    const partialEmit = findText((text) => text.startsWith("codex partial output before failure:"));
    expect(partialEmit).toBeDefined();
    expect(partialEmit).toContain("step 1: ok");
    expect(partialEmit).toContain("step 2: ok");
    expect(findText((text) => text.includes("run failed: sandbox blocked write"))).toBeDefined();
    relay.dispose();
  });

  it("emits no final block when the child produced nothing before completion", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-empty",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:empty",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-empty",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(findText((text) => text.startsWith("codex final:"))).toBeUndefined();
    expect(findText((text) => text.includes("run completed"))).toBeDefined();
    relay.dispose();
  });
});
