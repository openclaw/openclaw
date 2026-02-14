import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pullOllamaModel } from "./ollama-model-pull.js";

function ndjsonStream(chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map((c) => JSON.stringify(c) + "\n");
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

describe("pullOllamaModel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("successful pull with progress events", async () => {
    const chunks = [
      { status: "pulling manifest" },
      { status: "downloading sha256:abc", completed: 500, total: 1000 },
      { status: "downloading sha256:abc", completed: 1000, total: 1000 },
      { status: "success" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: ndjsonStream(chunks),
    });

    const progress: Array<[string, number | undefined, number | undefined]> = [];
    const result = await pullOllamaModel("gemma3:4b", {
      onProgress: (status, completed, total) => progress.push([status, completed, total]),
    });

    expect(result).toEqual({ success: true });
    expect(progress).toHaveLength(4);
    expect(progress[0]).toEqual(["pulling manifest", undefined, undefined]);
    expect(progress[1]).toEqual(["downloading sha256:abc", 500, 1000]);
    expect(progress[2]).toEqual(["downloading sha256:abc", 1000, 1000]);
    expect(progress[3]).toEqual(["success", undefined, undefined]);
  });

  it("failed pull - model not found", async () => {
    const chunks = [{ status: "pulling manifest" }, { status: "error", error: "model not found" }];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: ndjsonStream(chunks),
    });

    const result = await pullOllamaModel("nonexistent:latest");
    expect(result).toEqual({ success: false, error: "model not found" });
  });

  it("network error - connection refused", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("fetch failed: Connection refused"),
    );

    const result = await pullOllamaModel("gemma3:4b");
    expect(result).toEqual({ success: false, error: "fetch failed: Connection refused" });
  });

  it("abort signal cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const result = await pullOllamaModel("gemma3:4b", { signal: controller.signal });
    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
  });

  it("progress callback receives correct completed/total numbers", async () => {
    const chunks = [
      { status: "downloading sha256:abc", completed: 0, total: 2000 },
      { status: "downloading sha256:abc", completed: 1000, total: 2000 },
      { status: "downloading sha256:abc", completed: 2000, total: 2000 },
      { status: "success" },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: ndjsonStream(chunks),
    });

    const progress: Array<[number | undefined, number | undefined]> = [];
    await pullOllamaModel("gemma3:4b", {
      onProgress: (_status, completed, total) => progress.push([completed, total]),
    });

    expect(progress[0]).toEqual([0, 2000]);
    expect(progress[1]).toEqual([1000, 2000]);
    expect(progress[2]).toEqual([2000, 2000]);
    expect(progress[3]).toEqual([undefined, undefined]);
  });
});
