import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiffArtifactStore } from "./store.js";
import { createDiffStoreHarness, expireDiffArtifactForTest } from "./test-helpers.js";

const metadata = { version: 1, kind: "rendered_file", format: "png" } as const;
const ttlMs = 60_000;
let fixture: Awaited<ReturnType<typeof createDiffStoreHarness>>;

beforeEach(async () => {
  fixture = await createDiffStoreHarness("openclaw-diffs-bulk-");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fixture.cleanup();
});

const artifactPath = (id: string, ...parts: string[]) => path.join(fixture.rootDir, id, ...parts);
const readPreview = (id: string) => fs.readFile(artifactPath(id, "preview.png"), "utf8");

async function file(id: string, old = false) {
  const directory = artifactPath(id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "preview.png"), id);
  if (old) {
    const time = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await fs.utimes(directory, time, time);
  }
  return directory;
}

it.each(["expired", "orphan"] as const)("cleans 129 %s files; keeps live files", async (kind) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const live = "f".repeat(20);
  const young = "e".repeat(20);
  const boundary = "d".repeat(20);
  await file(young);
  const boundaryDir = await file(boundary);
  const boundaryTime = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  await fs.utimes(boundaryDir, boundaryTime, boundaryTime);
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
  await fixture.store.cleanupExpired();
  expect((await fs.readdir(fixture.rootDir)).toSorted()).toEqual([boundary, young, live]);
  expect(lookup.mock.calls).toHaveLength(kind === "orphan" ? 130 : 1);
  expect(lookup.mock.calls.map(([key]) => key)).not.toContain(young);
  expect(lookup.mock.calls.map(([key]) => key)).not.toContain(boundary);
  expect(await readPreview(live)).toBe(live);
  expect((await fixture.blobStore.entries()).map((entry) => entry.key)).toEqual([live]);
});

it("scheduled cleanup joins accepted filesystem work before reporting a sibling read failure", async () => {
  const [heldId, failedId] = ["a".repeat(20), "b".repeat(20)];
  const heldDirectory = await file(heldId, true);
  await file(failedId, true);
  const [started, release] = [createDeferred<void>(), createDeferred<void>()];
  const failure = new Error("fixture Blob lookup failed");
  const lookup = fixture.blobStore.lookup.bind(fixture.blobStore);
  vi.spyOn(fixture.blobStore, "lookup").mockImplementation((key) =>
    key === failedId ? Promise.reject(failure) : lookup(key),
  );
  const remove = fs.rm.bind(fs);
  const removals = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (target === heldDirectory) {
      started.resolve();
      await release.promise;
    }
    return await remove(target, options);
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const scheduled = new DiffArtifactStore({ ...fixture, logger });
  const settled = vi.fn<() => void>();
  scheduled.scheduleCleanup();
  const stopping = scheduled.stopCleanup().then(settled);
  const joined = scheduled
    .cleanupExpired()
    .catch((error: unknown) => error)
    .finally(settled);
  try {
    await started.promise;
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    release.resolve();
    expect(await joined).toBe(failure);
    await stopping;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
    await expect(fs.stat(heldDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readPreview(failedId)).toBe(failedId);
  } finally {
    release.resolve();
    await Promise.allSettled([joined, stopping]);
    await Promise.allSettled(removals.mock.results.map((result) => result.value));
  }
});
