import type { IncomingMessage, ServerResponse } from "node:http";
import { vi } from "vitest";

type DispatcherInit = RequestInit & { dispatcher?: unknown };

export async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
  }
  return body;
}

export function stripDispatcher(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || !("dispatcher" in init)) {
    return init;
  }
  const { dispatcher: _dispatcher, ...rest } = init as DispatcherInit;
  return rest;
}

/** Observe the consumer without replacing the native response, reader, or chunks. */
export function observeResponseBody(response: Response): {
  bytesRead: number;
  cancelCalls: number;
} {
  const state = { bytesRead: 0, cancelCalls: 0 };
  const body = response.body;
  if (!body) {
    throw new Error("expected a response body to observe");
  }
  const getReader = body.getReader.bind(body);
  vi.spyOn(body, "getReader").mockImplementation(() => {
    const reader = getReader();
    const read = reader.read.bind(reader);
    const cancel = reader.cancel.bind(reader);
    vi.spyOn(reader, "read").mockImplementation(async () => {
      const next = await read();
      if (!next.done) {
        state.bytesRead += next.value.byteLength;
      }
      return next;
    });
    vi.spyOn(reader, "cancel").mockImplementation((reason) => {
      const result = cancel(reason);
      state.cancelCalls += 1;
      return result;
    });
    return reader;
  });
  return state;
}

/**
 * Streams JSON one chunk past `capBytes`, then holds the response open without
 * ending it. Resolves once the client closes the unfinished response, so a test
 * awaiting it observes the reader's cancellation; eager runtime buffering (Bun
 * fetch) cannot race a finite body to EOF first.
 */
export function writeOversizedJson(
  res: ServerResponse,
  capBytes: number,
  jsonPrefix: string,
): Promise<void> {
  const clientClosed = new Promise<void>((resolve) => {
    res.once("close", () => resolve());
  });
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  const prefix = Buffer.from(jsonPrefix);
  let bytesWritten = prefix.byteLength;
  res.writeHead(200, { "content-type": "application/json" });
  res.write(prefix);
  const sendChunk = () => {
    if (res.destroyed || bytesWritten > capBytes) {
      return;
    }
    bytesWritten += chunk.byteLength;
    if (res.write(chunk)) {
      setImmediate(sendChunk);
      return;
    }
    res.once("drain", sendChunk);
  };
  setImmediate(sendChunk);
  return clientClosed;
}
