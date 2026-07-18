/**
 * Runtime evidence: Direct test of actual decodeWebSocketData function
 *
 * This imports and tests the ACTUAL decodeWebSocketData function from
 * openai-chatgpt-responses.ts
 *
 * Proves:
 * 1. Oversized Blob-like objects fail BEFORE arrayBuffer() is called
 * 2. Valid Blob-like objects decode successfully
 * 3. Second byteLength check catches fake size values
 */

import { describe, it, expect, vi } from "vitest";

// Import the actual decoder through the module's explicit test-only export.
const { decodeWebSocketDataForTest } = await import("./openai-chatgpt-responses.js");

describe("decodeWebSocketData runtime proof", () => {
  it("rejects oversized Blob-like object BEFORE arrayBuffer() call", async () => {
    let arrayBufferCallCount = 0;

    const oversizedBlobLike = {
      size: 16 * 1024 * 1024 + 1, // Over 16MB limit
      arrayBuffer: vi.fn(async () => {
        arrayBufferCallCount++;
        return new ArrayBuffer(0);
      }),
    };

    await expect(decodeWebSocketDataForTest(oversizedBlobLike)).rejects.toThrow(
      "Codex WebSocket message exceeded size limit",
    );

    expect(arrayBufferCallCount).toBe(0);
    expect(oversizedBlobLike.arrayBuffer).not.toHaveBeenCalled();
  });

  it("decodes valid Blob-like object successfully", async () => {
    const validData = new TextEncoder().encode(
      'data: {"type":"response.created","response":{"id":"resp_123"}}\n\n',
    );
    const validBlob = new Blob([validData]);

    const validBlobLike = {
      size: validBlob.size,
      arrayBuffer: vi.fn(async () => await validBlob.arrayBuffer()),
    };

    const result = await decodeWebSocketDataForTest(validBlobLike);

    expect(result).toContain("response.created");
    expect(validBlobLike.arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it("second check catches fake size that passes first check", async () => {
    // Create data that's actually oversized but fake a small size
    const oversizedData = new Uint8Array(16 * 1024 * 1024 + 1);
    const oversizedBlob = new Blob([oversizedData]);

    const fakeSizeBlobLike = {
      size: 100, // Fake small size to pass first check
      arrayBuffer: vi.fn(async () => await oversizedBlob.arrayBuffer()),
    };

    await expect(decodeWebSocketDataForTest(fakeSizeBlobLike)).rejects.toThrow(
      "Codex WebSocket message exceeded size limit",
    );

    // arrayBuffer SHOULD be called (first check passed due to fake size)
    expect(fakeSizeBlobLike.arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it("handles boundary case at exact limit", async () => {
    const boundaryData = new Uint8Array(16 * 1024 * 1024);
    const boundaryBlob = new Blob([boundaryData]);

    const boundaryBlobLike = {
      size: boundaryBlob.size,
      arrayBuffer: vi.fn(async () => await boundaryBlob.arrayBuffer()),
    };

    // At exact limit, should pass both checks
    const result = await decodeWebSocketDataForTest(boundaryBlobLike);

    expect(result).toBeDefined();
    expect(boundaryBlobLike.arrayBuffer).toHaveBeenCalledTimes(1);
  });
});
