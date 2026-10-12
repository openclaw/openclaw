import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffArtifactStore } from "./store.js";
import { createDiffStoreHarness, expireDiffArtifactForTest } from "./test-helpers.js";

const metadata = { version: 1, kind: "rendered_file", format: "png" } as const;
const ttlMs = 60_000;

describe("DiffArtifactStore bulk cleanup", () => {
  let fixture: Awaited<ReturnType<typeof createDiffStoreHarness>>;

  beforeEach(async () => {
    fixture = await createDiffStoreHarness("openclaw-diffs-bulk-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  async function file(id: string, old = false) {
    const directory = path.join(fixture.rootDir, id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "preview.png"), id);
    if (old) {
      const time = new Date(Date.now() - 25 * 60 * 60 * 1_000);
      await fs.utimes(directory, time, time);
    }
  }

  it.each(["expired", "orphan"] as const)(
    "cleans 129 %s materializations through the real shared reader while preserving live files",
    async (kind) => {
      const live = "f".repeat(20);
      await fixture.blobStore.register(live, new Uint8Array(), metadata);
      await file(live, true);
      for (let index = 0; index < 129; index += 1) {
        const id = index.toString(16).padStart(20, "0");
        await file(id, kind === "orphan");
        if (kind === "expired") {
          await fixture.blobStore.register(id, new Uint8Array(), metadata, { ttlMs });
          await expireDiffArtifactForTest(fixture.rootDir, id, ttlMs);
        }
      }

      const lookup = vi.spyOn(fixture.blobStore, "lookup");
      const remove = vi.spyOn(fs, "rm");
      try {
        await fixture.store.cleanupExpired();

        expect(await fs.readdir(fixture.rootDir)).toEqual([live]);
        expect(await fs.readFile(path.join(fixture.rootDir, live, "preview.png"), "utf8")).toBe(
          live,
        );
        expect((await fixture.blobStore.entries()).map((entry) => entry.key)).toEqual([live]);
      } finally {
        // Also drain the unfixed implementation during the negative control.
        await Promise.allSettled(lookup.mock.results.map((result) => result.value));
        await Promise.allSettled(remove.mock.results.map((result) => result.value));
      }
    },
  );

  it("scheduled cleanup joins accepted filesystem work before reporting a sibling read failure", async () => {
    const heldId = "a".repeat(20);
    const failedId = "b".repeat(20);
    for (const id of [heldId, failedId]) {
      await file(id);
      await fixture.blobStore.register(id, new Uint8Array(), metadata, { ttlMs });
      await expireDiffArtifactForTest(fixture.rootDir, id, ttlMs);
    }
    const heldDirectory = path.join(fixture.rootDir, heldId);
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const failure = new Error("fixture Blob lookup failed");
    const lookup = fixture.blobStore.lookup.bind(fixture.blobStore);
    vi.spyOn(fixture.blobStore, "lookup").mockImplementation(async (key) => {
      if (key === failedId) {
        throw failure;
      }
      return await lookup(key);
    });
    const remove = fs.rm.bind(fs);
    const removals = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === heldDirectory) {
        started.resolve();
        await release.promise;
      }
      return await remove(target, options);
    });
    const warn = vi.fn();
    const store = new DiffArtifactStore({
      rootDir: fixture.rootDir,
      blobStore: fixture.blobStore,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const joinedSettled = vi.fn<() => void>();
    const stopped = vi.fn<() => void>();
    store.scheduleCleanup();
    const stopping = store.stopCleanup().then(stopped);
    const joined = store.cleanupExpired().then(
      () => joinedSettled(),
      (error: unknown) => {
        joinedSettled();
        return error;
      },
    );
    try {
      await started.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(joinedSettled).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      release.resolve();
      expect(await joined).toBe(failure);
      await stopping;
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
      await expect(fs.stat(heldDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(fixture.rootDir, failedId, "preview.png"), "utf8")).toBe(
        failedId,
      );
    } finally {
      release.resolve();
      await Promise.allSettled([joined, stopping]);
      await Promise.allSettled(removals.mock.results.map((result) => result.value));
      await store.stopCleanup();
    }
  });
});
