import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { checkMcpToolAuth, publishMcpRbacDenied, resolveMcpAuth } from "./mcp-auth.js";
import { CLAWORKS_MCP_TOOLS, callClaworksMcpTool } from "./tools.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function jsonRpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

function mcpToolsListPayload() {
  return {
    tools: CLAWORKS_MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

async function handleJsonRpc(
  runtime: ClaworksRuntime,
  body: JsonRpcRequest,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { id, method, params } = body;
  const auth = resolveMcpAuth(req, runtime);
  if (!auth.authenticated) {
    sendJson(res, 401, jsonRpcError(id, -32001, "Unauthorized"));
    return;
  }
  try {
    if (method === "initialize") {
      sendJson(
        res,
        200,
        jsonRpcResult(id, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "claworks-mcp", version: runtime.robot.version },
          capabilities: { tools: {} },
        }),
      );
      return;
    }
    if (method === "tools/list") {
      sendJson(res, 200, jsonRpcResult(id, mcpToolsListPayload()));
      return;
    }
    if (method === "tools/call") {
      const name = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const rbac = checkMcpToolAuth(runtime, auth, name, args);
      if (!rbac.allowed) {
        await publishMcpRbacDenied(runtime, auth, name, rbac.reason);
        sendJson(
          res,
          200,
          jsonRpcError(id, -32003, "Forbidden", { code: "RBAC_DENIED", reason: rbac.reason }),
        );
        return;
      }
      const result = await callClaworksMcpTool(runtime, name, args);
      sendJson(res, 200, {
        ...jsonRpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        }),
      });
      return;
    }
    sendJson(res, 200, jsonRpcError(id, -32601, `Method not found: ${method ?? ""}`));
  } catch (err) {
    sendJson(res, 200, jsonRpcError(id, -32603, err instanceof Error ? err.message : String(err)));
  }
}

export function createMcpHttpHandler(
  getRuntime: () => ClaworksRuntime | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/mcp") && !url.pathname.startsWith("/v1/mcp")) {
      return false;
    }

    const runtime = getRuntime();
    if (!runtime) {
      sendJson(res, 503, { error: "runtime not ready" });
      return true;
    }

    const auth = resolveMcpAuth(req, runtime);
    if (!auth.authenticated) {
      sendJson(res, 401, { error: "Unauthorized", code: "UNAUTHORIZED" });
      return true;
    }

    // JSON-RPC 2.0 (MCP-compatible): POST /mcp 或 POST /v1/mcp（openclaw-claworks-client 期望 /v1/mcp）
    if (
      req.method === "POST" &&
      (url.pathname === "/mcp" ||
        url.pathname === "/mcp/" ||
        url.pathname === "/v1/mcp" ||
        url.pathname === "/v1/mcp/")
    ) {
      const body = (await readBody(req)) as JsonRpcRequest;
      if (body.jsonrpc === "2.0" && body.method) {
        await handleJsonRpc(runtime, body, req, res);
        return true;
      }
      sendJson(res, 400, jsonRpcError(body.id, -32600, "Invalid JSON-RPC request"));
      return true;
    }

    // Legacy HTTP helpers (kept for openclaw-claworks-extension compatibility)
    if (
      req.method === "POST" &&
      (url.pathname === "/mcp/tools/list" || url.pathname === "/v1/mcp/tools/list")
    ) {
      sendJson(res, 200, { tools: CLAWORKS_MCP_TOOLS });
      return true;
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/mcp/tools/call" || url.pathname === "/v1/mcp/tools/call")
    ) {
      const body = (await readBody(req)) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const name = body.name ?? "";
      const args = body.arguments ?? {};
      const rbac = checkMcpToolAuth(runtime, auth, name, args);
      if (!rbac.allowed) {
        await publishMcpRbacDenied(runtime, auth, name, rbac.reason);
        sendJson(res, 403, { error: "Forbidden", code: "RBAC_DENIED", reason: rbac.reason });
        return true;
      }

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
