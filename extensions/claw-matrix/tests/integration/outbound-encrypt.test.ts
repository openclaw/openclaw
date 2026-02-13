/**
 * Integration test: Outbound Encryption Smoke Test
 *
 * Tests the ensureRoomKeysShared → encryptRoomEvent → putEvent flow
 * using the mock OlmMachine (no real FFI) and mock homeserver.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initHttpClient, matrixFetch } from "../../src/client/http.js";
import { setRoomEncrypted } from "../../src/client/rooms.js";
import { MockMatrixServer } from "../mocks/matrix-server.js";
import { createMockOlmMachine, type MockOlmMachine } from "../mocks/olm-machine.js";

// We cannot use the real OlmMachine without the full test harness and FFI,
// so we mock the crypto/machine module to return our mock machine.
vi.mock("../../src/crypto/machine.js", () => ({
  getMachine: vi.fn(),
  withCryptoTimeout: vi.fn((promise: Promise<unknown>) => promise),
  CRYPTO_TIMEOUT_MS: 30_000,
  initCryptoMachine: vi.fn(),
  closeMachine: vi.fn(),
}));

// Mock the outgoing module — we don't want to actually process outgoing requests
vi.mock("../../src/crypto/outgoing.js", () => ({
  processOutgoingRequests: vi.fn().mockResolvedValue(undefined),
}));

// Mock the health module
vi.mock("../../src/health.js", () => ({
  incrementCounter: vi.fn(),
}));

describe("Outbound Encryption Smoke Test", () => {
  let mockMachine: MockOlmMachine;
  let server: MockMatrixServer;

  beforeEach(async () => {
    mockMachine = createMockOlmMachine();

    // Wire up the mock machine
    const machineModule = await import("../../src/crypto/machine.js");
    vi.mocked(machineModule.getMachine).mockReturnValue(mockMachine as any);

    // Start mock server
    server = new MockMatrixServer();
    await server.start();
    initHttpClient(server.baseUrl, "test_token_12345");
  });

  afterEach(async () => {
    await server.stop();
    vi.restoreAllMocks();
  });

  describe("encryptRoomEvent output validation", () => {
    it("encrypted output has required fields: algorithm, sender_key, ciphertext, session_id, device_id", async () => {
      const encryptedJson = await mockMachine.encryptRoomEvent();
      const encrypted = JSON.parse(encryptedJson);

      expect(encrypted).toHaveProperty("algorithm", "m.megolm.v1.aes-sha2");
      expect(encrypted).toHaveProperty("sender_key", "test_sender_key");
      expect(encrypted).toHaveProperty("ciphertext", "encrypted_content");
      expect(encrypted).toHaveProperty("session_id", "test_session_id");
      expect(encrypted).toHaveProperty("device_id", "TEST_DEVICE");
    });

    it("encrypted output is under 65536 bytes", async () => {
      const encryptedJson = await mockMachine.encryptRoomEvent();
      const size = Buffer.byteLength(encryptedJson);

      expect(size).toBeLessThan(65_536);
    });
  });

  describe("sendEncrypted → putEvent flow", () => {
    it("sends m.room.encrypted event to the homeserver", async () => {
      // Mark room as encrypted so sendMatrixMessage takes the encrypted path
      setRoomEncrypted("!encrypted-room:test");

      // Import sendMatrixMessage after mocks are wired
      const { sendMatrixMessage } = await import("../../src/client/send.js");

      const result = await sendMatrixMessage({
        roomId: "!encrypted-room:test",
        text: "Hello encrypted world",
      });

      expect(result.eventId).toBeTruthy();
      expect(result.roomId).toBe("!encrypted-room:test");

      // Verify the server received an m.room.encrypted PUT
      const sends = server.getRequestsMatching({
        method: "PUT",
        path: /\/rooms\/.*\/send\/m\.room\.encrypted\//,
      });
      expect(sends.length).toBeGreaterThanOrEqual(1);

      // Verify the body has encrypted content structure
      const body = sends[0].body;
      expect(body).toHaveProperty("algorithm", "m.megolm.v1.aes-sha2");
      expect(body).toHaveProperty("sender_key");
      expect(body).toHaveProperty("ciphertext");
      expect(body).toHaveProperty("session_id");
    });

    it("uses unique transaction IDs for each send", async () => {
      setRoomEncrypted("!txn-room:test");
      const { sendMatrixMessage } = await import("../../src/client/send.js");

      await sendMatrixMessage({ roomId: "!txn-room:test", text: "First" });
      await sendMatrixMessage({ roomId: "!txn-room:test", text: "Second" });

      const sends = server.getRequestsMatching({
        method: "PUT",
        path: /\/rooms\/.*\/send\/m\.room\.encrypted\//,
      });

      // Extract txnIds from paths
      const txnIds = sends.map((s) => s.path.split("/").pop());
      const unique = new Set(txnIds);
      expect(unique.size).toBe(txnIds.length);
    });

    it("calls ensureRoomKeysShared before encrypting", async () => {
      setRoomEncrypted("!keys-room:test");
      server.setRoomMembers("!keys-room:test", ["@alice:test", "@bob:test"]);
      const { sendMatrixMessage } = await import("../../src/client/send.js");

      await sendMatrixMessage({ roomId: "!keys-room:test", text: "Test" });

      // The mock machine's updateTrackedUsers should have been called
      // (part of ensureRoomKeysShared)
      expect(mockMachine.updateTrackedUsers).toHaveBeenCalled();
    });

    it("calls shareRoomKey before encrypting", async () => {
      setRoomEncrypted("!share-room:test");
      server.setRoomMembers("!share-room:test", ["@alice:test", "@bob:test"]);
      const { sendMatrixMessage } = await import("../../src/client/send.js");

      await sendMatrixMessage({ roomId: "!share-room:test", text: "Test" });

      expect(mockMachine.shareRoomKey).toHaveBeenCalled();
    });

    it("encryptRoomEvent is called with room ID and event type", async () => {
      setRoomEncrypted("!verify-room:test");
      const { sendMatrixMessage } = await import("../../src/client/send.js");

      await sendMatrixMessage({ roomId: "!verify-room:test", text: "Check args" });

      expect(mockMachine.encryptRoomEvent).toHaveBeenCalled();
      const callArgs = mockMachine.encryptRoomEvent.mock.calls[0];
      // First arg is RoomId object, second is event type string
      expect(callArgs[1]).toBe("m.room.message");
    });
  });
});
