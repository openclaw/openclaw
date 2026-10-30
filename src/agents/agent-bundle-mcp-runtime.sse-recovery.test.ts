import { afterEach, expect, it, vi } from "vitest";
import { snapshotMcpTools } from "./agent-bundle-mcp-recovery.test-support.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import { OpenClawSSEClientTransport } from "./mcp-http-transport.js";

const { resolveTransport } = vi.hoisted(() => ({ resolveTransport: vi.fn() }));

vi.mock("./mcp-transport.js", () => ({ resolveMcpTransport: resolveTransport }));
vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: () => ({
    mcpServers: { legacy: { url: "http://mcp.invalid/sse", transport: "sse" } },
    diagnostics: [],
    prepareDataDirsByServer: {},
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  resolveTransport.mockReset();
});

it.each([
  { status: 404, reconnects: true, failureMethod: "tools/call" },
  { status: 500, reconnects: false, failureMethod: "tools/call" },
  { status: 404, reconnects: true, failureMethod: "tools/list" },
  { status: 500, reconnects: false, failureMethod: "tools/list" },
  { status: 200, reconnects: true, failureMethod: "endpoint" },
])(
  "recovers legacy SSE $failureMethod ($status) without replaying a failed tool call",
  async ({ status, reconnects, failureMethod }) => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const send = (endpoint: string, message: unknown) =>
      streams
        .get(endpoint)
        ?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
    const calls: string[] = [];
    const lists: string[] = [];
    let sessionCount = 0;
    let rejectNextRequest = false;
    const fetchFixture = async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        const endpoint = `/messages/${++sessionCount}`;
        let onAbort: (() => void) | undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(endpoint, controller);
              onAbort = () => {
                if (streams.delete(endpoint)) {
                  controller.error(init?.signal?.reason);
                }
              };
              init?.signal?.addEventListener("abort", onAbort, { once: true });
              controller.enqueue(
                encoder.encode(`retry: 1\nevent: endpoint\ndata: ${endpoint}\n\n`),
              );
            },
            cancel() {
              streams.delete(endpoint);
              if (onAbort) {
                init?.signal?.removeEventListener("abort", onAbort);
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const endpoint = new URL(input instanceof Request ? input.url : input).pathname;
      if (typeof init?.body !== "string") {
        throw new Error("expected serialized JSON-RPC request body");
      }
      const message = JSON.parse(init.body) as {
        id?: number;
        method: string;
        params?: { arguments?: { attempt?: string } };
      };
      if (message.method === "tools/call") {
        calls.push(`${endpoint}:${message.params?.arguments?.attempt}`);
      } else if (message.method === "tools/list") {
        lists.push(endpoint);
      }
      if (message.method === failureMethod && rejectNextRequest) {
        rejectNextRequest = false;
        return new Response("Session not found", { status });
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "legacy", version: "1" },
            }
          : message.method === "tools/list"
            ? { tools: [{ name: "probe", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: endpoint }] };
      if (message.id !== undefined) {
        send(endpoint, { jsonrpc: "2.0", id: message.id, result });
      }
      return new Response(null, { status: 202 });
    };
    resolveTransport.mockImplementation(() => ({
      transport: new OpenClawSSEClientTransport(new URL("http://mcp.invalid/sse"), {
        fetch: fetchFixture,
        eventSourceInit: { fetch: fetchFixture },
      }),
      description: "legacy fixture",
      transportType: "sse",
      connectionTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      supportsParallelToolCalls: true,
    }));
    const runtime = createSessionMcpRuntime({ sessionId: "legacy", workspaceDir: "/workspace" });
    const toolBytes = async () => (await snapshotMcpTools({ runtime })).bytes;
    try {
      expect((await runtime.getCatalog()).tools).toHaveLength(1);
      const originalTools = await toolBytes();
      rejectNextRequest = failureMethod !== "endpoint";
      if (failureMethod === "endpoint") {
        const stream = streams.get("/messages/1");
        streams.delete("/messages/1");
        stream?.close();
        await vi.advanceTimersByTimeAsync(1);
      } else if (failureMethod === "tools/call") {
        await expect(runtime.callTool("legacy", "probe", { attempt: "expired" })).rejects.toThrow(
          `Error POSTing to endpoint (HTTP ${status}): Session not found`,
        );
        if (reconnects) {
          expect(runtime.peekCatalog()?.diagnostics?.[0]?.message).toBe("expired HTTP session");
          expect(await toolBytes()).toBe(originalTools);
        } else {
          expect(runtime.peekCatalog()?.diagnostics).toBeUndefined();
        }
      } else {
        send("/messages/1", { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        await vi.advanceTimersByTimeAsync(0);
        const failedCatalog = await runtime.getCatalog();
        expect(failedCatalog.tools).toHaveLength(1);
        expect(await toolBytes()).toBe(originalTools);
        expect(failedCatalog.diagnostics?.[0]?.message).toContain(`HTTP ${status}`);
        expect(streams.size).toBe(reconnects ? 0 : 1);
        await vi.advanceTimersByTimeAsync(5_000);
      }

      if (failureMethod !== "endpoint") {
        await runtime.getCatalog();
        await vi.advanceTimersByTimeAsync(0);
      }
      const expectedSessions = failureMethod === "endpoint" ? 3 : reconnects ? 2 : 1;
      const activeEndpoint = `/messages/${expectedSessions}`;
      await expect(
        runtime.callTool("legacy", "probe", { attempt: "after" }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: activeEndpoint }],
      });
      expect(calls).toEqual([
        ...(failureMethod === "tools/call" ? ["/messages/1:expired"] : []),
        `${activeEndpoint}:after`,
      ]);
      if (failureMethod === "tools/list") {
        expect(lists).toEqual(["/messages/1", "/messages/1", activeEndpoint]);
      }
      expect(sessionCount).toBe(expectedSessions);
      expect(await toolBytes()).toBe(originalTools);
    } finally {
      await runtime.dispose();
      await runtime.joinCleanup?.();
    }
    expect(streams.size).toBe(0);
  },
);
