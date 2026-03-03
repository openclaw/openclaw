import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOpenClawReadTool } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

vi.mock("./sandbox-paths.js", () => ({
  assertSandboxPath: vi.fn(async () => ({ resolved: "/tmp", relative: "" })),
}));

describe("createOpenClawReadTool directory guard (#32889)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-read-dir-"));
    await fs.writeFile(path.join(tmpDir, "a.txt"), "content-a");
    await fs.writeFile(path.join(tmpDir, "b.txt"), "content-b");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeBaseTool(): AnyAgentTool {
    return {
      name: "Read",
      description: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: vi.fn(async () => {
        throw new Error("EISDIR: illegal operation on a directory, read");
      }),
    } as unknown as AnyAgentTool;
  }

  it("returns directory listing instead of EISDIR error", async () => {
    const base = makeBaseTool();
    const tool = createOpenClawReadTool(base);

    const result = await tool.execute("tc1", { path: tmpDir });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

    expect(text).toContain("is a directory");
    expect(text).toContain("a.txt");
    expect(text).toContain("b.txt");
    expect((base as { execute: ReturnType<typeof vi.fn> }).execute).not.toHaveBeenCalled();
  });

  it("returns empty directory message for empty dirs", async () => {
    const emptyDir = path.join(tmpDir, "empty-sub");
    await fs.mkdir(emptyDir, { recursive: true });

    const base = makeBaseTool();
    const tool = createOpenClawReadTool(base);

    const result = await tool.execute("tc1", { path: emptyDir });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

    expect(text).toContain("is a directory");
    expect(text).toContain("(empty directory)");
  });

  it("delegates to base tool for regular files", async () => {
    const filePath = path.join(tmpDir, "a.txt");
    const baseTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: vi.fn(async () => ({
        content: [{ type: "text", text: "file content" }],
      })),
    } as unknown as AnyAgentTool;

    const tool = createOpenClawReadTool(baseTool);
    const result = await tool.execute("tc1", { path: filePath });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

    expect(text).toBe("file content");
    expect((baseTool as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalled();
  });
});
