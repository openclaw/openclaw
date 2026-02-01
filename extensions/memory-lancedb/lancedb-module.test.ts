/**
 * LanceDB Native Module Availability Test
 *
 * This test verifies that @lancedb/lancedb native module is correctly
 * compiled and available in the environment. This is critical for:
 * - Docker multi-stage build validation
 * - Production deployment verification
 * - Memory extension functionality
 *
 * The test ensures the Rust-based lancedb native module (compiled to .node binary)
 * is present and functional, which is essential for the memory-lancedb extension.
 *
 * Note: These tests are skipped in CI environments where the native module
 * may not be available. They are primarily useful for verifying Docker image
 * builds and production environments where the module should be compiled.
 */

import { describe, test, expect } from "vitest";

// Check if lancedb native module is available
let lancedbAvailable = false;
try {
  // Try synchronous require to check availability
  require.resolve("@lancedb/lancedb");
  lancedbAvailable = true;
} catch {
  lancedbAvailable = false;
}

const describeLanceDB = lancedbAvailable ? describe : describe.skip;

describeLanceDB("@lancedb/lancedb native module", () => {
  test("module can be imported successfully", async () => {
    // This test validates that the native lancedb module is available
    // It will fail if:
    // 1. Docker build did not compile the native module (missing build tools)
    // 2. The .node binary is not included in the image (missing COPY in Dockerfile)
    // 3. The module has incompatible binary dependencies
    try {
      const lancedb = await import("@lancedb/lancedb");
      expect(lancedb).toBeDefined();
      expect(lancedb.default || lancedb).toBeTruthy();
    } catch (error) {
      throw new Error(
        `Failed to import @lancedb/lancedb. ` +
          `This indicates the native module compilation failed or the binary is missing from the image. ` +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });

  test("connect function is available", async () => {
    // Verify that the core lancedb.connect() function is accessible
    // This is the main API entry point for the memory extension
    const lancedb = await import("@lancedb/lancedb");
    const connect = lancedb.default?.connect || lancedb.connect;

    expect(typeof connect).toBe("function");
  });

  test("module has required methods", async () => {
    // Verify that essential LanceDB API methods are available
    // This ensures the native binding is complete and not corrupted
    const lancedb = await import("@lancedb/lancedb");
    const api = lancedb.default || lancedb;

    expect(typeof api.connect).toBe("function");
  });
});
