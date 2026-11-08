// Google SSE framing is exercised through the production transport stream.
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let createGoogleGenerativeAiTransportStreamFn: typeof import("./transport-stream.js").createGoogleGenerativeAiTransportStreamFn;

function buildGeminiModel(
  overrides: Partial<Model<"google-generative-ai">> = {},
): Model<"google-generative-ai"> {
  return {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

async function runGeminiStreamResult(
  params: {
    model?: Model<"google-generative-ai">;
    context?: Parameters<ReturnType<typeof createGoogleGenerativeAiTransportStreamFn>>[1];
    options?: Record<string, unknown>;
  } = {},
) {
  const streamFn = createGoogleGenerativeAiTransportStreamFn();
  const stream = await Promise.resolve(
    streamFn(
      params.model ?? buildGeminiModel(),
      (params.context ?? {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      }) as Parameters<typeof streamFn>[1],
      params.options as Parameters<typeof streamFn>[2],
    ),
  );
  return stream.result();
}

function buildRawSseResponse(sse: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("google transport stream", () => {
  beforeAll(async () => {
    ({ createGoogleGenerativeAiTransportStreamFn } = await import("./transport-stream.js"));
  });

  beforeEach(() => {
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/provider-transport-runtime");
    vi.resetModules();
  });

  it.each([
    'data: {"candidates":[{"finishReason":"STOP"}]}\n\ndata: {"candidates":[',
    'data: {"candidates":[{"finishReason":"STOP"}]}\r\n',
  ])("rejects an incomplete SSE frame: %s", async (sse) => {
    guardedFetchMock.mockResolvedValueOnce(buildRawSseResponse(sse));
    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });
    expect(result.stopReason).toBe("error");
    // Agent retry classifies this exact text as a transient disconnect.
    expect(result.errorMessage).toBe("Google SSE stream ended with an incomplete frame");
  });

  it.each([
    ...[
      { label: "keepalive comment", tail: ": keepalive\n" },
      { label: "control fields", tail: "event: ping\nid: heartbeat" },
      { label: "empty data field", tail: "data:\n" },
    ].map(({ label, tail }) => ({
      label,
      sse: `data: {"candidates":[{"finishReason":"STOP"}]}\n\r${tail}`,
    })),
    ...[
      { label: "carriage-return-only", delimiter: "\r\r" },
      { label: "line-feed then CRLF", delimiter: "\n\r\n" },
      { label: "CRLF then carriage-return", delimiter: "\r\n\r" },
      { label: "carriage-return then CRLF", delimiter: "\r\r\n" },
    ].map(({ label, delimiter }) => ({
      label,
      sse: `data: {"candidates":[{"finishReason":"STOP"}]}${delimiter}`,
    })),
    {
      label: "CRLF-separated data lines",
      sse: 'data: {"candidates":[\r\ndata: {"finishReason":"STOP"}]}\r\n\r\n',
    },
  ])("accepts Google SSE framing with $label", async ({ sse }) => {
    guardedFetchMock.mockResolvedValueOnce(buildRawSseResponse(sse));
    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });
    expect(result.stopReason).toBe("stop");
  });

  it("surfaces a framed provider error arriving after a terminal Google response", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildRawSseResponse(
        'data: {"candidates":[{"finishReason":"STOP"}]}\n\n' +
          'data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}\n\n',
      ),
    );

    const result = await runGeminiStreamResult({ options: { apiKey: "gemini-api-key" } });

    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: "RESOURCE_EXHAUSTED",
      errorMessage: expect.stringContaining("quota exceeded"),
    });
  });
});
