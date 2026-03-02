import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { createHostWorkspaceWriteTool } = await import("./pi-tools.read.js");

describe("readOnlyPaths configuration", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it.runIf(process.platform !== "win32")("allows write to paths not in readOnlyPaths", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-readonly-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const writableDir = path.join(tmpDir, "writable");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(writableDir);

    const tool = createHostWorkspaceWriteTool(workspaceDir, {
      readOnlyPaths: [path.join(tmpDir, "readonly")],
    });

    const result = await tool.execute("test", {
      path: path.join(writableDir, "test.txt"),
      content: "hello",
    });

    expect(result.content).toBeDefined();
  });

  it.runIf(process.platform !== "win32")("blocks write to paths in readOnlyPaths", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-readonly-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const readonlyDir = path.join(tmpDir, "readonly");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(readonlyDir);

    const tool = createHostWorkspaceWriteTool(workspaceDir, {
      readOnlyPaths: [readonlyDir],
    });

    await expect(
      tool.execute("test", {
        path: path.join(readonlyDir, "test.txt"),
        content: "hello",
      }),
    ).rejects.toThrow("Path is read-only");
  });

  it.runIf(process.platform !== "win32")(
    "resolves symlinks when checking read-only paths",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-readonly-test-"));
      const workspaceDir = path.join(tmpDir, "workspace");
      const readonlyDir = path.join(tmpDir, "readonly");
      const symlinkDir = path.join(tmpDir, "symlink");
      const testFile = path.join(readonlyDir, "test.txt");
      await fs.mkdir(workspaceDir);
      await fs.mkdir(readonlyDir);
      await fs.writeFile(testFile, "hello world");
      await fs.symlink(readonlyDir, symlinkDir);

      const tool = createHostWorkspaceWriteTool(workspaceDir, {
        readOnlyPaths: [readonlyDir],
      });

      await expect(
        tool.execute("test", {
          path: path.join(symlinkDir, "test.txt"),
          content: "hello",
        }),
      ).rejects.toThrow("Path is read-only");
    },
  );

  it.runIf(process.platform !== "win32")("blocks mkdir in readOnlyPaths", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-readonly-test-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const readonlyDir = path.join(tmpDir, "readonly");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(readonlyDir);

    const tool = createHostWorkspaceWriteTool(workspaceDir, {
      readOnlyPaths: [readonlyDir],
    });

    await expect(
      tool.execute("test", {
        path: path.join(readonlyDir, "subdir", "test.txt"),
        content: "hello",
      }),
    ).rejects.toThrow("Path is read-only");
  });

  it.runIf(process.platform !== "win32")(
    "blocks write to nested path in readOnlyPaths when intermediate dirs don't exist",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-readonly-test-"));
      const workspaceDir = path.join(tmpDir, "workspace");
      const readonlyDir = path.join(tmpDir, "readonly");
      await fs.mkdir(workspaceDir);
      // Note: NOT creating readonlyDir - testing nested path

      const tool = createHostWorkspaceWriteTool(workspaceDir, {
        readOnlyPaths: [readonlyDir],
      });

      // Writing to nested path in read-only directory should be blocked
      // because ancestor /readonly is in readOnlyPaths
      await expect(
        tool.execute("test", {
          path: path.join(readonlyDir, "a", "b", "test.txt"),
          content: "hello",
        }),
      ).rejects.toThrow("Path is read-only");
    },
  );
});
