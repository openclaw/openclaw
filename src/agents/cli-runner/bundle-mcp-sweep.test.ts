import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_MCP_TEMP_PREFIX, sweepOrphanedBundleMcpTempDirs } from "./bundle-mcp-sweep.js";

const OLD_MTIME = new Date(Date.now() - 24 * 60 * 60 * 1000);

async function createTempConfigDir(root: string, suffix: string, options?: { old?: boolean }) {
  const dir = path.join(root, `${BUNDLE_MCP_TEMP_PREFIX}${suffix}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "mcp.json"), `{"mcpServers":{}}\n`, "utf-8");
  if (options?.old !== false) {
    await fs.utimes(dir, OLD_MTIME, OLD_MTIME);
  }
  return dir;
}

describe("sweepOrphanedBundleMcpTempDirs", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-sweep-test-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("removes dirs no live process references (gateway died with runs in flight)", async () => {
    const orphan = await createTempConfigDir(root, "orphan");
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated --flag"],
    });
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("keeps dirs referenced by a live CLI child argv (persistent live session, #73244)", async () => {
    const live = await createTempConfigDir(root, "live");
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => [
        `claude --strict-mcp-config --mcp-config ${path.join(live, "mcp.json")}`,
      ],
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([live]);
    await expect(fs.stat(live)).resolves.toBeDefined();
  });

  it("keeps dirs referenced by a concurrent gateway instance's child", async () => {
    const other = await createTempConfigDir(root, "other-instance");
    const orphan = await createTempConfigDir(root, "orphan");
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => [`claude --mcp-config ${path.join(other, "mcp.json")} --other-flag`],
    });
    expect(result.removed).toEqual([orphan]);
    expect(result.kept).toEqual([other]);
  });

  it("keeps recent dirs inside the spawn grace window (child not spawned yet)", async () => {
    const fresh = await createTempConfigDir(root, "fresh", { old: false });
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([fresh]);
    await expect(fs.stat(fresh)).resolves.toBeDefined();
  });

  it("fails closed when the process scan yields nothing", async () => {
    const orphan = await createTempConfigDir(root, "orphan");
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => [],
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([orphan]);
    await expect(fs.stat(orphan)).resolves.toBeDefined();
  });

  it("removes legacy empty dirs (mcp.json already gone) with no live reference", async () => {
    const empty = path.join(root, `${BUNDLE_MCP_TEMP_PREFIX}legacy-empty`);
    await fs.mkdir(empty, { recursive: true });
    await fs.utimes(empty, OLD_MTIME, OLD_MTIME);
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
    });
    expect(result.removed).toEqual([empty]);
  });

  it("ignores non-matching entries and missing roots", async () => {
    await fs.mkdir(path.join(root, "unrelated-dir"));
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node"],
    });
    expect(result.removed).toEqual([]);
    const missing = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: path.join(root, "does-not-exist"),
      listCommandLines: () => ["node"],
    });
    expect(missing).toEqual({ removed: [], kept: [] });
  });
});
