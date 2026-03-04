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

  it("updates the stored file path", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const filePath = store.allocateFilePath(artifact.id);
    const updated = await store.updateFilePath(artifact.id, filePath);
    expect(updated.filePath).toBe(filePath);
    expect(updated.imagePath).toBe(filePath);
  });

  it("rejects file paths that escape the store root", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    await expect(store.updateFilePath(artifact.id, "../outside.png")).rejects.toThrow(
      "escapes store root",
    );
  });

  it("rejects tampered html metadata paths outside the store root", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });
    const metaPath = path.join(rootDir, artifact.id, "meta.json");
    const rawMeta = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(rawMeta) as { htmlPath: string };
    meta.htmlPath = "../outside.html";
    await fs.writeFile(metaPath, JSON.stringify(meta), "utf8");

    await expect(store.readHtml(artifact.id)).rejects.toThrow("escapes store root");
  });

  it("creates standalone file artifacts with managed metadata", async () => {
    const standalone = await store.createStandaloneFileArtifact();
    expect(standalone.filePath).toMatch(/preview\.png$/);
    expect(standalone.filePath).toContain(rootDir);
    expect(Date.parse(standalone.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("expires standalone file artifacts using ttl metadata", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);

    const standalone = await store.createStandaloneFileArtifact({
      format: "png",
      ttlMs: 1_000,
    });
    await fs.writeFile(standalone.filePath, Buffer.from("png"));

    vi.setSystemTime(new Date(now.getTime() + 2_000));
    await store.cleanupExpired();

    await expect(fs.stat(path.dirname(standalone.filePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("supports image path aliases for backward compatibility", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const imagePath = store.allocateImagePath(artifact.id, "pdf");
    expect(imagePath).toMatch(/preview\.pdf$/);
    const standalone = await store.createStandaloneFileArtifact();
    expect(standalone.filePath).toMatch(/preview\.png$/);

    const updated = await store.updateImagePath(artifact.id, imagePath);
    expect(updated.filePath).toBe(imagePath);
    expect(updated.imagePath).toBe(imagePath);
  });

  it("allocates PDF file paths when format is pdf", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const artifactPdf = store.allocateFilePath(artifact.id, "pdf");
    const standalonePdf = await store.createStandaloneFileArtifact({ format: "pdf" });
    expect(artifactPdf).toMatch(/preview\.pdf$/);
    expect(standalonePdf.filePath).toMatch(/preview\.pdf$/);
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
