import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  KDP_EBOOK_COVER_HEIGHT,
  KDP_EBOOK_COVER_MAX_BYTES,
  KDP_EBOOK_COVER_WIDTH,
  buildCoverTiff,
  isKdpReadyTiffCover,
  readTiffCoverInfo,
} from "./cover.js";
import type { BookBible } from "./types.js";

function fixtureBible(): BookBible {
  return {
    runId: "cover-test",
    title: "The Ledger at Briar Hill",
    subtitle: "An Original Clean Mystery",
    slug: "the-ledger-at-briar-hill",
    penName: "Northstar House",
    genre: "clean mystery",
    readerPromise: "A complete original test book.",
    premise: "A test premise.",
    cast: [],
    originalityStrategy: [],
    bannedDependencies: [],
    targetWords: 12000,
    createdAt: "2026-05-18T00:00:00.000Z",
  };
}

describe("book-writer cover TIFF", () => {
  it("builds a KDP-ready RGB TIFF cover", async () => {
    const buffer = buildCoverTiff(fixtureBible());
    const info = readTiffCoverInfo(buffer);

    expect(buffer.subarray(0, 4).toString("latin1")).toBe("II*\u0000");
    expect(info?.width).toBe(KDP_EBOOK_COVER_WIDTH);
    expect(info?.height).toBe(KDP_EBOOK_COVER_HEIGHT);
    expect(info?.samplesPerPixel).toBe(3);
    expect(info?.bitsPerSample).toEqual([8, 8, 8]);
    expect(info?.compression).toBe(1);
    expect(info?.photometricInterpretation).toBe(2);
    expect(buffer.byteLength).toBeLessThan(KDP_EBOOK_COVER_MAX_BYTES);
    expect(isKdpReadyTiffCover(info)).toBe(true);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-book-writer-cover-"));
    const coverPath = path.join(dir, "cover.tiff");
    await fs.writeFile(coverPath, buffer);
    const written = await fs.readFile(coverPath);
    expect(readTiffCoverInfo(written)?.width).toBe(KDP_EBOOK_COVER_WIDTH);
  });
});
