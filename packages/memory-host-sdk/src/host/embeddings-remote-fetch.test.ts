// Memory Host SDK tests cover embeddings remote fetch behavior.
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
    ),
  );
  return responseBytes;
}

function respondJson(payload: unknown): number {
  return respond(JSON.stringify(payload));
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
    { usage: { prompt_tokens: 3 }, expected: { promptTokens: 3, totalTokens: 3 } },
    { usage: { total_tokens: 0 }, expected: { promptTokens: 0, totalTokens: 0 } },
    { usage: { prompt_tokens: -1 }, expected: undefined },
  ])("reports validated usage for $usage without changing vectors", async ({ usage, expected }) => {
    respondJson({ data: [{ embedding: [0.1] }], usage });
    const onUsage = vi.fn();
    await expect(fetchEmbeddings(["one"], onUsage)).resolves.toEqual([[0.1]]);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([
    { name: "missing data", payload: {}, reason: "missing data array" },
    {
      name: "empty data",
      payload: { data: [] },
      reason: "empty data array; expected 2 vectors",
    },
    {
      name: "wrong vector count",
      payload: { data: [{ embedding: [0.1] }] },
      reason: "expected 2 vectors, got 1",
    },
    {
      name: "missing embedding array",
      payload: { data: [{ embedding: [0.1] }, {}] },
      reason: "missing embedding array at position 1",
    },
    {
      name: "empty embedding",
      payload: { data: [{ embedding: [0.1] }, { embedding: [] }] },
      reason: "empty embedding at position 1",
    },
    {
      name: "missing later index",
      payload: { data: [{ index: 0, embedding: [0.1] }, { embedding: [0.2] }] },
      reason: "missing index at position 1 (mixed indexed and positional entries)",
    },
    {
      name: "missing first index",
      payload: { data: [{ embedding: [0.1] }, { index: 1, embedding: [0.2] }] },
      reason: "missing index at position 0 (mixed indexed and positional entries)",
    },
    {
      name: "duplicate index",
      payload: {
        data: [
          { index: 0, embedding: [0.1] },
          { index: 0, embedding: [0.2] },
        ],
      },
      reason: "duplicate index 0 at position 1",
    },
    {
      name: "non-numeric coordinate",
      payload: { data: [{ embedding: [0.1] }, { embedding: ["coordinate-private-marker"] }] },
      reason: "non-numeric coordinate at position 1, coordinate 0",
    },
  ])("identifies $name without exposing response contents", async ({ payload, reason }) => {
    respondJson(payload);

    await expect(fetchEmbeddings()).rejects.toMatchObject({
      code: "INVALID_EMBEDDING_RESPONSE",
      message: `${ERROR_PREFIX}: ${reason}`,
    });
    expect(JSON.stringify(debugMock.mock.calls)).not.toContain("coordinate-private-marker");
  });

  it.each([{ name: "out-of-range", index: 2 }])(
    "identifies a $name index without exposing its value",
    async ({ index }) => {
      respondJson({
        data: [
          { index: 0, embedding: [0.1] },
          { index, embedding: [0.2] },
        ],
      });

      await expect(fetchEmbeddings()).rejects.toThrow(
        `${ERROR_PREFIX}: invalid index at position 1; expected an integer in [0, 1]`,
      );
      expect(JSON.stringify(debugMock.mock.calls)).not.toContain("index-private-marker");
    },
  );

  it("identifies non-finite coordinates parsed from a valid JSON number", async () => {
    respond('{"data":[{"embedding":[0.1]},{"embedding":[1e309]}]}');

    await expect(fetchEmbeddings()).rejects.toThrow(
      `${ERROR_PREFIX}: non-finite coordinate at position 1, coordinate 0`,
    );
  });

  it("accepts response-sized vectors when request input is not an array", async () => {
    respondJson({
      data: [
        { index: 1, embedding: [0.2] },
        { index: 0, embedding: [0.1] },
      ],
    });

    await expect(fetchEmbeddings("query")).resolves.toEqual([[0.1], [0.2]]);
  });

  it("logs only request and response shape metadata", async () => {
    const responseBytes = respondJson({
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1, embedding: [0.3, 0.4] },
      ],
      provider_private: "response-private-marker",
    });

    await expect(
      fetchEmbeddings(["input-private-marker-one", "input-private-marker-two"]),
    ).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    const metadata = debugMock.mock.calls.map(([, meta]) => meta);
    expect(metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ context: ERROR_PREFIX, inputCount: 2 }),
        expect.objectContaining({ context: ERROR_PREFIX, status: 200, responseBytes }),
        expect.objectContaining({
          context: ERROR_PREFIX,
          vectorCount: 2,
          firstVectorDimensions: 2,
          firstIndexType: "number",
        }),
      ]),
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
    for (const meta of metadata) {
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
    expect(debugMock.mock.calls.map(([, meta]) => meta)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ context: ERROR_PREFIX, status: 200, responseBytes }),
      ]),
    );
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
    expect(debugMock.mock.calls.map(([, meta]) => meta)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ context: ERROR_PREFIX, status: 429, responseBytes }),
      ]),
    );
    expect(JSON.stringify(debugMock.mock.calls)).not.toContain(AUTH_TOKEN);
  });
});
