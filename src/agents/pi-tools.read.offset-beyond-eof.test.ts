import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxedReadTool } from "./pi-tools.read.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlock = content.find(
    (block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  ) as { text?: string } | undefined;
  return textBlock?.text ?? "";
}

describe("read tool: offset-beyond-EOF graceful truncation", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("offset exactly 1 beyond last line does not throw and returns content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-eof-"));
    const filePath = path.join(tmpDir, "short.txt");
    const lines = Array.from({ length: 10 }, (_u, i) => `line-${i + 1}`);
    await fs.writeFile(filePath, lines.join("\n"), "utf8");

    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: createHostSandboxFsBridge(tmpDir),
    });

    // offset=11 is 1 beyond the 10-line file
    const result = await readTool.execute("eof-1", { path: "short.txt", offset: 11 });
    const text = extractToolText(result);
    expect(text).toBeTruthy();
    expect(text).toContain("line-");
  });

  it("offset far beyond last line does not throw and returns content from the last line", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-eof-far-"));
    const filePath = path.join(tmpDir, "small.txt");
    // No trailing newline so "world" is the content of the last line
    await fs.writeFile(filePath, "hello\nworld", "utf8");

    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: createHostSandboxFsBridge(tmpDir),
    });

    // offset=99999 far beyond the 2-line file
    const result = await readTool.execute("eof-far", { path: "small.txt", offset: 99999 });
    const text = extractToolText(result);
    expect(text).toContain("world");
  });

  it("empty file with offset > 0 resolves gracefully without throwing", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-eof-empty-"));
    const filePath = path.join(tmpDir, "empty.txt");
    await fs.writeFile(filePath, "", "utf8");

    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: createHostSandboxFsBridge(tmpDir),
    });

    // The upstream tool handles empty files gracefully (returns empty content, does not throw)
    await expect(
      readTool.execute("eof-empty", { path: "empty.txt", offset: 5 }),
    ).resolves.toBeDefined();
  });

  it("explicit limit + offset beyond EOF does not throw and returns content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-eof-limit-"));
    const filePath = path.join(tmpDir, "limited.txt");
    const lines = Array.from({ length: 20 }, (_u, i) => `row-${i + 1}`);
    await fs.writeFile(filePath, lines.join("\n"), "utf8");

    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: createHostSandboxFsBridge(tmpDir),
    });

    // offset=999 beyond 20-line file, with explicit limit=5
    const result = await readTool.execute("eof-limit", {
      path: "limited.txt",
      offset: 999,
      limit: 5,
    });
    const text = extractToolText(result);
    expect(text).toBeTruthy();
    expect(text).toContain("row-");
  });
});
