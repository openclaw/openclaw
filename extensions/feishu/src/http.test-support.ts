import type { IncomingMessage, ServerResponse } from "node:http";

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
