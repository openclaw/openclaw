import { APIError } from "openai/core/error";
import { describe, expect, it } from "vitest";
import { configureProviderErrorRedactor, projectProviderError } from "./provider-error.js";

describe("projectProviderError", () => {
  const malformed = "[Malformed diagnostic JSON redacted]";
  const projectBody = (body: unknown) => projectProviderError({ status: 500, body });
  const serialize = (error: unknown) => JSON.stringify(projectProviderError(error));
  const sdkError = (status: number, headers: Record<string, string>) =>
    new APIError(status, { message: "rate limited" }, undefined, new Headers(headers));
  it("preserves streamed response.failed error semantics without response content", () => {
    const error = Object.assign(new Error("invalid_prompt: rejected"), {
      code: "invalid_prompt",
      response: {
        id: "resp_fixture",
        status: "failed",
        error: { code: "invalid_prompt", type: "invalid_request_error", message: "rejected" },
        output: [{ type: "message", content: "unrelated generated text" }],
      },
    });
    expect(projectProviderError(error)).toMatchObject({
      errorCode: "invalid_prompt",
      errorType: "invalid_request_error",
      errorBody: '{"code":"invalid_prompt","message":"rejected","type":"invalid_request_error"}',
    });
  });
  it("requires a complete redaction marker before preserving prose", () => {
    expect(
      projectProviderError("[2 ordinary lines remain] token=<redacted>=short-secret").errorMessage,
    ).toBe(malformed);
  });
  it.each([
    "[1 note token=short-secret]",
    "[1 note data=QUJDRA== type=image]",
    "[1 note status=b64_json=QUJDRA==]",
    '[[2 ordinary lines remain],"sk-synthetic-secret-value"]',
  ])("keeps structured admission around prose: %s", (error) => {
    expect(projectProviderError(error).errorMessage).toBe(malformed);
  });
  it("fails closed for nonnumeric structured fragments", () => {
    const error =
      '[note "-----BEGIN PRIVATE KEY-----\\nQUJDRA==\\n-----END PRIVATE KEY-----"] {"ok":true}';
    expect(projectProviderError(error).errorMessage).toBe(malformed);
  });
  it("preserves SDK retry timing without exposing unrelated headers", () => {
    const error = sdkError(429, {
      "retry-after": "7",
      "retry-after-ms": "335",
      authorization: "Bearer synthetic-credential",
    });
    const projection = projectProviderError(error);
    expect(projection.retryAfterMs).toBe(7_000);
    expect(projection.errorMessage).toContain("Retry-After: 7 seconds");
    expect(projection.errorBody).toBe('{"message":"rate limited"}');
    expect(JSON.stringify(projection)).not.toContain("synthetic-credential");
  });
  it.each([
    // An explicit retry instruction outranks the bucket's full-refill time.
    { status: 429, remaining: "0", retryAfter: "7", retryAfterMs: 7_000 },
    { status: 429, remaining: "0", retryAfter: undefined, retryAfterMs: 62_500 },
    { status: 429, remaining: "1", retryAfter: "7", retryAfterMs: 7_000 },
    { status: 503, remaining: "0", retryAfter: "7", retryAfterMs: 7_000 },
  ])(
    "projects native quota headers before redaction: $status/$remaining/$retryAfter",
    ({ status, remaining, retryAfter, retryAfterMs }) => {
      const projection = projectProviderError(
        sdkError(status, {
          ...(retryAfter ? { "retry-after": retryAfter } : {}),
          "x-ratelimit-remaining-tokens": remaining,
          "x-ratelimit-reset-tokens": "1m2.5s",
          authorization: "Bearer synthetic-credential",
        }),
      );
      expect(projection.retryAfterMs).toBe(retryAfterMs);
      expect(JSON.stringify(projection)).not.toContain("synthetic-credential");
    },
  );
  it("reserves room for retry timing after truncating a long SDK message", () => {
    const error = new APIError(
      429,
      undefined,
      "x".repeat(5000),
      new Headers({ "retry-after": "7" }),
    );
    const projection = projectProviderError(error);
    expect(projection.errorMessage).toHaveLength(4096);
    expect(projection.errorMessage).toMatch(/; Retry-After: 7 seconds$/);
  });
  it("normalizes string and finite-number provider error fields", () => {
    const error = { message: "  provider failure  ", code: 12.5, type: "  upstream  " };
    expect(projectProviderError(error)).toMatchObject({
      errorMessage: "provider failure",
      errorCode: "12.5",
      errorType: "upstream",
    });
    expect(
      projectProviderError({ message: "failed", code: Number.POSITIVE_INFINITY }),
    ).not.toHaveProperty("errorCode");
  });
  it("bounds repeated aliases without expanding the shared graph", () => {
    const shared = { detail: "safe" };
    expect(projectProviderError({ first: shared, second: shared }).errorMessage).toBe(
      '{"first":{"detail":"safe"},"second":"[Circular]"}',
    );
  });
  it("does not split surrogate pairs when truncating response bodies", () => {
    const body = `${"x".repeat(499)}😀tail`;
    const error = Object.assign(new Error("502 status code (no body)"), { status: 502, body });
    expect(projectProviderError(error).errorBody).toBe(`${"x".repeat(499)}... [truncated]`);
  });
  it("keeps the rejection reason when bounding a redacted structured response body", () => {
    const projection = projectProviderError({
      status: 400,
      body: {
        error: { message: "Cache control limit exceeded" },
        trace: "x".repeat(5000),
      },
    });
    expect(projection.errorCode).toBe("400");
    expect(projection.errorMessage).toContain("400:");
    expect(projection.errorMessage).toContain("Cache control limit exceeded");
    expect(projection.errorMessage?.length).toBeLessThanOrEqual(4111);
    expect(projection.errorBody?.length).toBeLessThanOrEqual(515);
  });
  it("preserves known HTTP status with a short message and a response body", () => {
    const error = Object.assign(new Error("Provider request failed"), {
      status: 429,
      body: { error: { message: "Try later" } },
    });
    expect(projectProviderError(error)).toMatchObject({
      errorMessage: "429: Provider request failed",
      errorCode: "429",
    });
  });
  it("bounds repeated structured diagnostic fragments before extraction", () => {
    expect(projectProviderError("{}".repeat(8193)).errorMessage).toBe(
      "[Oversized diagnostic JSON redacted]",
    );
  });
  it.each([
    [
      "credential in a JSON message prefix",
      new Error('Provider token=abcdefghijklmnop : {"b64_json":"QUJDRA=="}'),
      'Provider token=<redacted> : {"b64_json":"<redacted>"}',
    ],
    [
      "harmless JSON before sensitive JSON",
      new Error('meta {"ok":true} payload {"type":"video","data":"QUJDRA=="}'),
      'meta {"ok":true} payload {"data":{"bytes":4,"redacted":"<redacted>"},"type":"video"}',
    ],
  ])("redacts media from %s", (_name, error, expected) => {
    expect(projectProviderError(error).errorMessage).toBe(expected);
  });
  it("redacts media arrays containing string chunks", () => {
    expect(JSON.stringify(projectBody({ videoFrames: ["QUJDRA=="] }))).not.toMatch(
      /QUJDRA==|65,66,67,68/u,
    );
  });
  it.each([
    [
      "MIME-qualified file URI",
      '{"mimeType":"video/mp4","fileUri":"https://media.invalid/signed"}',
      "https://media.invalid/signed",
    ],
    ["audio wrapper bytes", '{"audio":{"bytes":[65,66,67,68]}}', "[65,66,67,68]"],
    ["array following a JSON literal", '[true,{"b64_json":"QUJDRA=="}]', "QUJDRA=="],
  ])("redacts %s from a JSON response-body string", (_name, body, leaked) => {
    expect(JSON.stringify(projectBody(body))).not.toContain(leaked);
  });
  it("canonicalizes sensitive JSON with duplicate credential values", () => {
    const body = '{"name":"password","value":"actual-secret","value":"<redacted>"}';
    expect(projectBody(body).errorBody).toBe('{"name":"password","value":"<redacted>"}');
  });
  it("fails closed for a malformed payload in bracketed diagnostic text", () => {
    expect(projectBody('[ERROR] payload "type":"video","data":"QUJDRA=="').errorBody).toBe(
      malformed,
    );
  });
  it("fails closed for malformed JSON response-body strings", () => {
    const projected = projectBody('{"type":"video","data":"QUJDRA=="');
    expect(JSON.stringify(projected)).not.toContain("QUJDRA==");
    expect(projected.errorBody).toBe(malformed);
  });
  it("does not invoke hostile terminal-field accessors without a host", () => {
    const error = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(error, "safe", { enumerable: true, value: "connection failed" });
    for (const key of ["status", "body", "message"]) {
      Object.defineProperty(error, key, {
        enumerable: true,
        get: () => {
          throw new Error(`${key} getter`);
        },
      });
    }
    expect(() => projectProviderError(error)).not.toThrow();
    expect(projectProviderError(error).errorMessage).toContain("connection failed");
  });
  it("never throws when a proxy revokes itself after descriptor collection", () => {
    const revocable = Proxy.revocable([], {
      ownKeys: Reflect.ownKeys,
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "length") {
          revocable.revoke();
        }
        return descriptor;
      },
    });
    const projected = projectProviderError(revocable.proxy);
    expect(projected.stopReason).toBe("error");
    expect(projected.errorMessage).toBe("[Unserializable]");
  });
  it("caps descriptor reads from hostile objects", () => {
    let descriptorReads = 0;
    const keys = Array.from({ length: 1_000 }, (_, index) => `field${index}`);
    const error = new Proxy(
      {},
      {
        ownKeys: () => keys,
        getOwnPropertyDescriptor: (_target, key) => {
          descriptorReads += 1;
          return { configurable: true, enumerable: true, value: String(key) };
        },
      },
    );
    expect(projectProviderError(error).stopReason).toBe("error");
    // Fixed timing-metadata probes (headers plus the RetryInfo body shape) precede the
    // bounded diagnostic walk.
    expect(descriptorReads).toBe(64 + 10);
  });
  it("caps descriptor reads across a branching hostile graph", () => {
    let descriptorReads = 0;
    const keys = Array.from({ length: 64 }, (_, index) => `field${index}`);
    const createNode = (): object =>
      new Proxy(
        {},
        {
          ownKeys: () => keys,
          getOwnPropertyDescriptor: () => {
            descriptorReads += 1;
            return { configurable: true, enumerable: true, value: createNode() };
          },
        },
      );
    expect(projectProviderError(createNode()).stopReason).toBe("error");
    // Status, response and RetryInfo shape probes are a fixed cost, not another graph walk.
    expect(descriptorReads).toBe(64 * 64 + 33);
  });
  it.each([
    ["value", "late-discriminator-secret", "name", "api_key"],
    ["data", "QUJDRA==", "type", "video"],
  ])("redacts %s when its discriminator falls beyond the field cap", (field, value, key, kind) => {
    const error: Record<string, unknown> = { [field]: value };
    for (let index = 0; index < 63; index += 1) {
      error[`field${index}`] = index;
    }
    error[key] = kind;
    expect(serialize(error)).not.toContain(value);
  });
  it("redacts ArrayBuffer media bytes without an installed host", () => {
    const error = Object.assign(new Error("502 status code (no body)"), {
      status: 502,
      body: { type: "video", data: new Uint8Array([7, 8, 9]).buffer },
    });
    const projected = projectProviderError(error);
    const serialized = JSON.stringify(projected);
    expect(projected.errorMessage).toContain("502:");
    expect(serialized).toContain("<redacted>");
    expect(serialized).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
  });
  it("redacts a bare Buffer response body by value", () => {
    const projected = projectBody(Buffer.from([1, 2, 3]));
    const summary = '{"bytes":3,"redacted":"<redacted>"}';
    expect(projected.errorMessage).toBe(`500: ${summary}`);
    expect(projected.errorBody).toBe(summary);
    expect(JSON.stringify(projected)).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
  });
  it("redacts credentials from terminal fields without an installed host", () => {
    const bearer = ["not", "a", "bearer", "credential"].join("-");
    const apiKey = ["not", "an", "api", "key"].join("-");
    const jwt = [
      "eyJub3QiLCJhIjoicmVhbCIsImp3dCI6dHJ1ZX0",
      "bm90LXJlYWwtc2lnbmF0dXJl",
      "bm90LXJlYWwtc2lnbmF0dXJl",
    ].join(".");
    const cookie = ["not", "a", "session", "cookie", "value"].join("-");
    const projected = projectProviderError({
      status: 400,
      body: {
        authorization: `Bearer ${bearer}`,
        apiKey,
        details: [`Bearer ${bearer}`, jwt, `session=${cookie}`],
      },
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain(cookie);
    expect(serialized).toContain("Bearer <redacted>");
    expect(serialized).toContain("<redacted-jwt>");
    expect(serialized).toContain("session=<redacted>");
  });
  it("keeps the package-safe snapshot when host strengthening throws", () => {
    const secret = "package-owned-fallback-secret";
    const previous = configureProviderErrorRedactor(() => {
      throw new Error("redactor failed");
    });
    try {
      const projected = projectProviderError({
        message: "provider failed",
        body: { apiKey: secret },
      });
      expect(projected.errorMessage).toBe("provider failed");
      expect(JSON.stringify(projected)).not.toContain(secret);
    } finally {
      configureProviderErrorRedactor(previous);
    }
  });
  it.each(["JSESSIONID=0123456789abcdef", 'token="abcdefghijklmnop"'])(
    "redacts loose credential pair in %s",
    (value) => {
      expect(projectProviderError(value).errorMessage).not.toMatch(
        /0123456789abcdef|sk-0123456789012345|abcdefghijklmnop/u,
      );
    },
  );
  it("redacts arbitrary credential names inside cookie headers", () => {
    expect(projectProviderError("Cookie: sid=abc123").errorMessage).toMatch(
      /^(?:Set-)?Cookie: <redacted>$/u,
    );
  });
  it.each(["x-api-key: sk-0123456789012345", "{'Authorization': 'ApiKey 0123456789abcdef'}"])(
    "redacts credential header %s",
    (header) => {
      expect(projectProviderError(header).errorMessage).not.toMatch(
        /sk-0123456789012345|0123456789abcdef/u,
      );
    },
  );
});
