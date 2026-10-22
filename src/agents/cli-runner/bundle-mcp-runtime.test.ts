import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTemporaryBundleMcpJson } from "./bundle-mcp-runtime.js";

const LEAK_PROBE_PREFIX = "openclaw-mcp-leak-regression-";

async function probeDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((entry) => entry.startsWith(LEAK_PROBE_PREFIX));
}

function circularValue(): Record<string, unknown> {
  const value: Record<string, unknown> = { mcpServers: {} };
  value.self = value;
  return value;
}

describe("writeTemporaryBundleMcpJson", () => {
  it("removes the temp directory when the non-atomic write fails", async () => {
    const before = new Set(await probeDirs());
    await expect(
      writeTemporaryBundleMcpJson(LEAK_PROBE_PREFIX, circularValue(), "mcp.json", false),
    ).rejects.toThrow();
    const leaked = (await probeDirs()).filter((entry) => !before.has(entry));
    expect(leaked).toEqual([]);
  });

  it("removes the temp directory when the atomic write fails", async () => {
    const before = new Set(await probeDirs());
    await expect(
      writeTemporaryBundleMcpJson(LEAK_PROBE_PREFIX, circularValue(), "settings.json"),
    ).rejects.toThrow();
    const leaked = (await probeDirs()).filter((entry) => !before.has(entry));
    expect(leaked).toEqual([]);
  });

  it("removes the directory via cleanup after a successful write", async () => {
    const { filePath, cleanup } = await writeTemporaryBundleMcpJson(
      LEAK_PROBE_PREFIX,
      { mcpServers: {} },
      "mcp.json",
      false,
    );
    const dirName = path.basename(path.dirname(filePath));
    expect(dirName.startsWith(LEAK_PROBE_PREFIX)).toBe(true);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toContain("mcpServers");
    await cleanup();
    expect(await probeDirs()).not.toContain(dirName);
  });
});
