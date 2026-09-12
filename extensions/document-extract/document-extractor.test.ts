import type { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPdfFixture } from "./document-extractor.test-support.js";

const workers = vi.hoisted(() => [] as Worker[]);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        workers.push(this);
      }
    },
  };
});

import { createPdfDocumentExtractor } from "./document-extractor.js";

afterAll(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

const fixture = createPdfFixture([
  "BT /F1 24 Tf 50 700 Td (First PDF page) Tj ET",
  "BT /F1 24 Tf 50 700 Td (Second PDF page) Tj ET",
]);
const request = {
  buffer: fixture,
  mimeType: "application/pdf",
  maxPages: 2,
  maxPixels: 100_000,
  minTextChars: 1,
};

describe("PDF document extractor worker", () => {
  it("extracts selected pages through the public plugin and preserves the caller's buffer", async () => {
    const extractor = createPdfDocumentExtractor();
    expect(extractor).toMatchObject({ id: "pdf", mimeTypes: ["application/pdf"] });
    const source = Buffer.concat([Buffer.from("prefix"), fixture, Buffer.from("suffix")]);
    const buffer = source.subarray(6, -6);
    const result = await extractor.extract({ ...request, buffer, pageNumbers: [2] });
    expect(result?.text).toContain("Second PDF page");
    expect(result?.text).not.toContain("First PDF page");
    expect(result?.images).toEqual([]);
    expect(buffer).toEqual(fixture);
  });

  it("renders real pages within the aggregate pixel budget", async () => {
    const result = await createPdfDocumentExtractor().extract({ ...request, minTextChars: 10_000 });
    expect(result?.images).toHaveLength(2);
    const pixels = result!.images.reduce((total, image) => {
      const png = Buffer.from(image.data, "base64");
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      return total + png.readUInt32BE(16) * png.readUInt32BE(20);
    }, 0);
    expect(pixels).toBeLessThanOrEqual(request.maxPixels);
    expect(pixels).toBeGreaterThan(request.maxPixels / 2);
  });

  it("cancels queued or active extraction and allows the next document to succeed", async () => {
    const extractor = createPdfDocumentExtractor();
    await extractor.extract(request);
    const abort = new AbortController();
    const reason = new Error("owning turn cancelled");
    const timer = setTimeout(() => abort.abort(reason), 0);
    try {
      await expect(
        extractor.extract({
          ...request,
          minTextChars: 10_000,
          maxPixels: 4_000_000,
          signal: abort.signal,
        }),
      ).rejects.toBe(reason);
    } finally {
      clearTimeout(timer);
    }
    await expect(extractor.extract({ ...request, signal: abort.signal })).rejects.toBe(reason);
    await expect(extractor.extract(request)).resolves.toMatchObject({
      text: expect.stringContaining("First PDF page"),
    });
  });

  it("preserves invalid-document errors without poisoning later extraction", async () => {
    const extractor = createPdfDocumentExtractor();
    await expect(
      extractor.extract({ ...request, buffer: Buffer.from("invalid PDF") }),
    ).rejects.toThrow(/PDF|document/i);
    await expect(extractor.extract(request)).resolves.toMatchObject({
      text: expect.stringContaining("Second PDF page"),
    });
  });
});
