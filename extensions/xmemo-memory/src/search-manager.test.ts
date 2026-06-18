import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XMemoClient } from "./client.js";
import { XMemoSearchManager } from "./search-manager.js";

function mockResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(status === 204 ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestUrl(callIndex: number, calls: unknown[][]): string {
  return String(calls[callIndex]?.[0]);
}

function requestInit(callIndex: number, calls: unknown[][]): RequestInit {
  return (calls[callIndex]?.[1] ?? {}) as RequestInit;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createConfig(
  overrides: Partial<{
    apiKey: string;
    bucket: string;
    scope: string | undefined;
    teamId: string | undefined;
    recallMaxItems: number;
    recallMaxTokens: number;
    recallMaxChars: number;
  }> = {},
) {
  return {
    baseUrl: "https://xmemo.dev",
    apiKey: overrides.apiKey ?? "key",
    bucket: overrides.bucket ?? "openclaw",
    scope: overrides.scope,
    teamId: overrides.teamId,
    agentId: "openclaw",
    agentInstanceId: "instance",
    authMode: "api-key" as const,
    autoCapture: false,
    captureMaxChars: 500,
    customTriggers: undefined,
    recallMaxChars: overrides.recallMaxChars ?? 1000,
    recallMaxItems: overrides.recallMaxItems ?? 8,
    recallMaxTokens: overrides.recallMaxTokens ?? 1500,
  };
}

describe("XMemoSearchManager", () => {
  it("returns empty results when client is not configured", async () => {
    const client = new XMemoClient("https://xmemo.dev", "", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const results = await manager.search("hello");
    expect(results).toEqual([]);
  });

  it("maps recall_context items to MemorySearchResult", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        items: [
          { id: "mem-1", content: "first memory", path: "openclaw", score: 0.95 },
          { id: "mem-2", content: "second memory", score: 0.88 },
        ],
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const results = await manager.search("hello");

    expect(results).toHaveLength(2);
    const [first, second] = results;
    expect(first?.path).toBe("openclaw/mem-1");
    expect(first?.snippet).toBe("first memory");
    expect(second?.path).toBe("openclaw/mem-2");
  });

  it("reads a memory by id path", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        id: "mem-1",
        content: "line one\nline two\nline three",
        path: "openclaw",
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const result = await manager.readFile({ relPath: "openclaw/mem-1", from: 2, lines: 1 });

    expect(result.text).toBe("line two");
    expect(result.from).toBe(2);
    expect(result.lines).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("reads a memory by non-UUID id path", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        id: "custom-id-123",
        content: "custom memory",
        path: "openclaw",
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const result = await manager.readFile({ relPath: "openclaw/custom-id-123" });

    expect(result.text).toBe("custom memory");
  });

  it("reports not connected before any probe", () => {
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const status = manager.status();
    expect((status.custom as Record<string, unknown>).connected).toBe(false);
  });

  it("probes connectivity with token validation", async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: "valid" }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());

    const ok = await manager.probeConnectivity();
    expect(ok).toBe(true);
    expect(requestUrl(0, fetchMock.mock.calls)).toBe("https://xmemo.dev/v1/auth/token/validate");
    expect(requestInit(0, fetchMock.mock.calls).method).toBe("GET");
    expect((manager.status().custom as Record<string, unknown>).connected).toBe(true);
  });

  it("reports probe failure without leaking the api key", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "bad key: super-secret-key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "super-secret-key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());

    const ok = await manager.probeConnectivity();
    expect(ok).toBe(false);
    const lastError = (manager.status().custom as Record<string, unknown>).lastError as string;
    expect(lastError).not.toContain("super-secret-key");
  });

  it("returns status with backend xmemo", () => {
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const status = manager.status();

    expect(status.backend).toBe("xmemo");
    expect(status.provider).toBe("xmemo-memory");
    expect((status.custom as Record<string, unknown>).configured).toBe(true);
  });
});
