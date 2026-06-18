import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XMemoClient } from "./client.js";

function mockResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(status === 204 ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("XMemoClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends X-API-Key by default", async () => {
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const client = new XMemoClient(
      "https://xmemo.dev",
      "secret-key",
      "openclaw",
      "instance",
      "api-key",
    );
    await client.searchMemory({ query: "hello", bucket: "openclaw" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("secret-key");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sends Bearer token when authMode is bearer", async () => {
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const client = new XMemoClient(
      "https://xmemo.dev",
      "secret-key",
      "openclaw",
      "instance",
      "bearer",
    );
    await client.searchMemory({ query: "hello", bucket: "openclaw" });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-key");
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("sends both headers when authMode is both", async () => {
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const client = new XMemoClient(
      "https://xmemo.dev",
      "secret-key",
      "openclaw",
      "instance",
      "both",
    );
    await client.searchMemory({ query: "hello", bucket: "openclaw" });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("secret-key");
    expect(headers["Authorization"]).toBe("Bearer secret-key");
  });

  it("uses GET for searchMemory with query params", async () => {
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await client.searchMemory({ query: "hello", bucket: "openclaw", scope: "team", max_items: 5 });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://xmemo.dev/v1/memories/search?query=hello&bucket=openclaw&scope=team&limit=5",
    );
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });

  it("redacts the api key when it appears in the response body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid key: super-secret-key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "super-secret-key", "openclaw", "instance");
    await expect(client.remember({ content: "hello", bucket: "openclaw" })).rejects.toThrow(
      "invalid key: ***",
    );
    await expect(client.remember({ content: "hello", bucket: "openclaw" })).rejects.not.toThrow(
      "super-secret-key",
    );
  });

  it("falls back to search when getMemory direct endpoint returns 404", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        mockResponse({
          results: [{ id: "mem-1", content: "found via search", bucket: "openclaw" }],
        }),
      );

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const memory = await client.getMemory("mem-1");
    expect(memory.id).toBe("mem-1");
    expect(memory.content).toBe("found via search");
  });

  it("falls back to search when getMemory direct endpoint returns 405", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("method not allowed", { status: 405 }))
      .mockResolvedValueOnce(
        mockResponse({
          results: [{ id: "mem-2", content: "found via search after 405", bucket: "openclaw" }],
        }),
      );

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const memory = await client.getMemory("mem-2");
    expect(memory.id).toBe("mem-2");
    expect(memory.content).toBe("found via search after 405");
  });

  it("throws the original error when getMemory fallback search finds no match", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(mockResponse({ results: [] }));

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await expect(client.getMemory("missing-id")).rejects.toThrow("failed (404)");
  });

  it("does not fallback to search on 401 auth errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await expect(client.getMemory("mem-1")).rejects.toThrow("failed (401)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fallback to search on 403 forbidden errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await expect(client.getMemory("mem-1")).rejects.toThrow("failed (403)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fallback to search on AbortError", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abort);

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await expect(client.getMemory("mem-1")).rejects.toThrow("aborted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("remembers content via POST /v1/remember", async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: "mem-1" }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const result = await client.remember({ content: "hello", bucket: "openclaw" });

    expect(result.id).toBe("mem-1");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://xmemo.dev/v1/remember");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });

  it("validates tokens via GET /v1/auth/token/validate", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ status: "valid", scopes: ["memory:read"], setup_state: "setup_completed" }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const result = await client.validateToken();

    expect(result.status).toBe("valid");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://xmemo.dev/v1/auth/token/validate");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });

  it("lists reminders using item_status and unwraps { reminders }", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        reminders: [
          { id: "r-1", content: "buy milk", status: "open", due_at: "2026-06-20T00:00:00Z" },
        ],
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const result = await client.listReminders({ bucket: "openclaw", item_status: "open" });

    expect(result.reminders).toHaveLength(1);
    expect(result.reminders[0]).toMatchObject({ id: "r-1", content: "buy milk" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://xmemo.dev/v1/reminders?bucket=openclaw&item_status=open",
    );
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });
});
