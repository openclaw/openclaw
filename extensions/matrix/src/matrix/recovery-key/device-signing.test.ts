/**
 * Unit tests for device signing utilities.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import crypto from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { ERROR_MESSAGES } from "./constants.js";
import {
  getCurrentDeviceKeys,
  signDevice,
  uploadDeviceSignature,
  type DeviceKeys,
} from "./device-signing.js";

describe("getCurrentDeviceKeys", () => {
  it("should retrieve device keys successfully", async () => {
    // Arrange: Mock MatrixClient with crypto engine
    const mockClient = {
      userId: "@user:example.com",
      crypto: {
        deviceId: "TESTDEVICE123",
        deviceEd25519: "test_ed25519_key_base64",
        deviceCurve25519: "test_curve25519_key_base64",
      },
    } as unknown as MatrixClient;

    // Act
    const result = await getCurrentDeviceKeys(mockClient);

    // Assert
    expect(result).toEqual({
      userId: "@user:example.com",
      deviceId: "TESTDEVICE123",
      keys: {
        "ed25519:TESTDEVICE123": "test_ed25519_key_base64",
        "curve25519:TESTDEVICE123": "test_curve25519_key_base64",
      },
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    });
  });

  it("should throw error when crypto is unavailable", async () => {
    // Arrange: Mock MatrixClient without crypto
    const mockClient = {
      userId: "@user:example.com",
      crypto: undefined,
    } as unknown as MatrixClient;

    // Act & Assert
    await expect(getCurrentDeviceKeys(mockClient)).rejects.toThrow(
      ERROR_MESSAGES.CRYPTO_ENGINE_UNAVAILABLE,
    );
  });

  it("should throw error when crypto engine is unavailable", async () => {
    // Arrange: Mock MatrixClient with crypto but missing device ID
    const mockClient = {
      userId: "@user:example.com",
      crypto: {
        deviceId: undefined,
      },
    } as unknown as MatrixClient;

    // Act & Assert
    await expect(getCurrentDeviceKeys(mockClient)).rejects.toThrow(
      "Device ID not available from crypto client",
    );
  });

  it("should throw error when device ID is missing", async () => {
    // Arrange: Mock MatrixClient without device ID
    const mockClient = {
      userId: "@user:example.com",
      crypto: {
        deviceId: undefined,
      },
    } as unknown as MatrixClient;

    // Act & Assert
    await expect(getCurrentDeviceKeys(mockClient)).rejects.toThrow(
      "Device ID not available from crypto client",
    );
  });

  it("should throw error when user ID is missing", async () => {
    // Arrange: Mock MatrixClient without user ID
    const mockClient = {
      userId: undefined,
      crypto: {
        deviceId: "TESTDEVICE123",
        deviceEd25519: "test_ed25519_key_base64",
        deviceCurve25519: "test_curve25519_key_base64",
      },
    } as unknown as MatrixClient;

    // Act & Assert
    await expect(getCurrentDeviceKeys(mockClient)).rejects.toThrow(
      "User ID not available from client",
    );
  });

  it("should throw error when identity keys are missing", async () => {
    // Arrange: Mock MatrixClient with crypto but missing identity keys
    const mockClient = {
      userId: "@user:example.com",
      crypto: {
        deviceId: "TESTDEVICE123",
        deviceEd25519: "test_ed25519_key_base64",
        deviceCurve25519: undefined, // Missing curve25519 key
      },
    } as unknown as MatrixClient;

    // Act & Assert
    await expect(getCurrentDeviceKeys(mockClient)).rejects.toThrow(
      "Identity keys not available from crypto engine",
    );
  });
});

describe("signDevice", () => {
  it("should generate valid signature for device keys", () => {
    // Arrange: Generate a test ed25519 keypair
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const privateKeyRaw = privateKey.export({ type: "pkcs8", format: "der" });

    // Extract raw 32-byte private key from PKCS8 DER format
    // PKCS8 has header/wrapper, the actual key starts at byte 16
    const selfSigningKey = new Uint8Array(privateKeyRaw.subarray(16, 48));

    const deviceKeys: DeviceKeys = {
      userId: "@user:example.com",
      deviceId: "TESTDEVICE123",
      keys: {
        "ed25519:TESTDEVICE123": "test_ed25519_key",
        "curve25519:TESTDEVICE123": "test_curve25519_key",
      },
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    };

    // Act
    const signature = signDevice(deviceKeys, selfSigningKey);

    // Assert: Signature should be base64 string (unpadded)
    expect(signature).toMatch(/^[A-Za-z0-9+/]+$/);
    expect(signature).not.toContain("="); // Unpadded

    // Verify signature can be validated with public key
    // We need to manually construct the canonical JSON to match the signing function
    const canonicalJson =
      `{` +
      `"algorithms":["m.olm.v1.curve25519-aes-sha2","m.megolm.v1.aes-sha2"],` +
      `"device_id":"TESTDEVICE123",` +
      `"keys":{"curve25519:TESTDEVICE123":"test_curve25519_key","ed25519:TESTDEVICE123":"test_ed25519_key"},` +
      `"user_id":"@user:example.com"` +
      `}`;

    const signatureBuffer = Buffer.from(signature, "base64");

    const isValid = crypto.verify(null, Buffer.from(canonicalJson), publicKey, signatureBuffer);

    expect(isValid).toBe(true);
  });

  it("should produce consistent signatures for same input", () => {
    // Arrange: Use fixed private key
    const selfSigningKey = crypto.randomBytes(32);
    const deviceKeys: DeviceKeys = {
      userId: "@user:example.com",
      deviceId: "TESTDEVICE123",
      keys: {
        "ed25519:TESTDEVICE123": "fixed_ed25519_key",
        "curve25519:TESTDEVICE123": "fixed_curve25519_key",
      },
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    };

    // Act: Sign twice
    const signature1 = signDevice(deviceKeys, selfSigningKey);
    const signature2 = signDevice(deviceKeys, selfSigningKey);

    // Assert: Should produce identical signatures
    expect(signature1).toBe(signature2);
  });

  it("should use canonical JSON for signing", () => {
    // Arrange
    const selfSigningKey = crypto.randomBytes(32);

    // Create two device keys with same data but different property order
    const deviceKeys1: DeviceKeys = {
      userId: "@user:example.com",
      deviceId: "TESTDEVICE123",
      keys: {
        "ed25519:TESTDEVICE123": "key1",
        "curve25519:TESTDEVICE123": "key2",
      },
      algorithms: ["alg1", "alg2"],
    };

    const deviceKeys2: DeviceKeys = {
      // Different order
      deviceId: "TESTDEVICE123",
      userId: "@user:example.com",
      algorithms: ["alg1", "alg2"],
      keys: {
        "curve25519:TESTDEVICE123": "key2",
        "ed25519:TESTDEVICE123": "key1",
      },
    };

    // Act
    const signature1 = signDevice(deviceKeys1, selfSigningKey);
    const signature2 = signDevice(deviceKeys2, selfSigningKey);

    // Assert: Should produce identical signatures due to canonical JSON
    expect(signature1).toBe(signature2);
  });
});

describe("uploadDeviceSignature", () => {
  it("should upload signature successfully", async () => {
    // Arrange: Mock MatrixClient
    const mockDoRequest = vi.fn().mockResolvedValue({});
    const mockClient = {
      doRequest: mockDoRequest,
    } as unknown as MatrixClient;

    const deviceKeys: DeviceKeys = {
      userId: "@user:example.com",
      deviceId: "TESTDEVICE123",
      keys: {
        "ed25519:TESTDEVICE123": "test_ed25519_key",
        "curve25519:TESTDEVICE123": "test_curve25519_key",
      },
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    };

    const signature = "test_signature_base64";
    const selfSigningKeyId = "test_key_id";

    // Act
    await uploadDeviceSignature(
      mockClient,
      "@user:example.com",
      "TESTDEVICE123",
      deviceKeys,
      signature,
      selfSigningKeyId,
    );

    // Assert: Should call doRequest with correct parameters
    expect(mockDoRequest).toHaveBeenCalledOnce();
    expect(mockDoRequest).toHaveBeenCalledWith(
      "POST",
      "/_matrix/client/v3/keys/signatures/upload",
      null,
      {
        "@user:example.com": {
          TESTDEVICE123: {
            user_id: "@user:example.com",
            device_id: "TESTDEVICE123",
            algorithms: deviceKeys.algorithms,
            keys: deviceKeys.keys,
            signatures: {
              "@user:example.com": {
                "ed25519:test_key_id": signature,
              },
            },
          },
        },
      },
    );
  });

  it("should handle rate limiting error (429)", async () => {
    // Arrange: Mock MatrixClient with rate limit error
    const mockDoRequest = vi.fn().mockRejectedValue({
      statusCode: 429,
      body: { errcode: "M_LIMIT_EXCEEDED" },
    });
    const mockClient = {
      doRequest: mockDoRequest,
    } as unknown as MatrixClient;

    const deviceKeys: DeviceKeys = {
      userId: "@user:example.com",
      deviceId: "TESTDEVICE123",
      keys: {
        "ed25519:TESTDEVICE123": "test_ed25519_key",
        "curve25519:TESTDEVICE123": "test_curve25519_key",
      },
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
    };

    // Act & Assert
    await expect(
      uploadDeviceSignature(
        mockClient,
        "@user:example.com",
        "TESTDEVICE123",
        deviceKeys,
        "signature",
        "keyId",
      ),
    ).rejects.toThrow("Rate limited by homeserver");
  });

  it("should handle invalid signature error (400)", async () => {
    // Arrange: Mock MatrixClient with invalid signature error
    const mockDoRequest = vi.fn().mockRejectedValue({
      statusCode: 400,
      body: { errcode: "M_INVALID_SIGNATURE" },
    });
    const mockClient = {
      doRequest: mockDoRequest,
    } as unknown as MatrixClient;

    const deviceKeys: DeviceKeys = {
      userId: "@user:example.com",
      deviceId: "TESTDEVICE123",
      keys: {
        "ed25519:TESTDEVICE123": "test_ed25519_key",
        "curve25519:TESTDEVICE123": "test_curve25519_key",
      },
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
    };

    // Act & Assert
    await expect(
      uploadDeviceSignature(
        mockClient,
        "@user:example.com",
        "TESTDEVICE123",
        deviceKeys,
        "invalid_signature",
        "keyId",
      ),
    ).rejects.toThrow("Invalid signature");
  });

  it("should handle network errors", async () => {
    // Arrange: Mock MatrixClient with network error
    const mockDoRequest = vi.fn().mockRejectedValue(new Error("Network timeout"));
    const mockClient = {
      doRequest: mockDoRequest,
    } as unknown as MatrixClient;

    const deviceKeys: DeviceKeys = {
      userId: "@user:example.com",
      deviceId: "TESTDEVICE123",
      keys: {
        "ed25519:TESTDEVICE123": "test_ed25519_key",
        "curve25519:TESTDEVICE123": "test_curve25519_key",
      },
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
    };

    // Act & Assert
    await expect(
      uploadDeviceSignature(
        mockClient,
        "@user:example.com",
        "TESTDEVICE123",
        deviceKeys,
        "signature",
        "keyId",
      ),
    ).rejects.toThrow("Failed to upload device signature: Network timeout");
  });
});
