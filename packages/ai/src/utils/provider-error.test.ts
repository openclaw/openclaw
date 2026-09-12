import { APIError } from "openai/core/error";
import { describe, expect, it } from "vitest";
import { configureProviderErrorRedactor, projectProviderError } from "./provider-error.js";

describe("projectProviderError", () => {
  it.each([
    ["", "[2 ordinary lines remain] token=<redacted>"],
    ["=short-secret", "[Malformed diagnostic JSON redacted]"],
  ])("requires a complete redaction marker before preserving prose (%s)", (suffix, expected) => {
    expect(
      projectProviderError(`[2 ordinary lines remain] token=<redacted>${suffix}`).errorMessage,
    ).toBe(expected);
  });

  it.each([
    '[true-story,"sk-synthetic-secret-value"]',
    '[false-positive,"sk-synthetic-secret-value"]',
    '[null-value,"sk-synthetic-secret-value"]',
    "[1 note token=short-secret]",
    "[1 note token=1234]",
    "[1 note b64_json=QUJDRA==]",
    "[1 note image=QUJDRA==]",
    "[1 note type=image data=QUJDRA==]",
    "[1 note data=QUJDRA== type=image]",
    "[1 note status=token=short-secret]",
    "[1 note status=b64_json=QUJDRA==]",
    "[1 note token==short-secret]",
    "[1 note b64_json==QUJDRA==]",
    "[1 note type==image data=QUJDRA==]",
    "[1 note token= =short-secret]",
    '[[2 ordinary lines remain],"sk-synthetic-secret-value"]',
    '[ [2 ordinary lines remain],"sk-synthetic-secret-value"]',
    '[note [2 ordinary lines remain],"sk-synthetic-secret-value"]',
  ])("keeps structured admission around prose: %s", (error) => {
    expect(projectProviderError(error).errorMessage).toBe("[Malformed diagnostic JSON redacted]");
  });

  it("preserves an ordinary comparison alongside numeric prose", () => {
    const value = "count == 3\n[2 ordinary lines remain]";
    expect(projectProviderError(value).errorMessage).toBe(value);
  });

  it.each([
    '[note "-----BEGIN PRIVATE KEY-----\\nQUJDRA==\\n-----END PRIVATE KEY-----"] {"ok":true}',
    '[note "sk-synthetic-secret-value"] {"ok":true}',
    '[note "\\u002d\\u002d\\u002d\\u002d\\u002dBEGIN PRIVATE KEY-----QUJDRA=="] {"ok":true}',
    '[note -----BEGIN PRIVATE KEY-----\nQUJDRA==\n-----END PRIVATE KEY-----] {"ok":true}',
    '[note token=short-secret] {"ok":true}',
  ])("fails closed for nonnumeric structured fragments: %s", (error) => {
    expect(projectProviderError(error).errorMessage).toBe("[Malformed diagnostic JSON redacted]");
  });

  it.each([
    "\nQUJDRA==\n-----END PRIVATE KEY-----",
    "QUJDRA==-----END PRIVATE KEY-----",
    "QUJDRA==",
    "",
  ])("fails closed for numeric prose containing a raw private key (%j)", (body) => {
    const error = `[1 note -----BEGIN RSA PRIVATE KEY-----${body}]`;
    expect(projectProviderError(error).errorMessage).toBe("[Malformed diagnostic JSON redacted]");
  });

  it.each(["-", "01", "1e+", "1x", "1x words", "1 words"])(
    "redacts malformed numeric array %s without host strengthening",
    (prefix) => {
      const error = `[${prefix},"-----BEGIN PRIVATE KEY-----\\nQUJDRA==\\n-----END PRIVATE KEY-----"]`;
      expect(projectProviderError(error)).toEqual({
        stopReason: "error",
        errorMessage: "[Malformed diagnostic JSON redacted]",
      });
    },
  );

  it.each([
    ["335", 7],
    ["8500", 8.5],
  ])(
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
      expect(projection.errorMessage).toContain(`Retry-After: ${seconds} seconds`);
      expect(projection.errorBody).toBe('{"message":"rate limited"}');
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

  it.each([
    {
      name: "JSON body",
      error: Object.assign(new Error("403 status code (no body)"), {
        status: 403,
        error: { message: "blocked by gateway" },
      }),
      expected: '403: {"message":"blocked by gateway"}',
    },
    {
      name: "text body",
      error: Object.assign(new Error("502 status code (no body)"), {
        status: 502,
        body: "proxy unavailable",
      }),
      expected: "502: proxy unavailable",
    },
    {
      name: "no body",
      error: Object.assign(new Error("503 status code (no body)"), { status: 503 }),
      expected: "503 status code (no body)",
    },
  ])("formats an HTTP error with $name", ({ error, expected }) => {
    expect(projectProviderError(error).errorMessage).toBe(expected);
  });

  it("preserves an SDK message that already contains the response body", () => {
    const body = '{"error":{"message":"permission denied"}}';
    const error = Object.assign(new Error(body), { status: 403, body });

    expect(projectProviderError(error).errorMessage).toBe(body);
  });

  it("preserves a meaningful SDK message alongside its structured body", () => {
    const error = Object.assign(new Error("400 Param Incorrect"), {
      status: 400,
      error: { code: "invalid_parameter", message: "parameter detail" },
    });

    expect(projectProviderError(error)).toMatchObject({
      errorMessage: "400 Param Incorrect",
      errorBody: '{"code":"invalid_parameter","message":"parameter detail"}',
    });
  });

  it("preserves diagnostic fields when serializing a circular error object", () => {
    const error: Record<string, unknown> = { code: "ECONNRESET" };
    error.self = error;

    expect(projectProviderError(error).errorMessage).toBe(
      '{"code":"ECONNRESET","self":"[Circular]"}',
    );
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

  it("bounds repeated structured diagnostic fragments before extraction", () => {
    expect(projectProviderError("{}".repeat(8193)).errorMessage).toBe(
      "[Oversized diagnostic JSON redacted]",
    );
  });

  it.each([
    ["Error.message", new Error("failed data:video/mp4;base64,QUJDRA=="), "failed <redacted>"],
    ["string throw", "failed data:audio/mpeg;base64,QUJDRA==", "failed <redacted>"],
    [
      "structured response body",
      Object.assign(new Error("415 status code (no body)"), {
        status: 415,
        body: { type: "video", data: "QUJDRA==" },
      }),
      '415: {"data":{"bytes":4,"redacted":"<redacted>"},"type":"video"}',
    ],
    [
      "prefixed JSON message",
      new Error('Error: {"b64_json":"QUJDRA=="}'),
      'Error: {"b64_json":"<redacted>"}',
    ],
    [
      "credential in a JSON message prefix",
      new Error('Provider token=abcdefghijklmnop : {"b64_json":"QUJDRA=="}'),
      'Provider token=<redacted> : {"b64_json":"<redacted>"}',
    ],
    [
      "bracketed provider prefix",
      new Error('Error [provider]: {"b64_json":"QUJDRA=="}'),
      'Error [provider]: {"b64_json":"<redacted>"}',
    ],
    [
      "provider prefix without a delimiter",
      new Error('Error [provider] {"b64_json":"QUJDRA=="}'),
      'Error [provider] {"b64_json":"<redacted>"}',
    ],
    [
      "multiline provider prefix",
      new Error('Error from\nprovider: {"b64_json":"QUJDRA=="}'),
      'Error from\nprovider: {"b64_json":"<redacted>"}',
    ],
    [
      "long provider prefix",
      new Error(`${"x".repeat(129)}: {"b64_json":"QUJDRA=="}`),
      `${"x".repeat(129)}: {"b64_json":"<redacted>"}`,
    ],
    [
      "suffixed Anthropic JSON message",
      new Error(
        'HTTP 429: {"type":"error","error":{"message":"safe","b64_json":"QUJDRA=="}}; Retry-After: 30 seconds',
      ),
      'HTTP 429: {"error":{"b64_json":"<redacted>","message":"safe"},"type":"error"}; Retry-After: 30 seconds',
    ],
    [
      "bracket-tagged JSON message",
      new Error('[ERROR] payload {"type":"video","data":"QUJDRA=="}'),
      '[ERROR] payload {"data":{"bytes":4,"redacted":"<redacted>"},"type":"video"}',
    ],
    [
      "harmless JSON before sensitive JSON",
      new Error('meta {"ok":true} payload {"type":"video","data":"QUJDRA=="}'),
      'meta {"ok":true} payload {"data":{"bytes":4,"redacted":"<redacted>"},"type":"video"}',
    ],
    [
      "two sensitive JSON fragments",
      new Error('first {"b64_json":"QUJDRA=="} second {"b64_json":"QUJDRA=="}'),
      'first {"b64_json":"<redacted>"} second {"b64_json":"<redacted>"}',
    ],
  ])("redacts media from %s", (_name, error, expected) => {
    expect(projectProviderError(error).errorMessage).toBe(expected);
  });

  it.each([
    { name: "audio string", key: "audio", value: "QUJDRA==" },
    { name: "image numeric bytes", key: "image", value: [65, 66, 67, 68] },
    { name: "video typed bytes", key: "video", value: new Uint8Array([65, 66, 67, 68]) },
  ])("redacts a direct $name field", ({ key, value }) => {
    expect(projectProviderError({ status: 500, body: { [key]: value } }).errorBody).toBe(
      `{"${key}":{"bytes":4,"redacted":"<redacted>"}}`,
    );
  });

  it.each([
    ["string chunks", ["QUJDRA=="]],
    ["numeric chunks", [[65, 66, 67, 68]]],
  ])("redacts media arrays containing %s", (_name, videoFrames) => {
    expect(
      JSON.stringify(projectProviderError({ status: 500, body: { videoFrames } })),
    ).not.toMatch(/QUJDRA==|65,66,67,68/u);
  });

  it.each([
    ["imageBytes", true],
    ["imageBase64", true],
    ["audioData", true],
    ["audioDelta", true],
    ["videoData", true],
    ["videoUrl", true],
    ["videoUri", true],
    ["videoFileUri", true],
    ["inputImage", true],
    ["outputVideo", true],
    ["video_bytes_base64", true],
    ["imageDataBase64", true],
    ["video_frame", true],
    ["videoFrame", true],
    ["outputVideoFrames", true],
    ["audioCodec", false],
  ])("classifies normalized media field %s", (key, redacted) => {
    const value = `media-value-for-${key}`;
    const serialized = JSON.stringify(
      projectProviderError({ status: 500, body: { [key]: value } }),
    );

    expect(serialized.includes(value)).toBe(!redacted);
  });

  it.each([
    ["nested videoBytes", '{"generatedVideos":[{"video":{"videoBytes":"QUJDRA=="}}]}', "QUJDRA=="],
    ["bare b64_json", '{"b64_json":"QUJDRA=="}', "QUJDRA=="],
    ["typed video data", '{"type":"video","data":"QUJDRA=="}', "QUJDRA=="],
    ["typed numeric video data", '{"type":"video","data":[65,66,67,68]}', "[65,66,67,68]"],
    ["image generation result", '{"type":"image_generation_call","result":"QUJDRA=="}', "QUJDRA=="],
    [
      "typed video URI",
      '{"type":"video","uri":"https://media.invalid/private"}',
      "https://media.invalid/private",
    ],
    [
      "MIME-qualified file URI",
      '{"mimeType":"video/mp4","fileUri":"https://media.invalid/signed"}',
      "https://media.invalid/signed",
    ],
    ["audio wrapper data", '{"audio":{"data":"QUJDRA=="}}', "QUJDRA=="],
    ["video wrapper blob", '{"video":{"blob":"QUJDRA=="}}', "QUJDRA=="],
    ["video frame wrapper data", '{"video_frame":{"data":"QUJDRA=="}}', "QUJDRA=="],
    ["camel-case video frame wrapper data", '{"videoFrame":{"data":"QUJDRA=="}}', "QUJDRA=="],
    [
      "camel-case input video frame wrapper data",
      '{"inputVideoFrame":{"data":"QUJDRA=="}}',
      "QUJDRA==",
    ],
    ["output audio wrapper data", '{"output_audio":{"data":"QUJDRA=="}}', "QUJDRA=="],
    ["audio wrapper bytes", '{"audio":{"bytes":[65,66,67,68]}}', "[65,66,67,68]"],
    ["video wrapper buffer", '{"video":{"buffer":"QUJDRA=="}}', "QUJDRA=="],
    [
      "plural video container URL",
      '{"videos":[{"url":"https://media.invalid/private/path-token"}]}',
      "https://media.invalid/private/path-token",
    ],
    ["array following a JSON literal", '[true,{"b64_json":"QUJDRA=="}]', "QUJDRA=="],
  ])("redacts %s from a JSON response-body string", (_name, body, leaked) => {
    const projected = projectProviderError({ status: 500, body });

    expect(JSON.stringify(projected)).not.toContain(leaked);
  });

  it.each(['{"message": "safe", "nested": [1, 2]}', 'prefix "notjson[1]" middle {"a":1} suffix'])(
    "preserves harmless diagnostic JSON byte-for-byte: %s",
    (body) => {
      expect(projectProviderError({ status: 500, body }).errorBody).toBe(body);
    },
  );

  it.each([
    {
      name: "duplicate credential value",
      body: '{"name":"password","value":"actual-secret","value":"<redacted>"}',
      expected: '{"name":"password","value":"<redacted>"}',
    },
    {
      name: "value-equal duplicate media marker",
      body: '{"videoUrl":"https://media.invalid/actual-secret","videoUrl":"<redacted>"}',
      expected: '{"videoUrl":"<redacted>"}',
    },
  ])("canonicalizes sensitive JSON with $name", ({ body, expected }) => {
    expect(projectProviderError({ status: 500, body }).errorBody).toBe(expected);
  });

  it.each([
    "[ERROR] provider unavailable",
    "[GoogleGenerativeAI Error]: provider unavailable",
    "[429] rate limited: retry later",
    "Error: [GoogleGenerativeAI Error]: provider unavailable",
  ])("preserves plain bracketed diagnostic text", (body) => {
    expect(projectProviderError({ status: 500, body }).errorBody).toBe(body);
  });

  it.each(['[ERROR] payload "type":"video","data":"QUJDRA=="'])(
    "fails closed when bracketed diagnostic text contains a malformed structured payload",
    (body) => {
      expect(projectProviderError({ status: 500, body }).errorBody).toBe(
        "[Malformed diagnostic JSON redacted]",
      );
    },
  );

  it.each([
    '{"type":"video","data":"QUJDRA=="',
    'Error: {"type":"video","data":"QUJDRA=="',
    'meta {"ok":true} payload {"type":"video","data":"QUJDRA=="',
    '[ERROR] payload "type":"video","data":"QUJDRA==" context {"ok":true}',
    'meta {"ok":true} payload type:video,data:"QUJDRA=="',
    'payload "b64_json" {} : "QUJDRA=="',
    '[undefined,{"b64_json":"QUJDRA=="}]',
  ])("fails closed for malformed JSON response-body strings", (body) => {
    const projected = projectProviderError({ status: 500, body });

    expect(JSON.stringify(projected)).not.toContain("QUJDRA==");
    expect(projected.errorBody).toBe("[Malformed diagnostic JSON redacted]");
  });

  it("retains readable status and body from a hostile non-Error value", () => {
    const error = {
      status: 429,
      body: "retry after data:image/png;base64,QUJDRA==",
      get hostile() {
        throw new Error("getter failed");
      },
    };

    expect(projectProviderError(error).errorMessage).toBe("429: retry after <redacted>");
  });

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
    expect(descriptorReads).toBe(64);
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
    expect(descriptorReads).toBe(64 * 64);
  });

  it("skips proxy keys without property descriptors", () => {
    const error = new Proxy(
      { safe: "connection failed" },
      {
        ownKeys: () => ["missing", "safe"],
        getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
      },
    );

    expect(projectProviderError(error).errorMessage).toContain("connection failed");
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

  it.each([
    { name: "Buffer", bytes: Buffer.from([1, 2, 3]) },
    { name: "Uint8Array", bytes: new Uint8Array([4, 5, 6]) },
    { name: "ArrayBuffer", bytes: new Uint8Array([7, 8, 9]).buffer },
  ])("redacts $name media bytes without an installed host", ({ bytes }) => {
    const error = Object.assign(new Error("502 status code (no body)"), {
      status: 502,
      body: { type: "video", data: bytes },
    });

    const projected = projectProviderError(error);
    const serialized = JSON.stringify(projected);

    expect(projected.errorMessage).toContain("502:");
    expect(serialized).toContain("<redacted>");
    expect(serialized).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
  });

  it.each([
    ["Buffer", Buffer.from([1, 2, 3])],
    ["Uint8Array", new Uint8Array([4, 5, 6])],
    ["ArrayBuffer", new Uint8Array([7, 8, 9]).buffer],
    ["DataView", new DataView(new Uint8Array([0, 10, 11, 12, 0]).buffer, 1, 3)],
  ])("redacts a bare %s response body by value", (_name, body) => {
    const projected = projectProviderError({ status: 500, body });
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

  it.each([
    ["returns nullish", () => undefined],
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

  it("preserves ordinary key-value diagnostics", () => {
    const value = "provider=openai api=openai-completions model=some-long-model-name";

    expect(projectProviderError(value).errorMessage).toBe(value);
  });

  it.each([
    "JSESSIONID=0123456789abcdef",
    "api_key=sk-0123456789012345",
    "https://host.test/path?api_key=abcdefghijklmnop&mode=test",
    'token="abcdefghijklmnop"',
  ])("redacts loose credential pair in %s", (value) => {
    expect(projectProviderError(value).errorMessage).not.toMatch(
      /0123456789abcdef|sk-0123456789012345|abcdefghijklmnop/u,
    );
  });

  it.each([
    "Cookie: JSESSIONID=0123456789abcdef; account=abcdefghijklmnop",
    "Set-Cookie: PHPSESSID=0123456789abcdef; Path=/; HttpOnly",
    "Cookie: sid=abc123",
    "Set-Cookie: auth=x:y",
  ])("redacts arbitrary credential names inside cookie headers", (header) => {
    expect(projectProviderError(header).errorMessage).toMatch(/^(?:Set-)?Cookie: <redacted>$/u);
  });

  it.each([
    "x-api-key: sk-0123456789012345",
    "api-key: 0123456789abcdef",
    "Authorization: ApiKey 0123456789abcdef",
    "Error: x-api-key: sk-0123456789012345",
    "headers: Authorization: ApiKey 0123456789abcdef",
    'headers: {"x-api-key":"sk-0123456789012345"}',
    "{'Authorization': 'ApiKey 0123456789abcdef'}",
  ])("redacts credential header %s", (header) => {
    expect(projectProviderError(header).errorMessage).not.toMatch(
      /sk-0123456789012345|0123456789abcdef/u,
    );
  });

  it("preserves ordinary colon-delimited diagnostics", () => {
    expect(projectProviderError("status: healthy").errorMessage).toBe("status: healthy");
  });

  it.each([
    ["credential", false],
    ["cookie", false],
    ["setCookie", false],
    ["privateKey", false],
    ["signingKey", false],
    ["secretAccessKey", false],
    ["AWS_SECRET_ACCESS_KEY", false],
    ["publicKey", true],
    ["accessKeyId", true],
  ])("classifies normalized credential field %s", (key, preserved) => {
    const value = `credential-value-for-${key}`;
    const serialized = JSON.stringify(
      projectProviderError({ status: 400, body: { [key]: value } }),
    );

    expect(serialized.includes(value)).toBe(preserved);
  });
});
