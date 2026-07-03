import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { resolveHermesBridgeConfig } from "../src/config.js";
import { createHermesBridgeHttpHandler } from "../src/http-route.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18789;
const TASK_ROUTE = "/api/plugins/hermes-bridge/tasks";

export const HERMES_BRIDGE_LOCAL_ALLOWED_TASKS = [
  "status.echo",
  "status.health",
  "message.preview",
  "tasks.organize_today",
  "agents.ask_team",
] as const;

type StartupParams = {
  host: string;
  port: number;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export function createLocalHealthPayload(params: Pick<StartupParams, "host" | "port">) {
  return {
    ok: true,
    status: "live",
    bridge: "hermes-bridge-local",
    host: params.host,
    port: params.port,
    dryRunDefault: true,
  };
}

export function buildStartupDiagnostics(params: StartupParams) {
  return {
    host: params.host,
    port: params.port,
    healthUrl: `http://${params.host}:${params.port}/healthz`,
    taskRoute: TASK_ROUTE,
    gatewayTokenConfigured: Boolean(params.env.OPENCLAW_GATEWAY_TOKEN),
    bridgeTokenConfigured: Boolean(params.env.OPENCLAW_HERMES_BRIDGE_TOKEN),
    dryRunDefault: true,
    allowedTasks: HERMES_BRIDGE_LOCAL_ALLOWED_TASKS,
  };
}

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_HERMES_BRIDGE_PORT ?? env.OPENCLAW_GATEWAY_PORT;
  const port = Number(raw ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      `Invalid Hermes bridge port "${raw}". Set OPENCLAW_HERMES_BRIDGE_PORT to a TCP port from 1 to 65535.`,
    );
  }
  return port;
}

const port = readPort(process.env);
const host = process.env.OPENCLAW_HERMES_BRIDGE_HOST ?? DEFAULT_HOST;

const config = resolveHermesBridgeConfig({
  enabled: true,
  mode: "mock",
  hermesMode: "real",
  sharedSecretEnv: "OPENCLAW_HERMES_BRIDGE_TOKEN",
  allowedTasks: [...HERMES_BRIDGE_LOCAL_ALLOWED_TASKS],
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
    res.end(JSON.stringify(createLocalHealthPayload({ host, port })));
    return;
  }

  if (req.url === TASK_ROUTE) {
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

function printStartupDiagnostics(): void {
  const diagnostics = buildStartupDiagnostics({ host, port, env: process.env });
  console.log(`Hermes bridge local server listening on http://${host}:${port}`);
  console.log(`Hermes bridge health: ${diagnostics.healthUrl}`);
  console.log(`Hermes bridge task route: ${diagnostics.taskRoute}`);
  console.log(`Hermes bridge dryRun default: ${diagnostics.dryRunDefault}`);
  console.log(`Hermes bridge allowed tasks: ${diagnostics.allowedTasks.join(", ")}`);
  if (!diagnostics.gatewayTokenConfigured) {
    console.warn("OPENCLAW_GATEWAY_TOKEN is not configured; task route requests will be rejected.");
  }
  if (!diagnostics.bridgeTokenConfigured) {
    console.warn("OPENCLAW_HERMES_BRIDGE_TOKEN is not configured; task route requests will fail closed.");
  }
}

function startServer(): void {
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Hermes bridge failed to start: ${host}:${port} is already in use. Stop the existing process or set OPENCLAW_HERMES_BRIDGE_PORT.`,
      );
      process.exitCode = 1;
      return;
    }
    console.error(`Hermes bridge failed to start: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, host, printStartupDiagnostics);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
