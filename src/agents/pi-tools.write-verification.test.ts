import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostWorkspaceWriteTool, createSandboxedWriteTool } from "./pi-tools.read.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

describe("write tool post-write verification", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-verify-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  describe("host write operations", () => {
    it("should succeed when file is written correctly", async () => {
      const tool = createHostWorkspaceWriteTool(tempDir, { workspaceOnly: false });
      const filePath = path.join(tempDir, "test.txt");
      const content = "hello world";

      const result = await tool.execute("test-call", { path: filePath, content });

      expect(result.content).toBeDefined();
      const textContent = result.content.find((c: { type: string }) => c.type === "text");
      expect(textContent).toBeDefined();
      expect((textContent as { text: string }).text).toContain("Successfully wrote");

      // Verify file actually exists
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBe(Buffer.byteLength(content, "utf-8"));
    });

    it("should succeed with nested directories", async () => {
      const tool = createHostWorkspaceWriteTool(tempDir, { workspaceOnly: false });
      const filePath = path.join(tempDir, "nested", "deep", "test.txt");
      const content = "nested content";

      const result = await tool.execute("test-call", { path: filePath, content });

      expect(result.content).toBeDefined();
      const textContent = result.content.find((c: { type: string }) => c.type === "text");
      expect(textContent).toBeDefined();
      expect((textContent as { text: string }).text).toContain("Successfully wrote");

      // Verify file actually exists
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });
  });

  describe("sandbox write operations", () => {
    it("should fail when bridge.writeFile succeeds but stat returns null", async () => {
      const mockBridge: SandboxFsBridge = {
        resolvePath: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn().mockResolvedValue(undefined),
        mkdirp: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        rename: vi.fn(),
        stat: vi.fn().mockResolvedValue(null), // File doesn't exist after write
      };

      const tool = createSandboxedWriteTool({
        root: tempDir,
        bridge: mockBridge,
      });

      await expect(
        tool.execute("test-call", { path: "/workspace/test.txt", content: "test content" }),
      ).rejects.toThrow(/Write verification failed.*does not exist/);
    });

    it("should fail when bridge.stat returns wrong type", async () => {
      const mockBridge: SandboxFsBridge = {
        resolvePath: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn().mockResolvedValue(undefined),
        mkdirp: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        rename: vi.fn(),
        stat: vi.fn().mockResolvedValue({
          type: "directory", // Wrong type
          size: 12,
          mtimeMs: Date.now(),
        }),
      };

      const tool = createSandboxedWriteTool({
        root: tempDir,
        bridge: mockBridge,
      });

      await expect(
        tool.execute("test-call", { path: "/workspace/test.txt", content: "test content" }),
      ).rejects.toThrow(/Write verification failed.*not a file/);
    });

    it("should fail when bridge.stat returns wrong size", async () => {
      const content = "test content with specific size";
      const expectedSize = Buffer.byteLength(content, "utf-8");

      const mockBridge: SandboxFsBridge = {
        resolvePath: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn().mockResolvedValue(undefined),
        mkdirp: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        rename: vi.fn(),
        stat: vi.fn().mockResolvedValue({
          type: "file",
          size: expectedSize - 10, // Wrong size
          mtimeMs: Date.now(),
        }),
      };

      const tool = createSandboxedWriteTool({
        root: tempDir,
        bridge: mockBridge,
      });

      await expect(
        tool.execute("test-call", { path: "/workspace/test.txt", content }),
      ).rejects.toThrow(/Write verification failed.*expected.*bytes but file has/);
    });

    it("should succeed when all verifications pass", async () => {
      const content = "verified content";
      const expectedSize = Buffer.byteLength(content, "utf-8");

      const mockBridge: SandboxFsBridge = {
        resolvePath: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn().mockResolvedValue(undefined),
        mkdirp: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        rename: vi.fn(),
        stat: vi.fn().mockResolvedValue({
          type: "file",
          size: expectedSize,
          mtimeMs: Date.now(),
        }),
      };

      const tool = createSandboxedWriteTool({
        root: tempDir,
        bridge: mockBridge,
      });

      const result = await tool.execute("test-call", {
        path: "/workspace/test.txt",
        content,
      });

      expect(result.content).toBeDefined();
      const textContent = result.content.find((c: { type: string }) => c.type === "text");
      expect(textContent).toBeDefined();
      expect((textContent as { text: string }).text).toContain("Successfully wrote");
    });
  });

  describe("issue #67136 - false success scenario", () => {
    it("should NOT report success when file is not actually created", async () => {
      // This test ensures the fix for issue #67136 works correctly
      // The bug was: write tool reports "Successfully wrote X bytes" but file doesn't exist

      const mockBridge: SandboxFsBridge = {
        resolvePath: vi.fn(),
        readFile: vi.fn(),
        // writeFile "succeeds" (no error thrown)
        writeFile: vi.fn().mockResolvedValue(undefined),
        mkdirp: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        rename: vi.fn(),
        // But stat shows file doesn't exist (returns null)
        stat: vi.fn().mockResolvedValue(null),
      };

      const tool = createSandboxedWriteTool({
        root: tempDir,
        bridge: mockBridge,
      });

      // Before the fix, this would succeed with "Successfully wrote X bytes"
      // After the fix, this should throw an error
      await expect(
        tool.execute("test-call", {
          path: "/workspace/missing-file.txt",
          content: "this content was never written",
        }),
      ).rejects.toThrow(/Write verification failed/);
    });
  });
});
