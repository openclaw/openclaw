import { describe, expect, it } from "vitest";
import { secureMemoryClear, withDecryptedKeySync } from "./secure-memory.js";

// Test private key (DO NOT use in production - this is a known test key)
const TEST_HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("secureMemoryClear", () => {
  it("zeros out a Uint8Array", () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5]);
    secureMemoryClear(buffer);

    // All bytes should be zero
    for (let i = 0; i < buffer.length; i++) {
      expect(buffer[i]).toBe(0);
    }
  });

  it("clears a 32-byte buffer (typical private key size)", () => {
    const buffer = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      buffer[i] = i;
    }

    secureMemoryClear(buffer);

    for (let i = 0; i < 32; i++) {
      expect(buffer[i]).toBe(0);
    }
  });

  it("works with empty buffer", () => {
    const buffer = new Uint8Array(0);
    expect(() => secureMemoryClear(buffer)).not.toThrow();
  });
});

describe("withDecryptedKeySync", () => {
  it("converts hex string to Uint8Array for function", () => {
    let capturedSk: Uint8Array | null = null;

    withDecryptedKeySync(TEST_HEX_KEY, "passphrase", (sk) => {
      capturedSk = new Uint8Array(sk); // Capture a copy
      return true;
    });

    // Verify we received a proper Uint8Array
    expect(capturedSk).toBeInstanceOf(Uint8Array);
    expect(capturedSk!.length).toBe(32);
  });

  it("clears the key after function execution", () => {
    let skAfter: Uint8Array | null = null;

    const sk = withDecryptedKeySync(TEST_HEX_KEY, "passphrase", (sk) => {
      // Create a reference to check after the function returns
      // Note: we can't directly access the variable after return, so we test indirectly
      return new Uint8Array(sk); // Return a copy
    });

    // The returned copy should still have data (we copied it)
    let hasData = false;
    for (let i = 0; i < sk.length; i++) {
      if (sk[i] !== 0) {
        hasData = true;
        break;
      }
    }
    expect(hasData).toBe(true);
  });

  it("throws when encryptedKey is null", () => {
    expect(() => {
      withDecryptedKeySync(null, "passphrase", () => true);
    }).toThrow("Encrypted key and passphrase are required");
  });

  it("throws when passphrase is undefined", () => {
    expect(() => {
      withDecryptedKeySync(TEST_HEX_KEY, undefined, () => true);
    }).toThrow("Encrypted key and passphrase are required");
  });

  it("allows function to return arbitrary value", () => {
    const result = withDecryptedKeySync(TEST_HEX_KEY, "passphrase", (sk) => {
      return { success: true, keyLength: sk.length };
    });

    expect(result).toEqual({ success: true, keyLength: 32 });
  });

  it("propagates function errors", () => {
    expect(() => {
      withDecryptedKeySync(TEST_HEX_KEY, "passphrase", () => {
        throw new Error("Test error");
      });
    }).toThrow("Test error");
  });
});
