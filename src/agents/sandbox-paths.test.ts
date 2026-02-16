import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSandboxedMediaSource } from "./sandbox-paths.js";

describe("resolveSandboxedMediaSource", () => {
  // Group 1: /tmp paths (the bug fix)
  it("allows absolute paths under os.tmpdir()", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
    try {
      const result = await resolveSandboxedMediaSource({
        media: path.join(os.tmpdir(), "image.png"),
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(path.join(os.tmpdir(), "image.png"));
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("allows file:// URLs pointing to os.tmpdir()", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
    try {
      const tmpFile = path.join(os.tmpdir(), "photo.png");
      const fileUrl = pathToFileURL(tmpFile).href;
      const result = await resolveSandboxedMediaSource({
        media: fileUrl,
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(tmpFile);
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("allows nested paths under os.tmpdir()", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
    try {
      const result = await resolveSandboxedMediaSource({
        media: path.join(os.tmpdir(), "subdir", "deep", "file.png"),
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(path.join(os.tmpdir(), "subdir", "deep", "file.png"));
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  // Group 2: Sandbox-relative paths (existing behavior)
  it("resolves sandbox-relative paths", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
    try {
      const result = await resolveSandboxedMediaSource({
        media: "./data/file.txt",
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(path.join(sandboxDir, "data", "file.txt"));
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  // Group 3: Rejections (security)
  it("rejects paths outside sandbox root and tmpdir", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
    try {
      await expect(
        resolveSandboxedMediaSource({ media: "/etc/passwd", sandboxRoot: sandboxDir }),
      ).rejects.toThrow(/sandbox/i);
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal through tmpdir", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
    try {
      await expect(
        resolveSandboxedMediaSource({
          media: path.join(os.tmpdir(), "..", "etc", "passwd"),
          sandboxRoot: sandboxDir,
        }),
      ).rejects.toThrow(/sandbox/i);
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("rejects file:// URLs outside sandbox", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
    try {
      await expect(
        resolveSandboxedMediaSource({
          media: "file:///etc/passwd",
          sandboxRoot: sandboxDir,
        }),
      ).rejects.toThrow(/sandbox/i);
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("throws on invalid file:// URLs", async () => {
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
    try {
      await expect(
        resolveSandboxedMediaSource({
          media: "file://not a valid url\x00",
          sandboxRoot: sandboxDir,
        }),
      ).rejects.toThrow(/Invalid file:\/\/ URL/);
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  // Group 4: Passthrough
  it("passes HTTP URLs through unchanged", async () => {
    const result = await resolveSandboxedMediaSource({
      media: "https://example.com/image.png",
      sandboxRoot: "/any/path",
    });
    expect(result).toBe("https://example.com/image.png");
  });

  it("returns empty string for empty input", async () => {
    const result = await resolveSandboxedMediaSource({
      media: "",
      sandboxRoot: "/any/path",
    });
    expect(result).toBe("");
  });

  it("returns empty string for whitespace-only input", async () => {
    const result = await resolveSandboxedMediaSource({
      media: "   ",
      sandboxRoot: "/any/path",
    });
    expect(result).toBe("");
  });
});
