import { afterEach, describe, it, expect, vi } from "vitest";
import type { AcpRuntime, AcpRuntimeEvent } from "../../acp/runtime/types.js";
import { consumeAcpTurnStream, type AcpTurnEventGate } from "./manager.turn-stream.js";

function createMockRuntime(params: {
  events?: AcpRuntimeEvent[];
  eventDelaysMs?: number[];
  throwOnRunTurn?: Error;
  delayMs?: number;
}): AcpRuntime {
  return {
    ensureSession: vi.fn(),
    async *runTurn() {
      if (params.delayMs) {
        await new Promise((r) => setTimeout(r, params.delayMs));
      }
      if (params.throwOnRunTurn) {
        throw params.throwOnRunTurn;
      }
      if (params.events) {
        for (const [index, event] of params.events.entries()) {
          const delayMs = params.eventDelaysMs?.[index] ?? 0;
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          yield event;
        }
      }
    },
    cancel: vi.fn(),
    close: vi.fn(),
  } as unknown as AcpRuntime;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("consumeAcpTurnStream", () => {
  it("returns sawTerminalEvent=true when done event is emitted", async () => {
    const runtime = createMockRuntime({
      events: [
        { type: "text_delta", text: "hello" },
        { type: "done", stopReason: "end_turn" },
      ],
    });
    const eventGate: AcpTurnEventGate = { open: true };

    const result = await consumeAcpTurnStream({
      runtime,
      turn: {
        handle: { sessionKey: "test", backend: "test", runtimeSessionName: "test" },
        text: "hi",
        mode: "prompt",
        requestId: "1",
      },
      eventGate,
    });

    expect(result.sawOutput).toBe(true);
    expect(result.sawTerminalEvent).toBe(true);
  });

  it("throws error when stream completes without terminal event (child exits prematurely)", async () => {
    const runtime = createMockRuntime({
      events: [{ type: "text_delta", text: "partial" }], // no done event
    });
    const eventGate: AcpTurnEventGate = { open: true };

    await expect(
      consumeAcpTurnStream({
        runtime,
        turn: {
          handle: { sessionKey: "test", backend: "test", runtimeSessionName: "test" },
          text: "hi",
          mode: "prompt",
          requestId: "1",
        },
        eventGate,
      }),
    ).rejects.toThrow("ACP turn ended without a terminal done event");
  });

  it("throws error when runtime.runTurn throws unexpectedly", async () => {
    const runtime = createMockRuntime({
      throwOnRunTurn: new Error("child process crashed"),
    });
    const eventGate: AcpTurnEventGate = { open: true };

    await expect(
      consumeAcpTurnStream({
        runtime,
        turn: {
          handle: { sessionKey: "test", backend: "test", runtimeSessionName: "test" },
          text: "hi",
          mode: "prompt",
          requestId: "1",
        },
        eventGate,
      }),
    ).rejects.toThrow("child process crashed");
  });

  it("re-throws ACP error event as structured error", async () => {
    const runtime = createMockRuntime({
      events: [{ type: "error", message: "auth failed", code: "AUTH_FAILED" }],
    });
    const eventGate: AcpTurnEventGate = { open: true };

    await expect(
      consumeAcpTurnStream({
        runtime,
        turn: {
          handle: { sessionKey: "test", backend: "test", runtimeSessionName: "test" },
          text: "hi",
          mode: "prompt",
          requestId: "1",
        },
        eventGate,
      }),
    ).rejects.toThrow("auth failed");
  });

  it("does not throw when eventGate is closed", async () => {
    const runtime = createMockRuntime({
      events: [{ type: "text_delta", text: "hello" }],
    });
    const eventGate: AcpTurnEventGate = { open: false };

    const result = await consumeAcpTurnStream({
      runtime,
      turn: {
        handle: { sessionKey: "test", backend: "test", runtimeSessionName: "test" },
        text: "hi",
        mode: "prompt",
        requestId: "1",
      },
      eventGate,
    });

    expect(result.sawOutput).toBe(false); // events skipped when gate closed
  });

  it("allows a valid stream to emit done after more than 30 seconds", async () => {
    vi.useFakeTimers();
    const runtime = createMockRuntime({
      events: [
        { type: "text_delta", text: "still working" },
        { type: "done", stopReason: "end_turn" },
      ],
      eventDelaysMs: [0, 31_000],
    });
    const eventGate: AcpTurnEventGate = { open: true };

    const resultPromise = consumeAcpTurnStream({
      runtime,
      turn: {
        handle: { sessionKey: "test", backend: "test", runtimeSessionName: "test" },
        text: "hi",
        mode: "prompt",
        requestId: "1",
      },
      eventGate,
    });

    await vi.advanceTimersByTimeAsync(31_000);

    await expect(resultPromise).resolves.toEqual({
      sawOutput: true,
      sawTerminalEvent: true,
    });
  });
});
