import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensureDefaultModel } from "./ollama-auto-setup.js";

function jsonResponse(data: object): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

function ndjsonStream(chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(JSON.stringify(c) + "\n"));
      }
      controller.close();
    },
  });
}

describe("ensureDefaultModel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("model already available → returns alreadyAvailable: true, doesn't pull", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ models: [{ name: "gemma3:4b" }] }),
    );

    const result = await ensureDefaultModel();
    expect(result).toEqual({ alreadyAvailable: true, pulled: false, model: "gemma3:4b" });
    expect(fetch).toHaveBeenCalledTimes(1); // only tags, no pull
  });

  it("model not available → pulls and returns pulled: true", async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce({
        ok: true,
        body: ndjsonStream([{ status: "pulling manifest" }, { status: "success" }]),
      });

    const result = await ensureDefaultModel();
    expect(result).toEqual({ alreadyAvailable: false, pulled: true, model: "gemma3:4b" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("pull fails → returns error", async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce({
        ok: true,
        body: ndjsonStream([{ status: "error", error: "model not found" }]),
      });

    const result = await ensureDefaultModel();
    expect(result).toEqual({
      alreadyAvailable: false,
      pulled: false,
      model: "gemma3:4b",
      error: "model not found",
    });
  });

  it("Ollama not running → returns error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Connection refused"));

    const result = await ensureDefaultModel();
    expect(result).toEqual({
      alreadyAvailable: false,
      pulled: false,
      model: "gemma3:4b",
      error: "Connection refused",
    });
  });
});
