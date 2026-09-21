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
    return directory;
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

      const reads: Promise<unknown>[] = [];
      const removals: Promise<unknown>[] = [];
      const lookup = fixture.blobStore.lookup.bind(fixture.blobStore);
      vi.spyOn(fixture.blobStore, "lookup").mockImplementation((key) => {
        const pending = lookup(key);
        reads.push(pending);
        return pending;
      });
      const remove = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation((target, options) => {
        const pending = remove(target, options);
        removals.push(pending);
        return pending;
      });
      try {
        await fixture.store.cleanupExpired();

        expect(await fs.readdir(fixture.rootDir)).toEqual([live]);
        expect(await fs.readFile(path.join(fixture.rootDir, live, "preview.png"), "utf8")).toBe(
          live,
        );
        expect((await fixture.blobStore.entries()).map((entry) => entry.key)).toEqual([live]);
      } finally {
        // Also drain the unfixed implementation during the negative control.
        await Promise.allSettled(reads);
        await Promise.allSettled(removals);
      }
    },
  );

  it.each(["direct", "scheduled"] as const)(
    "%s cleanup joins accepted filesystem work before reporting a sibling read failure",
    async (mode) => {
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
      const removed = createDeferred<void>();
      const failure = new Error("fixture Blob lookup failed");
      const lookup = fixture.blobStore.lookup.bind(fixture.blobStore);
      vi.spyOn(fixture.blobStore, "lookup").mockImplementation(async (key) => {
        if (key === failedId) {
          throw failure;
        }
        return await lookup(key);
      });
      const remove = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        if (target === heldDirectory) {
          started.resolve();
          await release.promise;
          try {
            return await remove(target, options);
          } finally {
            removed.resolve();
          }
        }
        return await remove(target, options);
      });
      const warn = vi.fn();
      const store = new DiffArtifactStore({
        rootDir: fixture.rootDir,
        blobStore: fixture.blobStore,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      let settled = false;
      let joinedSettled = false;
      let stopped = false;
      let operation: Promise<void>;
      if (mode === "direct") {
        operation = store.cleanupExpired();
      } else {
        store.scheduleCleanup();
        operation = store.stopCleanup();
      }
      const observe = (pending: Promise<void>, finished: () => void) =>
        pending.then(
          () => {
            finished();
            return { error: undefined };
          },
          (error: unknown) => {
            finished();
            return { error };
          },
        );
      const outcome = observe(operation, () => {
        settled = true;
      });
      const joined = observe(store.cleanupExpired(), () => {
        joinedSettled = true;
      });
      const stopping = store.stopCleanup().then(() => {
        stopped = true;
      });
      try {
        await started.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(joinedSettled).toBe(false);
        expect(stopped).toBe(false);
        expect(warn).not.toHaveBeenCalled();
        release.resolve();
        expect((await outcome).error).toBe(mode === "direct" ? failure : undefined);
        expect((await joined).error).toBe(failure);
        await stopping;
        if (mode === "scheduled") {
          expect(warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
        }
        await expect(fs.stat(heldDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(fixture.rootDir, failedId, "preview.png"), "utf8")).toBe(
          failedId,
        );
      } finally {
        release.resolve();
        await Promise.allSettled([outcome, joined, stopping]);
        await removed.promise;
        await store.stopCleanup();
      }
    },
  );
});
