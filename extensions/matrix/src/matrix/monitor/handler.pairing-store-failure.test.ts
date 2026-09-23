// Matrix tests cover DM pairing when the pairing store cannot be read.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

beforeEach(() => {
  installMatrixMonitorTestRuntime();
});

describe("matrix monitor handler pairing store failure", () => {
  it("fails closed instead of prompting to pair when the pairing store read fails", async () => {
    const readAllowFromStore = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    const upsertPairingRequest = vi.fn(async () => ({ code: "ABCDEFGH", created: false }));
    const logVerboseMessage = vi.fn();

    const { handler } = createMatrixHandlerTestHarness({
      readAllowFromStore,
      upsertPairingRequest,
      logVerboseMessage,
      dmPolicy: "pairing",
      isDirectMessage: true,
      getMemberDisplayName: async () => "sender",
      dropPreStartupMessages: true,
      needsRoomAliasesForConfig: false,
      dispatchInboundMessage: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event1",
        body: "hello",
        mentions: { room: true },
      }),
    );

    // A read failure must not be indistinguishable from a legitimately empty
    // store: it must not trigger a pairing challenge to an already-paired sender...
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    // ...and it must still end in a visible, logged outcome rather than a silent drop.
    expect(logVerboseMessage).toHaveBeenCalledWith(
      expect.stringContaining("matrix: blocked dm sender @user:example.org"),
    );
  });
});
