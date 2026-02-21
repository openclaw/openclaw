import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSandboxedMediaSource } from "./sandbox-paths.js";

async function withSandboxRoot<T>(run: (sandboxDir: string) => Promise<T>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-media-"));
  try {
    return await run(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function expectSandboxRejection(media: string, sandboxRoot: string, pattern: RegExp) {
  await expect(resolveSandboxedMediaSource({ media, sandboxRoot })).rejects.toThrow(pattern);
}

describe("resolveSandboxedMediaSource", () => {
  // Group 1: /tmp paths (the bug fix)
  it.each([
    {
      name: "absolute paths under os.tmpdir()",
      media: path.join(os.tmpdir(), "image.png"),
      expected: path.join(os.tmpdir(), "image.png"),
    },
    {
      name: "file:// URLs pointing to os.tmpdir()",
      media: pathToFileURL(path.join(os.tmpdir(), "photo.png")).href,
      expected: path.join(os.tmpdir(), "photo.png"),
    },
    {
      name: "nested paths under os.tmpdir()",
      media: path.join(os.tmpdir(), "subdir", "deep", "file.png"),
      expected: path.join(os.tmpdir(), "subdir", "deep", "file.png"),
    },
  ])("allows $name", async ({ media, expected }) => {
    await withSandboxRoot(async (sandboxDir) => {
      const result = await resolveSandboxedMediaSource({
        media,
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(expected);
    });
  });

  // Group 2: Sandbox-relative paths (existing behavior)
  it("resolves sandbox-relative paths", async () => {
    await withSandboxRoot(async (sandboxDir) => {
      const result = await resolveSandboxedMediaSource({
        media: "./data/file.txt",
        sandboxRoot: sandboxDir,
      });
      expect(result).toBe(path.join(sandboxDir, "data", "file.txt"));
    });
  });

  // Group 3: Rejections (security)
  it.each([
    {
      name: "paths outside sandbox root and tmpdir",
      media: "/etc/passwd",
      expected: /sandbox/i,
    },
    {
      name: "path traversal through tmpdir",
      media: path.join(os.tmpdir(), "..", "etc", "passwd"),
      expected: /sandbox/i,
    },
    {
      name: "relative traversal outside sandbox",
      media: "../outside-sandbox.png",
      expected: /sandbox/i,
    },
    {
      name: "file:// URLs outside sandbox",
      media: "file:///etc/passwd",
      expected: /sandbox/i,
    },
    {
      name: "invalid file:// URLs",
      media: "file://not a valid url\x00",
      expected: /Invalid file:\/\/ URL/,
    },
  ])("rejects $name", async ({ media, expected }) => {
    await withSandboxRoot(async (sandboxDir) => {
      await expectSandboxRejection(media, sandboxDir, expected);
    });
  });

  it("rejects symlinked tmpdir paths escaping tmpdir", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withSandboxRoot(async (sandboxDir) => {
      const symlinkPath = path.join(sandboxDir, "tmp-link-escape");
      await fs.symlink("/etc/passwd", symlinkPath);
      await expectSandboxRejection(symlinkPath, sandboxDir, /symlink|sandbox/i);
    });
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
