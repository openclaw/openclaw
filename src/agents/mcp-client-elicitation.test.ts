import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  bindMcpClientElicitation,
  runWithMcpElicitationHandler,
  type McpElicitationHandler,
} from "./mcp-client-elicitation.js";
import { buildMcpClientCapabilities } from "./mcp-metadata.js";
const accepted = { action: "accept" as const };

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
it("advertises and answers OpenAI forms on the actual MCP connection", async () => {
  await using f = await fixture();
  f.server.setRequestHandler("tools/call", async () => {
    const result = await f.request({
      requestedSchema: { type: "object", properties: {} },
      message: "Pick",
    });
    return { content: [], structuredContent: result };
  });
  const handler = vi.fn<McpElicitationHandler>(async () => ({
    ...accepted,
    content: { color: "blue" },
  }));
  const result = await f.call(handler, () => f.client.callTool({ name: "pick" }));
  expect(result.structuredContent).toEqual({ action: "accept", content: { color: "blue" } });
  expect(handler.mock.calls[0]?.[0]).toMatchObject({
    method: "openai/elicitation/create",
    params: { message: "Pick" },
  });
  expect(f.server.getClientCapabilities()?.extensions?.["openai/elicitation"]).toEqual({
    form: {},
  });
});
it("refuses ambiguous concurrent requesters and releases settled ownership", async () => {
  await using f = await fixture();
  const hold = createDeferred();
  const started = createDeferred();
  const first = f.call(
    async () => accepted,
    async () => {
      started.resolve();
      await hold.promise;
    },
  );
  await started.promise;
  await f.call(
    async () => accepted,
    async () => {
      await expect(f.request()).rejects.toThrow("unambiguous active requester");
    },
  );
  hold.resolve();
  await first;
  await expect(f.request()).rejects.toThrow("unambiguous active requester");
});
