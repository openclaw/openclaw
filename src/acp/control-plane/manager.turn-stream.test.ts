import { describe, it, expect, vi } from "vitest";
import type { AcpRuntime, AcpRuntimeEvent } from "../../acp/runtime/types.js";
import { consumeAcpTurnStream, type AcpTurnEventGate } from "./manager.turn-stream.js";

function createMockRuntime(params: {
  events?: AcpRuntimeEvent[];
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
        for (const event of params.events) {
          yield event;
        }
      }
    },
    cancel: vi.fn(),
    close: vi.fn(),
  } as unknown as AcpRuntime;
}

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

  it("times out when stream hangs without completing", async () => {
    // Create a runtime that never yields any events (simulates hung child process)
    const runtime = createMockRuntime({
      events: [],
      delayMs: 60_000, // would delay forever
    });
    const eventGate: AcpTurnEventGate = { open: true };

    const start = Date.now();
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
    ).rejects.toThrow("timed out");
    const elapsed = Date.now() - start;
    // Should timeout within the 30s window, not 60s
    expect(elapsed).toBeLessThan(35_000);
    expect(elapsed).toBeGreaterThan(28_000);
  });
});
