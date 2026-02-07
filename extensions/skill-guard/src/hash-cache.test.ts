import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManifestResponse } from "./types.js";
import { HashCache } from "./hash-cache.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "sg-hc-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

const SAMPLE_MANIFEST: ManifestResponse = {
  store: { name: "Test", version: "v42" },
  syncIntervalSeconds: 60,
  blocklist: ["evil"],
  skills: {
    "web-search": {
      version: "1.0.0",
      fileCount: 1,
      files: { "SKILL.md": "abcd1234".repeat(8) },
    },
  },
};

describe("HashCache", () => {
  it("starts without data", () => {
    const dir = makeTmpDir();
    const cache = new HashCache(path.join(dir, "cache.json"));
    expect(cache.hasData()).toBe(false);
    expect(cache.getVersion()).toBeUndefined();
    expect(cache.getSkill("web-search")).toBeUndefined();
    expect(cache.getBlocklist()).toEqual([]);
  });

  it("update populates the cache", () => {
    const dir = makeTmpDir();
    const cache = new HashCache(path.join(dir, "cache.json"));
    cache.update(SAMPLE_MANIFEST);

    expect(cache.hasData()).toBe(true);
    expect(cache.getVersion()).toBe("v42");
    expect(cache.getSkill("web-search")?.fileCount).toBe(1);
    expect(cache.getBlocklist()).toEqual(["evil"]);
  });

  it("persists to disk and loads back", () => {
    const dir = makeTmpDir();
    const cachePath = path.join(dir, "sub", "cache.json");

    const cache1 = new HashCache(cachePath);
    cache1.update(SAMPLE_MANIFEST);

    const cache2 = new HashCache(cachePath);
    cache2.loadFromDisk();

    expect(cache2.hasData()).toBe(true);
    expect(cache2.getVersion()).toBe("v42");
    expect(cache2.getSkill("web-search")?.files["SKILL.md"]).toBe("abcd1234".repeat(8));
  });

  it("loadFromDisk handles missing file gracefully", () => {
    const dir = makeTmpDir();
    const cache = new HashCache(path.join(dir, "nonexistent.json"));
    cache.loadFromDisk();
    expect(cache.hasData()).toBe(false);
  });

  it("clear removes in-memory data", () => {
    const dir = makeTmpDir();
    const cache = new HashCache(path.join(dir, "cache.json"));
    cache.update(SAMPLE_MANIFEST);
    expect(cache.hasData()).toBe(true);
    cache.clear();
    expect(cache.hasData()).toBe(false);
  });
});
