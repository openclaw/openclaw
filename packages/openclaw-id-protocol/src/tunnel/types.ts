// HEAD frame shapes of openclaw/tunnel/1.

/** A header as a [name, value] pair. Order and repeats are preserved. */
export type HeaderPair = [name: string, value: string];

/** Client HEAD for an HTTP request stream. */
export type HttpRequestHead = { kind: "http"; method: string; path: string; headers: HeaderPair[] };
/** Client HEAD for a WebSocket stream. */
export type WsRequestHead = {
  kind: "ws";
  path: string;
  headers: HeaderPair[];
  protocols: string[];
};
/** First frame the client sends on a stream. */
export type TunnelRequestHead = HttpRequestHead | WsRequestHead;

/** Server HEAD for HTTP, or a refused WebSocket upgrade (any non-101 status). */
export type HttpResponseHead = { status: number; headers: HeaderPair[] };
/** Server HEAD for an accepted WebSocket. */
export type WsAcceptHead = { status: 101; protocol: string | null };
/** First frame the server sends on a stream. */
export type TunnelResponseHead = HttpResponseHead | WsAcceptHead;

/** A decoded WebSocket message frame. */
export type WsMessage =
  | { op: "text"; data: Uint8Array }
  | { op: "binary"; data: Uint8Array }
  | { op: "close"; code: number | null; reason: string };
