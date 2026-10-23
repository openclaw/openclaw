import type { Worker } from "node:worker_threads";
import type { DocumentExtractionRequest } from "openclaw/plugin-sdk/document-extractor";
import { afterAll, expect, it, vi } from "vitest";
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

afterAll(() => Promise.all(workers.splice(0).map((worker) => worker.terminate())));

const textPage = (text: string, size = 12) => `BT /F1 ${size} Tf 50 700 Td (${text}) Tj ET`;
const request = {
  buffer: createPdfFixture(["First PDF page", "Second PDF page"].map((text) => textPage(text, 24))),
  mimeType: "application/pdf",
  maxPages: 2,
  maxPixels: 100_000,
  minTextChars: 1,
};
const extractor = createPdfDocumentExtractor();
const extract = (overrides: Partial<DocumentExtractionRequest> = {}) =>
  extractor.extract({ ...request, ...overrides });
const correction = "PAGE 21 CORRECTION: REJECTED";
it.each([
  { pageNumbers: [21], total: 21, text: correction },
  { pageNumbers: [], total: 2, text: "" },
])("extracts explicit pages $pageNumbers", async ({ pageNumbers, total, text }) => {
  const fixture = createPdfFixture(
    Array.from({ length: total }, (_, index) => textPage(index === total - 1 ? correction : "")),
  );
  const padding = Buffer.from("prefix");
  const buffer = Buffer.concat([padding, fixture, padding]).subarray(6, -6);
  expect(await extract({ buffer, pageNumbers, maxPages: 1 })).toEqual({
    text,
    images: [],
    metadata: {
      pages: { processed: pageNumbers, total, selection: "explicit", truncated: false },
      textTruncated: false,
      imagesTruncated: false,
    },
  });
  expect(buffer).toEqual(fixture);
});

it("preserves image-only pages beside selectable text", async () => {
  const input = {
    buffer: createPdfFixture([
      textPage("Selectable report text. ".repeat(12)),
      "1 0 0 rg 50 50 300 500 re f",
    ]),
    minTextChars: 200,
  };
  const result = await extract(input);
  const imageOnly = await extract({ ...input, pageNumbers: [2] });

  expect(result?.text).toContain("Selectable report text.");
  expect(result?.images).toHaveLength(1);
  expect(result?.images).toEqual(imageOnly?.images);
  const textOnly = await extract({ ...input, pageNumbers: [1] });
  expect(textOnly).toMatchObject({ images: [], text: result?.text });
});

it("renders real pages within the aggregate pixel budget", async () => {
  const result = await extract({ minTextChars: 10_000 });
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
  await extract();
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
      extract({ minTextChars: 10_000, maxPixels: 4_000_000, signal: abort.signal }),
    ).rejects.toBe(reason);
    expect(worker.threadId).toBe(-1);
  } finally {
    dispatch.mockRestore();
  }
  await expect(extract({ signal: abort.signal })).rejects.toBe(reason);
  expect((await extract())?.text).toContain("First PDF page");
});

it("preserves invalid-document errors without poisoning later extraction", async () => {
  await expect(extract({ buffer: Buffer.from("invalid PDF") })).rejects.toThrow(/PDF|document/i);
  expect((await extract())?.text).toContain("Second PDF page");
});
