import { describe, expect, it, vi } from "vitest";
import { handleAutoCompactionEnd, handleAutoCompactionStart } from "./pi-embedded-subscribe.handlers.compaction.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => undefined),
}));

function createContext(overrides?: {
  onAgentEvent?: (event: unknown) => void;
  compactionCount?: number;
}): EmbeddedPiSubscribeContext {
  return {
    params: {
      runId: "run-1",
      config: {},
      sessionKey: "agent:main:main",
      onAgentEvent: overrides?.onAgentEvent,
      session: {
        messages: [
          { role: "assistant", usage: { totalTokens: 123 } },
          { role: "user" },
        ],
        sessionFile: "/tmp/session.jsonl",
      },
    },
    state: {
      compactionInFlight: false,
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    incrementCompactionCount: vi.fn(),
    getCompactionCount: vi.fn(() => overrides?.compactionCount ?? 0),
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("compaction event observability", () => {
  it("emits reason-aware start events and structured start logs", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext({ onAgentEvent, compactionCount: 2 });

    handleAutoCompactionStart(ctx, {
      type: "auto_compaction_start",
      reason: "overflow",
    } as never);

    expect(ctx.state.compactionInFlight).toBe(true);
    expect(ctx.ensureCompactionPromise).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "embedded run compaction start",
      expect.objectContaining({
        event: "embedded_run_compaction_start",
        reason: "overflow",
        sessionKey: "agent:main:main",
        messageCount: 2,
        consoleMessage:
          "embedded run compaction start: runId=run-1 reason=overflow sessionKey=agent:main:main",
      }),
    );
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: { phase: "start", reason: "overflow" },
    });
  });

  it("logs retry compaction failures with sanitized error text and emits end payloads", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext({ onAgentEvent });

    handleAutoCompactionEnd(ctx, {
      type: "auto_compaction_end",
      willRetry: true,
      aborted: false,
      errorMessage:
        "x-api-key: sk-abcdefghijklmnopqrstuvwxyz123456\tToo many tokens per day\nrequest id=req_1234567890",
    } as never);

    expect(ctx.state.compactionInFlight).toBe(false);
    expect(ctx.noteCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.resetForCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.maybeResolveCompactionWait).not.toHaveBeenCalled();
    expect(ctx.incrementCompactionCount).not.toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "embedded run compaction retry",
      expect.objectContaining({
        event: "embedded_run_compaction_retry",
        completed: false,
        hasResult: false,
        wasAborted: false,
        errorMessage: expect.stringContaining(
          "x-api-key: *** Too many tokens per day request id=sha256:",
        ),
      }),
    );
    const warnMeta = vi.mocked(ctx.log.warn).mock.calls[0]?.[1];
    expect(warnMeta?.consoleMessage).toContain(
      "embedded run compaction retry: runId=run-1 sessionKey=agent:main:main completed=false hasResult=false aborted=false error=x-api-key: *** Too many tokens per day request id=sha256:",
    );
    expect(warnMeta?.consoleMessage).not.toContain("\n");
    expect(warnMeta?.consoleMessage).not.toContain("\t");
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: expect.objectContaining({
        phase: "end",
        willRetry: true,
        completed: false,
        errorMessage: expect.stringContaining(
          "x-api-key: *** Too many tokens per day request id=sha256:",
        ),
      }),
    });
  });

  it("logs successful compaction completion with completion metadata", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext({ onAgentEvent, compactionCount: 3 });

    handleAutoCompactionEnd(ctx, {
      type: "auto_compaction_end",
      willRetry: false,
      aborted: false,
      result: { ok: true },
    } as never);

    expect(ctx.state.compactionInFlight).toBe(false);
    expect(ctx.incrementCompactionCount).toHaveBeenCalledTimes(1);
    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "embedded run compaction end",
      expect.objectContaining({
        event: "embedded_run_compaction_end",
        completed: true,
        hasResult: true,
        wasAborted: false,
        compactionCount: 3,
        messageCount: 2,
      }),
    );
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: {
        phase: "end",
        willRetry: false,
        completed: true,
        errorMessage: undefined,
      },
    });
  });
});
