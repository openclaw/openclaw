import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";

/** The static report is shared. The connected report requires Alice's synthetic credential. */
export async function startReportMcp(accountId: string) {
  const calls: { source: string; tool: string; units: number }[] = [];
  let units = 1;
  const server = createServer((req, res) => {
    const source = req.url === "/static" ? "static" : "connected";
    const credential = source === "static" ? "fixture-shared" : `fixture-${accountId}-+15550000001`;
    if (req.headers.authorization !== `Bearer ${credential}`) {
      res.writeHead(403).end();
      return;
    }
    const mcp = new McpServer({ name: source, version: "1" });
    for (const name of ["report", "amend"]) {
      mcp.registerTool(
        name,
        {
          description: name === "report" ? "Read today's unit count." : "Amend today's count.",
          inputSchema: {},
          annotations: { readOnlyHint: name === "report", destructiveHint: name === "amend" },
        },
        () => {
          calls.push({ source, tool: name, units });
          return {
            content: [
              {
                type: "text",
                text: `Today's ${source} report: ${units} ${units === 1 ? "unit" : "units"}.`,
              },
            ],
          };
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => {
      void mcp.close();
    });
    void mcp
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => res.destroy());
  });
  const port = await listenOnLoopback(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    setUnits(value: number) {
      units = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
