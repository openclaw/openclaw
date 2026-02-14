import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ollamaFetch } from "./ollama-retry.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okResponse(body = "ok") {
  return new Response(body, { status: 200 });
}

function errorResponse(status: number, body = "error") {
  return new Response(body, { status });
}

function connRefusedError(): TypeError {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
    code: "ECONNREFUSED",
    errno: "ECONNREFUSED",
  });
  return new TypeError("fetch failed", { cause });
}

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

describe("ollamaFetch", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on first try with no retries", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    const res = await ollamaFetch("http://localhost:11434/api/chat", undefined, {
      retries: 3,
      retryDelayMs: 10,
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on ECONNREFUSED then succeeds", async () => {
    mockFetch.mockRejectedValueOnce(connRefusedError()).mockResolvedValueOnce(okResponse());

    const res = await ollamaFetch("http://localhost:11434/api/chat", undefined, {
      retries: 3,
      retryDelayMs: 10,
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(503, "model loading"))
      .mockResolvedValueOnce(okResponse());

    const res = await ollamaFetch("http://localhost:11434/api/chat", undefined, {
      retries: 3,
      retryDelayMs: 10,
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after all retries exhausted", async () => {
    mockFetch
      .mockRejectedValueOnce(connRefusedError())
      .mockRejectedValueOnce(connRefusedError())
      .mockRejectedValueOnce(connRefusedError())
      .mockRejectedValueOnce(connRefusedError());

    await expect(
      ollamaFetch("http://localhost:11434/api/chat", undefined, {
        retries: 3,
        retryDelayMs: 10,
      }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("does not retry on 400 error", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(400, "bad request"));

    await expect(
      ollamaFetch("http://localhost:11434/api/chat", undefined, {
        retries: 3,
        retryDelayMs: 10,
      }),
    ).rejects.toThrow("Ollama API error 400");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on timeout", async () => {
    mockFetch.mockRejectedValueOnce(timeoutError());

    await expect(
      ollamaFetch("http://localhost:11434/api/chat", undefined, {
        retries: 3,
        retryDelayMs: 10,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("timeout");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with correct attempt number", async () => {
    const onRetry = vi.fn();
    mockFetch
      .mockRejectedValueOnce(connRefusedError())
      .mockRejectedValueOnce(connRefusedError())
      .mockResolvedValueOnce(okResponse());

    await ollamaFetch("http://localhost:11434/api/chat", undefined, {
      retries: 3,
      retryDelayMs: 10,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error));
  });

  it("respects max retries config", async () => {
    mockFetch.mockRejectedValueOnce(connRefusedError()).mockRejectedValueOnce(connRefusedError());

    await expect(
      ollamaFetch("http://localhost:11434/api/chat", undefined, {
        retries: 1,
        retryDelayMs: 10,
      }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });
});
