import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestClient } from "./rest.js";
import { createAbortableFetchMock, createJsonResponse } from "./test-builders.test-support.js";

async function expectAbortError(promise: Promise<unknown>) {
  let abortError: unknown;
  try {
    await promise;
  } catch (error) {
    abortError = error;
  }
  expect(abortError).toBeInstanceOf(DOMException);
  if (!(abortError instanceof DOMException)) {
    throw new Error("expected Discord request abort error");
  }
  expect(abortError.name).toBe("AbortError");
  expect(abortError.message).toBe("The operation was aborted.");
}

describe("RequestClient proxy transport", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves a live REST abort signal through successful proxied fetches", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (!(init?.signal instanceof AbortSignal)) {
        throw new Error("Expected proxied fetch init to include an AbortSignal");
      }
      expect(init.signal.aborted).toBe(false);
      receivedSignal = init.signal;
      return createJsonResponse([]);
    });

    const client = new RequestClient("Bot test-token", {
      fetch: fetchSpy,
      queueRequests: false,
    });

    await client.get("/channels/123/messages");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("lets the REST client abort hanging proxied requests after its timeout", async () => {
    const { fetch: fetchSpy } = createAbortableFetchMock();
    vi.useFakeTimers();

    const client = new RequestClient("Bot test-token", {
      fetch: fetchSpy,
      queueRequests: false,
      timeout: 20,
    });

    const request = client.get("/channels/123/messages");
    const abortExpectation = expectAbortError(request);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    await abortExpectation;
  }, 1_000);

  it("lets a caller signal cancel active proxied fetches", async () => {
    const abortable = createAbortableFetchMock();
    const controller = new AbortController();
    const client = new RequestClient("Bot test-token", {
      fetch: abortable.fetch,
      queueRequests: false,
      signal: controller.signal,
      timeout: 5_000,
    });

    const request = client.get("/channels/123/messages");
    await vi.waitFor(() => expect(abortable.fetch).toHaveBeenCalledTimes(1));

    controller.abort();

    await expectAbortError(request);
    expect(abortable.receivedSignal?.aborted).toBe(true);
  });
});
