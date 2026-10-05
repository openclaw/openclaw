import { expect, it } from "vitest";
import { buildAgentsApiMcpTools } from "./agentsapi-mcp.js";

it("forwards explicit HTTP transport over a stale type alias while excluding command-bearing servers", async () => {
  const tools = await buildAgentsApiMcpTools({
    workspaceDir: process.cwd(),
    config: {
      plugins: { enabled: false },
      mcp: {
        servers: {
          remote: {
            transport: "streamable-http",
            type: "stdio",
            url: "https://mcp.example.com/mcp",
          },
          executable: {
            transport: "streamable-http",
            type: "stdio",
            url: "https://mcp.example.com/mcp",
            command: "node",
          },
        },
      },
    },
  });

  expect(tools).toEqual([
    {
      type: "mcp",
      server_label: "remote",
      transport: {
        type: "http",
        server_url: "https://mcp.example.com/mcp",
      },
      connection_origin: "environment",
    },
  ]);
});
