import { describe, expect, it, vi } from "vitest";
import { createHarness, sentEvents } from "./realtime-quicksilver-bridge.test-support.js";
import {
  delegation,
  publicDelegation,
  transcript,
  turn,
} from "./realtime-quicksilver-events.test-support.js";
const noCommentary = ({ socket }: ReturnType<typeof createHarness>) =>
  expect(sentEvents(socket).filter((event) => event.type === "session.commentary.append")).toEqual(
    [],
  );

describe("GPT-Live bridge delegation admission", () => {
  it("claims subscription tasks and controls before callbacks without consuming fresh context", async () => {
    const classify = vi.fn(() => "consult" as const);
    const harness = createHarness({ model: "gpt-live-1-codex", handleDelegationInput: classify });
    const delegate = (id: string) => harness.socket.serverEvent(delegation(id));
    await harness.bridge.connect();
    try {
      harness.onToolCall.mockImplementationOnce(() => delegate("first"));
      delegate("first");
      expect(harness.onToolCall).toHaveBeenCalledOnce();
      harness.bridge.submitToolResult("first", "Done.");
      harness.socket.serverEvent(turn("user", "Fresh context."));
      delegate("first");
      expect(classify).toHaveBeenCalledOnce();
      delegate("second");
      expect(harness.onToolCall).toHaveBeenCalledTimes(2);
      expect(harness.onTranscript).toHaveBeenCalledWith("user", "Fresh context.", true);
      harness.bridge.submitToolResult("second", "Done.");
      expect(harness.onError).not.toHaveBeenCalled();
    } finally {
      await harness.bridge.close();
    }
    delegate("third");
    expect(harness.onToolCall).toHaveBeenCalledTimes(2);

    // Provider IDs belong to a connection, never a process-global replay cache.
    const fresh = createHarness({ model: "gpt-live-1-codex" });
    await fresh.bridge.connect();
    try {
      fresh.socket.serverEvent(delegation("first"));
      expect(fresh.onToolCall).toHaveBeenCalledOnce();
    } finally {
      await fresh.bridge.close();
    }
  });

  it("does not reclassify a completed native control notice against later work", async () => {
    const classify = vi.fn(() => "control" as const);
    const harness = createHarness({ model: "gpt-live-1-codex", handleDelegationInput: classify });
    await harness.bridge.connect();
    const event = delegation("cancel-one", "Cancel it.");
    try {
      harness.socket.serverEvent(event);
      harness.socket.serverEvent(event);
      expect(classify).toHaveBeenCalledOnce();
      expect(harness.onToolCall).not.toHaveBeenCalled();
    } finally {
      await harness.bridge.close();
    }
  });

  it("waits for public transcript input and ignores duplicate notices after tool completion", async () => {
    const harness = createHarness({ model: "gpt-live-1" });
    await harness.bridge.connect();
    const delegate = (id: string) => harness.socket.serverEvent(publicDelegation(id, 100));
    delegate("early");
    delegate("early");
    noCommentary(harness);
    harness.socket.serverEvent(transcript("Find a train."));
    expect(harness.onToolCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        callId: "early",
        args: { question: expect.stringContaining("Find a train.") },
      }),
    );
    harness.bridge.submitToolResult("early", "Done.");
    harness.socket.serverEvent(transcript("Check a flight."));
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
    harness.socket.serverEvent(publicDelegation());
    harness.socket.serverEvent(transcript("Check a flight."));
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
        harness.socket.serverEvent(publicDelegation());
        const closing = boundary === "local-close" ? harness.bridge.close() : undefined;
        if (boundary === "remote-close") {
          harness.socket.serverEvent({ type: "session.closed", reason: "remote_hangup" });
        }
        if (boundary === "error") {
          harness.socket.emit("error", new Error("disconnected"));
        }
        harness.socket.serverEvent(transcript("Late request."));
        if (boundary === "local-close") {
          harness.socket.serverEvent({ type: "session.closed", reason: "close_requested" });
        }
        await closing;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.onToolCall).not.toHaveBeenCalled();
        noCommentary(harness);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
