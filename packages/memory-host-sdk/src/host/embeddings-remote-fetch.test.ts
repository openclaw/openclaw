import { beforeEach, describe, expect, it, vi } from "vitest";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import { withRemoteHttpResponse } from "./remote-http.js";

vi.mock("./remote-http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote-http.js")>()),
  withRemoteHttpResponse: vi.fn(),
}));

vi.mock("./embeddings-debug.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embeddings-debug.js")>();
  return { ...actual, debugEmbeddingsLog: vi.fn(actual.debugEmbeddingsLog) };
});

const remoteHttpMock = vi.mocked(withRemoteHttpResponse);
const debugMock = vi.mocked(debugEmbeddingsLog);
const ERROR_PREFIX = "embedding fetch failed (model: fixture-model, batch size: 2)";
const AUTH_TOKEN = "fixture-token-private-marker";
const REQUEST = {
  url: "https://memory.example/v1/embeddings?token=url-private-marker",
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  errorPrefix: "embedding fetch failed",
};

function respond(body: string, status = 200, headers?: Record<string, string>): number {
  const responseBytes = Buffer.byteLength(body);
  remoteHttpMock.mockImplementationOnce(async (params) =>
    params.onResponse(
      new Response(body, {
        status,
        headers: { "content-length": String(responseBytes), ...headers },
      }),
      params.init?.headers,
    ),
  );
  return responseBytes;
}

function respondJson(payload: unknown): number {
  return respond(JSON.stringify(payload));
}

function vector(embedding: unknown = [0.1], index?: unknown) {
  return { embedding, ...(index !== undefined ? { index } : {}) };
}

function expectMetadata(...shapes: Record<string, unknown>[]) {
  expect(debugMock.mock.calls.map(([, meta]) => meta)).toEqual(
    expect.arrayContaining(
      shapes.map((shape) => expect.objectContaining({ context: ERROR_PREFIX, ...shape })),
    ),
  );
}

function fetchEmbeddings(
  input: unknown = ["first", "second"],
  onUsage?: Parameters<typeof fetchRemoteEmbeddingVectors>[0]["onUsage"],
) {
  return fetchRemoteEmbeddingVectors({
    ...REQUEST,
    body: { model: "fixture-model", input },
    onUsage,
  });
}

describe("fetchRemoteEmbeddingVectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    remoteHttpMock.mockReset();
  });

  it.each([
    { usage: { prompt_tokens: 7, total_tokens: 9 }, expected: { promptTokens: 7, totalTokens: 9 } },
    { usage: { prompt_tokens: 3 }, expected: { promptTokens: 3, totalTokens: 3 } },
    { usage: { total_tokens: 0 }, expected: { promptTokens: 0, totalTokens: 0 } },
    { usage: undefined, expected: undefined },
    { usage: { prompt_tokens: -1 }, expected: undefined },
    { usage: { prompt_tokens: 1.5 }, expected: undefined },
    { usage: { prompt_tokens: "7" }, expected: undefined },
  ])("reports validated usage for $usage without changing vectors", async ({ usage, expected }) => {
    respondJson({ data: [{ embedding: [0.1] }], usage });
    const onUsage = vi.fn();
    await expect(fetchEmbeddings(["one"], onUsage)).resolves.toEqual([[0.1]]);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("ignores non-finite usage parsed from a valid JSON number", async () => {
    respond('{"data":[{"embedding":[0.1]}],"usage":{"prompt_tokens":1e309}}');
    const onUsage = vi.fn();
    await expect(fetchEmbeddings(["one"], onUsage)).resolves.toEqual([[0.1]]);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("preserves positional vectors with differing dimensions", async () => {
    respondJson({ data: [vector([0.1, 0.2]), vector([0.4]), vector([0.3])] });

    await expect(fetchEmbeddings(["one", "two", "three"])).resolves.toEqual([
      [0.1, 0.2],
      [0.4],
      [0.3],
    ]);
  });

  it("forwards the abort signal and sends the unchanged request", async () => {
    const controller = new AbortController();
    const body = { model: "fixture-model", input: ["one"] };
    respondJson({ data: [{ embedding: [0.1] }] });

    await fetchRemoteEmbeddingVectors({ ...REQUEST, body, signal: controller.signal });

    expect(remoteHttpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: REQUEST.url,
        signal: controller.signal,
        init: { method: "POST", headers: REQUEST.headers, body: JSON.stringify(body) },
      }),
    );
  });

  it("promotes the Azure version header before sending embeddings", async () => {
    respondJson({ data: [{ embedding: [0.1] }] });
    await fetchRemoteEmbeddingVectors({
      ...REQUEST,
      url: "https://example.openai.azure.com/embeddings",
      headers: { "api-version": "2024-10-21" },
      body: { input: ["one"] },
    });
    expect(remoteHttpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.openai.azure.com/embeddings?api-version=2024-10-21",
        init: expect.objectContaining({ headers: {} }),
      }),
    );
  });

  it("returns indexed response vectors in their original request order", async () => {
    respondJson({ data: [vector([0.2], 1), vector([0.1], 0)] });

    await expect(fetchEmbeddings()).resolves.toEqual([[0.1], [0.2]]);
  });

  it.each([
    ["non-object response", [], "missing data array"],
    ["missing data", {}, "missing data array"],
    ["empty data", { data: [] }, "empty data array; expected 2 vectors"],
    ["wrong vector count", { data: [vector()] }, "expected 2 vectors, got 1"],
    ["missing embedding array", { data: [vector(), {}] }, "missing embedding array at position 1"],
    ["empty embedding", { data: [vector(), vector([])] }, "empty embedding at position 1"],
    [
      "missing later index",
      { data: [vector([0.1], 0), vector([0.2])] },
      "missing index at position 1 (mixed indexed and positional entries)",
    ],
    [
      "missing first index",
      { data: [vector(), vector([0.2], 1)] },
      "missing index at position 0 (mixed indexed and positional entries)",
    ],
    [
      "duplicate index",
      { data: [vector([0.1], 0), vector([0.2], 0)] },
      "duplicate index 0 at position 1",
    ],
    [
      "non-numeric coordinate",
      { data: [vector(), vector(["coordinate-private-marker"])] },
      "non-numeric coordinate at position 1, coordinate 0",
    ],
  ])("identifies %s without exposing response contents", async (_name, payload, reason) => {
    respondJson(payload);

    await expect(fetchEmbeddings()).rejects.toMatchObject({
      code: "INVALID_EMBEDDING_RESPONSE",
      message: `${ERROR_PREFIX}: ${reason}`,
    });
    expect(JSON.stringify(debugMock.mock.calls)).not.toContain("coordinate-private-marker");
  });

  it.each([
    { name: "out-of-range", index: 2 },
    { name: "negative", index: -1 },
    { name: "fractional", index: 0.5 },
    { name: "non-numeric", index: "index-private-marker" },
    { name: "null", index: null },
  ])("identifies a $name index without exposing its value", async ({ index }) => {
    respondJson({ data: [vector([0.1], 0), vector([0.2], index)] });

    await expect(fetchEmbeddings()).rejects.toThrow(
      `${ERROR_PREFIX}: invalid index at position 1; expected an integer in [0, 1]`,
    );
    expect(JSON.stringify(debugMock.mock.calls)).not.toContain("index-private-marker");
  });

  it("identifies non-finite coordinates parsed from a valid JSON number", async () => {
    respond('{"data":[{"embedding":[0.1]},{"embedding":[1e309]}]}');

    await expect(fetchEmbeddings()).rejects.toThrow(
      `${ERROR_PREFIX}: non-finite coordinate at position 1, coordinate 0`,
    );
  });

  it("preserves an empty response for an empty submitted input batch", async () => {
    respondJson({ data: [] });

    await expect(fetchEmbeddings([])).resolves.toEqual([]);
  });

  it("accepts response-sized vectors when request input is not an array", async () => {
    respondJson({ data: [vector([0.2], 1), vector([0.1], 0)] });

    await expect(fetchEmbeddings("query")).resolves.toEqual([[0.1], [0.2]]);
  });

  it("logs only request and response shape metadata", async () => {
    const responseBytes = respondJson({
      data: [vector([0.1, 0.2], 0), vector([0.3, 0.4], 1)],
      provider_private: "response-private-marker",
    });

    await expect(
      fetchEmbeddings(["input-private-marker-one", "input-private-marker-two"]),
    ).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    expectMetadata(
      { inputCount: 2 },
      { status: 200, responseBytes },
      { vectorCount: 2, firstVectorDimensions: 2, firstIndexType: "number" },
    );
    const allowedKeys = new Set([
      "context",
      "inputCount",
      "status",
      "responseBytes",
      "vectorCount",
      "firstVectorDimensions",
      "firstIndexType",
    ]);
    for (const [, meta] of debugMock.mock.calls) {
      expect(Object.keys(meta ?? {}).filter((key) => !allowedKeys.has(key))).toEqual([]);
    }
    const logs = JSON.stringify(debugMock.mock.calls);
    for (const secret of [
      AUTH_TOKEN,
      "url-private-marker",
      "input-private-marker",
      "response-private-marker",
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("records HTTP shape before rejecting malformed JSON", async () => {
    const responseBytes = respond("{ invalid JSON");

    await expect(fetchEmbeddings()).rejects.toMatchObject({
      message: `${ERROR_PREFIX}: malformed JSON response`,
      embeddingErrorMessage: "embedding fetch failed: malformed JSON response",
    });
    expectMetadata({ status: 200, responseBytes });
  });

  it("preserves provider error details, retry metadata, and credential redaction", async () => {
    const responseBytes = respond(
      JSON.stringify({
        error: { code: "quota_exceeded", message: `Quota exhausted for Bearer ${AUTH_TOKEN}` },
      }),
      429,
      { "retry-after": "3" },
    );

    const error = await fetchEmbeddings().catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      status: 429,
      statusCode: 429,
      errorCode: "quota_exceeded",
      retryAfterMs: 3_000,
      message: expect.stringContaining(`${ERROR_PREFIX} (429): Quota exhausted`),
      errorBody: expect.stringContaining("***"),
    });
    expect(String(error)).not.toContain(AUTH_TOKEN);
    expect(JSON.stringify(error)).not.toContain(AUTH_TOKEN);
    expectMetadata({ status: 429, responseBytes });
    expect(JSON.stringify(debugMock.mock.calls)).not.toContain(AUTH_TOKEN);
  });
});
