import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { resolveHermesBridgeConfig } from "../src/config.js";
import { createHermesBridgeHttpHandler } from "../src/http-route.js";

const port = Number(
  process.env.OPENCLAW_HERMES_BRIDGE_PORT ?? process.env.OPENCLAW_GATEWAY_PORT ?? 18789,
);
const host = process.env.OPENCLAW_HERMES_BRIDGE_HOST ?? "127.0.0.1";

const config = resolveHermesBridgeConfig({
  enabled: true,
  mode: "mock",
  hermesMode: "real",
  sharedSecretEnv: "OPENCLAW_HERMES_BRIDGE_TOKEN",
  allowedTasks: [
    "status.echo",
    "status.health",
    "message.preview",
    "tasks.organize_today",
    "agents.ask_team",
  ],
  allowedTools: [],
  maxRequestBytes: 65_536,
});

const bridgeHandler = createHermesBridgeHttpHandler({
  resolveConfig: () => config,
  env: process.env,
});

function isAuthorized(req: IncomingMessage): boolean {
  const expectedToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!expectedToken) {
    return false;
  }
  return req.headers.authorization === `Bearer ${expectedToken}`;
}

const server = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, status: "live", bridge: "hermes-bridge-local" }));
    return;
  }

  if (req.url === "/api/plugins/hermes-bridge/tasks") {
    if (!isAuthorized(req)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          mode: "mock",
          status: "blocked",
          summary: "Invalid OpenClaw gateway token.",
          artifacts: [],
          auditLog: [],
          error: { type: "invalid_gateway_token", message: "Invalid OpenClaw gateway token." },
        }),
      );
      return;
    }
    await bridgeHandler(req, res);
    return;
  }

  res.statusCode = 404;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, status: "not_found" }));
});

server.listen(port, host, () => {
  console.log(`Hermes bridge local server listening on http://${host}:${port}`);
});
