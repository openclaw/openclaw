import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Create a minimal mock IncomingMessage for testing routes. */
export function createMockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body = "",
): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  emitter.method = method;
  emitter.url = url;
  emitter.headers = { host: "localhost", ...headers } as IncomingMessage["headers"];

  // Simulate body streaming
  process.nextTick(() => {
    if (body) emitter.emit("data", Buffer.from(body));
    emitter.emit("end");
  });

  return emitter;
}

/** Create a minimal mock ServerResponse that captures output. */
export function createMockRes(): ServerResponse & {
  _body: string;
  _headers: Record<string, string>;
} {
  const res = new EventEmitter() as ServerResponse & {
    _body: string;
    _headers: Record<string, string>;
    statusCode: number;
  };
  res._body = "";
  res._headers = {};
  res.statusCode = 200;

  res.setHeader = (name: string, value: string | number | readonly string[]) => {
    res._headers[name.toLowerCase()] = String(value);
    return res;
  };

  res.end = (data?: unknown) => {
    if (data) res._body = String(data);
    return res;
  };

  res.write = (data: unknown) => {
    res._body += String(data);
    return true;
  };

  return res;
}
