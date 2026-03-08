import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "../../types.ts";
import { OllamaRepositoryImpl } from "../ollama-repository.ts";

const mockFetch = vi.fn<typeof fetch>();
const mockLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  vi.mocked(mockLogger.info).mockReset();
  vi.mocked(mockLogger.warn).mockReset();
  vi.mocked(mockLogger.error).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Helper: Ollama /api/generate response
const ollamaResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ response: JSON.stringify(data), done: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const format = {
  type: "object",
  properties: { meetingDetected: { type: "boolean" } },
  required: ["meetingDetected"],
};

describe("OllamaRepository", () => {
  it("returns parsed response on success", async () => {
    mockFetch.mockResolvedValueOnce(ollamaResponse({ meetingDetected: true }));
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    const result = await repo.generate<{ meetingDetected: boolean }>({
      prompt: "test prompt",
      format,
      model: "llama3.1:8b",
    });

    expect(result).toEqual({ meetingDetected: true });
  });

  it("returns null on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network timeout"));
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    const result = await repo.generate({ prompt: "test", format, model: "llama3.1:8b" });

    expect(result).toBeNull();
  });

  it("returns null on non-ok HTTP status", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    const result = await repo.generate({ prompt: "test", format, model: "llama3.1:8b" });

    expect(result).toBeNull();
  });

  it("returns null on malformed response", async () => {
    // response field is not valid JSON
    const badResponse = new Response(JSON.stringify({ response: "not json", done: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    mockFetch.mockResolvedValueOnce(badResponse);
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    const result = await repo.generate({ prompt: "test", format, model: "llama3.1:8b" });

    expect(result).toBeNull();
  });

  it("sends correct body shape to correct URL", async () => {
    mockFetch.mockResolvedValueOnce(ollamaResponse({ meetingDetected: false }));
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    await repo.generate({ prompt: "classify this", format, model: "llama3.1:8b" });

    expect(mockFetch).toHaveBeenCalledWith("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.1:8b",
        prompt: "classify this",
        stream: false,
        format,
        think: false,
      }),
    });
  });

  it("logs raw response before parsing", async () => {
    mockFetch.mockResolvedValueOnce(ollamaResponse({ meetingDetected: true }));
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    await repo.generate({ prompt: "test", format, model: "llama3.1:8b" });

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('ollama raw response: {"meetingDetected":true}'),
    );
  });

  it("logs error via logger on malformed response", async () => {
    const badResponse = new Response(JSON.stringify({ response: "not json", done: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    mockFetch.mockResolvedValueOnce(badResponse);
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    await repo.generate({ prompt: "test", format, model: "llama3.1:8b" });

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("ollama repository:"));
  });

  it("logs error via logger on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network timeout"));
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    await repo.generate({ prompt: "test", format, model: "llama3.1:8b" });

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("network timeout"));
  });

  it("logs error via logger on non-ok HTTP status", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    await repo.generate({ prompt: "test", format, model: "llama3.1:8b" });

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("500"));
  });

  it("logs warning when response field is empty", async () => {
    const emptyResponse = new Response(JSON.stringify({ response: "", done: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    mockFetch.mockResolvedValueOnce(emptyResponse);
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    const result = await repo.generate({ prompt: "test", format, model: "qwen3.5:4b" });

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "ollama repository: empty response from model qwen3.5:4b",
    );
  });

  it("throws error when unsupported model is passed", async () => {
    const repo = new OllamaRepositoryImpl("http://localhost:11434", mockLogger);

    await expect(
      repo.generate({ prompt: "test", format, model: "unsupported-model:7b" }),
    ).rejects.toThrow('Unsupported model: "unsupported-model:7b"');
  });
});
