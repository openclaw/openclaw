import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  bindMcpClientElicitation,
  runWithMcpElicitationHandler,
  type McpElicitationHandler,
} from "./mcp-client-elicitation.js";
import { buildMcpClientCapabilities } from "./mcp-metadata.js";

async function fixture() {
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: buildMcpClientCapabilities(true), versionNegotiation: { mode: "legacy" } },
  );
  const server = new Server({ name: "test", version: "1" }, { capabilities: { tools: {} } });
  const call = bindMcpClientElicitation(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    server,
    call: <T>(handler: McpElicitationHandler, run: () => Promise<T>) =>
      runWithMcpElicitationHandler(handler, () => call(new AbortController().signal, run)),
    request: (params: Record<string, unknown> = {}) =>
      server.request(
        { method: "openai/elicitation/create", params },
        z.object({ action: z.string(), content: z.record(z.string(), z.unknown()).optional() }),
      ),
    [Symbol.asyncDispose]: async () => {
      await client.close();
      await server.close();
    },
  };
}
describe("direct MCP elicitation binding", () => {
  it("advertises and answers OpenAI forms on the actual MCP connection", async () => {
    await using f = await fixture();
    f.server.setRequestHandler("tools/call", async () => {
      const result = await f.request({
        requestedSchema: { type: "object", properties: {} },
        message: "Pick",
      });
      return { content: [], structuredContent: result };
    });
    const handler = vi.fn(async () => ({
      action: "accept" as const,
      content: { color: "blue" },
    }));
    const result = await f.call(handler, () => f.client.callTool({ name: "pick" }));
    expect(result.structuredContent).toEqual({ action: "accept", content: { color: "blue" } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "openai/elicitation/create",
        params: expect.objectContaining({ message: "Pick" }),
      }),
    );
    expect(f.server.getClientCapabilities()?.extensions?.["openai/elicitation"]).toEqual({
      form: {},
    });
  });
  it("refuses ambiguous concurrent requesters and releases settled ownership", async () => {
    await using f = await fixture();
    const hold = createDeferred();
    const started = createDeferred();
    const first = f.call(
      async () => ({ action: "accept" }),
      async () => {
        started.resolve();
        await hold.promise;
      },
    );
    await started.promise;
    const second = f.call(
      async () => ({ action: "accept" }),
      async () => {
        await expect(f.request()).rejects.toThrow("unambiguous active requester");
      },
    );
    await second;
    hold.resolve();
    await first;
    await expect(f.request()).rejects.toThrow("unambiguous active requester");
  });
});
