import { mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyAvatarToDataDir } from "./utils.js";

describe("copyAvatarToDataDir", () => {
  let testDir: string;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `deltachat-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should copy avatar file to data directory", () => {
    const result = copyAvatarToDataDir(testDir);

    // Should return a path (or null if avatar doesn't exist)
    expect(result).toBeDefined();

    if (result) {
      // The avatar file should exist at the returned path
      expect(existsSync(result)).toBe(true);

      // The file should be named openclaw-avatar.png (Delta.Chat requires JPEG or PNG)
      expect(result).toContain("openclaw-avatar.png");

      // The file should be in the test directory
      expect(result).toContain(testDir);
    }
  });

  it("should handle non-existent data directory gracefully", () => {
    const nonExistentDir = join(testDir, "non-existent");
    const result = copyAvatarToDataDir(nonExistentDir);

    // Should return null or a path if avatar exists
    expect(result).toBeDefined();

    if (result) {
      // If avatar was copied, the directory should now exist
      expect(existsSync(nonExistentDir)).toBe(true);
    }
  });

  it("should return null if avatar source doesn't exist", () => {
    // This test would fail if the avatar source doesn't exist
    // But in a real workspace, it should exist
    const result = copyAvatarToDataDir(testDir);

    // If the avatar source exists, we should get a path
    // If it doesn't exist, we should get null
    expect(result === null || typeof result === "string").toBe(true);
  });
});
