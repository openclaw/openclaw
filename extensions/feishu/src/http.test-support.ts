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

export function writeOversizedJson(
  res: ServerResponse,
  totalBytes: number,
  jsonPrefix: string,
): { bytesPulled: () => number; canceled: () => boolean } {
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  let bytesPulled = 0;
  let canceled = false;
  let ended = false;
  res.writeHead(200, { "content-type": "application/json" });
  res.on("close", () => {
    if (!ended && bytesPulled < totalBytes) {
      canceled = true;
    }
  });
  const prefix = Buffer.from(jsonPrefix);
  bytesPulled += prefix.byteLength;
  res.write(prefix);
  const sendChunk = () => {
    if (bytesPulled >= totalBytes) {
      if (!res.destroyed) {
        ended = true;
        res.end('"}');
      }
      return;
    }
    const remaining = totalBytes - bytesPulled;
    const size = Math.min(chunk.byteLength, remaining);
    bytesPulled += size;
    const ok = res.write(chunk.subarray(0, size));
    if (ok) {
      setImmediate(sendChunk);
      return;
    }
    res.once("drain", sendChunk);
  };
  setImmediate(sendChunk);
  return {
    bytesPulled: () => bytesPulled,
    canceled: () => canceled || (!ended && bytesPulled < totalBytes),
  };
}
