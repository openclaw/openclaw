import { Client, InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { MCP_ENTERPRISE_AUTH_CLIENT_EXTENSION, prepareMcpCaps } from "./mcp-metadata.js";

describe("enterprise MCP client capability", () => {
  it("advertises enterprise authorization only for configured servers", () => {
    const [transport] = InMemoryTransport.createLinkedPair();
    expect(
      prepareMcpCaps({ transport, enterpriseAuth: true }, undefined, false).extensions,
    ).toHaveProperty(MCP_ENTERPRISE_AUTH_CLIENT_EXTENSION, {});
    expect(prepareMcpCaps({ transport }, undefined, false).extensions).toBeUndefined();
  });

  it("preserves host-provided client extensions", () => {
    const [transport] = InMemoryTransport.createLinkedPair();
    expect(
      prepareMcpCaps(
        { transport, enterpriseAuth: true },
        { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } } },
        true,
      ).extensions,
    ).toEqual({
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] },
      [MCP_ENTERPRISE_AUTH_CLIENT_EXTENSION]: {},
    });
  });

  it("places the extension on requests sent through a negotiated MCP client", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message, options) => {
      sent.push(message);
      return send(message, options);
    };
    const client = new Client(
      { name: "enterprise-test", version: "1" },
      {
        capabilities: prepareMcpCaps(
          { transport: clientTransport, enterpriseAuth: true },
          undefined,
          false,
        ),
        versionNegotiation: { mode: "auto" },
      },
    );
    const server = new Server({ name: "test", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: [] }));
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      await client.listTools();
      const request = sent.find(
        (message) => "method" in message && message.method === "tools/list",
      );
      expect(request).toMatchObject({
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { [MCP_ENTERPRISE_AUTH_CLIENT_EXTENSION]: {} },
            },
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
