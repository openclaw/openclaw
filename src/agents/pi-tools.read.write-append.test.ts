import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandboxedWriteTool, createHostWorkspaceWriteTool } from "./pi-tools.read.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

describe("createHostWorkspaceWriteTool append mode", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-append-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("overwrites file by default (no append)", async () => {
    const tool = createHostWorkspaceWriteTool(tmpDir);
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "original content", "utf-8");

    await tool.execute("call1", { path: "test.txt", content: "new content" }, undefined as never);
    const result = await fs.readFile(filePath, "utf-8");
    expect(result).toBe("new content");
  });

  it("appends to file when append=true", async () => {
    const tool = createHostWorkspaceWriteTool(tmpDir);
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "line 1\n", "utf-8");

    const result = await tool.execute(
      "call1",
      { path: "test.txt", content: "line 2\n", append: true },
      undefined as never,
    );
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("line 1\nline 2\n");
    expect(JSON.stringify(result)).toContain("Successfully appended");
  });

  it("creates file when appending to non-existent file", async () => {
    const tool = createHostWorkspaceWriteTool(tmpDir);
    const filePath = path.join(tmpDir, "new-file.txt");

    await tool.execute(
      "call1",
      { path: "new-file.txt", content: "first line\n", append: true },
      undefined as never,
    );
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("first line\n");
  });

  it("creates parent directories when appending", async () => {
    const tool = createHostWorkspaceWriteTool(tmpDir);
    const filePath = path.join(tmpDir, "sub", "dir", "file.txt");

    await tool.execute(
      "call1",
      { path: "sub/dir/file.txt", content: "nested\n", append: true },
      undefined as never,
    );
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("nested\n");
  });

  it("schema includes append property", () => {
    const tool = createHostWorkspaceWriteTool(tmpDir);
    const params = (tool.parameters ?? tool.schema) as Record<string, unknown>;
    const props = params?.properties as Record<string, unknown>;
    expect(props).toHaveProperty("append");
  });

  it("workspaceOnly mode blocks append outside workspace", async () => {
    const tool = createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: true });

    const result = await tool.execute(
      "call1",
      { path: "/etc/passwd", content: "bad\n", append: true },
      undefined as never,
    );
    expect(JSON.stringify(result)).toContain("Error");
  });

  it("allows append outside workspace when workspaceOnly=false", async () => {
    const tool = createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
    const outsideFile = path.join(path.dirname(tmpDir), "outside-append.txt");
    await fs.writeFile(outsideFile, "before\n", "utf-8");

    await tool.execute(
      "call1",
      { path: outsideFile, content: "after\n", append: true },
      undefined as never,
    );

    expect(await fs.readFile(outsideFile, "utf-8")).toBe("before\nafter\n");
    await fs.rm(outsideFile, { force: true });
  });

  it("allows append outside workspace when workspaceOnly is unset", async () => {
    const tool = createHostWorkspaceWriteTool(tmpDir);
    const outsideFile = path.join(path.dirname(tmpDir), "outside-unset-append.txt");
    await fs.writeFile(outsideFile, "before\n", "utf-8");

    await tool.execute(
      "call1",
      { path: outsideFile, content: "after\n", append: true },
      undefined as never,
    );

    expect(await fs.readFile(outsideFile, "utf-8")).toBe("before\nafter\n");
    await fs.rm(outsideFile, { force: true });
  });

  it("rejects whitespace-only append content", async () => {
    const tool = createHostWorkspaceWriteTool(tmpDir);
    const result = await tool.execute(
      "call1",
      { path: "test.txt", content: "   ", append: true },
      undefined as never,
    );

    expect(JSON.stringify(result)).toContain("content is required");
    await expect(fs.access(path.join(tmpDir, "test.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("normalizes structured append content before writing", async () => {
    const tool = createHostWorkspaceWriteTool(tmpDir);
    const filePath = path.join(tmpDir, "structured.txt");
    await fs.writeFile(filePath, "before\n", "utf-8");

    await tool.execute(
      "call1",
      {
        path: "structured.txt",
        content: [{ type: "text", text: "after\n" }],
        append: true,
      },
      undefined as never,
    );

    expect(await fs.readFile(filePath, "utf-8")).toBe("before\nafter\n");
  });

  it("rejects malformed append flags in sandbox mode instead of overwriting", async () => {
    const tool = createSandboxedWriteTool({
      root: tmpDir,
      bridge: createHostSandboxFsBridge(tmpDir),
    });
    const filePath = path.join(tmpDir, "sandbox.txt");
    await fs.writeFile(filePath, "original\n", "utf-8");

    const result = await tool.execute(
      "call1",
      { path: "sandbox.txt", content: "appended?\n", append: "true" },
      undefined as never,
    );

    expect(JSON.stringify(result)).toContain("append must be a boolean");
    expect(await fs.readFile(filePath, "utf-8")).toBe("original\n");
  });
});
