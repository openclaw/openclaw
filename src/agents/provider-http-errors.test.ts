// Verifies provider HTTP error parsing, redaction, and response-size limits.
import { describe, expect, it, vi } from "vitest";
import {
  assertOkOrThrowProviderError,
  assertOkOrThrowHttpError,
  createProviderHttpError,
  extractProviderErrorDetail,
  extractProviderRequestId,
  formatProviderErrorPayload,
  ProviderHttpError,
  readProviderBinaryResponse,
  readProviderJsonResponse,
  readProviderTextResponse,
  readResponseTextLimited,
} from "./provider-http-errors.js";

function createStreamingResponse(contentType: string, byte = 97) {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= 20) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(new Uint8Array(1024).fill(byte));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": contentType },
    }),
    getReadCount: () => reads,
  };
}

describe("provider error utils", () => {
  it.each([
    ["string", "provider failure", undefined],
    ["empty object", {}, undefined],
    ["type-only metadata", { type: " rate ", code: " " }, "[type=rate]"],
  ] as const)("formats the public %s payload", (_name, payload, expected) => {
    expect(formatProviderErrorPayload(payload)).toBe(expected);
  });

  it("reads string error fields and fallback request id headers", async () => {
    const response = new Response(JSON.stringify({ error: "Invalid API key" }), {
      status: 401,
      headers: { "request-id": "fallback_req" },
    });

    expect(await extractProviderErrorDetail(response)).toBe("Invalid API key");
    expect(extractProviderRequestId(response)).toBe("fallback_req");
  });

  it("preserves OAuth error descriptions as actionable details", async () => {
    const response = new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "AADSTS7000215: Invalid client secret provided.",
      }),
      { status: 400 },
    );

    await expect(
      assertOkOrThrowProviderError(response, "OAuth token exchange failed"),
    ).rejects.toThrow(
      "OAuth token exchange failed (400): AADSTS7000215: Invalid client secret provided. [code=invalid_request]",
    );
  });

  it("does not split UTF-16 surrogate pairs when truncating provider error details", async () => {
    const safePrefix = "a".repeat(218);
    const message = `${safePrefix}😀suffix`;
    const response = new Response(
      JSON.stringify({
        error: { message, code: "utf16_test" },
      }),
      { status: 400 },
    );

    await expect(assertOkOrThrowProviderError(response, "Provider API error")).rejects.toThrow(
      `Provider API error (400): ${safePrefix}… [code=utf16_test]`,
    );
  });

  it("propagates a bounded error-body timeout instead of hanging normalization", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>(() => {});
          },
          cancel,
        }),
        { status: 503 },
      );
      const assertion = expect(
        assertOkOrThrowHttpError(response, "Provider API error", {
          bodyTimeoutMs: () => 50,
          onBodyTimeout: ({ timeoutMs }) => new Error(`provider body timed out ${timeoutMs}`),
        }),
      ).rejects.toThrow("provider body timed out 50");

      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the request timeout that interrupts an error body", async () => {
    const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(timeout);
        },
      }),
      { status: 503 },
    );

    await expect(assertOkOrThrowProviderError(response, "Provider API error")).rejects.toBe(
      timeout,
    );
  });

  it("propagates an already-expired lazy error-body deadline", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel,
      }),
      { status: 503 },
    );

    await expect(
      assertOkOrThrowHttpError(response, "Provider API error", {
        bodyTimeoutMs: () => {
          throw new Error("provider deadline already expired");
        },
      }),
    ).rejects.toThrow("provider deadline already expired");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("releases provider error body reader locks after bounded reads complete", async () => {
    const releaseLock = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const chunks: Array<ReadableStreamReadResult<Uint8Array>> = [
      { done: false, value: new TextEncoder().encode("provider error") },
      { done: true, value: undefined },
    ];
    const response = {
      body: {
        getReader: () => ({
          read: async () => chunks.shift() ?? { done: true, value: undefined },
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;

    await expect(readResponseTextLimited(response, 64)).resolves.toBe("provider error");
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("cancels and releases provider error body readers after diagnostic truncation", async () => {
    const releaseLock = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const response = {
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new TextEncoder().encode("provider error") }),
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;

    await expect(readResponseTextLimited(response, 8)).resolves.toBe("provider");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("attaches structured provider error metadata", async () => {
    // API-key-like substrings must be redacted from stored error bodies.
    const response = new Response(
      JSON.stringify({
        error: {
          message: "Quota exceeded for api_key=sk-secret1234567890abcd",
          type: "rate_limit_error",
          code: "insufficient_quota",
        },
      }),
      {
        status: 429,
        headers: { "x-request-id": "req_456" },
      },
    );

    const error = await createProviderHttpError(response, "Provider API error");
    expect(error).toMatchObject({
      name: "ProviderHttpError",
      status: 429,
      statusCode: 429,
      code: "insufficient_quota",
      errorCode: "insufficient_quota",
      errorType: "rate_limit_error",
      requestId: "req_456",
    } satisfies Partial<ProviderHttpError>);
    const providerError = error as ProviderHttpError;
    expect(providerError.message).toContain("Quota exceeded");
    expect(providerError.errorBody).toContain("Quota exceeded");
    expect(providerError.errorBody).not.toContain("sk-secret1234567890abcd");
  });

  it.each([
    ["delta seconds", "12", 12_000],
    ["past HTTP date", "Fri, 01 May 2026 11:59:55 GMT", 0],
  ])("preserves Retry-After $name as structured milliseconds", async (_name, value, expected) => {
    const now = Date.UTC(2026, 4, 1, 12, 0, 0);
    // Shared-worker runs (--isolate=false): restore Date.now even on assertion failure.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const error = await createProviderHttpError(
        new Response(null, { status: 429, headers: { "Retry-After": value } }),
        "Provider API error",
      );

      expect(error).toMatchObject({ retryAfterMs: expected });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("redacts reflected request credentials before extracting provider error metadata", async () => {
    const credential = 'opaque +17/GLASS~MOTH%"tail';
    const encoded = encodeURIComponent(credential);
    const response = new Response(
      JSON.stringify({
        error: {
          message: `Proxy rejected ${"x".repeat(195)} ${credential}`,
          code: encoded,
          type: credential,
        },
      }),
      { status: 401, headers: { "x-request-id": encoded } },
    );

    const error = await createProviderHttpError(response, "Provider request failed", {
      requestHeaders: { "X-Proxy-Auth": credential },
    });

    expect(error).toMatchObject({
      status: 401,
      code: "***",
      errorCode: "***",
      errorType: "***",
      requestId: "***",
    });
    for (const representation of [credential, encoded, credential.slice(0, 6)]) {
      expect(error.message).not.toContain(representation);
      expect((error as ProviderHttpError).errorBody).not.toContain(representation);
    }
  });

  it("redacts a reflected credential cut by the error body byte limit", async () => {
    const credential = `opaque-prefix-${"q".repeat(16 * 1024)}-suffix`;
    const response = new Response(`Proxy rejected ${credential}`, { status: 401 });

    const error = await createProviderHttpError(response, "Provider request failed", {
      requestHeaders: new Headers({ "X-Proxy-Auth": credential }),
    });

    expect(error).toMatchObject({
      message: "Provider request failed (401): Proxy rejected ***",
      errorBody: "Proxy rejected ***",
    });
  });

  it("does not retain reflected credentials in malformed JSON causes", async () => {
    const credential = "opaque-credential";
    const response = new Response(credential, { status: 200 });
    const error = await readProviderJsonResponse(response, "Provider response failed", {
      requestHeaders: { "X-Proxy-Auth": credential },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "Provider response failed: malformed JSON response" });
    expect(String((error as Error).cause)).not.toContain(credential);
  });

  it("rejects provider JSON responses with invalid UTF-8 bytes instead of silently replacing them", async () => {
    const invalidUtf8Bytes = new Uint8Array([0x7b, 0x22, 0x6b, 0x65, 0x79, 0x22, 0x3a, 0xff, 0x7d]);
    const response = new Response(invalidUtf8Bytes.buffer, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    await expect(readProviderJsonResponse(response, "Provider JSON failed")).rejects.toMatchObject({
      message: "Provider JSON failed: malformed JSON response",
      cause: expect.any(TypeError) as unknown,
    });
  });

  it("caps successful text responses instead of buffering oversized bodies", async () => {
    const streamed = createStreamingResponse("text/plain", 120);

    await expect(
      readProviderTextResponse(streamed.response, "Provider text failed", {
        maxBytes: 2048,
      }),
    ).rejects.toThrow("Provider text failed: text response exceeds 2048 bytes");

    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("does not await clone-tee cancellation for rejected binary responses", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const captureClone = response.clone();

    await expect(
      readProviderBinaryResponse(response, "Provider TTS failed", "audio"),
    ).rejects.toThrow("Provider TTS failed: malformed audio response");
    expect(cancel).not.toHaveBeenCalled();
    await captureClone.body?.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: "video", contentType: undefined },
    { kind: "binary", contentType: "; text/html" },
  ])("accepts $kind response content type $contentType", async ({ kind, contentType }) => {
    const response = new Response(
      new Uint8Array([1]),
      contentType ? { headers: { "content-type": contentType } } : undefined,
    );

    await expect(readProviderBinaryResponse(response, "Provider failed", kind)).resolves.toEqual(
      Buffer.from([1]),
    );
  });

  it.each([
    { kind: "audio", contentType: "" },
    { kind: "audio", contentType: "video/mp4" },
    { kind: "audio", contentType: 'audio/ogg; codecs="opus\\", vorbis", text/html' },
  ])("rejects $contentType for $kind responses", async ({ kind, contentType }) => {
    const response = new Response(new Uint8Array([1]), {
      headers: { "content-type": contentType },
    });

    await expect(readProviderBinaryResponse(response, "Provider failed", kind)).rejects.toThrow(
      `Provider failed: malformed ${kind} response`,
    );
  });

  it("bounds stalled binary provider responses with the shared default idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
        { headers: { "content-type": "audio/mpeg" } },
      );
      const assertion = expect(
        readProviderBinaryResponse(response, "stalled-provider", "audio"),
      ).rejects.toThrow("stalled-provider: response body stalled for 30000ms");

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects stalled non-2xx error body read after chunk idle timeout", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error": {"message": "par'));
        },
      });
      const response = new Response(stream, {
        status: 502,
        headers: { "content-type": "application/json" },
      });

      const assertion = expect(
        assertOkOrThrowProviderError(response, "stalled-error"),
      ).rejects.toThrow("stalled-error (502)");
      await vi.advanceTimersByTimeAsync(0);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
