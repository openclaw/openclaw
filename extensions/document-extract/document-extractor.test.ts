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
  const completenessFixture = createPdfFixture(
    Array.from(
      { length: 21 },
      (_, index) =>
        `BT /F1 12 Tf 72 720 Td (PAGE ${index + 1}${index === 20 ? " CORRECTION: REJECTED" : ""}) Tj ET`,
    ),
  );

  it("reports pages omitted by the automatic page budget", async () => {
    const result = await createPdfDocumentExtractor().extract({
      ...request,
      buffer: completenessFixture,
      maxPages: 20,
    });
    expect(result).toMatchObject({
      text: expect.not.stringContaining("CORRECTION: REJECTED"),
      metadata: {
        pages: {
          processed: Array.from({ length: 20 }, (_, index) => index + 1),
          total: 21,
          selection: "automatic",
          truncated: true,
        },
        textTruncated: false,
      },
    });
  });

  it("extracts page 21 when the page budget is one selected page", async () => {
    const result = await createPdfDocumentExtractor().extract({
      ...request,
      buffer: completenessFixture,
      pageNumbers: [21],
      maxPages: 1,
    });
    expect(result).toMatchObject({
      text: "PAGE 21 CORRECTION: REJECTED",
      metadata: {
        pages: { processed: [21], total: 21, selection: "explicit", truncated: false },
        textTruncated: false,
      },
    });
  });

  it("preserves an explicitly empty page selection through the real worker", async () => {
    const result = await createPdfDocumentExtractor().extract({ ...request, pageNumbers: [] });
    expect(result).toEqual({
      text: "",
      images: [],
      metadata: {
        pages: { processed: [], total: 2, selection: "explicit", truncated: false },
        textTruncated: false,
        imagesTruncated: false,
      },
    });
  });

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

  it.each([false, true])(
    "preserves image-only pages beside selectable text (image first: %s)",
    async (imageFirst) => {
      const textPage = `BT /F1 12 Tf 40 700 Td (${"Selectable report text. ".repeat(12)}) Tj ET`;
      const imagePage = "1 0 0 rg 50 50 300 500 re f";
      const pages = imageFirst ? [imagePage, textPage] : [textPage, imagePage];
      const extractor = createPdfDocumentExtractor();
      const input = { ...request, buffer: createPdfFixture(pages), minTextChars: 200 };
      const result = await extractor.extract(input);
      const imageOnly = await extractor.extract({ ...input, pageNumbers: [imageFirst ? 1 : 2] });

      expect(result?.text).toContain("Selectable report text.");
      expect(result?.images).toHaveLength(1);
      expect(result?.images).toEqual(imageOnly?.images);
      const textOnly = await extractor.extract({ ...input, pageNumbers: [imageFirst ? 2 : 1] });
      expect(textOnly?.images).toEqual([]);
      expect(textOnly?.text).toBe(result?.text);
    },
  );

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

  it("joins canceled extraction before allowing the next document to succeed", async () => {
    const extractor = createPdfDocumentExtractor();
    await extractor.extract(request);
    const worker = workers.at(-1)!;
    expect(worker.threadId).toBeGreaterThan(0);
    const abort = new AbortController();
    const reason = new Error("owning turn cancelled");
    const postMessage = worker.postMessage.bind(worker);
    const dispatch = vi.spyOn(worker, "postMessage").mockImplementationOnce((...args) => {
      postMessage(...args);
      // Cancel at dispatch so a fast worker reply cannot beat the abort.
      abort.abort(reason);
    });
    try {
      await expect(
        extractor.extract({
          ...request,
          minTextChars: 10_000,
          maxPixels: 4_000_000,
          signal: abort.signal,
        }),
      ).rejects.toBe(reason);
      expect(worker.threadId).toBe(-1);
    } finally {
      dispatch.mockRestore();
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
