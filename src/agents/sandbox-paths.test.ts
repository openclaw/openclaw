import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSandboxedMediaSource } from "./sandbox-paths.js";

describe("resolveSandboxedMediaSource", () => {
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

  it("rejects paths outside sandbox root", async () => {
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
