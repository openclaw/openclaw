import { describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import type { MatrixClient } from "../sdk.js";
import { registerMatrixMonitorEvents } from "./events.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

type RoomEventListener = (roomId: string, event: MatrixRawEvent) => void;
type FailedDecryptListener = (roomId: string, event: MatrixRawEvent, error: Error) => Promise<void>;

function getSentNoticeBody(sendMessage: ReturnType<typeof vi.fn>, index = 0): string {
  const calls = sendMessage.mock.calls as unknown[][];
  const payload = (calls[index]?.[1] ?? {}) as { body?: string };
  return payload.body ?? "";
}

function createHarness(params?: {
  cfg?: CoreConfig;
  accountId?: string;
  authEncryption?: boolean;
  cryptoAvailable?: boolean;
  selfUserId?: string;
  joinedMembersByRoom?: Record<string, string[]>;
  verifications?: Array<{
    id: string;
    transactionId?: string;
    otherUserId: string;
    updatedAt?: string;
    completed?: boolean;
    sas?: {
      decimal?: [number, number, number];
      emoji?: Array<[string, string]>;
    };
  }>;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const onRoomMessage = vi.fn(async () => {});
  const listVerifications = vi.fn(async () => params?.verifications ?? []);
  const sendMessage = vi.fn(async () => "$notice");
  const invalidateRoom = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const formatNativeDependencyHint = vi.fn(() => "install hint");
  const client = {
    on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      listeners.set(eventName, listener);
      return client;
    }),
    sendMessage,
    getUserId: vi.fn(async () => params?.selfUserId ?? "@bot:example.org"),
    getJoinedRoomMembers: vi.fn(
      async (roomId: string) =>
        params?.joinedMembersByRoom?.[roomId] ?? ["@bot:example.org", "@alice:example.org"],
    ),
    ...(params?.cryptoAvailable === false
      ? {}
      : {
          crypto: {
            listVerifications,
          },
        }),
  } as unknown as MatrixClient;

  registerMatrixMonitorEvents({
    cfg: params?.cfg ?? { channels: { matrix: {} } },
    client,
    auth: {
      accountId: params?.accountId ?? "default",
      encryption: params?.authEncryption ?? true,
    } as MatrixAuth,
    directTracker: {
      invalidateRoom,
    },
    logVerboseMessage: vi.fn(),
    warnedEncryptedRooms: new Set<string>(),
    warnedCryptoMissingRooms: new Set<string>(),
    logger,
    formatNativeDependencyHint,
    onRoomMessage,
  });

  const roomEventListener = listeners.get("room.event") as RoomEventListener | undefined;
  if (!roomEventListener) {
    throw new Error("room.event listener was not registered");
  }

  return {
    onRoomMessage,
    sendMessage,
    invalidateRoom,
    roomEventListener,
    listVerifications,
    logger,
    formatNativeDependencyHint,
    roomMessageListener: listeners.get("room.message") as RoomEventListener | undefined,
    failedDecryptListener: listeners.get("room.failed_decryption") as
      | FailedDecryptListener
      | undefined,
  };
}

