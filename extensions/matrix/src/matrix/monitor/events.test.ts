import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixAuth } from "../client.js";
import { registerMatrixMonitorEvents } from "./events.js";
import type { MatrixRawEvent } from "./types.js";

const sendReadReceiptMatrixMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../send.js", () => ({
  sendReadReceiptMatrix: (...args: unknown[]) => sendReadReceiptMatrixMock(...args),
}));

describe("registerMatrixMonitorEvents", () => {
  beforeEach(() => {
    sendReadReceiptMatrixMock.mockClear();
  });

  function createHarness() {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const client = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      crypto: undefined,
    } as unknown as MatrixClient;

    const onRoomMessage = vi.fn();
    const logVerboseMessage = vi.fn();
    const logger = {
      warn: vi.fn(),
    } as unknown as RuntimeLogger;

    registerMatrixMonitorEvents({
      client,
      auth: { encryption: false } as MatrixAuth,
      logVerboseMessage,
      warnedEncryptedRooms: new Set<string>(),
      warnedCryptoMissingRooms: new Set<string>(),
      logger,
      formatNativeDependencyHint: (() =>
        "") as PluginRuntime["system"]["formatNativeDependencyHint"],
      onRoomMessage,
    });

    const roomMessageHandler = handlers.get("room.message");
    if (!roomMessageHandler) {
      throw new Error("missing room.message handler");
    }

    return { client, onRoomMessage, roomMessageHandler };
  }

  it("sends read receipt immediately for non-self messages", async () => {
    const { client, onRoomMessage, roomMessageHandler } = createHarness();
    const event = {
      event_id: "$e1",
      sender: "@alice:example.org",
    } as MatrixRawEvent;

    roomMessageHandler("!room:example.org", event);

    expect(onRoomMessage).toHaveBeenCalledWith("!room:example.org", event);
    await vi.waitFor(() => {
      expect(sendReadReceiptMatrixMock).toHaveBeenCalledWith("!room:example.org", "$e1", client);
    });
  });

  it("does not send read receipts for self messages", async () => {
    const { onRoomMessage, roomMessageHandler } = createHarness();
    const event = {
      event_id: "$e2",
      sender: "@bot:example.org",
    } as MatrixRawEvent;

    roomMessageHandler("!room:example.org", event);
    await vi.waitFor(() => {
      expect(onRoomMessage).toHaveBeenCalledWith("!room:example.org", event);
    });
    expect(sendReadReceiptMatrixMock).not.toHaveBeenCalled();
  });

  it("skips receipt when message lacks sender or event id", async () => {
    const { onRoomMessage, roomMessageHandler } = createHarness();
    const event = {
      sender: "@alice:example.org",
    } as MatrixRawEvent;

    roomMessageHandler("!room:example.org", event);
    await vi.waitFor(() => {
      expect(onRoomMessage).toHaveBeenCalledWith("!room:example.org", event);
    });
    expect(sendReadReceiptMatrixMock).not.toHaveBeenCalled();
  });
});
