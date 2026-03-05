import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parse } from "yaml";
import { parseRulesYaml } from "./rule-loader.js";
import type { HarnessRule } from "./rules.js";

const PORT = process.env.RULES_SERVER_PORT ? parseInt(process.env.RULES_SERVER_PORT, 10) : 18790;
const HOST = process.env.RULES_SERVER_HOST || "0.0.0.0";

interface RuleUpdateRequest {
  layer: string;
  rulesYaml: string;
}

interface RuleUpdateResponse {
  ok: boolean;
  count?: number;
  error?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function parseBody(req: IncomingMessage): Promise<RuleUpdateRequest> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as RuleUpdateRequest;
        resolve(parsed);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function handleRulesRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let body: RuleUpdateRequest;
  try {
    body = await parseBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { layer, rulesYaml } = body;

  if (!["operator", "client"].includes(layer)) {
    sendJson(res, 400, { error: "layer must be 'operator' or 'client'" });
    return;
  }

  const rules = parseRulesYaml(rulesYaml);
  if (rules.length === 0) {
    sendJson(res, 400, { error: "no valid rules" });
    return;
  }

  // Store rules to disk for hot-reload
  const fs = await import("node:fs");
  const path = await import("node:path");
  const rulesPath =
    layer === "operator"
      ? "/etc/fridaclaw/operator-rules.yaml"
      : path.join("/etc/fridaclaw", `client-rules.yaml`);

  // Ensure directory exists
  const dir = path.dirname(rulesPath);
  try {
    fs.accessSync(dir);
  } catch {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(rulesPath, rulesYaml);

  const response: RuleUpdateResponse = { ok: true, count: rules.length };
  sendJson(res, 200, response);
}

function createRulesServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/rules") {
      await handleRulesRequest(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });
}

export { createRulesServer, PORT, HOST };
