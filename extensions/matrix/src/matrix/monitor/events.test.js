import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixMonitorEvents } from "./events.js";
const sendReadReceiptMatrixMock = vi.hoisted(() => vi.fn().mockResolvedValue(void 0));
vi.mock("../send.js", () => ({
  sendReadReceiptMatrix: (...args) => sendReadReceiptMatrixMock(...args)
}));
describe("registerMatrixMonitorEvents", () => {
  const roomId = "!room:example.org";
  function makeEvent(overrides) {
    return {
      event_id: "$event",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 0,
      content: {},
      ...overrides
    };
  }
  beforeEach(() => {
    sendReadReceiptMatrixMock.mockClear();
  });
  function createHarness(options) {
    const handlers = /* @__PURE__ */ new Map();
    const getUserId = options?.getUserId ?? vi.fn().mockResolvedValue("@bot:example.org");
    const client = {
      on: vi.fn((event, handler) => {
        handlers.set(event, handler);
      }),
      getUserId,
      crypto: void 0
    };
    const onRoomMessage = vi.fn();
    const logVerboseMessage = vi.fn();
    const logger = {
      warn: vi.fn()
    };
    registerMatrixMonitorEvents({
      client,
      auth: { encryption: false },
      logVerboseMessage,
      warnedEncryptedRooms: /* @__PURE__ */ new Set(),
      warnedCryptoMissingRooms: /* @__PURE__ */ new Set(),
      logger,
      formatNativeDependencyHint: (() => ""),
      onRoomMessage
    });
    const roomMessageHandler = handlers.get("room.message");
    if (!roomMessageHandler) {
      throw new Error("missing room.message handler");
    }
    return { client, getUserId, onRoomMessage, roomMessageHandler, logVerboseMessage };
  }
  async function expectForwardedWithoutReadReceipt(event) {
    const { onRoomMessage, roomMessageHandler } = createHarness();
    roomMessageHandler(roomId, event);
    await vi.waitFor(() => {
      expect(onRoomMessage).toHaveBeenCalledWith(roomId, event);
    });
    expect(sendReadReceiptMatrixMock).not.toHaveBeenCalled();
  }
  it("sends read receipt immediately for non-self messages", async () => {
    const { client, onRoomMessage, roomMessageHandler } = createHarness();
    const event = makeEvent({
      event_id: "$e1",
      sender: "@alice:example.org"
    });
    roomMessageHandler("!room:example.org", event);
    expect(onRoomMessage).toHaveBeenCalledWith("!room:example.org", event);
    await vi.waitFor(() => {
      expect(sendReadReceiptMatrixMock).toHaveBeenCalledWith("!room:example.org", "$e1", client);
    });
  });
  it("does not send read receipts for self messages", async () => {
    await expectForwardedWithoutReadReceipt(
      makeEvent({
        event_id: "$e2",
        sender: "@bot:example.org"
      })
    );
  });
  it("skips receipt when message lacks sender or event id", async () => {
    await expectForwardedWithoutReadReceipt(
      makeEvent({
        sender: "@alice:example.org",
        event_id: ""
      })
    );
  });
  it("caches self user id across messages", async () => {
    const { getUserId, roomMessageHandler } = createHarness();
    const first = makeEvent({ event_id: "$e3", sender: "@alice:example.org" });
    const second = makeEvent({ event_id: "$e4", sender: "@bob:example.org" });
    roomMessageHandler("!room:example.org", first);
    roomMessageHandler("!room:example.org", second);
    await vi.waitFor(() => {
      expect(sendReadReceiptMatrixMock).toHaveBeenCalledTimes(2);
    });
    expect(getUserId).toHaveBeenCalledTimes(1);
  });
  it("logs and continues when sending read receipt fails", async () => {
    sendReadReceiptMatrixMock.mockRejectedValueOnce(new Error("network boom"));
    const { roomMessageHandler, onRoomMessage, logVerboseMessage } = createHarness();
    const event = makeEvent({ event_id: "$e5", sender: "@alice:example.org" });
    roomMessageHandler("!room:example.org", event);
    await vi.waitFor(() => {
      expect(onRoomMessage).toHaveBeenCalledWith("!room:example.org", event);
      expect(logVerboseMessage).toHaveBeenCalledWith(
        expect.stringContaining("matrix: early read receipt failed")
      );
    });
  });
  it("skips read receipts if self-user lookup fails", async () => {
    const { roomMessageHandler, onRoomMessage, getUserId } = createHarness({
      getUserId: vi.fn().mockRejectedValue(new Error("cannot resolve self"))
    });
    const event = makeEvent({ event_id: "$e6", sender: "@alice:example.org" });
    roomMessageHandler("!room:example.org", event);
    await vi.waitFor(() => {
      expect(onRoomMessage).toHaveBeenCalledWith("!room:example.org", event);
    });
    expect(getUserId).toHaveBeenCalledTimes(1);
    expect(sendReadReceiptMatrixMock).not.toHaveBeenCalled();
  });
  it("skips duplicate listener registration for the same client", () => {
    const handlers = /* @__PURE__ */ new Map();
    const onMock = vi.fn((event, handler) => {
      handlers.set(event, handler);
    });
    const client = {
      on: onMock,
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      crypto: void 0
    };
    const params = {
      client,
      auth: { encryption: false },
      logVerboseMessage: vi.fn(),
      warnedEncryptedRooms: /* @__PURE__ */ new Set(),
      warnedCryptoMissingRooms: /* @__PURE__ */ new Set(),
      logger: { warn: vi.fn() },
      formatNativeDependencyHint: (() => ""),
      onRoomMessage: vi.fn()
    };
    registerMatrixMonitorEvents(params);
    const initialCallCount = onMock.mock.calls.length;
    registerMatrixMonitorEvents(params);
    expect(onMock).toHaveBeenCalledTimes(initialCallCount);
    expect(params.logVerboseMessage).toHaveBeenCalledWith(
      "matrix: skipping duplicate listener registration for client"
    );
  });
});
