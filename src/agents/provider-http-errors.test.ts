import { describe, expect, it } from "vitest";
import {
  assertOkOrThrowProviderError,
  assertOkOrThrowHttpError,
  extractProviderErrorDetail,
  extractProviderRequestId,
} from "./provider-http-errors.js";

describe("provider error utils", () => {
  it("formats nested provider error details with request ids", async () => {
    const response = new Response(
      JSON.stringify({
        detail: {
          message: "Quota exceeded",
          status: "quota_exceeded",
        },
      }),
      {
        status: 429,
        headers: { "x-request-id": "req_123" },
      },
    );

    await expect(assertOkOrThrowProviderError(response, "Provider API error")).rejects.toThrow(
      "Provider API error (429): Quota exceeded [code=quota_exceeded] [request_id=req_123]",
    );
  });

  it("reads string error fields and fallback request id headers", async () => {
    const response = new Response(JSON.stringify({ error: "Invalid API key" }), {
      status: 401,
      headers: { "request-id": "fallback_req" },
    });

    expect(await extractProviderErrorDetail(response)).toBe("Invalid API key");
    expect(extractProviderRequestId(response)).toBe("fallback_req");
  });

  it("keeps legacy HTTP status formatting while sharing provider parsing", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: "Bad request",
          code: "invalid_request",
        },
      }),
      {
        status: 400,
        headers: { "x-request-id": "req_legacy" },
      },
    );

    await expect(assertOkOrThrowHttpError(response, "Legacy provider error")).rejects.toThrow(
      "Legacy provider error (HTTP 400): Bad request [code=invalid_request] [request_id=req_legacy]",
    );
  });

  it("falls back to HTTP status text when the response body is empty", async () => {
    const response = new Response(null, {
      status: 400,
      statusText: "Bad Request",
    });

    expect(await extractProviderErrorDetail(response)).toBe("Bad Request");
  });

  it("falls back to HTTP status text when only whitespace is returned", async () => {
    const response = new Response("   \n  ", {
      status: 503,
      statusText: "Service Unavailable",
    });

    expect(await extractProviderErrorDetail(response)).toBe("Service Unavailable");
  });

  it("returns undefined when the response body and status text are both empty", async () => {
    const response = new Response(null, { status: 502, statusText: "" });

    expect(await extractProviderErrorDetail(response)).toBeUndefined();
  });

  it("parses provider error envelopes wrapped in SSE `data:` framing", async () => {
    const sseBody = `data: ${JSON.stringify({
      error: { message: "Quota exceeded for streaming", code: "RESOURCE_EXHAUSTED" },
    })}\n\n`;
    const response = new Response(sseBody, {
      status: 429,
      headers: { "content-type": "text/event-stream", "x-request-id": "req_sse" },
    });

    await expect(assertOkOrThrowProviderError(response, "Provider stream error")).rejects.toThrow(
      "Provider stream error (429): Quota exceeded for streaming [code=RESOURCE_EXHAUSTED] [request_id=req_sse]",
    );
  });

  it("preserves the raw body when SSE framing wraps an unrecognized payload", async () => {
    const response = new Response("data: not-json-and-not-recognized\n\n", {
      status: 400,
      statusText: "Bad Request",
    });

    expect(await extractProviderErrorDetail(response)).toBe("data: not-json-and-not-recognized");
  });

  it("falls back to status text when reading the response body throws", async () => {
    // Simulate a response whose body reader fails mid-read (e.g. socket reset
    // while extracting a 4xx error). `extractProviderErrorDetail` must not
    // propagate the failure and should still surface a useful detail.
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("ECONNRESET while reading error body"));
      },
    });
    const response = new Response(failingStream, {
      status: 502,
      statusText: "Bad Gateway",
    });

    expect(await extractProviderErrorDetail(response)).toBe("Bad Gateway");
  });
});
