import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

console.log("Server class available:", !!Server);
console.log("McpServer class available:", !!McpServer);

if (Server) {
  const testServer = new Server({ name: "test", version: "1.0.0" }, { capabilities: {} });
  console.log(
    "Server.setRequestHandler exists:",
    typeof testServer.setRequestHandler === "function",
  );
}

if (McpServer) {
  const testMcp = new McpServer({ name: "test", version: "1.0.0" });
  console.log("McpServer.tool exists:", typeof testMcp.tool === "function");
}
