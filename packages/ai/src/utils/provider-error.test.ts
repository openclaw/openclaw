import { APIError } from "openai/core/error";
import { describe, expect, it } from "vitest";
import { configureProviderErrorRedactor, projectProviderError } from "./provider-error.js";

describe("projectProviderError", () => {
  it("preserves streamed response.failed error semantics without response content", () => {
    expect(
      projectProviderError(
        Object.assign(new Error("invalid_prompt: rejected"), {
          code: "invalid_prompt",
          response: {
            id: "resp_fixture",
            status: "failed",
            error: { code: "invalid_prompt", type: "invalid_request_error", message: "rejected" },
            output: [{ type: "message", content: "unrelated generated text" }],
          },
        }),
      ),
    ).toMatchObject({
      errorCode: "invalid_prompt",
      errorType: "invalid_request_error",
      errorBody: '{"code":"invalid_prompt","message":"rejected","type":"invalid_request_error"}',
    });
  });
  it.each([["=short-secret", "[Malformed diagnostic JSON redacted]"]])(
    "requires a complete redaction marker before preserving prose (%s)",
    (suffix, expected) => {
      expect(
        projectProviderError(`[2 ordinary lines remain] token=<redacted>${suffix}`).errorMessage,
      ).toBe(expected);
    },
  );

  it.each([
    "[1 note token=short-secret]",
    "[1 note data=QUJDRA== type=image]",
    "[1 note status=b64_json=QUJDRA==]",
    '[[2 ordinary lines remain],"sk-synthetic-secret-value"]',
  ])("keeps structured admission around prose: %s", (error) => {
    expect(projectProviderError(error).errorMessage).toBe("[Malformed diagnostic JSON redacted]");
  });

  it.each([
    '[note "-----BEGIN PRIVATE KEY-----\\nQUJDRA==\\n-----END PRIVATE KEY-----"] {"ok":true}',
  ])("fails closed for nonnumeric structured fragments: %s", (error) => {
    expect(projectProviderError(error).errorMessage).toBe("[Malformed diagnostic JSON redacted]");
  });

  it.each([["335", 7]])(
    "preserves SDK retry timing without exposing unrelated headers (%s ms)",
    (milliseconds, seconds) => {
      const error = new APIError(
        429,
        { message: "rate limited" },
        undefined,
        new Headers({
          "retry-after": "7",
          "retry-after-ms": milliseconds,
          authorization: "Bearer synthetic-credential",
        }),
      );
      const projection = projectProviderError(error);
      expect(projection.retryAfterMs).toBe(seconds * 1000);
      expect(projection.errorMessage).toContain(`Retry-After: ${seconds} seconds`);
      expect(projection.errorBody).toBe('{"message":"rate limited"}');
      expect(JSON.stringify(projection)).not.toContain("synthetic-credential");
    },
  );

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
        new APIError(
          status,
          { message: "rate limited" },
          undefined,
          new Headers({
            ...(retryAfter ? { "retry-after": retryAfter } : {}),
            "x-ratelimit-remaining-tokens": remaining,
            "x-ratelimit-reset-tokens": "1m2.5s",
            authorization: "Bearer synthetic-credential",
          }),
        ),
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
    expect(
      projectProviderError({
        message: "  provider failure  ",
        code: 12.5,
        type: "  upstream  ",
      }),
    ).toMatchObject({
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

  it.each([["string chunks", ["QUJDRA=="]]])(
    "redacts media arrays containing %s",
    (_name, videoFrames) => {
      expect(
        JSON.stringify(projectProviderError({ status: 500, body: { videoFrames } })),
      ).not.toMatch(/QUJDRA==|65,66,67,68/u);
    },
  );

  it.each([
    [
      "MIME-qualified file URI",
      '{"mimeType":"video/mp4","fileUri":"https://media.invalid/signed"}',
      "https://media.invalid/signed",
    ],
    ["audio wrapper bytes", '{"audio":{"bytes":[65,66,67,68]}}', "[65,66,67,68]"],
    ["array following a JSON literal", '[true,{"b64_json":"QUJDRA=="}]', "QUJDRA=="],
  ])("redacts %s from a JSON response-body string", (_name, body, leaked) => {
    const projected = projectProviderError({ status: 500, body });

    expect(JSON.stringify(projected)).not.toContain(leaked);
  });

  it.each([
    {
      name: "duplicate credential value",
      body: '{"name":"password","value":"actual-secret","value":"<redacted>"}',
      expected: '{"name":"password","value":"<redacted>"}',
    },
  ])("canonicalizes sensitive JSON with $name", ({ body, expected }) => {
    expect(projectProviderError({ status: 500, body }).errorBody).toBe(expected);
  });

  it.each(['[ERROR] payload "type":"video","data":"QUJDRA=="'])(
    "fails closed when bracketed diagnostic text contains a malformed structured payload",
    (body) => {
      expect(projectProviderError({ status: 500, body }).errorBody).toBe(
        "[Malformed diagnostic JSON redacted]",
      );
    },
  );

  it.each(['{"type":"video","data":"QUJDRA=="'])(
    "fails closed for malformed JSON response-body strings",
    (body) => {
      const projected = projectProviderError({ status: 500, body });

      expect(JSON.stringify(projected)).not.toContain("QUJDRA==");
      expect(projected.errorBody).toBe("[Malformed diagnostic JSON redacted]");
    },
  );

  it("does not invoke hostile terminal-field accessors without a host", () => {
    const error = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(error, {
      safe: { enumerable: true, value: "connection failed" },
      status: {
        enumerable: true,
        get: () => {
          throw new Error("status getter");
        },
      },
      body: {
        enumerable: true,
        get: () => {
          throw new Error("body getter");
        },
      },
      message: {
        enumerable: true,
        get: () => {
          throw new Error("message getter");
        },
      },
    });

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

  it("redacts value fields when their discriminator falls beyond the field cap", () => {
    const secret = "late-discriminator-secret";
    const error: Record<string, unknown> = { value: secret };
    for (let index = 0; index < 63; index += 1) {
      error[`field${index}`] = index;
    }
    error.name = "api_key";

    expect(JSON.stringify(projectProviderError(error))).not.toContain(secret);
  });

  it("redacts media fields when their discriminator falls beyond the field cap", () => {
    const media = "QUJDRA==";
    const error: Record<string, unknown> = { data: media };
    for (let index = 0; index < 63; index += 1) {
      error[`field${index}`] = index;
    }
    error.type = "video";

    expect(JSON.stringify(projectProviderError(error))).not.toContain(media);
  });

  it.each([{ name: "ArrayBuffer", bytes: new Uint8Array([7, 8, 9]).buffer }])(
    "redacts $name media bytes without an installed host",
    ({ bytes }) => {
      const error = Object.assign(new Error("502 status code (no body)"), {
        status: 502,
        body: { type: "video", data: bytes },
      });

      const projected = projectProviderError(error);
      const serialized = JSON.stringify(projected);

      expect(projected.errorMessage).toContain("502:");
      expect(serialized).toContain("<redacted>");
      expect(serialized).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
    },
  );

  it.each([["Buffer", Buffer.from([1, 2, 3])]])(
    "redacts a bare %s response body by value",
    (_name, body) => {
      const projected = projectProviderError({ status: 500, body });
      const summary = '{"bytes":3,"redacted":"<redacted>"}';

      expect(projected.errorMessage).toBe(`500: ${summary}`);
      expect(projected.errorBody).toBe(summary);
      expect(JSON.stringify(projected)).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
    },
  );

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

  it.each([
    [
      "throws",
      () => {
        throw new Error("redactor failed");
      },
    ],
  ])("keeps the package-safe snapshot when host strengthening %s", (_name, redactor) => {
    const secret = "package-owned-fallback-secret";
    const previous = configureProviderErrorRedactor(redactor);
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

  it.each(["Cookie: sid=abc123"])(
    "redacts arbitrary credential names inside cookie headers",
    (header) => {
      expect(projectProviderError(header).errorMessage).toMatch(/^(?:Set-)?Cookie: <redacted>$/u);
    },
  );

  it.each(["x-api-key: sk-0123456789012345", "{'Authorization': 'ApiKey 0123456789abcdef'}"])(
    "redacts credential header %s",
    (header) => {
      expect(projectProviderError(header).errorMessage).not.toMatch(
        /sk-0123456789012345|0123456789abcdef/u,
      );
    },
  );
});
