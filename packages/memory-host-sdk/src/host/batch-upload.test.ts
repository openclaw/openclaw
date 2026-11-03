import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { uploadBatchJsonlFile } from "./batch-upload.js";
import { withRemoteHttpResponse } from "./remote-http.js";
import { createPendingResponse } from "./response-snippet.test-harness.js";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

const remoteHttpMock = vi.mocked(withRemoteHttpResponse);

function upload(options: Partial<Parameters<typeof uploadBatchJsonlFile>[0]> = {}) {
  return uploadBatchJsonlFile({
    client: { baseUrl: "https://memory.example/v1", headers: { Authorization: "Bearer test" } },
    requests: [{ input: "one" }],
    errorPrefix: "file upload failed",
    ...options,
  });
}

function respond(response: Response) {
  remoteHttpMock.mockImplementationOnce(async (params) => await params.onResponse(response));
}

function streamingTextResponse(params: {
  body: string;
  status: number;
  headers?: HeadersInit;
  onCancel: () => void;
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(params.body));
    },
    cancel: params.onCancel,
  });
  return new Response(stream, { status: params.status, headers: params.headers });
}

beforeEach(() => vi.clearAllMocks());

it("wraps malformed file-upload JSON with the request error prefix", async () => {
  respond(new Response("{ nope", { status: 200 }));

  await expect(upload()).rejects.toThrow("file upload failed: malformed JSON response");
});

it.each([
  {
    name: "non-ok snippets",
    body: "x".repeat(12_000),
    status: 413,
    headers: undefined,
    maxResponseBytes: undefined,
    error: `file upload failed: 413 ${"x".repeat(1_000)}... [truncated]`,
  },
  {
    name: "successful JSON",
    body: '{"id":"file_123"}',
    status: 200,
    headers: { "content-length": "00064" },
    maxResponseBytes: 8,
    error: "file upload failed: response body too large: 64 bytes (limit: 8 bytes)",
  },
])(
  "bounds $name before parsing or formatting",
  async ({ body, status, headers, maxResponseBytes, error }) => {
    const onCancel = vi.fn();
    respond(streamingTextResponse({ body, status, headers, onCancel }));
    await expect(upload({ maxResponseBytes })).rejects.toThrow(error);
    expect(onCancel).toHaveBeenCalled();
  },
);

it("accepts leading-zero content-length values on successful file-upload JSON", async () => {
  respond(
    new Response('{"id":"file_123"}', {
      status: 200,
      headers: { "content-length": "00017" },
    }),
  );

  await expect(upload({ maxResponseBytes: 32 })).resolves.toBe("file_123");
});

it.for([
  { status: 500, label: "snippet", reason: "upload aborted" },
  { status: 200, label: "JSON", reason: "upload json aborted" },
])(
  "passes caller abort signals through file-upload $label reads",
  async ({ status, label, reason }, { signal }) => {
    const fixture = createPendingResponse({ status });
    respond(fixture.response);
    const controller = new AbortController();
    const expected = new Error(reason);
    const operation = upload({ signal: controller.signal });
    const settled = operation.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          fixture.readStarted,
          operation,
          `upload ${label} read did not start`,
        ),
        signal,
      );
      expect(fixture.response.body?.locked).toBe(true);
      controller.abort(expected);

      await expect(withinTest(settled, signal)).resolves.toBe(expected);
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.response.body?.locked).toBe(false);
      expect(remoteHttpMock.mock.calls[0]?.[0].signal).toBe(controller.signal);
    } finally {
      controller.abort(expected);
      fixture.dispose();
      await settled;
    }
  },
);