describe("registerMatrixMonitorEvents verification routing", () => {
  it("forwards reaction room events into the shared room handler", async () => {
    const { onRoomMessage, sendMessage, roomEventListener } = createHarness();

    roomEventListener("!room:example.org", {
      event_id: "$reaction1",
      sender: "@alice:example.org",
      type: EventType.Reaction,
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: "$msg1",
          key: "👍",
        },
      },
    });

    await vi.waitFor(() => {
      expect(onRoomMessage).toHaveBeenCalledWith(
        "!room:example.org",
        expect.objectContaining({ event_id: "$reaction1", type: EventType.Reaction }),
      );
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("invalidates direct-room membership cache on room member events", async () => {
    const { invalidateRoom, roomEventListener } = createHarness();

    roomEventListener("!room:example.org", {
      event_id: "$member1",
      sender: "@alice:example.org",
      state_key: "@mallory:example.org",
      type: EventType.RoomMember,
      origin_server_ts: Date.now(),
      content: {
        membership: "join",
      },
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("posts verification request notices directly into the room", async () => {
    const { onRoomMessage, sendMessage, roomMessageListener } = createHarness();
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }
    roomMessageListener("!room:example.org", {
      event_id: "$req1",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.key.verification.request",
        body: "verification request",
      },
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(onRoomMessage).not.toHaveBeenCalled();
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification request received from @alice:example.org.");
    expect(body).toContain('Open "Verify by emoji"');
  });

  it("posts ready-stage guidance for emoji verification", async () => {
    const { sendMessage, roomEventListener } = createHarness();
    roomEventListener("!room:example.org", {
      event_id: "$ready-1",
      sender: "@alice:example.org",
      type: "m.key.verification.ready",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-ready-1" },
      },
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification is ready with @alice:example.org.");
    expect(body).toContain('Choose "Verify by emoji"');
  });

  it("posts SAS emoji/decimal details when verification summaries expose them", async () => {
    const { sendMessage, roomEventListener, listVerifications } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-1",
          transactionId: "$different-flow-id",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
          otherUserId: "@alice:example.org",
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
        },
      ],
    });

    roomEventListener("!dm:example.org", {
      event_id: "$start2",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req2" },
      },
    });

    await vi.waitFor(() => {
      const bodies = (sendMessage.mock.calls as unknown[][]).map((call) =>
        String((call[1] as { body?: string } | undefined)?.body ?? ""),
      );
      expect(bodies.some((body) => body.includes("SAS emoji:"))).toBe(true);
      expect(bodies.some((body) => body.includes("SAS decimal: 6158 1986 3513"))).toBe(true);
    });
  });

  it("ignores verification notices in unrelated non-DM rooms", async () => {
    const { sendMessage, roomEventListener } = createHarness({
      joinedMembersByRoom: {
        "!group:example.org": ["@alice:example.org", "@bot:example.org", "@ops:example.org"],
      },
      verifications: [
        {
          id: "verification-2",
          transactionId: "$different-flow-id",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
        },
      ],
    });

    roomEventListener("!group:example.org", {
      event_id: "$start-group",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-group" },
      },
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(0);
    });
  });

  it("does not emit duplicate SAS notices for the same verification payload", async () => {
    const { sendMessage, roomEventListener, listVerifications } = createHarness({
      verifications: [
        {
          id: "verification-3",
          transactionId: "$req3",
          otherUserId: "@alice:example.org",
          sas: {
            decimal: [1111, 2222, 3333],
            emoji: [
              ["🚀", "Rocket"],
              ["🦋", "Butterfly"],
              ["📕", "Book"],
            ],
          },
        },
      ],
    });

    roomEventListener("!room:example.org", {
      event_id: "$start3",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req3" },
      },
    });
    await vi.waitFor(() => {
      expect(sendMessage.mock.calls.length).toBeGreaterThan(0);
    });

    roomEventListener("!room:example.org", {
      event_id: "$key3",
      sender: "@alice:example.org",
      type: "m.key.verification.key",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req3" },
      },
    });
    await vi.waitFor(() => {
      expect(listVerifications).toHaveBeenCalledTimes(2);
    });

    const sasBodies = sendMessage.mock.calls
      .map((call) => String(((call as unknown[])[1] as { body?: string } | undefined)?.body ?? ""))
      .filter((body) => body.includes("SAS emoji:"));
    expect(sasBodies).toHaveLength(1);
  });

  it("warns once when encrypted events arrive without Matrix encryption enabled", () => {
    const { logger, roomEventListener } = createHarness({
      authEncryption: false,
    });

    roomEventListener("!room:example.org", {
      event_id: "$enc1",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });
    roomEventListener("!room:example.org", {
      event_id: "$enc2",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt",
      { roomId: "!room:example.org" },
    );
  });

  it("uses the active Matrix account path in encrypted-event warnings", () => {
    const { logger, roomEventListener } = createHarness({
      accountId: "ops",
      authEncryption: false,
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {},
            },
          },
        },
      },
    });

    roomEventListener("!room:example.org", {
      event_id: "$enc1",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encrypted event received without encryption enabled; set channels.matrix.accounts.ops.encryption=true and verify the device to decrypt",
      { roomId: "!room:example.org" },
    );
  });

  it("warns once when crypto bindings are unavailable for encrypted rooms", () => {
    const { formatNativeDependencyHint, logger, roomEventListener } = createHarness({
      authEncryption: true,
      cryptoAvailable: false,
    });

    roomEventListener("!room:example.org", {
      event_id: "$enc1",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });
    roomEventListener("!room:example.org", {
      event_id: "$enc2",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });

    expect(formatNativeDependencyHint).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encryption enabled but crypto is unavailable; install hint",
      { roomId: "!room:example.org" },
    );
  });

  it("adds self-device guidance when decrypt failures come from the same Matrix user", async () => {
    const { logger, failedDecryptListener } = createHarness({
      accountId: "ops",
      selfUserId: "@gumadeiras:matrix.example.org",
    });
    if (!failedDecryptListener) {
      throw new Error("room.failed_decryption listener was not registered");
    }

    await failedDecryptListener(
      "!room:example.org",
      {
        event_id: "$enc-self",
        sender: "@gumadeiras:matrix.example.org",
        type: EventType.RoomMessageEncrypted,
        origin_server_ts: Date.now(),
        content: {},
      },
      new Error("The sender's device has not sent us the keys for this message."),
    );

    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      "Failed to decrypt message",
      expect.objectContaining({
        roomId: "!room:example.org",
        eventId: "$enc-self",
        sender: "@gumadeiras:matrix.example.org",
        senderMatchesOwnUser: true,
      }),
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "matrix: failed to decrypt a message from this same Matrix user. This usually means another Matrix device did not share the room key, or another OpenClaw runtime is using the same account. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
      {
        roomId: "!room:example.org",
        eventId: "$enc-self",
        sender: "@gumadeiras:matrix.example.org",
      },
    );
  });

  it("does not add self-device guidance for decrypt failures from another sender", async () => {
    const { logger, failedDecryptListener } = createHarness({
      accountId: "ops",
      selfUserId: "@gumadeiras:matrix.example.org",
    });
    if (!failedDecryptListener) {
      throw new Error("room.failed_decryption listener was not registered");
    }

    await failedDecryptListener(
      "!room:example.org",
      {
        event_id: "$enc-other",
        sender: "@alice:matrix.example.org",
        type: EventType.RoomMessageEncrypted,
        origin_server_ts: Date.now(),
        content: {},
      },
      new Error("The sender's device has not sent us the keys for this message."),
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to decrypt message",
      expect.objectContaining({
        roomId: "!room:example.org",
        eventId: "$enc-other",
        sender: "@alice:matrix.example.org",
        senderMatchesOwnUser: false,
      }),
    );
  });
});
