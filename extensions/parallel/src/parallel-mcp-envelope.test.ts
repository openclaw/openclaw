import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createParallelFreeWebSearchProvider } from "./parallel-free-web-search-provider.js";

installPinnedHostnameTestHooks();

afterEach(() => {
  vi.restoreAllMocks();
});

function result(id: string, searchId: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: { structuredContent: { search_id: searchId, results: [] } },
  };
}

function events(messages: unknown[], newline = "\n"): string {
  return messages.map((message) => `data: ${JSON.stringify(message)}${newline}${newline}`).join("");
}

async function search(callBody: (requestId: string) => string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    const request = JSON.parse(init.body) as { method: string; id: string };
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }
    const initializing = request.method === "initialize";
    const body = initializing
      ? JSON.stringify({ id: request.id, result: { protocolVersion: "2025-06-18" } })
      : callBody(request.id);
    return new Response(body, {
      headers: {
        "content-type": /^[{[]/.test(body) ? "application/json" : "text/event-stream",
        ...(initializing ? { "mcp-session-id": "fixture-server-session" } : {}),
      },
    });
  });
  const tool = createParallelFreeWebSearchProvider().createTool({
    searchConfig: { cacheTtlMinutes: 0 },
  });
  if (!tool) {
    throw new Error("Expected Parallel free search tool");
  }
  const output = await tool.execute({
    search_queries: ["public documentation"],
    session_id: "fixture-search-session",
  });
  return output;
}

describe("Parallel MCP envelope selection through the registered free provider", () => {
  it("keeps a matching error before a later matching success", async () => {
    await expect(
      search((id) => events([{ id, error: { message: "selected error" } }, result(id, "ignored")])),
    ).rejects.toThrow("selected error");
  });

  it("uses the last result when no response id matches", async () => {
    const output = await search(() =>
      events([
        result("other-first", "earlier"),
        { id: "other-error", error: { message: "earlier error" } },
        result("other-last", "selected fallback"),
      ]),
    );

    expect(output.searchId).toBe("selected fallback");
  });

  it("keeps multiline CRLF data and ignores malformed events and nested batch arrays", async () => {
    const output = await search((id) =>
      [
        ": ignored comment",
        "event: fixture",
        "data: {broken",
        "",
        `data: [null,7,[${JSON.stringify(result(id, "nested must not win"))}],`,
        `data: ${JSON.stringify(result(id, "selected"))}]`,
        "",
      ].join("\r\n"),
    );

    expect(output.searchId).toBe("selected");
  });
});
