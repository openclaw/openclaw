import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const stateDir = process.env.MCP_PEER_STATE_DIR ?? process.argv[2];
const mode = process.env.MCP_PEER_MODE ?? process.argv[3] ?? "plain";
const events = [];
const record = (event) => {
  events.push(event);
  fs.writeFileSync(path.join(stateDir, "events.json"), JSON.stringify(events));
};

record({ event: "started", pid: process.pid });
if (mode === "descendant") {
  // The descendant deliberately outlives stdio EOF; the browser session owns its cleanup.
  const child = spawn(
    process.execPath,
    ["-e", 'process.send("ready"); setInterval(() => {}, 60_000);'],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  await once(child, "message");
  record({ event: "descendant", pid: child.pid });
  child.disconnect();
  child.unref();
}

const tool = (name) => ({
  name,
  inputSchema: { type: "object" },
  outputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
});
const navigation = {
  name: "list_pages",
  inputSchema: { type: "object" },
  outputSchema: {
    type: "object",
    properties: { pages: { type: "array" } },
    required: ["pages"],
  },
};
const server = new Server(
  { name: "synthetic-v1-peripheral", version: "1.0.0" },
  {
    capabilities: { tools: {} },
  },
);
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
  record({ event: "list", cursor: params?.cursor ?? null });
  if (params?.cursor) {
    return { tools: mode === "navigation-second" ? [navigation] : [tool("fixture.next")] };
  }
  return {
    tools:
      mode === "navigation-second" ? [tool("fixture.echo")] : [navigation, tool("fixture.echo")],
    nextCursor: "second-page",
  };
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  record({ event: "call", name: params.name });
  const value = params.arguments?.invalid ? 7 : "first-page-result";
  const structuredContent =
    params.name === "list_pages"
      ? { pages: [{ id: 1, url: "https://example.test/", selected: true }] }
      : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
});
process.stdin.once("end", () => record({ event: "eof" }));
await server.connect(new StdioServerTransport());
