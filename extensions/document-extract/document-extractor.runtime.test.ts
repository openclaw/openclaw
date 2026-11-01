import type { WorkerTaskControl } from "openclaw/plugin-sdk/worker-task-server";
import { afterAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createPdfFixture } from "./document-extractor.test-support.js";
const { open, encodePng, page, pdf } = vi.hoisted(() => ({
  open: vi.fn(),
  encodePng: vi.fn(),
  page: { width: 5, height: 10, render: vi.fn(), text: vi.fn() },
  pdf: { pageCount: 2, page: vi.fn(), destroy: vi.fn() },
}));
vi.mock("clawpdf", async (importOriginal) => ({
  PdfError: (await importOriginal<typeof import("clawpdf")>()).PdfError,
  createEngine: async () => ({ open }),
  encodePng,
}));

import { extractPdfContent } from "./document-extractor.runtime.js";
const { text, render } = page;
let abort: AbortController;
const control: WorkerTaskControl = {
  runNativeSection: async (operation) => operation(),
  throwIfCancelled: () => abort.signal.throwIfAborted(),
};
const request = {
  buffer: Buffer.from("%PDF-1.4"),
  mimeType: "application/pdf",
  maxPages: 2,
  maxPixels: 100,
  minTextChars: 10,
};
const extract = (overrides = {}) => extractPdfContent({ ...request, ...overrides }, control);
const rendered = { width: 5, height: 10, rgba: new Uint8Array(200) };
afterAll(() => {
  vi.doUnmock("clawpdf");
  vi.resetModules();
});

beforeEach(() => {
  vi.resetAllMocks();
  abort = new AbortController();
  open.mockResolvedValue(pdf);
  pdf.pageCount = 2;
  text.mockReturnValue("");
  pdf.page.mockReturnValue(page);
  render.mockReturnValue(rendered);
  encodePng.mockResolvedValue(Buffer.from("png"));
});

it("caps text and pixels independently, preserving fallback after text exhaustion", async () => {
  pdf.pageCount = 21;
  const body = "x".repeat(199_991);
  const processed = Array.from({ length: 20 }, (_, i) => i + 1);
  const chunks = ["header", body + "🙂", "enough"];
  text.mockImplementation(() => chunks.shift() ?? "");
  render.mockReturnValueOnce({ width: 10, height: 10, rgba: new Uint8Array(400) });
  expect(await extract({ maxPages: 20, minTextChars: 5 })).toEqual({
    text: "header\n\n" + body,
    images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
    metadata: {
      pages: { processed, total: 21, selection: "automatic", truncated: true },
      textTruncated: true,
      imagesTruncated: true,
    },
  });
  expect(render).toHaveBeenCalledTimes(1);
  expect(pdf.destroy).toHaveBeenCalledOnce();
});

it.each([
  { width: 600, height: 800, rotation: 90, maxPixels: 2_000_000, expected: [1067, 800] },
  { width: 1_000_000, height: 1, rotation: 0, maxPixels: 20_000, expected: [10_000, 1] },
  { width: 1, height: 1_000_000, rotation: 0, maxPixels: 20_000, expected: [1, 10_000] },
  { width: 100_000, height: 100_000, rotation: 0, maxPixels: 10_000, expected: [100, 100] },
])("bounds PNG $width", async (spec) => {
  const { width, height, rotation, maxPixels, expected } = spec;
  const actual = await vi.importActual<typeof import("clawpdf")>("clawpdf");
  const engine = await actual.createEngine();
  onTestFinished(() => engine.destroy());
  const buffer = createPdfFixture([""], { width, height, rotation });
  open.mockResolvedValueOnce(await engine.open(buffer));
  encodePng.mockImplementationOnce(actual.encodePng);
  const result = await extract({ buffer, maxPixels });
  expect(result.images).toHaveLength(1);
  const png = Buffer.from(result.images[0]!.data, "base64");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual(expected);
});

it.each(["render", "encode"])("propagates %s cancellation", async (stage) => {
  const reason = new Error("owning turn cancelled");
  const onImageExtractionError = vi.fn();
  (stage === "render" ? render : encodePng).mockImplementationOnce(() => {
    abort.abort(reason);
    if (stage === "encode") {
      throw new Error("encoding failed after cancellation");
    }
    return rendered;
  });
  await expect(extract({ onImageExtractionError })).rejects.toBe(reason);
  expect(encodePng).toHaveBeenCalledTimes(stage === "render" ? 0 : 1);
  expect(onImageExtractionError).not.toHaveBeenCalled();
  expect(pdf.destroy).toHaveBeenCalledOnce();
});

it("normalizes clawpdf password errors", async () => {
  open.mockRejectedValueOnce(Object.assign(new Error("bad password"), { code: "password" }));
  await expect(extract({ password: "wrong" })).rejects.toThrow(
    "PDF requires a password or password is incorrect.",
  );
  expect(open).toHaveBeenCalledWith(expect.any(Uint8Array), { password: "wrong" });
});

it("filters selected pages and preserves their order and duplicates", async () => {
  pdf.page.mockImplementation((pageNumber: number) => ({
    ...page,
    render: () => ({ ...rendered, rgba: Uint8Array.of(pageNumber) }),
  }));
  encodePng.mockImplementation(async (rgba: Uint8Array) =>
    Uint8Array.of(99, ...rgba, 99).subarray(1, -1),
  );
  const buffer = Buffer.from("!%PDF-1.4?").subarray(1, -1);
  const result = await extract({
    buffer,
    pageNumbers: [3, 2, 0, 1, 2],
    maxPages: 3,
    maxPixels: 150,
  });
  expect(Buffer.from(open.mock.calls[0]?.[0] ?? [])).toEqual(buffer);
  expect(result.images.map(({ data }) => data)).toEqual(["Ag==", "AQ==", "Ag=="]);
  expect(result.metadata?.pages).toMatchObject({ processed: [2, 1, 2], truncated: true });
});

it("rejects selected pages outside the PDF page count before extraction", async () => {
  await expect(extract({ pageNumbers: [3] })).rejects.toThrow(
    "No requested PDF pages exist in this 2-page document.",
  );
  expect(pdf.page).not.toHaveBeenCalled();
});

it("reports nonfinite image budgets while preserving extracted text", async () => {
  const onImageExtractionError = vi.fn();
  text.mockReturnValueOnce("short");
  expect(await extract({ maxPixels: Infinity, onImageExtractionError })).toMatchObject({
    text: "short",
    images: [],
    metadata: { textTruncated: false, imagesTruncated: true },
  });
  const error = { code: "budget", message: "maxPixels must be a finite positive number" };
  expect(onImageExtractionError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(error));
  expect(render).not.toHaveBeenCalled();
});

it("surfaces image fallback failures for whitespace-only PDF text without a callback", async () => {
  const { PdfBudgetError } = await vi.importActual<typeof import("clawpdf")>("clawpdf");
  const failure = new PdfBudgetError("renderPixels", 100);
  text.mockReturnValueOnce(" \t\n");
  render.mockImplementationOnce(() => {
    throw failure;
  });
  await expect(extract()).rejects.toMatchObject({
    message: "PDF image extraction failed with no extractable text.",
    cause: failure,
  });
});
