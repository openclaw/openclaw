import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOkOrThrowProviderError as assertProviderOk,
  assertOkOrThrowHttpError as assertHttpOk,
  createProviderCredentialMatcher as credentialMatcher,
  createProviderErrorTextRedactor as textRedactor,
  createProviderHttpError as createError,
  extractProviderErrorDetail as errorDetail,
  extractProviderRequestId as requestId,
  formatProviderErrorPayload as formatPayload,
  ProviderHttpError,
  readProviderBinaryResponse as readBinary,
  readProviderJsonResponse as readJson,
  readProviderTextResponse as readText,
  readResponseTextLimited as readLimited,
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

const streamResponse = (
  source: UnderlyingSource<Uint8Array>,
  status = 200,
  headers?: HeadersInit,
) => new Response(new ReadableStream<Uint8Array>(source), { status, headers });
const byteResponse = (contentType?: string) =>
  new Response(
    new Uint8Array([1]),
    contentType === undefined ? undefined : { headers: { "content-type": contentType } },
  );

const label = "Provider API error";
const jsonResponse = (payload: unknown, status = 400, headers?: HeadersInit) =>
  new Response(JSON.stringify(payload), { status, headers });
const stalledResponse = (cancel: () => void) =>
  streamResponse({ pull: () => new Promise<void>(() => {}), cancel }, 503);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("provider error utils", () => {
  it("matches only active credential values, including the redaction marker itself", () => {
    const empty = credentialMatcher({
      headers: new Headers({ Accept: "application/json" }),
      defaultAuthHeader: "Authorization",
    });
    expect(empty("Bearer demo application/json")).toBe(false);
    const active = credentialMatcher({
      headers: new Headers({ Authorization: "Bearer ***" }),
      defaultAuthHeader: "Authorization",
      defaultAuthPrefix: "Bearer ",
    });
    expect(active("***")).toBe(true);
    expect(active("Bearer demo")).toBe(false);
    const basic = credentialMatcher({
      headers: new Headers({
        Authorization: "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64"),
      }),
      defaultAuthHeader: "Authorization",
    });
    expect(basic("fixture-password")).toBe(true);
  });
  it("matches the active values of configured headers without matching transport defaults", () => {
    const matches = credentialMatcher({
      headers: new Headers({
        Accept: "application/json",
        "X-API-Key": "active-key",
        "X-Request-Key": "request-key",
      }),
      configuredHeaderNames: ["X-API-Key"],
      request: { headers: { "X-Request-Key": "overridden-key" } },
      defaultAuthHeader: "Authorization",
    });
    expect(matches("active-key")).toBe(true);
    expect(matches("request-key")).toBe(true);
    expect(matches("overridden-key application/json Bearer demo")).toBe(false);
  });
  it("redacts canonical JSON and URL encodings after removing a custom auth prefix", () => {
    const value = 'synthetic-"quoted-token';
    const redact = textRedactor({
      headers: new Headers({ "X-Server-Key": "Token " + value }),
      request: { auth: { mode: "header", headerName: "X-Server-Key", prefix: "Token ", value } },
      defaultAuthHeader: "Authorization",
    });
    expect(redact(JSON.stringify({ model: value }))).toBe('{"model":"***"}');
    expect(redact(encodeURIComponent(value))).toBe("***");
    expect(redact(value.slice(0, -3), { truncated: true })).toBe("***");
  });
  it.each([
    ["string", "provider failure", undefined],
    ["empty object", {}, undefined],
    ["type-only metadata", { type: " rate ", code: " " }, "[type=rate]"],
  ] as const)("formats the public %s payload", (_name, payload, expected) => {
    expect(formatPayload(payload)).toBe(expected);
  });

  it("reads string error fields and fallback request id headers", async () => {
    const response = jsonResponse({ error: "Invalid API key" }, 401, {
      "request-id": "fallback_req",
    });

    expect(await errorDetail(response)).toBe("Invalid API key");
    expect(requestId(response)).toBe("fallback_req");
  });

  it("preserves OAuth error descriptions as actionable details", async () => {
    const response = jsonResponse({
      error: "invalid_request",
      error_description: "AADSTS7000215: Invalid client secret provided.",
    });

    await expect(assertProviderOk(response, "OAuth token exchange failed")).rejects.toThrow(
      "OAuth token exchange failed (400): AADSTS7000215: Invalid client secret provided. [code=invalid_request]",
    );
  });

  it("does not split UTF-16 surrogate pairs when truncating provider error details", async () => {
    const safePrefix = "a".repeat(218);
    const message = `${safePrefix}😀suffix`;
    const response = jsonResponse({ error: { message, code: "utf16_test" } });

    await expect(assertProviderOk(response, label)).rejects.toThrow(
      `Provider API error (400): ${safePrefix}… [code=utf16_test]`,
    );
  });

  it("propagates a bounded error-body timeout instead of hanging normalization", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = stalledResponse(cancel);
    const assertion = expect(
      assertHttpOk(response, label, {
        bodyTimeoutMs: () => 50,
        onBodyTimeout: ({ timeoutMs }) => new Error(`provider body timed out ${timeoutMs}`),
      }),
    ).rejects.toThrow("provider body timed out 50");

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves the request timeout that interrupts an error body", async () => {
    const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const response = streamResponse(
      {
        start(controller) {
          controller.error(timeout);
        },
      },
      503,
    );

    await expect(assertProviderOk(response, label)).rejects.toBe(timeout);
  });

  it("propagates an already-expired lazy error-body deadline", async () => {
    const cancel = vi.fn();
    const response = stalledResponse(cancel);

    await expect(
      assertHttpOk(response, label, {
        bodyTimeoutMs: () => {
          throw new Error("provider deadline already expired");
        },
      }),
    ).rejects.toThrow("provider deadline already expired");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["complete", 64, "provider error", 0],
    ["truncated", 8, "provider", 1],
  ] as const)(
    "releases %s body readers and cancels only truncation",
    async (kind, limit, expected, cancellations) => {
      const releaseLock = vi.fn();
      const cancel = vi.fn(async () => undefined);
      let read = false;
      const response = {
        body: {
          getReader: () => ({
            read: async () => {
              const done = kind === "complete" && read;
              read = true;
              return done
                ? { done, value: undefined }
                : { done, value: new TextEncoder().encode("provider error") };
            },
            cancel,
            releaseLock,
          }),
        },
      } as unknown as Response;
      await expect(readLimited(response, limit)).resolves.toBe(expected);
      expect(cancel).toHaveBeenCalledTimes(cancellations);
      expect(releaseLock).toHaveBeenCalledOnce();
    },
  );

  it("attaches structured provider error metadata", async () => {
    // API-key-like substrings must be redacted from stored error bodies.
    const response = jsonResponse(
      {
        error: {
          message: "Quota exceeded for api_key=sk-secret1234567890abcd",
          type: "rate_limit_error",
          code: "insufficient_quota",
        },
      },
      429,
      { "x-request-id": "req_456" },
    );

    const error = await createError(response, label);
    expect(error).toMatchObject({
      name: "ProviderHttpError",
      status: 429,
      statusCode: 429,
      code: "insufficient_quota",
      errorCode: "insufficient_quota",
      errorType: "rate_limit_error",
      requestId: "req_456",
    } satisfies Partial<ProviderHttpError>);
    expect(error).toMatchObject({
      message: expect.stringContaining("Quota exceeded"),
      errorBody: expect.stringContaining("Quota exceeded"),
    });
    expect(error.errorBody).not.toContain("sk-secret1234567890abcd");
  });

  it.each([
    ["delta seconds", "12", 12_000],
    ["past HTTP date", "Fri, 01 May 2026 11:59:55 GMT", 0],
  ])("preserves Retry-After $name as structured milliseconds", async (_name, value, expected) => {
    const now = Date.UTC(2026, 4, 1, 12, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const error = await createError(
      new Response(null, { status: 429, headers: { "Retry-After": value } }),
      label,
    );

    expect(error).toMatchObject({ retryAfterMs: expected });
  });

  it("redacts reflected request credentials before extracting provider error metadata", async () => {
    const credential = 'opaque +17/GLASS~MOTH%"tail';
    const encoded = encodeURIComponent(credential);
    const response = jsonResponse(
      {
        error: {
          message: `Proxy rejected ${"x".repeat(195)} ${credential}`,
          code: encoded,
          type: credential,
        },
      },
      401,
      { "x-request-id": encoded },
    );

    const error = await createError(response, "Provider request failed", {
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
      expect(error.errorBody).not.toContain(representation);
    }
  });

  it("redacts a reflected credential cut by the error body byte limit", async () => {
    const credential = `opaque-prefix-${"q".repeat(16 * 1024)}-suffix`;
    const response = new Response(`Proxy rejected ${credential}`, { status: 401 });

    const error = await createError(response, "Provider request failed", {
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
    const error = await readJson(response, "Provider response failed", {
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

    await expect(readJson(response, "Provider JSON failed")).rejects.toMatchObject({
      message: "Provider JSON failed: malformed JSON response",
      cause: expect.any(TypeError) as unknown,
    });
  });

  it("caps successful text responses instead of buffering oversized bodies", async () => {
    const streamed = createStreamingResponse("text/plain", 120);

    await expect(
      readText(streamed.response, "Provider text failed", {
        maxBytes: 2048,
      }),
    ).rejects.toThrow("Provider text failed: text response exceeds 2048 bytes");

    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("does not await clone-tee cancellation for rejected binary responses", async () => {
    const cancel = vi.fn();
    const response = streamResponse({ cancel }, 200, { "content-type": "application/json" });
    const captureClone = response.clone();

    await expect(readBinary(response, "Provider TTS failed", "audio")).rejects.toThrow(
      "Provider TTS failed: malformed audio response",
    );
    expect(cancel).not.toHaveBeenCalled();
    await captureClone.body?.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: "video", contentType: undefined },
    { kind: "binary", contentType: "; text/html" },
  ])("accepts $kind response content type $contentType", async ({ kind, contentType }) => {
    const response = byteResponse(contentType);

    await expect(readBinary(response, "Provider failed", kind)).resolves.toEqual(Buffer.from([1]));
  });

  it.each([
    { kind: "audio", contentType: "" },
    { kind: "audio", contentType: "video/mp4" },
    { kind: "audio", contentType: 'audio/ogg; codecs="opus\\", vorbis", text/html' },
  ])("rejects $contentType for $kind responses", async ({ kind, contentType }) => {
    const response = byteResponse(contentType);

    await expect(readBinary(response, "Provider failed", kind)).rejects.toThrow(
      `Provider failed: malformed ${kind} response`,
    );
  });

  it.each([
    {
      kind: "binary",
      timeout: 30_000,
      contentType: "audio/mpeg",
      status: 200,
      body: new Uint8Array([1]),
      error: "stalled-provider: response body stalled for 30000ms",
    },
    {
      kind: "error",
      timeout: 10_000,
      contentType: "application/json",
      status: 502,
      body: new TextEncoder().encode('{"error": {"message": "par'),
      error: "stalled-error (502)",
    },
  ])(
    "bounds stalled $kind bodies with the default idle timeout",
    async ({ kind, timeout, contentType, status, body, error }) => {
      vi.useFakeTimers();
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const response = streamResponse(
        {
          start(controller) {
            controller.enqueue(body);
          },
        },
        status,
        { "content-type": contentType },
      );
      const assertion = expect(
        kind === "binary"
          ? readBinary(response, "stalled-provider", "audio")
          : assertProviderOk(response, "stalled-error"),
      ).rejects.toThrow(error);
      await vi.advanceTimersByTimeAsync(0);
      if (kind === "error") {
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), timeout);
      }
      await vi.advanceTimersByTimeAsync(timeout);
      await assertion;
    },
  );
});
