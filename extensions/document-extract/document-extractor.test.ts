// Document Extract tests cover document extractor plugin behavior.
import { Worker } from "node:worker_threads";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { createEngineMock, openPdfMock, pdfDocument } = vi.hoisted(() => ({
  createEngineMock: vi.fn(),
  openPdfMock: vi.fn(),
  pdfDocument: {
    pageCount: 2,
    extract: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("clawpdf", () => ({
  createEngine: createEngineMock,
}));

import { createPdfDocumentExtractor, testOnlyDocumentExtractor } from "./document-extractor.js";

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
    pdfDocument.extract.mockReset();
    pdfDocument.destroy.mockReset();
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

  it("extracts text first and renders each fallback page with its own pixel budget", async () => {
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({
        text: "",
        images: [
          {
            type: "image",
            bytes: Uint8Array.from(Buffer.from("png1")),
            mimeType: "image/png",
            page: 1,
            width: 5,
            height: 10,
          },
        ],
      })
      .mockResolvedValueOnce({
        text: "",
        images: [
          {
            type: "image",
            bytes: Uint8Array.from(Buffer.from("png2")),
            mimeType: "image/png",
            page: 2,
            width: 5,
            height: 10,
          },
        ],
      });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request());

    if (!result) {
      throw new Error("Expected PDF extraction result");
    }
    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(1, {
      mode: "text",
      maxPages: 2,
      maxTextChars: 200_000,
    });
    // Each page renders in its own extract() call, with the aggregate pixel cap
    // allocated across selected pages so later pages are not starved.
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(2, {
      mode: "images",
      pages: [1],
      image: { maxDimension: 10_000, maxPixels: 50, forms: true },
    });
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(3, {
      mode: "images",
      pages: [2],
      image: { maxDimension: 10_000, maxPixels: 50, forms: true },
    });
    expect(result).toEqual({
      text: "",
      images: [
        { type: "image", data: "cG5nMQ==", mimeType: "image/png" },
        { type: "image", data: "cG5nMg==", mimeType: "image/png" },
      ],
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("skips image fallback when enough text is extracted", async () => {
    pdfDocument.extract.mockResolvedValueOnce({ text: "enough text", images: [] });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ minTextChars: 5 }));

    expect(result).toEqual({ text: "enough text", images: [] });
    expect(pdfDocument.extract).toHaveBeenCalledTimes(1);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("opens encrypted PDFs with the request password", async () => {
    pdfDocument.extract.mockResolvedValueOnce({ text: "enough text", images: [] });
    const extractor = createPdfDocumentExtractor();

    await extractor.extract(request({ password: "secret" }));

    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array), { password: "secret" });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("normalizes clawpdf password errors", async () => {
    openPdfMock.mockRejectedValueOnce(
      Object.assign(new Error("bad password"), { code: "password" }),
    );
    const extractor = createPdfDocumentExtractor();

    await expect(extractor.extract(request({ password: "wrong" }))).rejects.toThrow(
      "PDF requires a password or password is incorrect.",
    );
    expect(pdfDocument.destroy).not.toHaveBeenCalled();
  });

  it("filters selected pages and renders them one page per image call", async () => {
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({ text: "", images: [] });
    const extractor = createPdfDocumentExtractor();

    await extractor.extract(request({ pageNumbers: [3, 2, 0, 1], maxPages: 2 }));

    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: "text", pages: [2, 1] }),
    );
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "images", pages: [2] }),
    );
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ mode: "images", pages: [1] }),
    );
  });

  it("reports image fallback failures and returns extracted text", async () => {
    const onImageExtractionError = vi.fn();
    const failure = new Error("render failed");
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "short", images: [] })
      .mockRejectedValueOnce(failure);
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ onImageExtractionError }));

    expect(result).toEqual({ text: "short", images: [] });
    expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("runs signal-aware PDF extraction in an isolated worker", async () => {
    const buffer = Buffer.from(
      [
        "%PDF-1.4",
        "1 0 obj",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "endobj",
        "2 0 obj",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "endobj",
        "3 0 obj",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
        "endobj",
        "trailer",
        "<< /Root 1 0 R >>",
        "%%EOF",
        "",
      ].join("\n"),
    );
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(
      request({
        buffer,
        maxPages: 1,
        maxPixels: 100,
        minTextChars: 1,
        signal: new AbortController().signal,
      }),
    );

    expect(result?.text).toBe("");
    expect(result?.images).toHaveLength(1);
    expect(result?.images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(pdfDocument.extract).not.toHaveBeenCalled();
  });

  it("bounds concurrent PDF workers and admits queued work after a slot is released", async () => {
    const started = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const startedView = new Int32Array(started);
    const blockingWorkerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { workerData } from "node:worker_threads";
        const started = new Int32Array(workerData.started);
        Atomics.store(started, workerData.index, 1);
        Atomics.notify(started, workerData.index);
        Atomics.wait(started, workerData.index, 1);
      `)}`,
    );
    const workers: Worker[] = [];
    const createWorker = vi.fn(() => {
      const worker = new Worker(blockingWorkerUrl, {
        workerData: { started, index: workers.length },
      });
      workers.push(worker);
      return worker;
    });
    const extractor = createPdfDocumentExtractor({
      createWorker,
      workerAdmission: testOnlyDocumentExtractor.createPdfWorkerAdmission(2),
    });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const pending = controllers.map((controller) =>
      extractor.extract(request({ signal: controller.signal })),
    );

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(Atomics.load(startedView, 0)).toBe(1);
      expect(Atomics.load(startedView, 1)).toBe(1);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(createWorker).toHaveBeenCalledTimes(2);

    controllers[0].abort(new Error("release first PDF worker"));
    await expect(pending[0]).rejects.toThrow("release first PDF worker");
    expect(workers[0]?.threadId).toBe(-1);
    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(Atomics.load(startedView, 2)).toBe(1));

    controllers[1].abort(new Error("release second PDF worker"));
    controllers[2].abort(new Error("release queued PDF worker"));
    await expect(pending[1]).rejects.toThrow("release second PDF worker");
    await expect(pending[2]).rejects.toThrow("release queued PDF worker");
    expect(workers[1]?.threadId).toBe(-1);
    expect(workers[2]?.threadId).toBe(-1);
    expect(pdfDocument.extract).not.toHaveBeenCalled();
  });

  it("removes aborted PDF requests from the worker admission queue", async () => {
    const started = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const startedView = new Int32Array(started);
    const blockingWorkerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { workerData } from "node:worker_threads";
        const started = new Int32Array(workerData.started);
        Atomics.store(started, 0, 1);
        Atomics.notify(started, 0);
        Atomics.wait(started, 0, 1);
      `)}`,
    );
    let worker: Worker | undefined;
    const createWorker = vi.fn(() => {
      worker = new Worker(blockingWorkerUrl, { workerData: { started } });
      return worker;
    });
    const extractor = createPdfDocumentExtractor({
      createWorker,
      workerAdmission: testOnlyDocumentExtractor.createPdfWorkerAdmission(1),
    });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = extractor.extract(request({ signal: activeController.signal }));
    const queued = extractor.extract(request({ signal: queuedController.signal }));

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(Atomics.load(startedView, 0)).toBe(1));
    queuedController.abort(new Error("queued PDF request disconnected"));
    await expect(queued).rejects.toThrow("queued PDF request disconnected");
    expect(createWorker).toHaveBeenCalledTimes(1);

    activeController.abort(new Error("active PDF request disconnected"));
    await expect(active).rejects.toThrow("active PDF request disconnected");
    expect(worker?.threadId).toBe(-1);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("terminates in-flight PDF work when the caller aborts", async () => {
    const controller = new AbortController();
    const started = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const startedView = new Int32Array(started);
    const blockingWorkerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { workerData } from "node:worker_threads";
        const started = new Int32Array(workerData.started);
        Atomics.store(started, 0, 1);
        Atomics.notify(started, 0);
        Atomics.wait(started, 0, 1);
      `)}`,
    );
    let worker: Worker | undefined;
    const createWorker = vi.fn(() => {
      worker = new Worker(blockingWorkerUrl, { workerData: { started } });
      return worker;
    });
    const extractor = createPdfDocumentExtractor({ createWorker });
    const pending = extractor.extract(request({ signal: controller.signal }));

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(Atomics.load(startedView, 0)).toBe(1));
    controller.abort(new Error("client disconnected"));

    await expect(pending).rejects.toThrow("client disconnected");
    expect(worker?.threadId).toBe(-1);
    expect(pdfDocument.extract).not.toHaveBeenCalled();
  });
});
