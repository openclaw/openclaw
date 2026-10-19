import type { WorkerTaskControl } from "openclaw/plugin-sdk/worker-task-server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPdfFixture } from "./document-extractor.test-support.js";

const { createEngineMock, openPdfMock, encodePngMock, renderMock, pageTextMock, pdfDocument } =
  vi.hoisted(() => ({
    createEngineMock: vi.fn(),
    openPdfMock: vi.fn(),
    encodePngMock: vi.fn(),
    renderMock: vi.fn(),
    pageTextMock: vi.fn(),
    pdfDocument: {
      pageCount: 2,
      page: vi.fn(),
      destroy: vi.fn(),
    },
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
function textResult(
  text: string,
  processed: number[],
  total: number,
  { truncated = false, textTruncated = false, imagesTruncated = false } = {},
) {
  return {
    text,
    images: [],
    metadata: {
      pages: { processed, total, selection: "automatic", truncated },
      textTruncated,
      imagesTruncated,
    },
  };
}

describe("PDF document extractor", () => {
  afterAll(() => {
    vi.doUnmock("clawpdf");
    vi.resetModules();
  });

  beforeEach(() => {
    createEngineMock.mockResolvedValue({ open: openPdfMock });
    openPdfMock.mockReset().mockResolvedValue(pdfDocument);
    pdfDocument.pageCount = 2;
    pageTextMock.mockReset().mockReturnValue("");
    pdfDocument.destroy.mockReset();
    pdfDocument.page.mockReset().mockReturnValue(page);
    renderMock.mockReset().mockReturnValue(rendered);
    encodePngMock.mockReset().mockResolvedValue(Uint8Array.from(Buffer.from("png")));
  });

  it("caps combined text while preserving image fallback after the text budget is exhausted", async () => {
    pdfDocument.pageCount = 3;
    pageTextMock
      .mockReturnValueOnce("header")
      .mockReturnValueOnce("x".repeat(200_000))
      .mockReturnValueOnce("");
    const result = await extractPdfContent(request({ maxPages: 3, minTextChars: 5 }), control);

    expect(result.text).toBe("header\n\n" + "x".repeat(199_992));
    expect(result.images).toHaveLength(1);
    expect(result.metadata?.textTruncated).toBe(true);
  });

  it("records the actual page selection and Unicode-safe text omission", async () => {
    pdfDocument.pageCount = 21;
    pageTextMock.mockReturnValueOnce("x".repeat(199_999) + "🙂").mockReturnValue("enough text");
    expect(await extract({ maxPages: 20, minTextChars: 5 })).toEqual(
      textResult(
        "x".repeat(199_999),
        Array.from({ length: 20 }, (_, index) => index + 1),
        21,
        { truncated: true, textTruncated: true },
      ),
    );
    expect(renderMock).not.toHaveBeenCalled();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { width: 600, height: 800, rotation: 90, maxPixels: 2_000_000, expected: [1067, 800] },
    { width: 1_000_000, height: 1, rotation: 0, maxPixels: 20_000, expected: [10_000, 1] },
    { width: 1, height: 1_000_000, rotation: 0, maxPixels: 20_000, expected: [1, 10_000] },
    { width: 100_000, height: 100_000, rotation: 0, maxPixels: 10_000, expected: [100, 100] },
  ])(
    "bounds PNG size for $width × $height rotated $rotation degrees",
    async ({ width, height, rotation, maxPixels, expected }) => {
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
    },
  );

  it.each(["render", "encode"])(
    "propagates %s cancellation without another render or image failure",
    async (stage) => {
      const reason = new Error("owning turn cancelled");
      const onImageExtractionError = vi.fn();
      const abort = new AbortController();
      const cancellableControl: WorkerTaskControl = {
        ...control,
        throwIfCancelled: () => abort.signal.throwIfAborted(),
      };
      pageTextMock.mockReturnValueOnce("short");
      if (stage === "render") {
        renderMock.mockImplementationOnce(() => {
          abort.abort(reason);
          return rendered;
        });
      } else {
        encodePngMock.mockImplementationOnce(async () => {
          abort.abort(reason);
          throw new Error("encoding failed after cancellation");
        });
      }

      await expect(extract({ onImageExtractionError }, cancellableControl)).rejects.toBe(reason);
      expect(renderMock).toHaveBeenCalledTimes(1);
      expect(encodePngMock).toHaveBeenCalledTimes(stage === "render" ? 0 : 1);
      expect(onImageExtractionError).not.toHaveBeenCalled();
      expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it("normalizes clawpdf password errors", async () => {
    openPdfMock.mockRejectedValueOnce(
      Object.assign(new Error("bad password"), { code: "password" }),
    );
    await expect(extract({ password: "wrong" })).rejects.toThrow(
      "PDF requires a password or password is incorrect.",
    );
    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array), { password: "wrong" });
    expect(pdfDocument.destroy).not.toHaveBeenCalled();
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
    const result = await extract({
      buffer,
      pageNumbers: [3, 2, 0, 1],
      maxPages: 2,
    });
    expect(Buffer.from(openPdfMock.mock.calls[0]?.[0] ?? [])).toEqual(buffer);

    expect(result.images).toEqual([
      { type: "image", data: "Ag==", mimeType: "image/png" },
      { type: "image", data: "AQ==", mimeType: "image/png" },
    ]);
    expect(pdfDocument.destroy).toHaveBeenCalledOnce();
    expect(result.metadata?.pages).toEqual({
      processed: [2, 1],
      total: 2,
      selection: "explicit",
      truncated: true,
    });
  });

  it("rejects selected pages outside the PDF page count before extraction", async () => {
    pdfDocument.pageCount = 1;
    await expect(extract({ pageNumbers: [2] })).rejects.toThrow(
      "No requested PDF pages exist in this 1-page document.",
    );
    expect(pdfDocument.page).not.toHaveBeenCalled();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("records when the aggregate pixel budget stops image rendering early", async () => {
    renderMock.mockReturnValueOnce({ width: 10, height: 10, rgba: new Uint8Array(400) });
    encodePngMock.mockResolvedValueOnce(Uint8Array.from(Buffer.from("page-one")));
    const result = await extract();

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(result.images).toEqual([{ type: "image", data: "cGFnZS1vbmU=", mimeType: "image/png" }]);
    expect(result.metadata?.imagesTruncated).toBe(true);
  });

  it("reports nonfinite image budgets while preserving extracted text", async () => {
    const onImageExtractionError = vi.fn();
    pageTextMock.mockReturnValueOnce("short");
    await expect(extract({ maxPixels: Infinity, onImageExtractionError })).resolves.toEqual(
      textResult("short", [1, 2], 2, { imagesTruncated: true }),
    );
    expect(onImageExtractionError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: "budget",
        message: "maxPixels must be a finite positive number",
      }),
    );
    expect(renderMock).not.toHaveBeenCalled();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
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
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });
});
