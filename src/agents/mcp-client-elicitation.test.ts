import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  bindMcpClientElicitation,
  runWithMcpElicitationHandler,
} from "./mcp-client-elicitation.js";
import { buildMcpClientCapabilities } from "./mcp-metadata.js";

async function fixture() {
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: buildMcpClientCapabilities(true) },
  );
  const server = new Server({ name: "test", version: "1" }, { capabilities: { tools: {} } });
  const call = bindMcpClientElicitation(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    server,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
describe("direct MCP elicitation binding", () => {
  it("advertises and answers OpenAI forms on the actual MCP connection", async () => {
    const f = await fixture();
    try {
      f.server.setRequestHandler(CallToolRequestSchema, async () => {
        const result = await f.server.request(
          {
            method: "openai/elicitation/create",
            params: { requestedSchema: { type: "object", properties: {} }, message: "Pick" },
          },
          z.object({ action: z.string(), content: z.record(z.string(), z.unknown()).optional() }),
        );
        return { content: [], structuredContent: result };
      });
      const handler = vi.fn(async () => ({
        action: "accept" as const,
        content: { color: "blue" },
      }));
      const result = await runWithMcpElicitationHandler(handler, () =>
        f.call(new AbortController().signal, () => f.client.callTool({ name: "pick" })),
      );
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
    } finally {
      await f.close();
    }
  });
  it("refuses ambiguous concurrent requesters and releases settled ownership", async () => {
    const f = await fixture();
    try {
      const hold = createDeferred();
      const started = createDeferred();
      const first = runWithMcpElicitationHandler(
        async () => ({ action: "accept" }),
        () =>
          f.call(new AbortController().signal, async () => {
            started.resolve();
            await hold.promise;
          }),
      );
      await started.promise;
      const second = runWithMcpElicitationHandler(
        async () => ({ action: "accept" }),
        () =>
          f.call(new AbortController().signal, async () => {
            await expect(
              f.server.request(
                { method: "openai/elicitation/create", params: {} },
                z.object({ action: z.string() }),
              ),
            ).rejects.toThrow("unambiguous active requester");
          }),
      );
      await second;
      hold.resolve();
      await first;
      await expect(
        f.server.request(
          { method: "openai/elicitation/create", params: {} },
          z.object({ action: z.string() }),
        ),
      ).rejects.toThrow("unambiguous active requester");
    } finally {
      await f.close();
    }
  });
});
