import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepOrphanedBundleMcpTempDirs } from "./bundle-mcp-sweep.js";

// Kept in sync with the module-private prefix in bundle-mcp-sweep.ts.
const BUNDLE_MCP_TEMP_PREFIX = "openclaw-cli-mcp-";
const OLD_MTIME = new Date(Date.now() - 24 * 60 * 60 * 1000);
const BOOT = "a1b2c3d4"; // 8-hex test boot tag
const START = "100"; // default owner process start ticks

type Owner = { pid: number; boot?: string; start?: string };

/** Build a temp dir name; owner identity is encoded in the name (or omitted = legacy). */
function dirName(suffix: string, owner?: Owner): string {
  if (!owner) {
    return `${BUNDLE_MCP_TEMP_PREFIX}legacy${suffix}`;
  }
  return `${BUNDLE_MCP_TEMP_PREFIX}${owner.pid}-${owner.boot ?? BOOT}-${owner.start ?? START}-${suffix}`;
}

async function createDir(
  root: string,
  suffix: string,
  options?: { old?: boolean; owner?: Owner; withMcpJson?: boolean },
) {
  const dir = path.join(root, dirName(suffix, options?.owner));
  await fs.mkdir(dir, { recursive: true });
  if (options?.withMcpJson !== false) {
    await fs.writeFile(path.join(dir, "mcp.json"), `{"mcpServers":{}}\n`, "utf-8");
  }
  if (options?.old !== false) {
    await fs.utimes(dir, OLD_MTIME, OLD_MTIME);
  }
  return dir;
}

// Owner-aware defaults: on this host the encoded owner is alive with a matching
// start time. Individual tests override isPidAlive/readStartTicks/currentBoot.
function sweep(root: string, over?: Parameters<typeof sweepOrphanedBundleMcpTempDirs>[0]) {
  return sweepOrphanedBundleMcpTempDirs({
    tmpRoot: root,
    currentBoot: BOOT,
    listCommandLines: () => ["node /usr/bin/unrelated"],
    isPidAlive: () => true,
    readStartTicks: async () => START,
    ...over,
  });
}

describe("sweepOrphanedBundleMcpTempDirs", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-sweep-test-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("removes legacy dirs no live process references (gateway died with runs in flight)", async () => {
    const orphan = await createDir(root, "orphan");
    const result = await sweep(root);
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("keeps dirs referenced by a live CLI child argv (persistent live session, #73244)", async () => {
    const live = await createDir(root, "live");
    const result = await sweep(root, {
      listCommandLines: () => [
        `claude --strict-mcp-config --mcp-config ${path.join(live, "mcp.json")}`,
      ],
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([live]);
    await expect(fs.stat(live)).resolves.toBeDefined();
  });

  it("keeps dirs referenced by a concurrent gateway instance's child", async () => {
    const other = await createDir(root, "other-instance");
    const orphan = await createDir(root, "orphan");
    const result = await sweep(root, {
      listCommandLines: () => [`claude --mcp-config ${path.join(other, "mcp.json")} --other-flag`],
    });
    expect(result.removed).toEqual([orphan]);
    expect(result.kept).toEqual([other]);
  });

  it("keeps recent legacy dirs inside the spawn grace window (child not spawned yet)", async () => {
    const fresh = await createDir(root, "fresh", { old: false });
    const result = await sweep(root);
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([fresh]);
    await expect(fs.stat(fresh)).resolves.toBeDefined();
  });

  it("fails closed when the process scan yields nothing", async () => {
    const orphan = await createDir(root, "orphan");
    const result = await sweep(root, { listCommandLines: () => [] });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([orphan]);
    await expect(fs.stat(orphan)).resolves.toBeDefined();
  });

  it("keeps an aged, unreferenced dir whose owning gateway is still alive (queued run before child spawn)", async () => {
    const queued = await createDir(root, "queued", { owner: { pid: 4242 } });
    const result = await sweep(root, {
      isPidAlive: (pid) => pid === 4242,
      readStartTicks: async () => START, // same process — start matches the name
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([queued]);
    await expect(fs.stat(queued)).resolves.toBeDefined();
  });

  it("removes an aged, unreferenced dir whose owning gateway is dead", async () => {
    const orphan = await createDir(root, "dead-owner", { owner: { pid: 4242 } });
    const result = await sweep(root, { isPidAlive: () => false });
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("removes an aged, unreferenced dir whose owner boot tag predates a reboot (pid may be reused)", async () => {
    const orphan = await createDir(root, "rebooted", { owner: { pid: 4242, boot: "deadbeef" } });
    const result = await sweep(root, {
      currentBoot: BOOT, // != "deadbeef"
      isPidAlive: () => true, // pid reused after reboot must not protect the dir
      readStartTicks: async () => START,
    });
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("removes an aged dir whose pid was reused (alive pid, mismatched start time)", async () => {
    const orphan = await createDir(root, "pid-reuse", { owner: { pid: 4242, start: "100" } });
    const result = await sweep(root, {
      isPidAlive: () => true, // pid 4242 is alive...
      readStartTicks: async () => "999999", // ...but a DIFFERENT process (start mismatch)
    });
    expect(result.removed).toEqual([orphan]);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("keeps a live-owned dir when start time cannot be verified (off-Linux/hidden, over-protect)", async () => {
    const queued = await createDir(root, "no-start", { owner: { pid: 4242 } });
    const result = await sweep(root, {
      isPidAlive: () => true,
      readStartTicks: async () => undefined, // cannot verify → trust the live pid
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([queued]);
  });

  it("reclaims a FRESH dead-owner dir despite the spawn grace window", async () => {
    // A gateway that crashed moments ago leaves fresh debris; the one-shot
    // startup sweep must reclaim it now, not leak it until the next restart.
    const fresh = await createDir(root, "fresh-dead", { old: false, owner: { pid: 4242 } });
    const result = await sweep(root, { isPidAlive: () => false });
    expect(result.removed).toEqual([fresh]);
    await expect(fs.stat(fresh)).rejects.toThrow();
  });

  it("treats an unparseable owner name as legacy (aged → removed)", async () => {
    // A prefixed dir whose name does not encode a valid owner (e.g. pid 0) is
    // legacy, not owned — it follows the age + argv rule.
    const dir = path.join(root, `${BUNDLE_MCP_TEMP_PREFIX}0-${BOOT}-${START}-badpid`);
    await fs.mkdir(dir, { recursive: true });
    await fs.utimes(dir, OLD_MTIME, OLD_MTIME);
    const result = await sweep(root);
    expect(result.removed).toEqual([dir]);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("keeps a removal candidate whose child spawns between the argv scan and removal", async () => {
    const racing = await createDir(root, "argv-race", { owner: { pid: 4242 } });
    let scan = 0;
    const result = await sweep(root, {
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

  it("removes legacy empty dirs (mcp.json already gone) with no live reference", async () => {
    const empty = await createDir(root, "empty", { withMcpJson: false });
    const result = await sweep(root);
    expect(result.removed).toEqual([empty]);
  });

  it("ignores non-matching entries and missing roots", async () => {
    await fs.mkdir(path.join(root, "unrelated-dir"));
    const result = await sweep(root, { listCommandLines: () => ["node"] });
    expect(result.removed).toEqual([]);
    const missing = await sweep(path.join(root, "does-not-exist"), {
      listCommandLines: () => ["node"],
    });
    expect(missing).toEqual({ removed: [], kept: [] });
  });
});
