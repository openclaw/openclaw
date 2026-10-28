import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("QA channel reset processing boundary", () => {
  it.each(["default", "other"])(
    "retains a pending %s turn through its final edit",
    async (accountId) => {
      const state = createQaBusState();
      const transport = createQaChannelTransport(state);
      state.addInboundMessage({
        accountId,
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text: "Recall my preference.",
      });
      const inboundCursor = state.getSnapshot().cursor;
      const preview = state.addOutboundMessage({ accountId, to: "dm:alice", text: "You" });
      // Fetch progress and another account's completion cannot release this turn.
      state.resolvePollCursor({ accountId, cursor: state.getSnapshot().cursor });
      state.resolvePollCursor({
        accountId: "unrelated",
        acknowledgedCursor: state.getSnapshot().cursor,
      });
      const reset = transport.reset();
      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(state.getSnapshot().messages.map(({ text }) => text)).toEqual([
          "Recall my preference.",
          "You",
        ]);
        state.editMessage({
          accountId,
          messageId: preview.id,
          text: "lemon pepper wings with blue cheese",
        });
      } finally {
        state.resolvePollCursor({ accountId, acknowledgedCursor: inboundCursor });
        await vi.runAllTimersAsync();
        await reset;
      }
      expect(state.getSnapshot().messages).toEqual([]);
      expect(state.getSnapshot().cursor).toBeGreaterThanOrEqual(inboundCursor);
    },
  );

  it("leaves unsettled messages intact when completion times out", async () => {
    const state = createQaBusState();
    state.addInboundMessage({
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "Still running.",
    });
    const before = state.getSnapshot();
    const reset = createQaChannelTransport(state).reset();
    const outcome = reset.then(
      () => "cleared",
      (error: unknown) => String(error),
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toBe("Error: timed out after 15000ms");
    expect(state.getSnapshot()).toEqual(before);
  });
});
