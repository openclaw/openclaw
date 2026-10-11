// Memory Host SDK tests cover post json behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import { postJson } from "./post-json.js";
import { withRemoteHttpResponse } from "./remote-http.js";
import { createPendingResponse } from "./response-snippet.test-harness.js";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

const remoteHttpMock = vi.mocked(withRemoteHttpResponse);

function streamingTextResponse(params: {
  body: string;
  status: number;
  headers?: HeadersInit;
  onCancel: () => void;
}): Response {
  const encoded = new TextEncoder().encode(params.body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
    },
    cancel() {
      params.onCancel();
    },
  });
  return new Response(stream, { status: params.status, headers: params.headers });
}

describe("postJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([200, 429])("aborts response body reads for HTTP %s", async (status) => {
    const fixture = createPendingResponse({ status });
    const controller = new AbortController();
    const expected = new Error("body aborted");
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(fixture.response);
    });

    const read = postJson({
      url: "https://memory.example/v1/post",
      headers: {},
      body: {},
      signal: controller.signal,
      errorPrefix: "post failed",
      parse: () => ({}),
    });
    const settled = read.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await withTestTimeout(fixture.readStarted, 1_000, "POST JSON read did not start");
      expect(fixture.response.body?.locked).toBe(true);
      controller.abort(expected);

      await expect(withTestTimeout(settled, 1_000, "POST JSON abort did not settle")).resolves.toBe(
        expected,
      );
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.response.body?.locked).toBe(false);
    } finally {
      controller.abort(expected);
      fixture.dispose();
      await withTestTimeout(settled, 1_000, "POST JSON cleanup did not settle");
    }
  });

  it("rejects successful JSON responses with oversized content-length", async () => {
    let canceled = false;
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        streamingTextResponse({
          body: "{}",
          status: 200,
          headers: { "content-length": "00032" },
          onCancel: () => {
            canceled = true;
          },
        }),
      );
    });

    await expect(
      postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        maxResponseBytes: 8,
        parse: () => ({}),
      }),
    ).rejects.toThrow("post failed: response body too large: 32 bytes (limit: 8 bytes)");
    expect(canceled).toBe(true);
  });

  it("cancels successful JSON responses that exceed the streaming byte cap", async () => {
    let canceled = false;
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        streamingTextResponse({
          body: `{"data":"${"x".repeat(32)}"}`,
          status: 200,
          onCancel: () => {
            canceled = true;
          },
        }),
      );
    });

    await expect(
      postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        maxResponseBytes: 16,
        parse: () => ({}),
      }),
    ).rejects.toThrow("post failed: response body too large");
    expect(canceled).toBe(true);
  });
});
