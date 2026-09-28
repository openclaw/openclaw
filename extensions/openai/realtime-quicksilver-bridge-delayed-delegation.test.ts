import { describe, expect, it, vi } from "vitest";
import { createHarness, sentEvents } from "./realtime-quicksilver-bridge.test-support.js";

describe("public GPT-Live delayed bridge delegation", () => {
  it("waits for public transcript input and ignores duplicate notices after tool completion", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    const delegate = (id: string) =>
      harness.socket.serverEvent({
        type: "session.delegation.created",
        offset_ms: 100,
        delegation: { type: "delegation", target: "client", id },
      });
    const transcript = (delta: string) =>
      harness.socket.serverEvent({
        type: "session.input_transcript.delta",
        delta,
        start_ms: 0,
        end_ms: 100,
      });
    delegate("early");
    delegate("early");
    expect(
      sentEvents(harness.socket).filter((event) => event.type === "session.commentary.append"),
    ).toEqual([]);
    transcript("Find a train.");
    expect(harness.onToolCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        callId: "early",
        args: { question: expect.stringContaining("Find a train.") },
      }),
    );
    harness.bridge.submitToolResult("early", "Done.");
    transcript("Check a flight.");
    delegate("early");
    expect(harness.onToolCall).toHaveBeenCalledOnce();
    delegate("next");
    expect(harness.onToolCall).toHaveBeenCalledTimes(2);
    expect(harness.onToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        callId: "next",
        args: { question: expect.stringContaining("Check a flight.") },
      }),
    );
    const closing = harness.bridge.close();
    harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
    await closing;
  });

  it("rechecks delayed delegation authority after an event observer closes the call", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    harness.onEvent.mockImplementation((event) => {
      if (event.type === "session.delegation.created") {
        void harness.bridge.close();
      }
    });
    harness.socket.serverEvent({
      type: "session.delegation.created",
      offset_ms: 0,
      delegation: { type: "delegation", target: "client", id: "pending" },
    });
    harness.socket.serverEvent({
      type: "session.input_transcript.delta",
      delta: "Check a flight.",
      start_ms: 0,
      end_ms: 100,
    });
    expect(harness.onToolCall).not.toHaveBeenCalled();
    harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
    await harness.bridge.close();
  });

  it.each(["local-close", "remote-close", "error"] as const)(
    "revokes delayed public delegation on %s before late captions or timeout",
    async (boundary) => {
      const harness = createHarness({ model: "gpt-live-1" });
      await harness.bridge.connect();
      vi.useFakeTimers();
      try {
        harness.socket.serverEvent({
          type: "session.delegation.created",
          offset_ms: 0,
          delegation: { type: "delegation", target: "client", id: "pending" },
        });
        const closing = boundary === "local-close" ? harness.bridge.close() : undefined;
        if (boundary === "remote-close") {
          harness.socket.serverEvent({ type: "session.closed", reason: "remote_hangup" });
        }
        if (boundary === "error") {
          harness.socket.emit("error", new Error("disconnected"));
        }
        harness.socket.serverEvent({
          type: "session.input_transcript.delta",
          delta: "Late request.",
          start_ms: 0,
          end_ms: 100,
        });
        if (boundary === "local-close") {
          harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
        }
        await closing;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.onToolCall).not.toHaveBeenCalled();
        expect(
          sentEvents(harness.socket).filter((event) => event.type === "session.commentary.append"),
        ).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
