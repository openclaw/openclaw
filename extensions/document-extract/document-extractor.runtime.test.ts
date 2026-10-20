import type { WorkerTaskControl } from "openclaw/plugin-sdk/worker-task-server";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPdfFixture } from "./document-extractor.test-support.js";

const { createEngineMock, openPdfMock, encodePngMock, renderMock, pageTextMock, pdfDocument } =
  vi.hoisted(() => ({
    createEngineMock: vi.fn(),
    openPdfMock: vi.fn(),
    encodePngMock: vi.fn(),
    renderMock: vi.fn(),
    pageTextMock: vi.fn(),
    pdfDocument: { pageCount: 2, page: vi.fn(), destroy: vi.fn() },
  }));

vi.mock("clawpdf", async (importOriginal) => ({
  PdfError: (await importOriginal<typeof import("clawpdf")>()).PdfError,
  createEngine: createEngineMock,
  encodePng: encodePngMock,
}));

import { extractPdfContent } from "./document-extractor.runtime.js";

const control: WorkerTaskControl = {
  runNativeSection: async (operation) => operation(),
  throwIfCancelled: vi.fn(),
};

const request = {
  buffer: Buffer.from("%PDF-1.4"),
  mimeType: "application/pdf",
  maxPages: 2,
  maxPixels: 100,
  minTextChars: 10,
};
const extract = (overrides = {}, taskControl = control) =>
  extractPdfContent({ ...request, ...overrides }, taskControl);
const rendered = { width: 5, height: 10, rgba: new Uint8Array(200) };
const page = { width: 5, height: 10, render: renderMock, text: pageTextMock };
const pages = (processed: number[], total = 2, selection = "automatic", truncated = false) => ({
  processed,
  total,
  selection,
  truncated,
});
const textResult = (text: string, summary: object, flags = {}) => ({
  text,
  images: [],
  metadata: { pages: summary, textTruncated: false, imagesTruncated: false, ...flags },
});

let expectedDestroys = 1;
afterAll(() => {
  vi.doUnmock("clawpdf");
  vi.resetModules();
});

beforeEach(() => {
  vi.resetAllMocks();
  expectedDestroys = 1;
  createEngineMock.mockResolvedValue({ open: openPdfMock });
  openPdfMock.mockResolvedValue(pdfDocument);
  pdfDocument.pageCount = 2;
  pageTextMock.mockReturnValue("");
  pdfDocument.page.mockReturnValue(page);
  renderMock.mockReturnValue(rendered);
  encodePngMock.mockResolvedValue(Buffer.from("png"));
});
afterEach(() => expect(pdfDocument.destroy).toHaveBeenCalledTimes(expectedDestroys));

it("caps combined text while preserving image fallback after the text budget is exhausted", async () => {
  pdfDocument.pageCount = 3;
  pageTextMock
    .mockReturnValueOnce("header")
    .mockReturnValueOnce("x".repeat(200_000))
    .mockReturnValueOnce("");
  const result = await extract({ maxPages: 3, minTextChars: 5 });

  expect(result.text).toBe("header\n\n" + "x".repeat(199_992));
  expect(result.images).toHaveLength(1);
  expect(result.metadata?.textTruncated).toBe(true);
});

it("records the actual page selection and Unicode-safe text omission", async () => {
  pdfDocument.pageCount = 21;
  const text = "x".repeat(199_999);
  const processed = Array.from({ length: 20 }, (_, i) => i + 1);
  pageTextMock.mockReturnValueOnce(text + "🙂").mockReturnValue("enough text");
  expect(await extract({ maxPages: 20, minTextChars: 5 })).toEqual(
    textResult(text, pages(processed, 21, "automatic", true), { textTruncated: true }),
  );
  expect(renderMock).not.toHaveBeenCalled();
});

