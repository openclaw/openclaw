import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { vi } from "vitest";
import type { MatrixClient } from "./sdk.js";

export function createMatrixTestDecryptionFailure(event: MatrixEvent) {
  const failed = new MatrixEvent({
    ...event.event,
    type: "m.room.message",
    content: {
      msgtype: "m.bad.encrypted",
      body: "Synthetic missing session key",
      "m.relates_to": event.getWireContent()["m.relates_to"],
    },
  });
  vi.spyOn(failed, "isDecryptionFailure").mockReturnValue(true);
  return failed;
}

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
  // SDK client tests own readiness/encryption policy. Send tests control the
  // preparation result to exercise upload and platform-dispatch sequencing.
  const prepareRoomForMessageSend = vi
    .fn<MatrixClient["prepareRoomForMessageSend"]>()
    .mockResolvedValue("m.room.message");
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
  } as unknown as MatrixClient;
  return {
    client,
    sendMessage,
    sendEvent,
    getEvent,
    getRelations,
    getJoinedRoomMembers,
    uploadContent,
    prepareRoomForMessageSend,
  };
};

export function makeEncryptedMediaClient() {
  const result = makeClient();
  // SAFETY: The fixture replaces only the crypto methods used by these media-send tests.
  const client = result.client as { crypto?: object };
  client.crypto = {
    encryptMedia: vi.fn().mockResolvedValue(createEncryptedMediaPayload()),
  };
  result.prepareRoomForMessageSend.mockResolvedValue("m.room.encrypted");
  return result;
}
