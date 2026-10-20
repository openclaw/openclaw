import { vi } from "vitest";
import type { MatrixClient, MessageEventContent } from "./sdk.js";

export function createEncryptedMediaPayload() {
  return {
    buffer: Buffer.from("encrypted"),
    file: {
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: "secret",
        ext: true,
      },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    },
  };
}

export const makeClient = () => {
  const sendMessage = vi.fn().mockResolvedValue("evt1");
  const sendEvent = vi.fn().mockResolvedValue("evt-poll-vote");
  const getEvent = vi.fn();
  const getRelations = vi.fn().mockResolvedValue({ events: [], nextBatch: null });
  const getJoinedRoomMembers = vi.fn().mockResolvedValue([]);
  const uploadContent = vi.fn().mockResolvedValue("mxc://example/file");
  const prepareRoomForMessageSend = vi.fn();
  // SAFETY: This test fixture implements the Matrix client methods exercised by outbound sends.
  const client = {
    sendMessage,
    sendEvent,
    getEvent,
    getRelations,
    getJoinedRoomMembers,
    uploadContent,
    prepareRoomForMessageSend,
    getTransactionScopeId: vi.fn().mockResolvedValue("scope-1"),
    getMessageWireEventType: vi.fn().mockResolvedValue("m.room.message"),
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
  } as unknown as MatrixClient;
  prepareRoomForMessageSend.mockImplementation(
    async (roomId: string, content?: MessageEventContent) => {
      const eventType = await client.getMessageWireEventType(roomId);
      if (eventType === "m.room.encrypted" && !client.crypto) {
        throw new Error("Encrypted Matrix room: enable encryption before sending messages");
      }
      if (
        eventType === "m.room.encrypted" &&
        (typeof content?.url === "string" ||
          (content?.info &&
            "thumbnail_url" in content.info &&
            typeof content.info.thumbnail_url === "string"))
      ) {
        throw new Error("Encrypted Matrix room contains unencrypted media; retry the send");
      }
      return eventType;
    },
  );
  return {
    client,
    sendMessage,
    sendEvent,
    getEvent,
    getRelations,
    getJoinedRoomMembers,
    uploadContent,
  };
};

export function makeEncryptedMediaClient() {
  const result = makeClient();
  // SAFETY: The fixture replaces only the crypto methods used by these media-send tests.
  const client = result.client as { crypto?: object };
  client.crypto = {
    isRoomEncrypted: vi.fn().mockResolvedValue(true),
    encryptMedia: vi.fn().mockResolvedValue(createEncryptedMediaPayload()),
  };
  vi.spyOn(result.client, "getMessageWireEventType").mockResolvedValue("m.room.encrypted");
  return result;
}
