import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLE_MCP_TEMP_PREFIX,
  sweepOrphanedBundleMcpTempDirs,
  writeBundleMcpOwnerMarker,
} from "./bundle-mcp-sweep.js";

const OLD_MTIME = new Date(Date.now() - 24 * 60 * 60 * 1000);
// Kept in sync with the module-private marker name in bundle-mcp-sweep.ts.
const BUNDLE_MCP_OWNER_MARKER = ".owner.json";

async function createTempConfigDir(
  root: string,
  suffix: string,
  options?: {
    old?: boolean;
    owner?: { pid: number; bootId?: string };
    corruptOwner?: boolean;
  },
) {
  const dir = path.join(root, `${BUNDLE_MCP_TEMP_PREFIX}${suffix}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "mcp.json"), `{"mcpServers":{}}\n`, "utf-8");
  if (options?.corruptOwner) {
    await fs.writeFile(path.join(dir, BUNDLE_MCP_OWNER_MARKER), "{ not valid json", "utf-8");
  } else if (options?.owner) {
    await fs.writeFile(
      path.join(dir, BUNDLE_MCP_OWNER_MARKER),
      `${JSON.stringify(options.owner)}\n`,
      "utf-8",
    );
  }
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

  it("keeps an aged, unreferenced dir whose owning gateway is still alive (queued run before child spawn)", async () => {
    const queued = await createTempConfigDir(root, "queued", { owner: { pid: 4242 } });
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
      isPidAlive: (pid) => pid === 4242, // the owning gateway is alive
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([queued]);
    await expect(fs.stat(queued)).resolves.toBeDefined();
  });

  it("removes an aged, unreferenced dir whose owning gateway is dead", async () => {
    const orphan = await createTempConfigDir(root, "dead-owner", { owner: { pid: 4242 } });
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
      isPidAlive: () => false, // owning gateway is gone
    });
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("removes an aged, unreferenced dir whose owner boot id predates a reboot (pid may be reused)", async () => {
    const orphan = await createTempConfigDir(root, "rebooted", {
      owner: { pid: 4242, bootId: "boot-before" },
    });
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
      currentBootId: "boot-after",
      isPidAlive: () => true, // pid reused after reboot must not protect the dir
    });
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("keeps a live-owned dir when the boot id still matches", async () => {
    const queued = await createTempConfigDir(root, "same-boot", {
      owner: { pid: 4242, bootId: "boot-a" },
    });
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
      currentBootId: "boot-a",
      isPidAlive: (pid) => pid === 4242,
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([queued]);
  });

  it("reclaims a FRESH dead-owner dir despite the spawn grace window", async () => {
    // A gateway that crashed moments ago leaves fresh debris; the one-shot
    // startup sweep must reclaim it now, not leak it until the next restart.
    const fresh = await createTempConfigDir(root, "fresh-dead", {
      old: false,
      owner: { pid: 4242 },
    });
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
      isPidAlive: () => false, // owning gateway is gone
    });
    expect(result.removed).toEqual([fresh]);
    await expect(fs.stat(fresh)).rejects.toThrow();
  });

  it("keeps a dir whose owner marker is unreadable/corrupt (unknown, fail-closed)", async () => {
    const unknown = await createTempConfigDir(root, "corrupt-marker", { corruptOwner: true });
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      listCommandLines: () => ["node /usr/bin/unrelated"],
      isPidAlive: () => false,
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([unknown]);
    await expect(fs.stat(unknown)).resolves.toBeDefined();
  });

  it("keeps a removal candidate whose child spawns between the argv scan and removal", async () => {
    const racing = await createTempConfigDir(root, "argv-race", { owner: { pid: 4242 } });
    let scan = 0;
    const result = await sweepOrphanedBundleMcpTempDirs({
      tmpRoot: root,
      // First scan: no reference (dead owner → removal candidate). Second scan
      // (immediately before rm): the CLI child has now spawned and references it.
      listCommandLines: () => {
        scan += 1;
        return scan === 1
          ? ["node /usr/bin/unrelated"]
          : [`claude --mcp-config ${path.join(racing, "mcp.json")}`];
      },
      isPidAlive: () => false,
    });
    expect(scan).toBe(2); // re-scan actually happened
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([racing]);
    await expect(fs.stat(racing)).resolves.toBeDefined();
  });

  it("writeBundleMcpOwnerMarker rejects when ownership cannot be recorded (fail-loud)", async () => {
    // A non-existent directory makes the marker write fail; the creator relies on
    // this rejection to roll back and never queue an unowned config.
    await expect(
      writeBundleMcpOwnerMarker(path.join(root, "does-not-exist-dir")),
    ).rejects.toThrow();
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
