import {
  SSEClientTransport,
  SseError,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const STREAM_RETRY_EXHAUSTED_RE = /^Maximum reconnection attempts \(\d+\) exceeded\.$/;
const SESSION_TERMINATION_TIMEOUT_MS = 5_000;

export class McpSseSessionExpiredError extends Error {}

class McpHttpResponseTooLargeError extends Error {
  readonly code = "MCP_HTTP_RESPONSE_TOO_LARGE";

  constructor(unit: "HTTP response" | "SSE event") {
    super(`MCP ${unit} exceeds ${STDIO_DEFAULT_MAX_BUFFER_SIZE} bytes`);
    this.name = "McpHttpResponseTooLargeError";
  }
}

function isMcpSseEventTooLargeError(error: Error): boolean {
  return error.message.includes(`MCP SSE event exceeds ${STDIO_DEFAULT_MAX_BUFFER_SIZE} bytes`);
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

function limitMcpResponseStream<Chunk extends Uint8Array>(
  body: ReadableStream<Chunk>,
  eventStream: boolean,
): ReadableStream<Chunk> {
  // Match the SDK stdio cap per MCP message. Resetting at each SSE event keeps
  // long-lived streams healthy without allowing one event to grow unbounded.
  let messageBytes = 0;
  let retainedEventBytes = 0;
  let lineBytes = 0;
  let lineIsComment = false;
  let previousByteWasCr = false;

  const checkEventLimit = () => {
    if (retainedEventBytes + lineBytes > STDIO_DEFAULT_MAX_BUFFER_SIZE) {
      throw new McpHttpResponseTooLargeError("SSE event");
    }
  };
  const finishEventLine = () => {
    if (lineBytes === 0) {
      retainedEventBytes = 0;
    } else if (!lineIsComment) {
      retainedEventBytes += lineBytes + 1;
    }
    lineBytes = 0;
    lineIsComment = false;
    checkEventLimit();
  };

  const reader = body.getReader();
  return new ReadableStream<Chunk>({
    async pull(controller) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (err) {
        controller.error(err);
        return;
      }
      const { done, value: chunk } = readResult;
      if (done) {
        controller.close();
        return;
      }
      try {
        if (!eventStream) {
          messageBytes += chunk.byteLength;
          if (messageBytes > STDIO_DEFAULT_MAX_BUFFER_SIZE) {
            throw new McpHttpResponseTooLargeError("HTTP response");
          }
          controller.enqueue(chunk);
          return;
        }

        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let cursor = previousByteWasCr && bytes[0] === 0x0a ? 1 : 0;
        if (bytes.length > 0) {
          previousByteWasCr = false;
        }
        // Keep both delimiter positions so many short lines cannot repeatedly
        // scan the rest of the chunk for an absent delimiter.
        let lf = bytes.indexOf(0x0a, cursor);
        let cr = bytes.indexOf(0x0d, cursor);
        while (cursor < bytes.length) {
          const delimiter = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
          const end = delimiter < 0 ? bytes.length : delimiter;
          if (end > cursor) {
            if (lineBytes === 0) {
              lineIsComment = bytes[cursor] === 0x3a;
            }
            lineBytes += end - cursor;
            previousByteWasCr = false;
            checkEventLimit();
          }
          if (delimiter < 0) {
            break;
          }
          finishEventLine();
          previousByteWasCr = bytes[delimiter] === 0x0d;
          cursor = delimiter + 1;
          if (previousByteWasCr && bytes[cursor] === 0x0a) {
            cursor += 1;
            previousByteWasCr = false;
          }
          if (lf >= 0 && lf < cursor) {
            lf = bytes.indexOf(0x0a, cursor);
          }
          if (cr >= 0 && cr < cursor) {
            cr = bytes.indexOf(0x0d, cursor);
          }
        }
        controller.enqueue(chunk);
      } catch (err) {
        void reader.cancel(err).catch(() => undefined);
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

function limitMcpHttpResponse(response: Response): Response {
  if (!response.body) {
    return response;
  }
  return new Response(limitMcpResponseStream(response.body, isEventStreamResponse(response)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function withMcpHttpResponseLimits(fetchFn: FetchLike): FetchLike {
  return async (input, init) => limitMcpHttpResponse(await fetchFn(input, init));
}

type EventSourceFetch = NonNullable<
  NonNullable<SSEClientTransportOptions["eventSourceInit"]>["fetch"]
>;
type EventSourceResponse = Awaited<ReturnType<EventSourceFetch>>;

function toEventSourceByteStream(
  body: NonNullable<EventSourceResponse["body"]>,
): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) {
    return body;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      if (!(result.value instanceof Uint8Array)) {
        await reader.cancel();
        throw new TypeError("MCP SSE response body must contain byte chunks");
      }
      controller.enqueue(new Uint8Array(result.value));
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

function limitMcpEventSourceResponse(response: EventSourceResponse): Response {
  // EventSource needs redirect and auth response metadata. Replace only the
  // body so the size boundary does not change its connection behavior.
  if (!response.body && response instanceof Response) {
    return response;
  }
  const headers = response instanceof Response ? response.headers : new Headers();
  if (!(response instanceof Response)) {
    for (const name of ["content-type", "www-authenticate"]) {
      const value = response.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    }
  }
  const body = response.body
    ? limitMcpResponseStream(toEventSourceByteStream(response.body), true)
    : null;
  const limitedResponse = new Response(body, {
    status: response.status,
    ...(response instanceof Response ? { statusText: response.statusText } : {}),
    headers,
  });
  Object.defineProperties(limitedResponse, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
  return limitedResponse;
}

function parseSseFieldLine(line: string): { field: string; value: string } | undefined {
  if (line.startsWith(":")) {
    return undefined;
  }
  const colon = line.indexOf(":");
  if (colon < 0) {
    return { field: line, value: "" };
  }
  let value = line.slice(colon + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }
  return { field: line.slice(0, colon), value };
}

/**
 * Passes stream chunks through unchanged while reporting every announced SSE
 * `endpoint` payload. Legacy MCP SSE servers create a fresh session per stream,
 * so a changed endpoint URL after a reconnect means later POSTs would target a
 * session that never completed initialization.
 */
function watchSseEndpointEvents(
  body: ReadableStream<Uint8Array>,
  onEndpoint: (data: string) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let scanFrom = 0;
  let eventType = "";
  let dataLines: string[] = [];
  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      if (eventType === "endpoint" && dataLines.length > 0) {
        onEndpoint(dataLines.join("\n"));
      }
      eventType = "";
      dataLines = [];
      return;
    }
    const parsed = parseSseFieldLine(line);
    if (!parsed) {
      return;
    }
    if (parsed.field === "event") {
      eventType = parsed.value;
    } else if (parsed.field === "data") {
      dataLines.push(parsed.value);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffered !== "") {
          const remainder = buffered;
          buffered = "";
          scanFrom = 0;
          consumeLine(remainder);
        }
        controller.close();
        return;
      }
      const chunk = value ?? new Uint8Array(0);
      buffered += decoder.decode(chunk, { stream: true });
      // eventsource-parser accepts LF, CR, and CRLF, so scan for both delimiters
      // and release each completed line: CR-terminated traffic (comments are not
      // charged against the per-event size limit) must not accumulate here.
      // Keep both delimiter positions so many short lines cannot repeatedly scan
      // the rest of the buffer for a delimiter it does not contain.
      let consumed = 0;
      let lf = buffered.indexOf("\n", scanFrom);
      let cr = buffered.indexOf("\r", scanFrom);
      let delimiter = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      while (delimiter >= 0) {
        if (buffered[delimiter] === "\r" && delimiter + 1 === buffered.length) {
          // Hold a trailing CR: only the next chunk can tell a lone CR from a split CRLF.
          break;
        }
        const next =
          buffered[delimiter] === "\r" && buffered[delimiter + 1] === "\n"
            ? delimiter + 2
            : delimiter + 1;
        consumeLine(buffered.slice(consumed, delimiter));
        consumed = next;
        if (lf >= 0 && lf < consumed) {
          lf = buffered.indexOf("\n", consumed);
        }
        if (cr >= 0 && cr < consumed) {
          cr = buffered.indexOf("\r", consumed);
        }
        delimiter = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      }
      if (consumed > 0) {
        buffered = buffered.slice(consumed);
        lf = lf < 0 ? -1 : lf - consumed;
        cr = cr < 0 ? -1 : cr - consumed;
      }
      // A surviving position can only be the held trailing CR; the rest of the
      // buffer is already known to hold no delimiter, so resume from there.
      scanFrom = Math.min(
        lf < 0 ? buffered.length : lf,
        cr < 0 ? buffered.length : cr,
        buffered.length,
      );
      controller.enqueue(chunk);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

abstract class OpenClawMcpHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  protected closed = false;
  private closeEmitted = false;

  protected emitClose(): void {
    if (this.closeEmitted) {
      return;
    }
    this.closeEmitted = true;
    this.onclose?.();
  }

  protected emitError(error: Error): void {
    if (!this.closed) {
      this.onerror?.(error);
    }
  }

  protected abstract readonly transport: Transport & { setProtocolVersion(version: string): void };
  protected abstract onTransportError(error: Error): void;

  async start(): Promise<void> {
    // The SDK transport exposes callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onmessage = (message) => this.onmessage?.(message);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onclose = () => this.emitClose();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onerror = (error) => this.onTransportError(error);
    await this.transport.start();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.transport.close();
    this.emitClose();
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion(version);
  }

  abstract send(message: JSONRPCMessage): Promise<void>;
}

/** Converts legacy SSE terminal HTTP failures into the lifecycle close the SDK omits. */
export class OpenClawSSEClientTransport extends OpenClawMcpHttpTransport {
  protected readonly transport: SSEClientTransport;
  private announcedEndpoints = new Set<string>();
  private sessionReplacedError?: McpSseSessionExpiredError;

  constructor(url: URL, options?: SSEClientTransportOptions) {
    super();
    const baseFetch = options?.fetch ?? fetch;
    const limitedFetch = withMcpHttpResponseLimits(baseFetch);
    const eventSourceInit = options?.eventSourceInit;
    const configuredEventSourceFetch = eventSourceInit?.fetch;
    this.transport = new SSEClientTransport(url, {
      ...options,
      fetch: async (input, init) => {
        const response = await limitedFetch(input, init);
        // The SDK discards POST status codes. Preserve session expiration for
        // the runtime owner without closing before the failed request settles.
        if (init?.method === "POST" && response.status === 404) {
          const text = await response.text().catch(() => null);
          throw new McpSseSessionExpiredError(`Error POSTing to endpoint (HTTP 404): ${text}`);
        }
        return response;
      },
      eventSourceInit: {
        ...eventSourceInit,
        fetch: async (eventUrl, init) => {
          const raw = configuredEventSourceFetch
            ? await configuredEventSourceFetch(eventUrl, init)
            : await baseFetch(eventUrl, init);
          const limited = limitMcpEventSourceResponse(raw);
          if (limited.status !== 200 || !isEventStreamResponse(limited) || !limited.body) {
            return limited;
          }
          const watched = new Response(
            watchSseEndpointEvents(limited.body, (data) => this.handleAnnouncedEndpoint(data, url)),
            {
              status: limited.status,
              statusText: limited.statusText,
              headers: limited.headers,
            },
          );
          // eventsource reads url/redirected off the response handed to it. The
          // size limiter preserves both, so watching the body must not drop them.
          Object.defineProperties(watched, {
            url: { value: limited.url },
            redirected: { value: limited.redirected },
          });
          return watched;
        },
      },
    });
  }

  /**
   * Tracks endpoint announcements across stream reconnects. eventsource
   * silently re-opens the stream after a server restart, and the SDK moves
   * `_endpoint` onto the freshly announced session without re-running the
   * initialize handshake. A changed endpoint URL therefore means every later
   * POST would hit an uninitialized session (JSON-RPC -32602), so surface the
   * same session-expired lifecycle the POST 404 path uses.
   */
  private handleAnnouncedEndpoint(data: string, url: URL): void {
    let endpoint: string;
    try {
      endpoint = new URL(data, url).href;
    } catch {
      return;
    }
    if (this.announcedEndpoints.size === 0) {
      this.announcedEndpoints.add(endpoint);
      return;
    }
    if (this.announcedEndpoints.has(endpoint)) {
      return;
    }
    this.announcedEndpoints.add(endpoint);
    this.handleSessionReplaced(endpoint);
  }

  private handleSessionReplaced(endpoint: string): void {
    if (this.sessionReplacedError) {
      return;
    }
    this.sessionReplacedError = new McpSseSessionExpiredError(
      `MCP SSE server reconnected onto a replacement session endpoint: ${endpoint}`,
    );
    this.emitError(this.sessionReplacedError);
    void this.close();
    // EventSource can arm its reconnect timer after this callback returns.
    // Close again on the next turn so that new timer cannot survive.
    setTimeout(() => void this.transport.close(), 0).unref?.();
  }

  protected onTransportError(error: Error): void {
    this.emitError(error);
    if (
      isMcpSseEventTooLargeError(error) ||
      (error instanceof SseError && error.code !== undefined)
    ) {
      void this.close();
      // EventSource schedules reconnect after its error callback returns.
      // Close again on the next turn so that new timer cannot survive.
      setTimeout(() => void this.transport.close(), 0).unref?.();
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.sessionReplacedError) {
      throw this.sessionReplacedError;
    }
    if (this.closed) {
      throw new Error("MCP SSE transport is closed");
    }
    await this.transport.send(message);
  }
}

/** Owns Streamable HTTP notification recovery and stateful cleanup around SDK 1.30.0. */
export class OpenClawStreamableHTTPClientTransport extends OpenClawMcpHttpTransport {
  protected readonly transport: StreamableHTTPClientTransport;
  private readonly url: URL;
  private readonly cleanupFetch: FetchLike;
  private readonly requestInit?: RequestInit;
  private pendingExpiredNotificationGet = false;
  private terminatedSessionId?: string;

  constructor(url: URL, options: StreamableHTTPClientTransportOptions = {}) {
    super();
    this.url = url;
    this.cleanupFetch = options.fetch ?? fetch;
    this.requestInit = options.requestInit;
    const runtimeFetch: FetchLike = async (input, init) => {
      if (this.closed) {
        throw new Error("MCP Streamable HTTP transport is closed");
      }
      const response = limitMcpHttpResponse(await this.cleanupFetch(input, init));
      if (init?.method === "GET" && response.status === 404 && this.sessionId !== undefined) {
        this.pendingExpiredNotificationGet = true;
      }
      return response;
    };
    this.transport = new StreamableHTTPClientTransport(url, {
      ...options,
      fetch: runtimeFetch,
    });
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  get protocolVersion(): string | undefined {
    return this.transport.protocolVersion;
  }

  protected onTransportError(error: Error): void {
    if (this.closed) {
      // SDK reconnect callbacks can finish after close() cleared their old timer.
      // Defer a second close so any timer armed later in that callback is cancelled.
      setTimeout(() => void this.transport.close(), 0).unref?.();
      return;
    }
    this.emitError(error);
    const sessionExpired =
      this.pendingExpiredNotificationGet &&
      error instanceof StreamableHTTPError &&
      error.code === 404;
    if (sessionExpired) {
      this.pendingExpiredNotificationGet = false;
    }
    if (
      isMcpSseEventTooLargeError(error) ||
      sessionExpired ||
      STREAM_RETRY_EXHAUSTED_RE.test(error.message)
    ) {
      void this.close();
    }
  }

  async send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]): Promise<void> {
    await this.transport.send(message, options);
  }

  /** Uses a fresh request signal because failed initialization makes the SDK's signal unusable. */
  async terminateSession(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || sessionId === this.terminatedSessionId) {
      return;
    }
    const headers = new Headers(this.requestInit?.headers);
    headers.set("mcp-session-id", sessionId);
    if (this.protocolVersion) {
      headers.set("mcp-protocol-version", this.protocolVersion);
    }
    const response = await this.cleanupFetch(this.url, {
      ...this.requestInit,
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(SESSION_TERMINATION_TIMEOUT_MS),
    });
    void response.body?.cancel().catch(() => undefined);
    // A terminated session is no longer addressable; MCP servers report 404
    // for that id, which is already the desired outcome of cleanup.
    if (!response.ok && response.status !== 404 && response.status !== 405) {
      throw new StreamableHTTPError(
        response.status,
        `Failed to terminate session: ${response.statusText}`,
      );
    }
    this.terminatedSessionId = sessionId;
  }
}
