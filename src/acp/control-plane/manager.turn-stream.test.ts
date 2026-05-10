import { describe, expect, it } from "vitest";
import type { AcpRuntime, AcpRuntimeEvent, AcpRuntimeHandle } from "../runtime/types.js";
import { consumeAcpTurnStream } from "./manager.turn-stream.js";

function mockRuntime(events: AcpRuntimeEvent[]): AcpRuntime {
  return {
    async ensureSession() {
      return { sessionKey: "s1", backend: "acpx", runtimeSessionName: "runtime:s1" };
    },
    async *runTurn() {
      for (const event of events) {
        yield event;
      }
    },
    async cancel() {},
    async close() {},
  } as unknown as AcpRuntime;
}

const turn = {
  handle: {} as AcpRuntimeHandle,
  text: "test",
  mode: "prompt" as const,
  requestId: "req-test",
};

describe("consumeAcpTurnStream", () => {
  it("delivers all events when gate stays open", async () => {
    const received: AcpRuntimeEvent[] = [];
    const runtime = mockRuntime([
      { type: "text_delta", text: "hello", stream: "reply" },
      { type: "done" },
    ]);
    await consumeAcpTurnStream({
      runtime,
      turn,
      eventGate: { open: true },
      onEvent: (e) => void received.push(e),
    });
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ type: "text_delta" });
    expect(received[1]).toMatchObject({ type: "done" });
  });

  it("delivers non-output events to onEvent after gate closes", async () => {
    const received: AcpRuntimeEvent[] = [];
    const outputReceived: AcpRuntimeEvent[] = [];
    const gate = { open: true };
    const runtime = mockRuntime([
      { type: "text_delta", text: "before", stream: "reply" },
      { type: "done" },
    ]);
    // Close gate before stream starts
    gate.open = false;
    await consumeAcpTurnStream({
      runtime,
      turn,
      eventGate: gate,
      onEvent: (e) => void received.push(e),
      onOutputEvent: (e) => void outputReceived.push(e),
    });
    // onEvent receives events even after gate closes
    expect(received).toHaveLength(2);
    // onOutputEvent is skipped when gate is closed
    expect(outputReceived).toHaveLength(0);
  });

  it("surfaces error events arriving after gate closes", async () => {
    const gate = { open: true };
    const runtime = mockRuntime([
      { type: "error", code: "ACP_TURN_FAILED", message: "runtime error after timeout" },
    ]);
    gate.open = false;
    await expect(consumeAcpTurnStream({ runtime, turn, eventGate: gate })).rejects.toMatchObject({
      message: "runtime error after timeout",
    });
  });

  it("surfaces error events arriving before gate closes", async () => {
    const runtime = mockRuntime([
      { type: "error", code: "ACP_TURN_FAILED", message: "turn error" },
    ]);
    await expect(
      consumeAcpTurnStream({ runtime, turn, eventGate: { open: true } }),
    ).rejects.toMatchObject({ message: "turn error" });
  });

  it("returns sawTerminalEvent=true when done event arrives while gate is open", async () => {
    const runtime = mockRuntime([{ type: "done" }]);
    const outcome = await consumeAcpTurnStream({
      runtime,
      turn,
      eventGate: { open: true },
    });
    expect(outcome.sawTerminalEvent).toBe(true);
  });
});
