// Document Extract tests cover document extractor plugin behavior.
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

function request(overrides = {}) {
  return {
    buffer: Buffer.from("%PDF-1.4"),
    mimeType: "application/pdf",
    maxPages: 2,
    maxPixels: 100,
    minTextChars: 10,
    ...overrides,
  };
}

describe("PDF document extractor", () => {
  afterAll(() => {
    vi.doUnmock("clawpdf");
    vi.resetModules();
  });

  beforeEach(() => {
    createEngineMock.mockResolvedValue({ open: openPdfMock });
    openPdfMock.mockReset();
    openPdfMock.mockResolvedValue(pdfDocument);
    pdfDocument.pageCount = 2;
    pageTextMock.mockReset();
    pageTextMock.mockReturnValue("");
    pdfDocument.destroy.mockReset();
    pdfDocument.page.mockReset();
    pdfDocument.page.mockReturnValue({
      width: 5,
      height: 10,
      render: renderMock,
      text: pageTextMock,
    });
    renderMock.mockReset();
    renderMock.mockReturnValue({ width: 5, height: 10, rgba: new Uint8Array(200) });
    encodePngMock.mockReset();
    encodePngMock.mockResolvedValue(Uint8Array.from(Buffer.from("png")));
  });

  it("extracts text first and renders each fallback page with its own pixel budget", async () => {
    pageTextMock.mockReturnValueOnce("");
    encodePngMock
      .mockResolvedValueOnce(Uint8Array.from(Buffer.from("!png1?")).subarray(1, 5))
      .mockResolvedValueOnce(Uint8Array.from(Buffer.from("png2")));
    const input = request({ buffer: Buffer.from("!%PDF-1.4?").subarray(1, -1) });
    const result = await extractPdfContent(input, control);

    if (!result) {
      throw new Error("Expected PDF extraction result");
    }
    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(Buffer.from(openPdfMock.mock.calls[0]?.[0] ?? [])).toEqual(input.buffer);
    expect(renderMock.mock.calls).toEqual([
      [{ height: 10, forms: true }],
      [{ height: 10, forms: true }],
    ]);
    expect(result).toEqual({
      text: "",
      images: [
        { type: "image", data: "cG5nMQ==", mimeType: "image/png" },
        { type: "image", data: "cG5nMg==", mimeType: "image/png" },
      ],
      metadata: {
        pages: { processed: [1, 2], total: 2, selection: "automatic", truncated: false },
        textTruncated: false,
        imagesTruncated: true,
      },
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("skips image fallback when enough text is extracted", async () => {
    pdfDocument.pageCount = 1;
    pageTextMock.mockReturnValueOnce("enough text");
    const result = await extractPdfContent(request({ minTextChars: 5 }), control);

    expect(result).toEqual({
      text: "enough text",
      images: [],
      metadata: {
        pages: { processed: [1], total: 1, selection: "automatic", truncated: false },
        textTruncated: false,
        imagesTruncated: false,
      },
    });
    expect(renderMock).not.toHaveBeenCalled();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
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
    const result = await extractPdfContent(request({ maxPages: 20, minTextChars: 5 }), control);

    expect(result.text).toBe("x".repeat(199_999));
    expect(result.images).toEqual([]);
    expect(result.metadata).toEqual({
      pages: {
        processed: Array.from({ length: 20 }, (_, index) => index + 1),
        total: 21,
        selection: "automatic",
        truncated: true,
      },
      textTruncated: true,
      imagesTruncated: false,
    });
    expect(renderMock).not.toHaveBeenCalled();
  });

  it.each([
    { width: 600, height: 800, rotation: 0, maxPixels: 2_000_000, expected: [800, 1067] },
    { width: 600, height: 800, rotation: 90, maxPixels: 2_000_000, expected: [1067, 800] },
    { width: 1_000_000, height: 1, rotation: 0, maxPixels: 20_000, expected: [10_000, 1] },
    { width: 1, height: 1_000_000, rotation: 0, maxPixels: 20_000, expected: [1, 10_000] },
    { width: 100_000, height: 100_000, rotation: 0, maxPixels: 10_000, expected: [100, 100] },
    { width: 1, height: 1, rotation: 0, maxPixels: 1, expected: [1, 1] },
  ])(
    "bounds real PNG output for a $width × $height page rotated $rotation degrees",
    async ({ width, height, rotation, maxPixels, expected }) => {
      const actual = await vi.importActual<typeof import("clawpdf")>("clawpdf");
      const engine = await actual.createEngine();
      try {
        const buffer = createPdfFixture([""], { width, height, rotation });
        openPdfMock.mockResolvedValueOnce(await engine.open(buffer));
        encodePngMock.mockImplementationOnce(actual.encodePng);
        const result = await extractPdfContent(request({ buffer, maxPixels }), control);

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
    "propagates cancellation during %s without rendering another page or reporting an image failure",
    async (stage) => {
      const reason = new Error("owning turn cancelled");
      const onImageExtractionError = vi.fn();
      let cancelled = false;
      const cancellableControl: WorkerTaskControl = {
        ...control,
        throwIfCancelled: () => {
          if (cancelled) {
            throw reason;
          }
        },
      };
      pageTextMock.mockReturnValueOnce("short");
      if (stage === "render") {
        renderMock.mockImplementationOnce(() => {
          cancelled = true;
          return { width: 5, height: 10, rgba: new Uint8Array(200) };
        });
      } else {
        encodePngMock.mockImplementationOnce(async () => {
          cancelled = true;
          throw new Error("encoding failed after cancellation");
        });
      }

      await expect(
        extractPdfContent(request({ onImageExtractionError }), cancellableControl),
      ).rejects.toBe(reason);
      expect(renderMock).toHaveBeenCalledTimes(1);
      expect(encodePngMock).toHaveBeenCalledTimes(stage === "render" ? 0 : 1);
      expect(onImageExtractionError).not.toHaveBeenCalled();
      expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it("opens encrypted PDFs with the request password", async () => {
    pageTextMock.mockReturnValueOnce("enough text");
    await extractPdfContent(request({ password: "secret" }), control);

    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array), { password: "secret" });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("normalizes clawpdf password errors", async () => {
    openPdfMock.mockRejectedValueOnce(
      Object.assign(new Error("bad password"), { code: "password" }),
    );
    await expect(extractPdfContent(request({ password: "wrong" }), control)).rejects.toThrow(
      "PDF requires a password or password is incorrect.",
    );
    expect(pdfDocument.destroy).not.toHaveBeenCalled();
  });

  it("filters selected pages and renders them in selection order", async () => {
    pdfDocument.page.mockImplementation((pageNumber: number) => ({
      width: 5,
      height: 10,
      text: () => "",
      render: () => ({ width: 5, height: 10, rgba: Uint8Array.of(pageNumber) }),
    }));
    encodePngMock.mockImplementation(async (rgba: Uint8Array) => rgba);
    const result = await extractPdfContent(
      request({ pageNumbers: [3, 2, 0, 1], maxPages: 2 }),
      control,
    );

    expect(result.images.map((image) => Buffer.from(image.data, "base64")[0])).toEqual([2, 1]);
    expect(result.metadata?.pages).toEqual({
      processed: [2, 1],
      total: 2,
      selection: "explicit",
      truncated: true,
    });
  });

  it("rejects selected pages outside the PDF page count before extraction", async () => {
    pdfDocument.pageCount = 1;
    pageTextMock.mockReturnValueOnce("");
    await expect(extractPdfContent(request({ pageNumbers: [2] }), control)).rejects.toThrow(
      "No requested PDF pages exist in this 1-page document.",
    );
    expect(pdfDocument.page).not.toHaveBeenCalled();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);

    await expect(extractPdfContent(request({ pageNumbers: [] }), control)).resolves.toEqual({
      text: "",
      images: [],
      metadata: {
        pages: { processed: [], total: 1, selection: "explicit", truncated: false },
        textTruncated: false,
        imagesTruncated: false,
      },
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(2);
  });

  it("reports image fallback failures and returns extracted text", async () => {
    const onImageExtractionError = vi.fn();
    const failure = new Error("render failed");
    pageTextMock.mockReturnValueOnce("short");
    renderMock.mockImplementationOnce(() => {
      throw failure;
    });
    const result = await extractPdfContent(request({ onImageExtractionError }), control);

    expect(result).toEqual({
      text: "short",
      images: [],
      metadata: {
        pages: { processed: [1, 2], total: 2, selection: "automatic", truncated: false },
        textTruncated: false,
        imagesTruncated: true,
      },
    });
    expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("records when the aggregate pixel budget stops image rendering early", async () => {
    renderMock.mockReturnValueOnce({ width: 10, height: 10, rgba: new Uint8Array(400) });
    encodePngMock.mockResolvedValueOnce(Uint8Array.from(Buffer.from("page-one")));
    const result = await extractPdfContent(request(), control);

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(result.images).toEqual([{ type: "image", data: "cGFnZS1vbmU=", mimeType: "image/png" }]);
    expect(result.metadata?.imagesTruncated).toBe(true);
  });

  it.each([
    { maxPixels: Number.NaN, text: "" },
    { maxPixels: Number.POSITIVE_INFINITY, text: "short" },
  ])("preserves image budget errors for maxPixels=$maxPixels", async ({ maxPixels, text }) => {
    const onImageExtractionError = vi.fn();
    pageTextMock.mockReturnValueOnce(text);
    const result = extractPdfContent(request({ maxPixels, onImageExtractionError }), control);
    if (text) {
      await expect(result).resolves.toEqual({
        text,
        images: [],
        metadata: {
          pages: { processed: [1, 2], total: 2, selection: "automatic", truncated: false },
          textTruncated: false,
          imagesTruncated: true,
        },
      });
    } else {
      await expect(result).rejects.toThrow("PDF image extraction failed");
    }
    expect(onImageExtractionError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "budget",
        message: "maxPixels must be a finite positive number",
      }),
    );
    expect(renderMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty", text: "", reportError: true },
    { label: "whitespace-only", text: " \t\n", reportError: false },
  ])("surfaces image fallback failures for $label PDF text", async ({ text, reportError }) => {
    const { PdfBudgetError } = await vi.importActual<typeof import("clawpdf")>("clawpdf");
    const onImageExtractionError = vi.fn();
    const failure = new PdfBudgetError("renderPixels", 100);
    pageTextMock.mockReturnValueOnce(text);
    renderMock.mockImplementationOnce(() => {
      throw failure;
    });
    const overrides = reportError ? { onImageExtractionError } : {};

    await expect(extractPdfContent(request(overrides), control)).rejects.toMatchObject({
      message: "PDF image extraction failed with no extractable text.",
      cause: failure,
    });
    expect(onImageExtractionError).toHaveBeenCalledTimes(reportError ? 1 : 0);
    if (reportError) {
      expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    }
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });
});
