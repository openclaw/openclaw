import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../../../src/auto-reply/commands-registry.js";
import { computeCommandHash, shouldSkipDeploy, updateDeployCache } from "./command-deploy-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpecs(overrides: Partial<NativeCommandSpec>[] = []): NativeCommandSpec[] {
  return [
    { name: "ask", description: "Ask a question", acceptsArgs: true },
    { name: "help", description: "Show help", acceptsArgs: false },
    ...overrides.map((o, i) => ({
      name: `extra-${i}`,
      description: "extra",
      acceptsArgs: false,
      ...o,
    })),
  ];
}

async function writeCacheFile(dir: string, botId: string, content: unknown): Promise<void> {
  const file = path.join(dir, `${botId}.json`);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(content), "utf8");
}

// ---------------------------------------------------------------------------
// computeCommandHash
// ---------------------------------------------------------------------------

describe("computeCommandHash", () => {
  it("is deterministic for the same specs", () => {
    const specs = makeSpecs();
    expect(computeCommandHash(specs)).toBe(computeCommandHash(specs));
  });

  it("produces different hashes for different specs", () => {
    const a = [{ name: "ask", description: "Ask", acceptsArgs: true }];
    const b = [{ name: "ask", description: "Ask something else", acceptsArgs: true }];
    expect(computeCommandHash(a)).not.toBe(computeCommandHash(b));
  });

  it("is insensitive to the order specs are supplied in", () => {
    const specs = makeSpecs();
    const reversed = [...specs].reverse();
    expect(computeCommandHash(specs)).toBe(computeCommandHash(reversed));
  });

  it("is insensitive to object key ordering within a spec", () => {
    // Construct two objects with the same fields in different order.
    const a: NativeCommandSpec[] = [{ name: "ask", description: "Ask", acceptsArgs: true }];
    const b: NativeCommandSpec[] = [
      Object.fromEntries(Object.entries(a[0]!).reverse()) as unknown as NativeCommandSpec,
    ];
    expect(computeCommandHash(a)).toBe(computeCommandHash(b));
  });

  it("produces different hashes when a spec is added", () => {
    const base = makeSpecs();
    const extended = [...base, { name: "new-cmd", description: "new", acceptsArgs: false }];
    expect(computeCommandHash(base)).not.toBe(computeCommandHash(extended));
  });

  it("produces different hashes when acceptsArgs changes", () => {
    const a: NativeCommandSpec[] = [{ name: "ask", description: "Ask", acceptsArgs: true }];
    const b: NativeCommandSpec[] = [{ name: "ask", description: "Ask", acceptsArgs: false }];
    expect(computeCommandHash(a)).not.toBe(computeCommandHash(b));
  });

  it("returns a 64-char hex string (SHA-256)", () => {
    const hash = computeCommandHash(makeSpecs());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles an empty spec list", () => {
    const hash = computeCommandHash([]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Empty list should differ from a non-empty list.
    expect(hash).not.toBe(computeCommandHash(makeSpecs()));
  });
});

// ---------------------------------------------------------------------------
// shouldSkipDeploy
// ---------------------------------------------------------------------------

describe("shouldSkipDeploy", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "discord-cache-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false when no cache file exists (first run)", async () => {
    const specs = makeSpecs();
    const result = await shouldSkipDeploy(specs, tmpDir, "bot-123");
    expect(result).toBe(false);
  });

  it("returns true when the cached hash matches current specs", async () => {
    const specs = makeSpecs();
    const hash = computeCommandHash(specs);
    await writeCacheFile(tmpDir, "bot-123", { hash, updatedAt: Date.now() });

    const result = await shouldSkipDeploy(specs, tmpDir, "bot-123");
    expect(result).toBe(true);
  });

  it("returns false when specs have changed since last deploy", async () => {
    const oldSpecs = makeSpecs();
    const oldHash = computeCommandHash(oldSpecs);
    await writeCacheFile(tmpDir, "bot-123", { hash: oldHash, updatedAt: Date.now() });

    const newSpecs = [...oldSpecs, { name: "newcmd", description: "new", acceptsArgs: false }];
    const result = await shouldSkipDeploy(newSpecs, tmpDir, "bot-123");
    expect(result).toBe(false);
  });

  it("returns false when the cache file contains invalid JSON", async () => {
    const file = path.join(tmpDir, "bot-123.json");
    await fs.promises.mkdir(tmpDir, { recursive: true });
    await fs.promises.writeFile(file, "NOT_VALID_JSON", "utf8");

    const result = await shouldSkipDeploy(makeSpecs(), tmpDir, "bot-123");
    expect(result).toBe(false);
  });

  it("returns false when the cache file is missing the hash field", async () => {
    await writeCacheFile(tmpDir, "bot-123", { updatedAt: Date.now() });

    const result = await shouldSkipDeploy(makeSpecs(), tmpDir, "bot-123");
    expect(result).toBe(false);
  });

  it("returns false when hash field is not a string", async () => {
    await writeCacheFile(tmpDir, "bot-123", { hash: 42, updatedAt: Date.now() });

    const result = await shouldSkipDeploy(makeSpecs(), tmpDir, "bot-123");
    expect(result).toBe(false);
  });

  it("uses the botId to scope the cache file (different bots don't share cache)", async () => {
    const specs = makeSpecs();
    const hash = computeCommandHash(specs);
    // Write cache for bot-A only.
    await writeCacheFile(tmpDir, "bot-A", { hash, updatedAt: Date.now() });

    expect(await shouldSkipDeploy(specs, tmpDir, "bot-A")).toBe(true);
    expect(await shouldSkipDeploy(specs, tmpDir, "bot-B")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateDeployCache
// ---------------------------------------------------------------------------

describe("updateDeployCache", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "discord-cache-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a JSON file with the correct hash", async () => {
    const specs = makeSpecs();
    const expectedHash = computeCommandHash(specs);

    await updateDeployCache(specs, tmpDir, "bot-123");

    const raw = await fs.promises.readFile(path.join(tmpDir, "bot-123.json"), "utf8");
    const parsed = JSON.parse(raw) as { hash: string; updatedAt: number };
    expect(parsed.hash).toBe(expectedHash);
  });

  it("writes an updatedAt timestamp", async () => {
    const before = Date.now();
    await updateDeployCache(makeSpecs(), tmpDir, "bot-123");
    const after = Date.now();

    const raw = await fs.promises.readFile(path.join(tmpDir, "bot-123.json"), "utf8");
    const parsed = JSON.parse(raw) as { hash: string; updatedAt: number };
    expect(parsed.updatedAt).toBeGreaterThanOrEqual(before);
    expect(parsed.updatedAt).toBeLessThanOrEqual(after);
  });

  it("creates the cache directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "discord-command-cache");
    await updateDeployCache(makeSpecs(), nestedDir, "bot-123");

    const exists = await fs.promises
      .access(path.join(nestedDir, "bot-123.json"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("overwrites an existing cache file with the new hash", async () => {
    const specs = makeSpecs();
    await writeCacheFile(tmpDir, "bot-123", { hash: "old-hash", updatedAt: 0 });
    await updateDeployCache(specs, tmpDir, "bot-123");

    const raw = await fs.promises.readFile(path.join(tmpDir, "bot-123.json"), "utf8");
    const parsed = JSON.parse(raw) as { hash: string };
    expect(parsed.hash).toBe(computeCommandHash(specs));
    expect(parsed.hash).not.toBe("old-hash");
  });

  it("scopes the cache file to the botId", async () => {
    const specsA = makeSpecs();
    const specsB = [{ name: "other", description: "other", acceptsArgs: false }];
    await updateDeployCache(specsA, tmpDir, "bot-A");
    await updateDeployCache(specsB, tmpDir, "bot-B");

    const rawA = JSON.parse(
      await fs.promises.readFile(path.join(tmpDir, "bot-A.json"), "utf8"),
    ) as { hash: string };
    const rawB = JSON.parse(
      await fs.promises.readFile(path.join(tmpDir, "bot-B.json"), "utf8"),
    ) as { hash: string };
    expect(rawA.hash).toBe(computeCommandHash(specsA));
    expect(rawB.hash).toBe(computeCommandHash(specsB));
    expect(rawA.hash).not.toBe(rawB.hash);
  });
});

// ---------------------------------------------------------------------------
// Integration: cache-hit/miss/force/fail using shouldSkipDeploy + updateDeployCache
// This mirrors the logic inside deployDiscordCommands.
// ---------------------------------------------------------------------------

async function runDeployWithCache(opts: {
  commandSpecs: NativeCommandSpec[];
  cacheDir: string;
  botId: string;
  forceDeployCommands: boolean;
  deploy: () => Promise<void>;
}): Promise<"skipped" | "deployed"> {
  if (!opts.forceDeployCommands) {
    const skip = await shouldSkipDeploy(opts.commandSpecs, opts.cacheDir, opts.botId);
    if (skip) {
      return "skipped";
    }
  }
  // Deploy — throws on failure (cache is NOT written in that case).
  await opts.deploy();
  // Write cache only after a successful deploy.
  await updateDeployCache(opts.commandSpecs, opts.cacheDir, opts.botId);
  return "deployed";
}

describe("deploy cache integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "discord-cache-int-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("triggers deploy and writes cache on first run (no cache file)", async () => {
    const specs = makeSpecs();
    const deploy = vi.fn().mockResolvedValue(undefined);

    const result = await runDeployWithCache({
      commandSpecs: specs,
      cacheDir: tmpDir,
      botId: "bot-1",
      forceDeployCommands: false,
      deploy,
    });

    expect(result).toBe("deployed");
    expect(deploy).toHaveBeenCalledOnce();
    // Cache must have been written.
    expect(await shouldSkipDeploy(specs, tmpDir, "bot-1")).toBe(true);
  });

  it("skips deploy when cache hash matches", async () => {
    const specs = makeSpecs();
    // Pre-populate cache with the current hash.
    await updateDeployCache(specs, tmpDir, "bot-1");
    const deploy = vi.fn().mockResolvedValue(undefined);

    const result = await runDeployWithCache({
      commandSpecs: specs,
      cacheDir: tmpDir,
      botId: "bot-1",
      forceDeployCommands: false,
      deploy,
    });

    expect(result).toBe("skipped");
    expect(deploy).not.toHaveBeenCalled();
  });

  it("deploys and updates cache when specs have changed", async () => {
    const oldSpecs = makeSpecs();
    await updateDeployCache(oldSpecs, tmpDir, "bot-1");

    const newSpecs = [...oldSpecs, { name: "newcmd", description: "new", acceptsArgs: false }];
    const deploy = vi.fn().mockResolvedValue(undefined);

    const result = await runDeployWithCache({
      commandSpecs: newSpecs,
      cacheDir: tmpDir,
      botId: "bot-1",
      forceDeployCommands: false,
      deploy,
    });

    expect(result).toBe("deployed");
    expect(deploy).toHaveBeenCalledOnce();
    // Cache should now reflect the new specs.
    expect(await shouldSkipDeploy(newSpecs, tmpDir, "bot-1")).toBe(true);
    expect(await shouldSkipDeploy(oldSpecs, tmpDir, "bot-1")).toBe(false);
  });

  it("does NOT update the cache when deploy fails", async () => {
    const specs = makeSpecs();
    const deploy = vi.fn().mockRejectedValue(new Error("deploy failed"));

    await expect(
      runDeployWithCache({
        commandSpecs: specs,
        cacheDir: tmpDir,
        botId: "bot-1",
        forceDeployCommands: false,
        deploy,
      }),
    ).rejects.toThrow("deploy failed");

    // Cache must NOT have been written — next restart should retry deploy.
    expect(await shouldSkipDeploy(specs, tmpDir, "bot-1")).toBe(false);
  });

  it("bypasses cache and deploys when forceDeployCommands is true", async () => {
    const specs = makeSpecs();
    // Pre-populate cache — normally this would cause a skip.
    await updateDeployCache(specs, tmpDir, "bot-1");
    const deploy = vi.fn().mockResolvedValue(undefined);

    const result = await runDeployWithCache({
      commandSpecs: specs,
      cacheDir: tmpDir,
      botId: "bot-1",
      forceDeployCommands: true,
      deploy,
    });

    expect(result).toBe("deployed");
    expect(deploy).toHaveBeenCalledOnce();
  });

  it("updates cache after a forced deploy so subsequent restarts can skip", async () => {
    const specs = makeSpecs();
    const deploy = vi.fn().mockResolvedValue(undefined);

    await runDeployWithCache({
      commandSpecs: specs,
      cacheDir: tmpDir,
      botId: "bot-1",
      forceDeployCommands: true,
      deploy,
    });

    // Next startup (no force) should skip because cache is now fresh.
    const nextDeploy = vi.fn().mockResolvedValue(undefined);
    const result = await runDeployWithCache({
      commandSpecs: specs,
      cacheDir: tmpDir,
      botId: "bot-1",
      forceDeployCommands: false,
      deploy: nextDeploy,
    });

    expect(result).toBe("skipped");
    expect(nextDeploy).not.toHaveBeenCalled();
  });
});
