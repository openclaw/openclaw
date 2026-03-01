import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffArtifactStore } from "./store.js";

describe("DiffArtifactStore", () => {
  let rootDir: string;
  let store: DiffArtifactStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-diffs-store-"));
    store = new DiffArtifactStore({ rootDir });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("creates and retrieves an artifact", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const loaded = await store.getArtifact(artifact.id, artifact.token);
    expect(loaded?.id).toBe(artifact.id);
    expect(await store.readHtml(artifact.id)).toBe("<html>demo</html>");
  });

  it("expires artifacts after the ttl", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);

    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "patch",
      fileCount: 2,
      ttlMs: 1_000,
    });

    vi.setSystemTime(new Date(now.getTime() + 2_000));
    const loaded = await store.getArtifact(artifact.id, artifact.token);
    expect(loaded).toBeNull();
  });

  it("updates the stored image path", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const imagePath = store.allocateImagePath(artifact.id);
    const updated = await store.updateImagePath(artifact.id, imagePath);
    expect(updated.imagePath).toBe(imagePath);
  });

  it("allocates standalone image paths outside artifact metadata", async () => {
    const imagePath = store.allocateStandaloneImagePath();
    expect(imagePath).toMatch(/preview\.png$/);
    expect(imagePath).toContain(rootDir);
  });

  it("throttles cleanup sweeps across repeated artifact creation", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);
    store = new DiffArtifactStore({
      rootDir,
      cleanupIntervalMs: 60_000,
    });
    const cleanupSpy = vi.spyOn(store, "cleanupExpired").mockResolvedValue();

    await store.createArtifact({
      html: "<html>one</html>",
      title: "One",
      inputKind: "before_after",
      fileCount: 1,
    });
    await store.createArtifact({
      html: "<html>two</html>",
      title: "Two",
      inputKind: "before_after",
      fileCount: 1,
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(now.getTime() + 61_000));
    await store.createArtifact({
      html: "<html>three</html>",
      title: "Three",
      inputKind: "before_after",
      fileCount: 1,
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });
});
