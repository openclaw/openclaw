import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClawdbotCodingTools } from "./pi-tools.js";
import { createSandboxedReadTool } from "./pi-tools.read.js";

describe("createClawdbotCodingTools", () => {
  it("applies sandbox path guards to file_path alias", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sbx-"));
    const outsidePath = path.join(os.tmpdir(), "clawdbot-outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    try {
      const readTool = createSandboxedReadTool(tmpDir);
      await expect(readTool.execute("tool-sbx-1", { file_path: outsidePath })).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(outsidePath, { force: true });
    }
  });
  it("falls back to process.cwd() when workspaceDir not provided", () => {
    const prevCwd = process.cwd();
    const tools = createClawdbotCodingTools();
    // Tools should be created without error
    expect(tools.some((tool) => tool.name === "read")).toBe(true);
    expect(tools.some((tool) => tool.name === "write")).toBe(true);
    expect(tools.some((tool) => tool.name === "edit")).toBe(true);
    // cwd should be unchanged
    expect(process.cwd()).toBe(prevCwd);
  });
});
