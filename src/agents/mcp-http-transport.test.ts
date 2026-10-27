import { createServer } from "node:http";
import type { Socket } from "node:net";
import { Client, SdkErrorCode } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStallingStream } from "../infra/http-body.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { settlesWithin } from "../shared/settle-within.js";
import {
  connectMcpClient,
  disposeMcpClient,
  isMcpHttpSessionExpired,
} from "./mcp-client-lifecycle.js";
import { redactMcpDiagnosticError } from "./mcp-error.js";
import {
  McpSseSessionExpiredError,
  OpenClawSSEClientTransport,
  OpenClawStreamableHTTPClientTransport,
} from "./mcp-http-transport.js";
import { initializedFetch, jsonResponse } from "./mcp-http-transport.test-support.js";

const MCP_HTTP_MAX_PARSE_BYTES = 10 * 1024 * 1024;
const OVERSIZED_MCP_TEXT = "x".repeat(MCP_HTTP_MAX_PARSE_BYTES + 1024);

function mcpResultResponse(
  id: string | number | undefined,
  result: unknown,
  options?: { contentType?: string; stream?: boolean; lineEnding?: string; chunkBytes?: number },
): Response {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
  const lineEnding = options?.lineEnding ?? "\n";
  const body = options?.stream
    ? `: keepalive${lineEnding}event: message${lineEnding}data: ${payload}${lineEnding}${lineEnding}: end${lineEnding}`
    : payload;
  const bytes = new TextEncoder().encode(body);
  const chunkBytes = options?.chunkBytes;
  return new Response(
    chunkBytes
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            for (let cursor = 0; cursor < bytes.length; cursor += chunkBytes) {
              controller.enqueue(bytes.subarray(cursor, cursor + chunkBytes));
            }
            controller.close();
          },
        })
      : bytes,
    {
      headers: {
        "content-type":
          options?.contentType ?? (options?.stream ? "text/event-stream" : "application/json"),
      },
    },
  );
}

function sseResponse(body: BodyInit): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function createSseReconnectFixture(buildGetResponse: (getCount: number) => Response) {
  let getCount = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") {
      return new Response(null, { status: 202 });
    }
    getCount += 1;
    return buildGetResponse(getCount);
  });
  const transport = new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
    fetch: fetchMock,
    eventSourceInit: { fetch: fetchMock },
  });
  const onclose = vi.fn();
  // MCP transports expose callback properties rather than EventTarget listeners.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = onclose;
  return {
    transport,
    onclose,
    getCount: () => getCount,
    postTargets: () =>
      fetchMock.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => call[0]),
  };
}

type SseReconnectFixture = ReturnType<typeof createSseReconnectFixture>;

async function expectSseSessionReplaced(fixture: SseReconnectFixture): Promise<void> {
  await vi.waitFor(() => expect(fixture.onclose).toHaveBeenCalledOnce());
  const sendError = await fixture.transport
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call" })
    .then(() => undefined)
    .catch((error: unknown) => error);
  expect(sendError).toBeInstanceOf(McpSseSessionExpiredError);
  expect(
    isMcpHttpSessionExpired({ transport: fixture.transport, transportType: "sse" }, sendError),
  ).toBe(true);
  expect(fixture.postTargets()).toHaveLength(0);
}