it.each([
  { width: 600, height: 800, rotation: 90, maxPixels: 2_000_000, expected: [1067, 800] },
  { width: 1_000_000, height: 1, rotation: 0, maxPixels: 20_000, expected: [10_000, 1] },
  { width: 1, height: 1_000_000, rotation: 0, maxPixels: 20_000, expected: [1, 10_000] },
  { width: 100_000, height: 100_000, rotation: 0, maxPixels: 10_000, expected: [100, 100] },
])("bounds PNG $width", async ({ width, height, rotation, maxPixels, expected }) => {
  expectedDestroys = 0;
  const actual = await vi.importActual<typeof import("clawpdf")>("clawpdf");
  const engine = await actual.createEngine();
  try {
    const buffer = createPdfFixture([""], { width, height, rotation });
    openPdfMock.mockResolvedValueOnce(await engine.open(buffer));
    encodePngMock.mockImplementationOnce(actual.encodePng);
    const result = await extract({ buffer, maxPixels });

    expect(result.images).toHaveLength(1);
    const png = Buffer.from(result.images[0]!.data, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual(expected);
  } finally {
    await engine.destroy();
  }
});

it.each(["render", "encode"])("propagates %s cancellation", async (stage) => {
  const reason = new Error("owning turn cancelled");
  const onImageExtractionError = vi.fn();
  const abort = new AbortController();
  const cancellableControl: WorkerTaskControl = {
    ...control,
    throwIfCancelled: () => abort.signal.throwIfAborted(),
  };
  (stage === "render" ? renderMock : encodePngMock).mockImplementationOnce(() => {
    abort.abort(reason);
    if (stage === "encode") {
      throw new Error("encoding failed after cancellation");
    }
    return rendered;
  });

  await expect(extract({ onImageExtractionError }, cancellableControl)).rejects.toBe(reason);
  expect(renderMock).toHaveBeenCalledTimes(1);
  expect(encodePngMock).toHaveBeenCalledTimes(stage === "render" ? 0 : 1);
  expect(onImageExtractionError).not.toHaveBeenCalled();
});

it("normalizes clawpdf password errors", async () => {
  expectedDestroys = 0;
  openPdfMock.mockRejectedValueOnce(Object.assign(new Error("bad password"), { code: "password" }));
  await expect(extract({ password: "wrong" })).rejects.toThrow(
    "PDF requires a password or password is incorrect.",
  );
  expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array), { password: "wrong" });
});

it("filters selected pages and renders them in selection order", async () => {
  pdfDocument.page.mockImplementation((pageNumber: number) => ({
    ...page,
    render: () => ({ ...rendered, rgba: Uint8Array.of(pageNumber) }),
  }));
  encodePngMock.mockImplementation(async (rgba: Uint8Array) =>
    Uint8Array.of(99, ...rgba, 99).subarray(1, -1),
  );
  const buffer = Buffer.from("!%PDF-1.4?").subarray(1, -1);
  const result = await extract({ buffer, pageNumbers: [3, 2, 0, 1], maxPages: 2 });
  expect(Buffer.from(openPdfMock.mock.calls[0]?.[0] ?? [])).toEqual(buffer);

  expect(result.images).toEqual([
    { type: "image", data: "Ag==", mimeType: "image/png" },
    { type: "image", data: "AQ==", mimeType: "image/png" },
  ]);
  expect(result.metadata?.pages).toEqual(pages([2, 1], 2, "explicit", true));
});

it("rejects selected pages outside the PDF page count before extraction", async () => {
  pdfDocument.pageCount = 1;
  await expect(extract({ pageNumbers: [2] })).rejects.toThrow(
    "No requested PDF pages exist in this 1-page document.",
  );
  expect(pdfDocument.page).not.toHaveBeenCalled();
});

it("records when the aggregate pixel budget stops image rendering early", async () => {
  renderMock.mockReturnValueOnce({ width: 10, height: 10, rgba: new Uint8Array(400) });
  const result = await extract();

  expect(renderMock).toHaveBeenCalledTimes(1);
  expect(result.images).toEqual([{ type: "image", data: "cG5n", mimeType: "image/png" }]);
  expect(result.metadata?.imagesTruncated).toBe(true);
});

it("reports nonfinite image budgets while preserving extracted text", async () => {
  const onImageExtractionError = vi.fn();
  pageTextMock.mockReturnValueOnce("short");
  await expect(extract({ maxPixels: Infinity, onImageExtractionError })).resolves.toEqual(
    textResult("short", pages([1, 2]), { imagesTruncated: true }),
  );
  const error = { code: "budget", message: "maxPixels must be a finite positive number" };
  expect(onImageExtractionError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(error));
  expect(renderMock).not.toHaveBeenCalled();
});

it("surfaces image fallback failures for whitespace-only PDF text without a callback", async () => {
  const { PdfBudgetError } = await vi.importActual<typeof import("clawpdf")>("clawpdf");
  const failure = new PdfBudgetError("renderPixels", 100);
  pageTextMock.mockReturnValueOnce(" \t\n");
  renderMock.mockImplementationOnce(() => {
    throw failure;
  });
  await expect(extract()).rejects.toMatchObject({
    message: "PDF image extraction failed with no extractable text.",
    cause: failure,
  });
});
