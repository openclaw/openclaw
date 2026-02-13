/**
 * Mock OlmMachine for unit/integration testing.
 *
 * Provides vitest-compatible mock functions for the subset of the
 * @matrix-org/matrix-sdk-crypto-nodejs OlmMachine API used by claw-matrix.
 */

import { vi } from "vitest";

export interface MockOlmMachine {
  encryptRoomEvent: ReturnType<typeof vi.fn>;
  updateTrackedUsers: ReturnType<typeof vi.fn>;
  getMissingSessions: ReturnType<typeof vi.fn>;
  shareRoomKey: ReturnType<typeof vi.fn>;
  markRequestAsSent: ReturnType<typeof vi.fn>;
  decryptRoomEvent: ReturnType<typeof vi.fn>;
  identityKeys: { curve25519: string; ed25519: string };
}

/**
 * Create a mock OlmMachine with sensible defaults.
 *
 * - `encryptRoomEvent` returns a valid m.megolm.v1.aes-sha2 payload
 * - `getMissingSessions` returns null (no missing sessions)
 * - `shareRoomKey` returns [] (no to-device requests)
 * - `markRequestAsSent` resolves void
 * - `updateTrackedUsers` resolves void
 */
export function createMockOlmMachine(): MockOlmMachine {
  const encryptedPayload = JSON.stringify({
    algorithm: "m.megolm.v1.aes-sha2",
    sender_key: "test_sender_key",
    ciphertext: "encrypted_content",
    session_id: "test_session_id",
    device_id: "TEST_DEVICE",
  });

  return {
    encryptRoomEvent: vi.fn().mockResolvedValue(encryptedPayload),
    updateTrackedUsers: vi.fn().mockResolvedValue(undefined),
    getMissingSessions: vi.fn().mockResolvedValue(null),
    shareRoomKey: vi.fn().mockResolvedValue([]),
    markRequestAsSent: vi.fn().mockResolvedValue(undefined),
    decryptRoomEvent: vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ event: JSON.stringify({ content: { body: "decrypted" } }) }),
      ),
    identityKeys: {
      curve25519: "mock_curve25519_key",
      ed25519: "mock_ed25519_key",
    },
  };
}
