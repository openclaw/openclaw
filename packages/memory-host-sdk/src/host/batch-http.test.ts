// Memory Host SDK tests cover batch http behavior.
import { createRetryRunner } from "@openclaw/retry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { postJsonWithRetry } from "./batch-http.js";
import { withRemoteHttpResponse } from "./remote-http.js";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

const remoteHttpMock = vi.mocked(withRemoteHttpResponse);

describe("postJsonWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the batch payload after a transient failure", async () => {
    remoteHttpMock
      .mockImplementationOnce(async (params) =>
        params.onResponse(new Response("busy", { status: 503 })),
      )
      .mockImplementationOnce(async (params) =>
        params.onResponse(Response.json({ ok: true, ids: [1, 2] })),
      );
    const waits: number[] = [];

    await expect(
      postJsonWithRetry({
        url: "https://memory.example/v1/batch",
        headers: {},
        body: { chunks: ["a", "b"] },
        errorPrefix: "memory batch failed",
        retryImpl: createRetryRunner({
          random: () => 0.5,
          sleep: async (delayMs) => void waits.push(delayMs),
        }),
      }),
    ).resolves.toEqual({ ok: true, ids: [1, 2] });

    expect(remoteHttpMock).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([300]);
  });

  it.each([429, 503])("keeps HTTP %s on the existing short batch retry budget", async (status) => {
    remoteHttpMock.mockImplementation(async (params) =>
      params.onResponse(new Response("retry later", { status, headers: { "Retry-After": "60" } })),
    );
    const waits: number[] = [];

    await expect(
      postJsonWithRetry({
        url: "https://memory.example/v1/batch",
        headers: {},
        body: { chunks: ["a"] },
        errorPrefix: "memory batch failed",
        retryImpl: createRetryRunner({
          random: () => 0.5,
          sleep: async (delayMs) => void waits.push(delayMs),
        }),
      }),
    ).rejects.toMatchObject({ status, retryAfterMs: 60_000 });

    expect(remoteHttpMock).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([300, 600]);
  });

  it("does not retry rejected batch input", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) =>
      params.onResponse(new Response("invalid input", { status: 400 })),
    );
    const sleep = vi.fn(async () => {});

    await expect(
      postJsonWithRetry({
        url: "https://memory.example/v1/batch",
        headers: {},
        body: { chunks: [] },
        errorPrefix: "memory batch failed",
        retryImpl: createRetryRunner({ sleep }),
      }),
    ).rejects.toMatchObject({ status: 400, message: "memory batch failed (400): invalid input" });

    expect(remoteHttpMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
