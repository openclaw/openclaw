import { vi } from "vitest";

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  });
}

export function initializedFetch(params: {
  onGet: () => Promise<Response> | Response;
  onInitialize?: () => Response | undefined;
  sessionId?: string | null;
  onDelete?: (init: RequestInit) => Response | void;
  onPost?: (message: { id?: string | number; method?: string }) => Promise<Response> | Response;
}) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      return params.onDelete?.(init) ?? new Response(null, { status: 204 });
    }
    if (init?.method === "GET") {
      return await params.onGet();
    }
    if (typeof init?.body !== "string") {
      throw new Error("expected serialized JSON-RPC request body");
    }
    const message = JSON.parse(init.body) as { id?: number; method?: string };
    if (message.method === "initialize") {
      const initializeResponse = params.onInitialize?.();
      if (initializeResponse) {
        return initializeResponse;
      }
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture", version: "1" },
          },
        },
        {
          headers:
            params.sessionId === null
              ? undefined
              : { "mcp-session-id": params.sessionId ?? "session-1" },
        },
      );
    }
    if (params.onPost) {
      return await params.onPost(message);
    }
    return new Response(null, { status: 202 });
  });
}
