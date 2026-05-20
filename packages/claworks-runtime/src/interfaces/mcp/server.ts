import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { CLAWORKS_MCP_TOOLS, callClaworksMcpTool } from "./tools.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function createMcpHttpHandler(
  getRuntime: () => ClaworksRuntime | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/mcp")) {
      return false;
    }

    const runtime = getRuntime();
    if (!runtime) {
      sendJson(res, 503, { error: "runtime not ready" });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/mcp/tools/list") {
      sendJson(res, 200, { tools: CLAWORKS_MCP_TOOLS });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/mcp/tools/call") {
      const body = (await readBody(req)) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const name = body.name ?? "";
      const args = body.arguments ?? {};

      try {
        const result = await callClaworksMcpTool(runtime, name, args);
        sendJson(res, 200, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
        return true;
      } catch (err) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : {};
}
