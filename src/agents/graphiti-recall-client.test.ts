import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  extractFacts,
  parseSse,
  SAFE_GROUP_ID,
  searchMemoryFacts,
} from "./graphiti-recall-client.ts";

interface FactRow {
  fact: string;
  expired_at?: string | null;
  invalid_at?: string | null;
}

function factsResult(facts: FactRow[]): unknown {
  const payload = { message: "Facts retrieved successfully", facts };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { result: payload },
    isError: false,
  };
}

describe("extractFacts", () => {
  it("reads structuredContent.result.facts", () => {
    expect(extractFacts(factsResult([{ fact: "A" }, { fact: "B" }]))).toEqual(["A", "B"]);
  });

  it("falls back to content[0].text JSON when structuredContent is absent", () => {
    const r = { content: [{ type: "text", text: JSON.stringify({ facts: [{ fact: "X" }] }) }] };
    expect(extractFacts(r)).toEqual(["X"]);
  });

  it("skips expired / invalidated facts", () => {
    const r = factsResult([
      { fact: "live" },
      { fact: "old", expired_at: "2020-01-01" },
      { fact: "bad", invalid_at: "2020-01-01" },
    ]);
    expect(extractFacts(r)).toEqual(["live"]);
  });

  it("clamps to max", () => {
    expect(extractFacts(factsResult([{ fact: "1" }, { fact: "2" }, { fact: "3" }]), 2)).toEqual([
      "1",
      "2",
    ]);
  });

  it("returns [] on junk / non-JSON text", () => {
    expect(extractFacts(null)).toEqual([]);
    expect(extractFacts({ content: [{ text: "not json" }] })).toEqual([]);
  });
});

describe("parseSse", () => {
  it("parses SSE data lines", () => {
    expect(parseSse('data: {"a":1}\n')).toEqual({ a: 1 });
  });
  it("falls back to plain JSON", () => {
    expect(parseSse('{"a":2}')).toEqual({ a: 2 });
  });
  it("returns null on garbage", () => {
    expect(parseSse("nope")).toBeNull();
  });
});

describe("SAFE_GROUP_ID", () => {
  it("accepts alnum + underscore", () => {
    expect(SAFE_GROUP_ID.test("app_user_123")).toBe(true);
  });
  it("rejects dash / colon / space / empty", () => {
    expect(SAFE_GROUP_ID.test("app-user")).toBe(false);
    expect(SAFE_GROUP_ID.test("app:user")).toBe(false);
    expect(SAFE_GROUP_ID.test("app user")).toBe(false);
    expect(SAFE_GROUP_ID.test("")).toBe(false);
  });
});

// A minimal MCP-over-streamable-HTTP server that records the tools/call it receives.
function startMockGraphiti(facts: FactRow[]): Promise<{
  url: string;
  captured: { name?: string; args?: Record<string, unknown>; host?: string };
  close: () => Promise<void>;
}> {
  const captured: { name?: string; args?: Record<string, unknown>; host?: string } = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg: {
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      } = {};
      try {
        msg = JSON.parse(body || "{}");
      } catch {
        /* ignore */
      }
      if (msg.method === "initialize") {
        res.setHeader("mcp-session-id", "sid-test");
        res.setHeader("Content-Type", "text/event-stream");
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n\n`);
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (msg.method === "tools/call") {
        captured.name = msg.params?.name;
        captured.args = msg.params?.arguments;
        captured.host = req.headers.host;
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: factsResult(facts) })}\n\n`,
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        captured,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

describe("searchMemoryFacts (wire + scope + timebox)", () => {
  it("sends group_ids:[groupId] (and no other scope field) and parses the facts", async () => {
    const srv = await startMockGraphiti([{ fact: "goal: build a daily writing routine" }]);
    try {
      const facts = await searchMemoryFacts({
        groupId: "app_user_abc",
        query: "goals",
        url: srv.url,
        hostHeader: "localhost:8000",
      });
      expect(facts).toEqual(["goal: build a daily writing routine"]);
      expect(srv.captured.name).toBe("search_memory_facts");
      expect(srv.captured.args?.group_ids).toEqual(["app_user_abc"]);
      expect(srv.captured.args).not.toHaveProperty("group_id");
      expect(srv.captured.args).not.toHaveProperty("center_node_uuid");
      expect(srv.captured.args?.query).toBe("goals");
      // proves the required Host header is sent verbatim (Graphiti rejects non-localhost Host)
      expect(srv.captured.host).toBe("localhost:8000");
    } finally {
      await srv.close();
    }
  });

  it("fails closed on an unsafe group id (no network call)", async () => {
    await expect(
      searchMemoryFacts({ groupId: "app-user", query: "x", url: "http://127.0.0.1:1/mcp" }),
    ).rejects.toThrow(/unsafe or missing group id/);
  });

  it("returns [] for an empty query without hitting the network", async () => {
    expect(
      await searchMemoryFacts({ groupId: "app_x", query: "   ", url: "http://127.0.0.1:1/mcp" }),
    ).toEqual([]);
  });

  it("aborts and throws when the server exceeds the timebox", async () => {
    const server = http.createServer(() => {
      /* never responds */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        searchMemoryFacts({
          groupId: "app_x",
          query: "q",
          url: `http://127.0.0.1:${port}/mcp`,
          timeoutMs: 100,
        }),
      ).rejects.toThrow();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
