import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { observeResponseBody, writeOversizedJson } from "./http.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("does not report reader activity while an HTTP response remains unread", async () => {
  let clientClosed: Promise<void> | undefined;
  const server = createServer((_req, res) => {
    clientClosed = writeOversizedJson(res, 32 * 1024 * 1024, '{"padding":"');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("local test server did not expose a TCP port");
  }
  let response: Response | undefined;
  try {
    response = await fetch(`http://127.0.0.1:${address.port}`);
    const state = observeResponseBody(response);
    expect(state.cancelCalls).toBe(0);
    expect(state.bytesRead).toBe(0);
  } finally {
    await response?.body?.cancel();
    server.closeAllConnections();
    await clientClosed;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

it("counts delivered bytes and forwards cancellation to the original stream", async () => {
  const chunk = new Uint8Array([1, 2, 3]);
  const canceled = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel: canceled,
    },
    { highWaterMark: 0 },
  );
  const response = new Response(body);
  const state = observeResponseBody(response);
  const reader = response.body!.getReader();
  try {
    const next = await reader.read();
    expect(next.value).toBe(chunk);
    expect(state).toEqual({ bytesRead: 3, cancelCalls: 0 });
    expect(canceled).not.toHaveBeenCalled();
    const reason = new Error("stop consuming");
    await reader.cancel(reason);
    expect(canceled).toHaveBeenCalledExactlyOnceWith(reason);
    expect(state).toEqual({ bytesRead: 3, cancelCalls: 1 });
  } finally {
    reader.releaseLock();
  }
});
