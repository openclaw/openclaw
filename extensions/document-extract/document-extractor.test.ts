import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { canvasSizes, getDocumentMock, pdfDocument } = vi.hoisted(() => ({
  canvasSizes: [] as Array<{ width: number; height: number }>,
  getDocumentMock: vi.fn(),
  pdfDocument: {
    numPages: 2,
    getPage: vi.fn(async () => ({
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 1000 * scale,
        height: 1000 * scale,
      })),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
    })),
  },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: getDocumentMock,
}));

vi.mock("@napi-rs/canvas", () => ({
  createCanvas: vi.fn((width: number, height: number) => {
    canvasSizes.push({ width, height });
    return {
      toBuffer: vi.fn(() => Buffer.from("png")),
    };
  }),
}));

import { createPdfDocumentExtractor } from "./document-extractor.js";

const require = createRequire(import.meta.url);

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>, label: string) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call[0];
}

describe("PDF document extractor", () => {
  afterAll(() => {
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
    vi.doUnmock("@napi-rs/canvas");
    vi.resetModules();
  });

  beforeEach(() => {
    canvasSizes.length = 0;
    getDocumentMock.mockReset();
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(pdfDocument) });
    pdfDocument.getPage.mockClear();
  });

  it("declares PDF support", () => {
    const extractor = createPdfDocumentExtractor();
    const { extract, ...descriptor } = extractor;
    expect(extract).toBeInstanceOf(Function);
    expect(descriptor).toEqual({
      id: "pdf",
      label: "PDF",
      mimeTypes: ["application/pdf"],
      autoDetectOrder: 10,
    });
  });

  it("treats maxPixels as a hard total image rendering budget", async () => {
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 2,
      maxPixels: 100,
      minTextChars: 10,
    });

    if (!result) {
      throw new Error("Expected PDF extraction result");
    }
    expect(result.images).toHaveLength(1);
    expect(canvasSizes).toEqual([{ width: 10, height: 10 }]);
  });

  it("passes standardFontDataUrl to pdfjs getDocument as a package-root filesystem path", async () => {
    const extractor = createPdfDocumentExtractor();

    await extractor.extract({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 4_000_000,
      minTextChars: 200,
    });

    expect(getDocumentMock).toHaveBeenCalledTimes(1);
    const params = requireFirstMockArg(getDocumentMock, "pdfjs getDocument call");
    const { data, standardFontDataUrl, ...stableParams } = params as {
      data: Uint8Array;
      disableWorker: boolean;
      standardFontDataUrl: string;
    };
    expect(stableParams).toEqual({
      disableWorker: true,
    });
    expect(data).toBeInstanceOf(Uint8Array);
    expect(typeof standardFontDataUrl).toBe("string");

    const expectedStandardFontDataUrl =
      path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + "/";
    expect(standardFontDataUrl).toBe(expectedStandardFontDataUrl);
    expect(path.isAbsolute(standardFontDataUrl)).toBe(true);
    expect(standardFontDataUrl.endsWith("/")).toBe(true);
    expect(standardFontDataUrl.startsWith("file://")).toBe(false);
    expect(existsSync(standardFontDataUrl)).toBe(true);
    expect(existsSync(path.join(standardFontDataUrl, "LiberationSans-Regular.ttf"))).toBe(true);
  });
});

