import { describe, expect, it } from "vitest";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { createKnowledgeBase } from "../../planes/data/knowledge-base.js";
import { createMcpHttpHandler } from "./server.js";

function mockRuntime(): ClaworksRuntime {
  return {
    config: {},
    robot: { name: "test", role: "monolith", version: "test", endpoint: "http://127.0.0.1:1" },
    kb: createKnowledgeBase(),
    playbookEngine: { list: () => [], trigger: async () => ({ id: "r1", status: "completed" }) },
  } as unknown as ClaworksRuntime;
}

describe("createMcpHttpHandler JSON-RPC", () => {
  it("handles tools/list over POST /mcp", async () => {
    const handler = createMcpHttpHandler(() => mockRuntime());
    const chunks: Buffer[] = [];
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string | string[] | undefined>,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      end(body: string) {
        chunks.push(Buffer.from(body));
      },
    };
    const req = {
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          }),
        );
      },
    };
    const handled = await handler(
      req as import("node:http").IncomingMessage,
      res as import("node:http").ServerResponse,
    );
    expect(handled).toBe(true);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      result?: { tools?: unknown[] };
    };
    expect(body.result?.tools?.length).toBeGreaterThan(0);
  });
});