describe("OpenClaw MCP HTTP lifecycle adapters", () => {
  describe("Streamable HTTP initialization rate limits", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(["seconds", "HTTP-date"])(
      "waits for Retry-After %s before recovering the tool catalog",
      async (format) => {
        const started = Date.now();
        const initializes: number[] = [];
        const fetchMock = initializedFetch({
          onGet: () => new Response(null, { status: 405 }),
          onInitialize: () => {
            initializes.push(Date.now() - started);
            return initializes.length === 1
              ? new Response("rate limited", {
                  status: 429,
                  headers: {
                    "retry-after":
                      format === "seconds" ? "2" : new Date(started + 2_000).toUTCString(),
                  },
                })
              : undefined;
          },
          onPost: (message) =>
            message.method === "tools/list"
              ? mcpResultResponse(message.id, {
                  tools: [{ name: "recovered", inputSchema: { type: "object" } }],
                })
              : new Response(null, { status: 202 }),
        });
        const transport = new OpenClawStreamableHTTPClientTransport(
          new URL("http://mcp.invalid/mcp"),
          { fetch: fetchMock },
        );
        const client = new Client({ name: "test", version: "1" });
        const connecting = client.connect(transport).catch((error: unknown) => error);

        try {
          await vi.advanceTimersByTimeAsync(1_999);
          expect(initializes).toEqual([0]);
          await vi.advanceTimersByTimeAsync(1);
          expect(await connecting).toBeUndefined();
          expect(initializes).toEqual([0, 2_000]);
          await expect(client.listTools()).resolves.toEqual({
            tools: [{ name: "recovered", inputSchema: { type: "object" } }],
          });
        } finally {
          await disposeMcpClient({ client, transport, transportType: "streamable-http" });
        }
      },
    );

    it("stops after three initialize attempts with bounded fallback delays", async () => {
      const started = Date.now();
      const initializes: number[] = [];
      const fetchMock = initializedFetch({
        onGet: () => new Response(null, { status: 405 }),
        onInitialize: () => {
          initializes.push(Date.now() - started);
          return new Response("rate limited", { status: 429 });
        },
      });
      const transport = new OpenClawStreamableHTTPClientTransport(
        new URL("http://mcp.invalid/mcp"),
        { fetch: fetchMock },
      );
      const client = new Client({ name: "test", version: "1" });
      const connecting = client.connect(transport).catch((error: unknown) => error);

      try {
        await vi.advanceTimersByTimeAsync(999);
        expect(initializes).toEqual([0]);
        await vi.advanceTimersByTimeAsync(1);
        expect(initializes).toEqual([0, 1_000]);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(initializes).toEqual([0, 1_000]);
        await vi.advanceTimersByTimeAsync(1);
        expect(await connecting).toMatchObject({ status: 429 });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(initializes).toEqual([0, 1_000, 3_000]);
      } finally {
        await disposeMcpClient({ client, transport, transportType: "streamable-http" });
      }
    });

    it.each(["deadline", "caller abort", "transport close"])(
      "does not POST again after %s interrupts a rate-limit wait",
      async (stop) => {
        const onInitialize = vi.fn(
          () => new Response("rate limited", { status: 429, headers: { "retry-after": "10" } }),
        );
        const transport = new OpenClawStreamableHTTPClientTransport(
          new URL("http://mcp.invalid/mcp"),
          {
            fetch: initializedFetch({
              onGet: () => new Response(null, { status: 405 }),
              onInitialize,
            }),
          },
        );
        const client = new Client({ name: "test", version: "1" });
        const controller = new AbortController();
        const connecting = connectMcpClient({
          client,
          transport,
          timeoutMs: stop === "deadline" ? 500 : 30_000,
          signal: controller.signal,
        }).catch((error: unknown) => error);

        try {
          await vi.advanceTimersByTimeAsync(500);
          expect(onInitialize).toHaveBeenCalledOnce();
          if (stop === "caller abort") {
            controller.abort(new Error("caller cancelled"));
          } else if (stop === "transport close") {
            await transport.close();
          }
          expect(await connecting).toBeInstanceOf(Error);
          await vi.advanceTimersByTimeAsync(10_000);
          expect(onInitialize).toHaveBeenCalledOnce();
        } finally {
          await disposeMcpClient({ client, transport, transportType: "streamable-http" });
        }
      },
    );

    it("does not replay a stateless tool call that returns HTTP 429", async () => {
      let toolCalls = 0;
      const transport = new OpenClawStreamableHTTPClientTransport(
        new URL("http://mcp.invalid/mcp"),
        {
          fetch: initializedFetch({
            sessionId: null,
            onGet: () => new Response(null, { status: 405 }),
            onPost: (message) => {
              if (message.method !== "tools/call") {
                return new Response(null, { status: 202 });
              }
              toolCalls += 1;
              return new Response("rate limited", {
                status: 429,
                headers: { "retry-after": "1" },
              });
            },
          }),
        },
      );
      const client = new Client({ name: "test", version: "1" });

      try {
        await client.connect(transport);
        expect(transport.sessionId).toBeUndefined();
        const calling = client
          .callTool({ name: "mutate", arguments: {} })
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await calling).toMatchObject({ status: 429 });
        expect(toolCalls).toBe(1);
      } finally {
        await disposeMcpClient({ client, transport, transportType: "streamable-http" });
      }
    });
  });

  it.each([
    "Streamable HTTP error: Error POSTing to endpoint: bearer=body-secret",
    "Error POSTing to endpoint (HTTP 500): bearer=body-secret",
    'Streamable HTTP error: Error POSTing to endpoint: {\n"token":"body-secret"\n}',
  ])("redacts an HTTP response body from %s", (message) => {
    const redacted = redactMcpDiagnosticError(new Error(message));
    expect(redacted).not.toContain("body-secret");
    expect(redacted).toContain("[redacted response body]");
  });

  it("rejects an oversized JSON message before the SDK parses it", async () => {
    const fetchMock = initializedFetch({
      onGet: () => new Response(null, { status: 405 }),
      onPost: (message) => {
        if (message.method !== "tools/call") {
          return new Response(null, { status: 202 });
        }
        return mcpResultResponse(
          message.id,
          { content: [{ type: "text", text: OVERSIZED_MCP_TEXT }] },
          { contentType: 'application/json; note="text/event-stream"' },
        );
      },
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
    });
    const client = new Client({ name: "test", version: "1" });

    try {
      await client.connect(transport);
      const error = await client.callTool({ name: "oversized", arguments: {} }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(String(error)).toContain("HTTP response exceeds 10485760 bytes");
    } finally {
      await disposeMcpClient({ client, transport, transportType: "streamable-http" });
    }
  });

  it.each([true])(
    "rejects an oversized SSE message before parsing (multiline=%s)",
    async (multiline) => {
      const fetchMock = initializedFetch({
        onGet: () => new Response(null, { status: 405 }),
        onPost: (message) => {
          if (message.method !== "tools/call") {
            return new Response(null, { status: 202 });
          }
          const midpoint = Math.floor(OVERSIZED_MCP_TEXT.length / 2);
          const payload = JSON.stringify(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [
                  { type: "text", text: OVERSIZED_MCP_TEXT.slice(0, midpoint) },
                  { type: "text", text: OVERSIZED_MCP_TEXT.slice(midpoint) },
                ],
              },
            },
            null,
            multiline ? 2 : undefined,
          );
          const event = payload
            .split("\n")
            .map((line) => `data: ${line}`)
            .join("\n");
          return new Response(`event: message\n${event}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      const transport = new OpenClawStreamableHTTPClientTransport(
        new URL("http://mcp.invalid/mcp"),
        {
          fetch: fetchMock,
        },
      );
      const client = new Client({ name: "test", version: "1" });
      const onerror = vi.fn();
      // MCP clients expose callback properties rather than EventTarget listeners.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      client.onerror = onerror;

      try {
        await client.connect(transport);
        const error = await client
          .callTool({ name: "oversized", arguments: {} }, { timeout: 100 })
          .then(
            () => undefined,
            (reason: unknown) => reason,
          );
        expect(String(error)).toContain("Connection closed");
        expect(onerror).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining("SSE event exceeds 10485760"),
          }),
        );
      } finally {
        await disposeMcpClient({ client, transport, transportType: "streamable-http" });
      }
    },
  );

  it.each([{ label: "SSE split CRLF", stream: true, lineEnding: "\r\n", chunkBytes: 1 }])(
    "accepts an under-limit $label message",
    async ({ stream, lineEnding, chunkBytes }) => {
      const fetchMock = initializedFetch({
        onGet: () => new Response(null, { status: 405 }),
        onPost: (message) =>
          message.method === "tools/call"
            ? mcpResultResponse(
                message.id,
                { content: [{ type: "text", text: "under-limit" }] },
                { stream, lineEnding, chunkBytes },
              )
            : new Response(null, { status: 202 }),
      });
      const transport = new OpenClawStreamableHTTPClientTransport(
        new URL("http://mcp.invalid/mcp"),
        {
          fetch: fetchMock,
        },
      );
      const client = new Client({ name: "test", version: "1" });

      try {
        await client.connect(transport);
        const result = await client.callTool({ name: "under_limit", arguments: {} });
        expect(result).toMatchObject({ content: [{ type: "text", text: "under-limit" }] });
      } finally {
        await disposeMcpClient({ client, transport, transportType: "streamable-http" });
      }
    },
  );

  it("keeps a legacy SSE stream open beyond the cumulative message limit", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const transport = new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
      fetch: fetchMock,
      eventSourceInit: { fetch: fetchMock },
    });
    let messageCount = 0;
    let lastMessage: unknown;
    // MCP transports expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onmessage = (message) => {
      messageCount += 1;
      lastMessage = message;
    };

    try {
      await transport.start();
      const notificationEvent = encoder.encode(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "info", data: "k".repeat(32 * 1024) },
        })}\n\n`,
      );
      for (let index = 0; index < 321; index += 1) {
        streamController?.enqueue(notificationEvent);
      }
      streamController?.enqueue(
        encoder.encode('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
      );

      await vi.waitFor(() => expect(messageCount).toBe(322));
      expect(lastMessage).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    } finally {
      await transport.close();
    }
  });

  it("closes legacy SSE after an oversized event without reconnecting", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") {
        return new Response(null, { status: 202 });
      }
      getCount += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode("retry: 1\n\nevent: endpoint\ndata: /messages\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const transport = new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
      fetch: fetchMock,
      eventSourceInit: { fetch: fetchMock },
    });
    const onclose = vi.fn();
    const onerror = vi.fn();
    // MCP transports expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = onclose;
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onerror = onerror;

    try {
      await transport.start();
      streamController?.enqueue(encoder.encode(`event: message\ndata: ${OVERSIZED_MCP_TEXT}\n\n`));

      await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("SSE event exceeds 10485760") }),
      );
      expect(getCount).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it("turns legacy SSE HTTP 204 into owner-visible closure", async () => {
    const transport = new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
      eventSourceInit: {
        fetch: async () => new Response(null, { status: 204, statusText: "No Content" }),
      },
    });
    const onclose = vi.fn();
    // MCP transports expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = onclose;

    await expect(transport.start()).rejects.toThrow();
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
  });

  it("closes an established legacy SSE transport after a terminal reconnect response", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        return new Response(null, { status: 202 });
      }
      if (!streamController) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encoder.encode("retry: 1\n\nevent: endpoint\ndata: /messages\n\n"),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 503, statusText: "Unavailable" });
    });
    const transport = new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
      fetch: fetchMock,
      eventSourceInit: { fetch: fetchMock },
    });
    const onclose = vi.fn();
    // MCP transports expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = onclose;

    try {
      await transport.start();
      streamController?.close();

      await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
      await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toThrow(
        "closed",
      );
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    } finally {
      await transport.close();
    }
  });

  it.each(["\n", "\r", "\r\n"])(
    "retires a replacement SSE session with %j delimiters",
    async (eol) => {
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const encoder = new TextEncoder();
      const fixture = createSseReconnectFixture((getCount) =>
        sseResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encoder.encode(
                  [
                    "retry: 1",
                    "",
                    "event: endpoint",
                    `data: /messages?session_id=${getCount}`,
                    "",
                    ": ping",
                    "",
                  ].join(eol),
                ),
              );
            },
          }),
        ),
      );

      try {
        await fixture.transport.start();
        streamController?.close();

        await expectSseSessionReplaced(fixture);
      } finally {
        await fixture.transport.close();
      }
    },
  );

  it("keeps a legacy SSE transport open when a reconnect re-announces the same session", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const fixture = createSseReconnectFixture(() =>
      sseResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(
              encoder.encode("retry: 1\n\nevent: endpoint\ndata: /messages?session_id=1\n\n"),
            );
          },
        }),
      ),
    );

    try {
      await fixture.transport.start();
      streamController?.close();

      await vi.waitFor(() => expect(fixture.getCount()).toBe(2));
      await expect(
        fixture.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ).resolves.toBeUndefined();
      expect(fixture.onclose).not.toHaveBeenCalled();
      const posts = fixture.postTargets();
      expect(posts).toHaveLength(1);
      const postTarget = posts[0];
      expect(postTarget).toBeInstanceOf(URL);
      expect(postTarget instanceof URL ? postTarget.searchParams.get("session_id") : null).toBe(
        "1",
      );
    } finally {
      await fixture.transport.close();
    }
  });

  it("detects replacement endpoints split across byte chunks and CRLF boundaries", async () => {
    const encoder = new TextEncoder();
    const fixture = createSseReconnectFixture((getCount) => {
      const head = `retry: 1\r\nevent: endpoint\rdata: /messages?session_id=${getCount}\r`;
      return sseResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of encoder.encode(head)) {
              controller.enqueue(Uint8Array.of(byte));
            }
            controller.enqueue(encoder.encode("\n\r\n"));
            controller.close();
          },
        }),
      );
    });

    try {
      await fixture.transport.start();

      await expectSseSessionReplaced(fixture);
    } finally {
      await fixture.transport.close();
    }
  });

  it("detects a replacement session after CR-terminated comment traffic", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const fixture = createSseReconnectFixture((getCount) => {
      const keepAlives = ": keep-alive\r".repeat(4096);
      const payload =
        getCount === 1
          ? `retry: 1\r\r${keepAlives}event: endpoint\rdata: /messages?session_id=1\r\r: ping\r`
          : `retry: 1\r\revent: endpoint\rdata: /messages?session_id=2\r\r: ping\r`;
      return sseResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode(payload));
          },
        }),
      );
    });

    try {
      await fixture.transport.start();
      streamController?.close();

      await expectSseSessionReplaced(fixture);
    } finally {
      await fixture.transport.close();
    }
  });

  it("keeps short-line scanning linear across a large SSE chunk", async () => {
    const encoder = new TextEncoder();
    // LF isolates our scanner from eventsource-parser's quadratic CR path.
    const timeFlood = async (lines: number): Promise<number> => {
      const payload = `${": ping\n".repeat(lines)}event: endpoint\ndata: /messages?session_id=1\n\n: tail\n`;
      const fixture = createSseReconnectFixture(() => sseResponse(encoder.encode(payload)));
      try {
        const started = performance.now();
        await fixture.transport.start();
        const elapsed = performance.now() - started;
        expect(fixture.onclose).not.toHaveBeenCalled();
        return elapsed;
      } finally {
        await fixture.transport.close();
      }
    };

    const smaller = await timeFlood(100_000);
    const larger = await timeFlood(400_000);
    expect(larger, "a 400k short-line SSE chunk must not stall the watcher").toBeLessThan(5_000);
    // Quadrupling the lines may cost a few multiples more (allocation, GC and
    // scheduling slack); a per-line suffix rescan grows an order beyond that.
    expect(larger).toBeLessThan(smaller * 6 + 500);
  }, 60_000);

  it("closes after Streamable notification retry exhaustion", async () => {
    let getCount = 0;
    const fetchMock = initializedFetch({
      onGet: () => {
        getCount += 1;
        return getCount === 1
          ? new Response(new ReadableStream({ start: (controller) => controller.close() }), {
              headers: { "content-type": "text/event-stream" },
            })
          : new Response(null, { status: 503, statusText: "Unavailable" });
      },
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
      reconnectionOptions: {
        initialReconnectionDelay: 1,
        maxReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 2,
      },
    });
    const client = new Client({ name: "test", version: "1" });
    const onclose = vi.fn();
    // MCP clients expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    client.onclose = onclose;

    await client.connect(transport);
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "GET")).toHaveLength(3);
  });

  it("closes a stateful Streamable session when its initial notification GET expired", async () => {
    const fetchMock = initializedFetch({
      onGet: () => new Response("Session not found", { status: 404, statusText: "Not Found" }),
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
    });
    const client = new Client({ name: "test", version: "1" });
    const onclose = vi.fn();
    // MCP clients expose callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    client.onclose = onclose;

    try {
      await client.connect(transport);

      await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
      expect(transport.sessionId).toBe("session-1");
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "GET")).toHaveLength(1);
    } finally {
      await disposeMcpClient({ client, transport, transportType: "streamable-http" });
    }
  });

  it.each([
    { cancellation: "pending", initializeStatus: 429 },
    { cancellation: "rejecting", initializeStatus: 500 },
  ])(
    "cleans up HTTP $initializeStatus with $cancellation DELETE body cancellation",
    async ({ cancellation, initializeStatus }) => {
      let initializeCount = 0;
      let deleteCount = 0;
      const sockets = new Set<Socket>();
      const server = createServer((request, response) => {
        response.on("error", () => {});
        if (request.method === "DELETE") {
          deleteCount += 1;
          response.writeHead(200).end("terminated");
          return;
        }
        if (request.method === "GET") {
          response.writeHead(405).end();
          return;
        }
        initializeCount += 1;
        response.writeHead(initializeStatus, {
          "mcp-session-id": "hang-cancel-session",
          "retry-after": "0",
        });
        response.end("initialize failed");
      });
      try {
        server.on("connection", (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        server.on("clientError", (_err, socket) => socket.destroy());
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("expected loopback TCP address");
        }
        const baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

        // Replace only cancellation after the real DELETE has completed.
        const cleanupFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await fetch(input, init);
          if (init?.method !== "DELETE") {
            return response;
          }
          expect(response.status).toBe(200);
          await response.arrayBuffer();
          return new Response(
            makeStallingStream([new TextEncoder().encode("bye")], () => {
              return cancellation === "rejecting"
                ? Promise.reject(new Error("synthetic cancellation rejection"))
                : new Promise(() => {});
            }),
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            },
          );
        };

        const transport = new OpenClawStreamableHTTPClientTransport(baseUrl, {
          fetch: cleanupFetch,
        });
        const client = new Client({ name: "test", version: "1" });

        await expect(client.connect(transport)).rejects.toThrow("initialize failed");
        expect(initializeCount).toBe(1);
        expect(transport.sessionId).toBe("hang-cancel-session");

        await expect(settlesWithin(transport.terminateSession(), 1_000)).resolves.toBe(true);
        expect(deleteCount).toBe(1);

        // Marked terminated — a second call must not issue another DELETE.
        await transport.terminateSession();
        expect(deleteCount).toBe(1);

        await disposeMcpClient({ client, transport, transportType: "streamable-http" });
        expect(deleteCount).toBe(1);
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
  );

  it("treats a server-already-terminated DELETE 404 as successful cleanup", async () => {
    let deleteCount = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => {
          const message = JSON.parse(body) as { id?: number };
          response.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "already-terminated",
          });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "fixture", version: "1" },
              },
            }),
          );
        });
        return;
      }
      if (request.method === "DELETE") {
        deleteCount += 1;
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("session already gone");
        return;
      }
      response.writeHead(405).end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected loopback TCP address");
      }
      const transport = new OpenClawStreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`),
      );
      const client = new Client({ name: "test", version: "1" });
      await client.connect(transport);

      await expect(transport.terminateSession()).resolves.toBeUndefined();
      await transport.terminateSession();
      expect(deleteCount).toBe(1);
      await expect(
        disposeMcpClient({ client, transport, transportType: "streamable-http" }),
      ).resolves.toBe("closed");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("does not record a rejected DELETE as successful termination", async () => {
    const onDelete = vi.fn(() => new Response("refused", { status: 500, statusText: "Rejected" }));
    const fetchMock = initializedFetch({
      onGet: () => new Response(null, { status: 405 }),
      onDelete,
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    await expect(transport.terminateSession()).rejects.toThrow(
      "Failed to terminate session: Rejected",
    );
    await expect(transport.terminateSession()).rejects.toThrow(
      "Failed to terminate session: Rejected",
    );
    await expect(
      disposeMcpClient({ client, transport, transportType: "streamable-http" }),
    ).resolves.toBe("closed");
    expect(onDelete).toHaveBeenCalledTimes(3);
  });

  it("does not fetch another notification stream after close returns", async () => {
    let getCount = 0;
    const fetchMock = initializedFetch({
      onGet: () => {
        getCount += 1;
        return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
      reconnectionOptions: {
        initialReconnectionDelay: 20,
        maxReconnectionDelay: 20,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 2,
      },
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    await vi.waitFor(() => expect(getCount).toBe(1));

    await client.close();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });
    expect(getCount).toBe(1);
  });

  it("keeps the client usable after cancelling an unread HTTP error body", async () => {
    const cancelled = createDeferredCore();
    const server = createServer((_request, response) => {
      response.once("close", () => cancelled.resolve());
      response.writeHead(405, { "content-type": "application/json" });
      response.write(JSON.stringify({ error: "Method not allowed" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const client = new Client({ name: "test", version: "1" });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const fetchMock = initializedFetch({
        onGet: () => fetch(`http://127.0.0.1:${address.port}/mcp`),
        onPost: (message) =>
          message.method === "ping"
            ? jsonResponse({ jsonrpc: "2.0", id: message.id, result: {} })
            : new Response(null, { status: 202 }),
      });
      const transport = new OpenClawStreamableHTTPClientTransport(
        new URL("http://mcp.invalid/mcp"),
        { fetch: fetchMock },
      );
      await client.connect(transport);
      await cancelled.promise;
      await expect(client.ping()).resolves.toEqual({});
    } finally {
      await client.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("preserves response size limits on non-ok HTTP error responses", async () => {
    let sourceCancelled: () => void;
    const cancelPromise = new Promise<void>((resolve) => {
      sourceCancelled = resolve;
    });
    const fetchMock = initializedFetch({
      onGet: () => new Response(null, { status: 405 }),
      onPost: (message) => {
        if (message.method === "ping") {
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode(OVERSIZED_MCP_TEXT));
              },
              cancel() {
                sourceCancelled();
              },
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(null, { status: 202 });
      },
    });
    const transport = new OpenClawStreamableHTTPClientTransport(new URL("http://mcp.invalid/mcp"), {
      fetch: fetchMock,
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    await expect(client.ping()).rejects.toMatchObject({
      code: SdkErrorCode.ClientHttpNotImplemented,
      status: 500,
    });
    await expect(settlesWithin(cancelPromise, 1_000)).resolves.toBe(true);
    await client.close();
  });
});
