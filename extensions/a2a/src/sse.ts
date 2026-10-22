import type { ServerResponse } from "node:http";

/**
 * Minimal Server-Sent Events writer for the A2A JSON-RPC streaming binding.
 *
 * A2A 1.0 emits bare `data:` frames (`docs/specification.md` §9.4); the payload
 * object's member name (`task` / `message` / `statusUpdate` / `artifactUpdate`)
 * is the type discriminator, so no `event:` line is sent for data frames. The
 * single exception is the terminal error frame, which uses `event: error`.
 */

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-store",
  connection: "keep-alive",
  // Disable proxy buffering so updates are not held back until the stream ends.
  "x-accel-buffering": "no",
};

export function writeSseHead(
  response: ServerResponse,
  extraHeaders?: Record<string, string>,
): void {
  response.writeHead(200, { ...SSE_HEADERS, ...extraHeaders });
  // Flush the headers immediately: a peer may block until it sees the stream open.
  // SAFETY: the test double lacks flushHeaders; the runtime ServerResponse provides it.
  if (typeof (response as { flushHeaders?: () => void }).flushHeaders === "function") {
    response.flushHeaders();
  }
}

function writeFrame(response: ServerResponse, event: string | undefined, payload: unknown): void {
  const body = `data: ${JSON.stringify(payload)}\n\n`;
  response.write(event === undefined ? body : `event: ${event}\n${body}`);
}

/** Send one stream payload. `payload` is the already-wrapped JSON-RPC result. */
export function writeSseResult(response: ServerResponse, payload: unknown): void {
  writeFrame(response, undefined, payload);
}

/** Send the terminal error frame. A2A names this event `error`. */
export function writeSseError(response: ServerResponse, payload: unknown): void {
  writeFrame(response, "error", payload);
}

export function isResponseWritable(response: ServerResponse): boolean {
  return !response.writableEnded && !response.destroyed;
}

/**
 * Resolve when the peer (or the server) tears the connection down.
 *
 * Streams must stop publishing to a closed socket; without this a long-running
 * task would keep buffering frames for a client that is already gone.
 */
export function onResponseClosed(
  request: {
    on: (event: string, listener: () => void) => void;
    removeListener: (event: string, listener: () => void) => void;
  },
  response: ServerResponse,
  listener: () => void,
): () => void {
  const closed = () => {
    cleanup();
    listener();
  };
  const cleanup = () => {
    response.removeListener("close", closed);
    request.removeListener("aborted", closed);
    request.removeListener("error", closed);
  };
  response.on("close", closed);
  request.on("aborted", closed);
  request.on("error", closed);
  return cleanup;
}
