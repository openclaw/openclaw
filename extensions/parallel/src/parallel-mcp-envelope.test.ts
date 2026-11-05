import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createParallelFreeWebSearchProvider } from "./parallel-free-web-search-provider.js";

installPinnedHostnameTestHooks();

afterEach(() => vi.restoreAllMocks());

const result = (id: string, searchId = "selected") => ({
  id,
  result: { structuredContent: { search_id: searchId, results: [] } },
});

function events(messages: unknown[]): string {
  return messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join("");
}

async function search(
  callBody: (requestId: string) => string,
  initBody = (id: string) => JSON.stringify({ id, result: { protocolVersion: "2025-06-18" } }),
) {
  const requests: Array<{ method: string; headers: Headers }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    assert(typeof init?.body === "string", "Expected a JSON request body");
    const request = JSON.parse(init.body) as { method: string; id: string };
    requests.push({ method: request.method, headers: new Headers(init?.headers) });
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }
    const initializing = request.method === "initialize";
    const body = (initializing ? initBody : callBody)(request.id);
    return new Response(body, {
      headers: {
        "content-type": /^[{[]/.test(body) ? "application/json" : "text/event-stream",
        ...(initializing ? { "mcp-session-id": "fixture-server-session" } : {}),
      },
    });
  });
  const provider = createParallelFreeWebSearchProvider();
  const tool = provider.createTool({ searchConfig: { cacheTtlMinutes: 0 } });
  assert(tool, "Parallel free search tool");
  const output = await tool.execute({ search_queries: ["query"], session_id: "search-session" });
  return { output, requests };
}

it.each(
  Object.entries({
    "first matching JSON result before conflicting tails": (id: string) =>
      JSON.stringify([
        { id, method: "notifications/progress" },
        result(id),
        { id, error: { message: "later matching error" } },
        result("unrelated", "last fallback"),
      ]),
    "last result when no response id matches": () =>
      events([
        result("other-first", "earlier"),
        { id: "other-error", error: { message: "earlier error" } },
        result("other-last"),
      ]),
    "multiline CRLF data ignoring malformed events and nested arrays": (id: string) =>
      ": ignored comment\r\nevent: fixture\r\ndata: {broken\r\n\r\n" +
      `data: [null,7,[${JSON.stringify(result(id, "nested must not win"))}],\r\n` +
      `data: ${JSON.stringify(result(id))}]\r\n`,
  }),
)("selects %s", async (_name, body) => {
  expect((await search(body)).output.searchId).toBe("selected");
});

it("keeps a matching error before a later matching success", async () => {
  await expect(
    search((id) => events([{ id, error: { message: "selected error" } }, result(id, "ignored")])),
  ).rejects.toThrow("selected error");
});

it("uses the selected initialization response for every follow-up request", async () => {
  const { output, requests } = await search(
    (id) => JSON.stringify(result(id)),
    (id) =>
      events([
        { id, result: { protocolVersion: "2025-03-26" } },
        { id: "other", result: { protocolVersion: "wrong trailing version" } },
      ]),
  );

  expect(output.searchId).toBe("selected");
  expect(requests.map((request) => request.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
  for (const request of requests.slice(1)) {
    expect(request.headers.get("mcp-session-id")).toBe("fixture-server-session");
    expect(request.headers.get("mcp-protocol-version")).toBe("2025-03-26");
  }
});
