import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostWorkspaceWriteTool, createSandboxedWriteTool } from "./pi-tools.read.js";

describe("write tool append mode", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-append-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("host workspace write tool", () => {
    it("overwrites by default", async () => {
      const tool = createHostWorkspaceWriteTool(tmpDir);
      const filePath = path.join(tmpDir, "test.txt");

      await tool.execute("call-1", { path: "test.txt", content: "first" }, undefined as never);
      await tool.execute("call-2", { path: "test.txt", content: "second" }, undefined as never);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("second");
    });

    it("appends when append=true", async () => {
      const tool = createHostWorkspaceWriteTool(tmpDir);
      const filePath = path.join(tmpDir, "test.txt");

      await tool.execute(
        "call-1",
        { path: "test.txt", content: "first", append: true },
        undefined as never,
      );
      await tool.execute(
        "call-2",
        { path: "test.txt", content: "second", append: true },
        undefined as never,
      );

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("first\nsecond");
    });

    it("creates parent directories when appending", async () => {
      const tool = createHostWorkspaceWriteTool(tmpDir);

      await tool.execute(
        "call-1",
        { path: "sub/dir/test.txt", content: "hello", append: true },
        undefined as never,
      );

      const content = await fs.readFile(path.join(tmpDir, "sub/dir/test.txt"), "utf-8");
      expect(content).toBe("hello");
    });

    it("redacts absolute host paths from append failures", async () => {
      const tool = createHostWorkspaceWriteTool(tmpDir);
      const relativePath = "nested/test.txt";
      const absolutePath = path.join(tmpDir, relativePath);

      vi.spyOn(fs, "open").mockRejectedValueOnce(
        new Error(`EACCES: permission denied, open '${absolutePath}'`),
      );

      let thrown: unknown;
      try {
        await tool.execute(
          "call-1",
          { path: relativePath, content: "hello", append: true },
          undefined as never,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(path.basename(relativePath));
      expect((thrown as Error).message).not.toContain(absolutePath);
      expect((thrown as Error).message).not.toContain(tmpDir);
    });

    it("includes append in schema", () => {
      const tool = createHostWorkspaceWriteTool(tmpDir);
      const schema = tool.parameters as Record<string, unknown>;
      const props = schema.properties as Record<string, unknown>;
      expect(props.append).toBeDefined();
      expect((props.append as Record<string, unknown>).type).toBe("boolean");
    });
  });

  describe("sandboxed write tool", () => {
    it("returns error when append=true is used", async () => {
      // Create a minimal mock sandbox bridge
      const mockBridge = {
        readFile: async () => Buffer.from(""),
        writeFile: async () => {},
        mkdirp: async () => {},
        stat: async () => ({ size: 0, isFile: true, isDirectory: false }),
      } as unknown as Parameters<typeof createSandboxedWriteTool>[0]["bridge"];

      const tool = createSandboxedWriteTool({
        root: tmpDir,
        bridge: mockBridge,
      });

      const result = await tool.execute(
        "call-1",
        { path: "test.txt", content: "hello", append: true },
        undefined as never,
      );

      const textContent = result.content.find((c: { type: string }) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(textContent?.text).toContain("not supported in sandboxed sessions");
    });

    it("works normally without append", async () => {
      let writtenPath = "";
      let writtenData = "";
      const mockBridge = {
        readFile: async () => Buffer.from(""),
        writeFile: async ({ filePath, data }: { filePath: string; data: string }) => {
          writtenPath = filePath;
          writtenData = data;
        },
        mkdirp: async () => {},
        stat: async () => null,
      } as unknown as Parameters<typeof createSandboxedWriteTool>[0]["bridge"];

      const tool = createSandboxedWriteTool({
        root: tmpDir,
        bridge: mockBridge,
      });

      await tool.execute("call-1", { path: "test.txt", content: "hello" }, undefined as never);

      // Should have written normally through the bridge
      expect(writtenPath || writtenData).toBeTruthy();
    });
  });
});
