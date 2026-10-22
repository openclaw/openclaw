import type { IncomingMessage } from "node:http";

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

export function createOversizedJsonResponse(totalBytes: number, jsonPrefix: string) {
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  let bytesPulled = 0;
  let canceled = false;
  // Observe the reader's pulls and cancellation, independent of TCP buffering.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bytesPulled >= totalBytes) {
        controller.enqueue(Buffer.from('"}'));
        controller.close();
        return;
      }
      const next =
        bytesPulled === 0
          ? Buffer.from(jsonPrefix)
          : chunk.subarray(0, Math.min(chunk.byteLength, totalBytes - bytesPulled));
      bytesPulled += next.byteLength;
      controller.enqueue(next);
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "application/json" } }),
    bytesPulled: () => bytesPulled,
    canceled: () => canceled,
  };
}
