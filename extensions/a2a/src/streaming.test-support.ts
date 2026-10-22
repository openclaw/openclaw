import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

/**
 * A `ServerResponse` double that records streamed writes.
 *
 * The shared mock only models `setHeader`/`end`, which is enough for unary JSON
 * but not for SSE: the streaming path calls `writeHead`, `flushHeaders` and
 * `write`, and aborts when the socket closes.
 */
export type StreamingResponse = ServerResponse & {
  body: () => string;
  status: () => number;
  header: (name: string) => string | undefined;
  chunks: string[];
};

export function createStreamingResponse(): StreamingResponse {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const events = new EventEmitter();
  let statusCode = 200;
  let ended = false;

  const response = {
    headersSent: false,
    get writableEnded() {
      return ended;
    },
    destroyed: false,
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader: (key: string, value: string) => {
      headers[key.toLowerCase()] = value;
      return response;
    },
    getHeader: (key: string) => headers[key.toLowerCase()],
    writeHead: (code: number, values?: Record<string, string>) => {
      statusCode = code;
      for (const [key, value] of Object.entries(values ?? {})) {
        headers[key.toLowerCase()] = value;
      }
      response.headersSent = true;
      return response;
    },
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: (body?: string) => {
      if (body !== undefined) {
        chunks.push(body);
      }
      ended = true;
      events.emit("finish");
      return response;
    },
    destroy: () => {
      response.destroyed = true;
      events.emit("close");
      return response;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      return response;
    },
    once: (event: string, listener: (...args: unknown[]) => void) => {
      events.once(event, listener);
      return response;
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      events.off(event, listener);
      return response;
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      events.removeListener(event, listener);
      return response;
    },
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
  };

  return Object.assign(response, {
    body: () => chunks.join(""),
    status: () => statusCode,
    header: (name: string) => headers[name.toLowerCase()],
    chunks,
  }) as unknown as StreamingResponse;
}

export type SseFrame = { event: string; data: string };

/** Parse an SSE body into frames; a missing `event:` line is the default type. */
export function parseSseFrames(body: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of body.split("\n\n")) {
    if (!block.trim()) {
      continue;
    }
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice("data:".length).trim());
      }
    }
    frames.push({ event, data: data.join("\n") });
  }
  return frames;
}

export function parseSseJsonFrames(body: string): Array<{ event: string; json: unknown }> {
  return parseSseFrames(body).map((frame) => ({
    event: frame.event,
    json: JSON.parse(frame.data),
  }));
}
