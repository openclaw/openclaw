import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const stateDir = process.env.MCP_PEER_STATE_DIR;
const events = [];
const record = (event) => {
  events.push(event);
  fs.writeFileSync(path.join(stateDir, "events.json"), JSON.stringify(events));
};
const tool = (name) => ({
  name,
  inputSchema: { type: "object" },
  outputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
});
const server = new Server(
  { name: "synthetic-v1-qa", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
record({ event: "started", pid: process.pid });
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
  record({ event: "list", cursor: params?.cursor ?? null });
  return params?.cursor
    ? { tools: [tool("fixture.next")] }
    : {
        tools: [tool("fixture.echo"), { name: "list_pages", inputSchema: { type: "object" } }],
        nextCursor: "second-page",
      };
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  record({ event: "call", name: params.name });
  const structuredContent = { value: params.arguments?.invalid ? 7 : "first-page-result" };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
});
process.stdin.once("end", () => record({ event: "eof" }));
await server.connect(new StdioServerTransport());