describe("pdftoppm fallback — canvas unavailable, pdftoppm available", () => {
  const mockSpawn = vi.fn();
  const mockMkdtemp = vi.fn();
  const mockChmod = vi.fn();
  const mockWriteFile = vi.fn();
  const mockReaddir = vi.fn();
  const mockReadFileFs = vi.fn();
  const mockRm = vi.fn();
  let capturedTempDirs: string[] = [];
  let freshCreate!: typeof createPdfDocumentExtractor;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("@napi-rs/canvas", () => {
      throw new Error("@napi-rs/canvas not installed");
    });
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: getDocumentMock }));
    vi.doMock("node:child_process", () => ({ spawn: mockSpawn }));
    vi.doMock("node:fs/promises", () => {
      const m = {
        mkdtemp: mockMkdtemp,
        chmod: mockChmod,
        writeFile: mockWriteFile,
        readdir: mockReaddir,
        readFile: mockReadFileFs,
        rm: mockRm,
      };
      return { ...m, default: m };
    });
    const mod =
      (await import("./document-extractor.js")) as typeof import("./document-extractor.js");
    freshCreate = mod.createPdfDocumentExtractor;
  });

  afterAll(() => {
    vi.doUnmock("@napi-rs/canvas");
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  beforeEach(() => {
    capturedTempDirs = [];
    mockMkdtemp.mockImplementation(async (prefix: string) => {
      const dir = `${prefix}testdir`;
      capturedTempDirs.push(dir);
      return dir;
    });
    mockChmod.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue(["page-1.png"]);
    mockReadFileFs.mockResolvedValue(Buffer.from("fakepng"));
    mockRm.mockResolvedValue(undefined);
    mockSpawn.mockImplementation(() => {
      const emitter = new EventEmitter();
      setImmediate(() => emitter.emit("close", 0));
      return emitter;
    });
    getDocumentMock.mockReset();
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(pdfDocument) });
    pdfDocument.getPage.mockClear();
  });

  it("produces page images using pdftoppm when @napi-rs/canvas is unavailable", async () => {
    const extractor = freshCreate();
    const result = await extractor.extract({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 1_000_000,
      minTextChars: 10,
    });
    expect(result.images.length).toBeGreaterThan(0);
    for (const img of result.images) {
      expect(img.mimeType).toBe("image/png");
      expect(typeof img.data).toBe("string");
      expect(img.data.length).toBeGreaterThan(0);
    }
  });

  it("removes the temp directory after pdftoppm renders", async () => {
    const extractor = freshCreate();
    await extractor.extract({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 1_000_000,
      minTextChars: 10,
    });
    expect(capturedTempDirs.length).toBeGreaterThan(0);
    for (const dir of capturedTempDirs) {
      expect(mockRm).toHaveBeenCalledWith(dir, { recursive: true, force: true });
    }
  });

  it("invokes pdftoppm with -scale-to-x/-scale-to-y so output stays within the pixel budget (#75358)", async () => {
    // Regression: the previous fallback passed `-r <dpi>` with a 72 DPI
    // floor, so for large source pages or small `maxPixels` budgets the
    // rendered PNG could exceed `plan.pixels` while `remainingPixels` was
    // decremented by the smaller planned size. Switching to
    // `-scale-to-x` / `-scale-to-y` forces Poppler to honor the planned
    // width/height regardless of source dimensions.
    const extractor = freshCreate();
    await extractor.extract({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 10_000, // intentionally tight — must still be honored
      minTextChars: 10,
    });
    expect(mockSpawn).toHaveBeenCalled();
    const [bin, argv] = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as [string, string[]];
    expect(bin).toBe("pdftoppm");
    expect(argv).toContain("-scale-to-x");
    expect(argv).toContain("-scale-to-y");
    expect(argv).not.toContain("-r");
    const xIdx = argv.indexOf("-scale-to-x");
    const yIdx = argv.indexOf("-scale-to-y");
    expect(Number(argv[xIdx + 1])).toBeGreaterThan(0);
    expect(Number(argv[yIdx + 1])).toBeGreaterThan(0);
    expect(Number(argv[xIdx + 1]) * Number(argv[yIdx + 1])).toBeLessThanOrEqual(10_000);
  });
});

describe("pdftoppm fallback — canvas unavailable, pdftoppm unavailable", () => {
  const mockSpawn = vi.fn();
  let freshCreate!: typeof createPdfDocumentExtractor;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("@napi-rs/canvas", () => {
      throw new Error("@napi-rs/canvas not installed");
    });
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: getDocumentMock }));
    vi.doMock("node:child_process", () => ({ spawn: mockSpawn }));
    const mod =
      (await import("./document-extractor.js")) as typeof import("./document-extractor.js");
    freshCreate = mod.createPdfDocumentExtractor;
  });

  afterAll(() => {
    vi.doUnmock("@napi-rs/canvas");
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  beforeEach(() => {
    mockSpawn.mockImplementation(() => {
      const emitter = new EventEmitter();
      setImmediate(() => emitter.emit("error", new Error("spawn ENOENT")));
      return emitter;
    });
    getDocumentMock.mockReset();
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(pdfDocument) });
    pdfDocument.getPage.mockClear();
  });

  it("calls onImageExtractionError and returns empty images when pdftoppm is also unavailable", async () => {
    const onImageExtractionError = vi.fn();
    const extractor = freshCreate();
    const result = await extractor.extract({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 1_000_000,
      minTextChars: 10,
      onImageExtractionError,
    });
    expect(onImageExtractionError).toHaveBeenCalledTimes(1);
    expect(result.images).toEqual([]);
  });
});
