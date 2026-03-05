import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const possiblePaths = [
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "..", ".env"),
  ];
  for (const envPath of possiblePaths) {
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf8");
        content.split("\n").forEach((line) => {
          const m = line.match(/^\s*([^#=]+)\s*=\s*(.*)$/);
          if (m) {
            const key = m[1].trim();
            const val = m[2].trim().replace(/^['"](.*)['"]$/, "$1");
            if (!process.env[key]) process.env[key] = val;
          }
        });
        return envPath;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

const loadedEnv = loadEnv();

import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  isLoopbackAddress,
  isLoopbackHost,
  rawDataToString,
  resolveRelayAcceptedTokensForPort,
  resolveRelayAuthTokenForPort,
} from "./utils.js";
import { probeAuthenticatedOpenClawRelay } from "./extension-relay-auth.js";

const RELAY_AUTH_HEADER = "x-openclaw-relay-token";
const DEFAULT_EXTENSION_RECONNECT_GRACE_MS = 20_000;
const DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS = 3_000;

function headerValue(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function getHeader(req, name) {
  return headerValue(req.headers[name.toLowerCase()]);
}

function getRelayAuthTokenFromRequest(req, url) {
  const headerToken = getHeader(req, RELAY_AUTH_HEADER)?.trim();
  if (headerToken) return headerToken;
  const queryToken = url?.searchParams.get("token")?.trim();
  if (queryToken) return queryToken;
  return undefined;
}

function parseUrlPort(parsed) {
  const port = parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return port;
}

function parseBaseUrl(raw) {
  const parsed = new URL(raw.trim().replace(/\/$/, ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`extension relay cdpUrl must be http(s), got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const port = parseUrlPort(parsed);
  if (!port) {
    throw new Error(`extension relay cdpUrl has invalid port: ${parsed.port || "(empty)"}`);
  }
  return { host, port, baseUrl: parsed.toString().replace(/\/$/, "") };
}

function text(res, status, bodyText) {
  const body = Buffer.from(bodyText);
  res.write(
    `HTTP/1.1 ${status} ${status === 200 ? "OK" : "ERR"}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${body.length}\r\n` +
    "Connection: close\r\n" +
    "\r\n",
  );
  res.write(body);
  res.end();
}

function rejectUpgrade(socket, status, bodyText) {
  text(socket, status, bodyText);
  try { socket.destroy(); } catch { /* ignore */ }
}

function envMsOrDefault(name, fallback) {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const relayRuntimeByPort = new Map();
const relayInitByPort = new Map();

function isAddrInUseError(err) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE";
}

function relayAuthTokenForUrl(url) {
  try {
    const parsed = new URL(url);
    if (!isLoopbackHost(parsed.hostname)) return null;
    const port = parseUrlPort(parsed);
    if (!port) return null;
    const runtimeToken = relayRuntimeByPort.get(port)?.relayAuthToken;
    if (runtimeToken) return runtimeToken;
    try {
      return resolveRelayAuthTokenForPort(port);
    } catch { return null; }
  } catch { return null; }
}

export function getChromeExtensionRelayAuthHeaders(url) {
  const token = relayAuthTokenForUrl(url);
  if (!token) return {};
  return { [RELAY_AUTH_HEADER]: token };
}

export async function ensureChromeExtensionRelayServer(opts) {
  const info = parseBaseUrl(opts.cdpUrl);
  if (!isLoopbackHost(info.host)) {
    throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
  }

  const existing = relayRuntimeByPort.get(info.port);
  if (existing) return existing.server;

  const inFlight = relayInitByPort.get(info.port);
  if (inFlight) return await inFlight;

  const extensionReconnectGraceMs = envMsOrDefault("OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS", DEFAULT_EXTENSION_RECONNECT_GRACE_MS);
  let currentLockTab = !!opts.lockTab;
  console.log(`[browser/extension-relay] Relay starting on ${info.host}:${info.port} (lockTab=${currentLockTab})`);

  const initPromise = (async () => {
    const relayAuthToken = resolveRelayAuthTokenForPort(info.port);
    const relayAuthTokens = new Set(resolveRelayAcceptedTokensForPort(info.port));

    let extensionWs = null;
    const cdpClients = new Set();
    const connectedTargets = new Map();
    const extensionConnected = () => extensionWs?.readyState === WebSocket.OPEN;
    let extensionDisconnectCleanupTimer = null;
    const extensionReconnectWaiters = new Set();

    const flushExtensionReconnectWaiters = (connected) => {
      if (extensionReconnectWaiters.size === 0) return;
      const waiters = Array.from(extensionReconnectWaiters);
      extensionReconnectWaiters.clear();
      for (const waiter of waiters) waiter(connected);
    };

    const clearExtensionDisconnectCleanupTimer = () => {
      if (!extensionDisconnectCleanupTimer) return;
      clearTimeout(extensionDisconnectCleanupTimer);
      extensionDisconnectCleanupTimer = null;
    };

    const closeCdpClientsAfterExtensionDisconnect = () => {
      connectedTargets.clear();
      for (const client of cdpClients) {
        try { client.close(1011, "extension disconnected"); } catch { /* ignore */ }
      }
      cdpClients.clear();
      flushExtensionReconnectWaiters(false);
    };

    const scheduleExtensionDisconnectCleanup = () => {
      clearExtensionDisconnectCleanupTimer();
      extensionDisconnectCleanupTimer = setTimeout(() => {
        extensionDisconnectCleanupTimer = null;
        if (extensionConnected()) return;
        closeCdpClientsAfterExtensionDisconnect();
      }, extensionReconnectGraceMs);
    };

    const pendingExtension = new Map();
    let nextExtensionId = 1;

    const sendToExtension = async (payload) => {
      const ws = extensionWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Chrome extension not connected");
      ws.send(JSON.stringify(payload));
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingExtension.delete(payload.id);
          reject(new Error(`extension request timeout: ${payload.params.method}`));
        }, 30_000);
        pendingExtension.set(payload.id, { resolve, reject, timer });
      });
    };

    const broadcastToCdpClients = (evt) => {
      const msg = JSON.stringify(evt);
      for (const ws of cdpClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    };

    const sendResponseToCdp = (ws, res) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
    };

    const broadcastDetachedTarget = (target, targetId) => {
      broadcastToCdpClients({
        method: "Target.detachedFromTarget",
        params: { sessionId: target.sessionId, targetId: targetId ?? target.targetId },
        sessionId: target.sessionId,
      });
    };

    const routeCdpCommand = async (cmd) => {
      switch (cmd.method) {
        case "Browser.getVersion": return { protocolVersion: "1.3", product: "Chrome/OpenClaw-Extension-Relay", revision: "0", userAgent: "OpenClaw-Extension-Relay", jsVersion: "V8" };
        case "Browser.setDownloadBehavior": return {};
        case "Target.setAutoAttach":
        case "Target.setDiscoverTargets": return {};
        case "Target.getTargets": return { targetInfos: Array.from(connectedTargets.values()).map(t => ({ ...t.targetInfo, attached: true })) };
        case "Target.getTargetInfo": {
          const targetId = cmd.params?.targetId;
          if (targetId) {
            for (const t of connectedTargets.values()) { if (t.targetId === targetId) return { targetInfo: t.targetInfo }; }
          }
          if (cmd.sessionId && connectedTargets.has(cmd.sessionId)) return { targetInfo: connectedTargets.get(cmd.sessionId).targetInfo };
          return { targetInfo: Array.from(connectedTargets.values())[0]?.targetInfo };
        }
        case "Target.attachToTarget": {
          const targetId = cmd.params?.targetId;
          if (!targetId) throw new Error("targetId required");
          for (const t of connectedTargets.values()) { if (t.targetId === targetId) return { sessionId: t.sessionId }; }
          throw new Error("target not found");
        }
        default: {
          const id = nextExtensionId++;
          return await sendToExtension({ id, method: "forwardCDPCommand", params: { method: cmd.method, sessionId: cmd.sessionId, params: cmd.params } });
        }
      }
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", info.baseUrl);
      const path = url.pathname;
      const origin = getHeader(req, "origin");
      const isChromeExtensionOrigin = typeof origin === "string" && origin.startsWith("chrome-extension://");

      if (isChromeExtensionOrigin && origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }

      if (req.method === "OPTIONS") {
        if (origin && !isChromeExtensionOrigin) { res.writeHead(403); res.end("Forbidden"); return; }
        const requestedHeaders = (getHeader(req, "access-control-request-headers") ?? "").split(",").map(h => h.trim().toLowerCase()).filter(h => h.length > 0);
        const allowedHeaders = new Set(["content-type", RELAY_AUTH_HEADER, ...requestedHeaders]);
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin ?? "*",
          "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
          "Access-Control-Allow-Headers": Array.from(allowedHeaders).join(", "),
          "Access-Control-Max-Age": "86400",
          Vary: "Origin, Access-Control-Request-Headers",
        });
        res.end();
        return;
      }

      if (path.startsWith("/json")) {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) { res.writeHead(401); res.end("Unauthorized"); return; }
      }

      if (req.method === "HEAD" && path === "/") { res.writeHead(200); res.end(); return; }
      if (path === "/") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("OK"); return; }

      const hostHeader = req.headers.host?.trim() || `${info.host}:${info.port}`;
      const wsHost = `ws://${hostHeader}`;
      const cdpWsUrl = `${wsHost}/cdp`;

      if ((path === "/json/version" || path === "/json/version/") && (req.method === "GET" || req.method === "PUT")) {
        const payload = { Browser: "OpenClaw/extension-relay", "Protocol-Version": "1.3" };
        if (extensionConnected() || connectedTargets.size > 0) payload.webSocketDebuggerUrl = cdpWsUrl;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      if (path.match(/^\/json(\/list)?\/?$/) && (req.method === "GET" || req.method === "PUT")) {
        const list = Array.from(connectedTargets.values()).map(t => ({
          id: t.targetId,
          type: t.targetInfo.type ?? "page",
          title: t.targetInfo.title ?? "",
          url: t.targetInfo.url ?? "",
          webSocketDebuggerUrl: cdpWsUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    const wssExtension = new WebSocketServer({ noServer: true });
    const wssCdp = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", info.baseUrl);
      const pathname = url.pathname;
      if (!isLoopbackAddress(req.socket.remoteAddress)) { rejectUpgrade(socket, 403, "Forbidden"); return; }
      const origin = headerValue(req.headers.origin);
      if (origin && !origin.startsWith("chrome-extension://")) { rejectUpgrade(socket, 403, "Forbidden: invalid origin"); return; }

      if (pathname === "/extension") {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) { rejectUpgrade(socket, 401, "Unauthorized"); return; }
        wssExtension.handleUpgrade(req, socket, head, (ws) => wssExtension.emit("connection", ws, req));
      } else if (pathname === "/cdp") {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) { rejectUpgrade(socket, 401, "Unauthorized"); return; }
        wssCdp.handleUpgrade(req, socket, head, (ws) => wssCdp.emit("connection", ws, req));
      } else {
        rejectUpgrade(socket, 404, "Not Found");
      }
    });

    wssExtension.on("connection", (ws) => {
      extensionWs = ws;
      clearExtensionDisconnectCleanupTimer();
      flushExtensionReconnectWaiters(true);
      const pingId = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: "ping" })); }, 5000);

      ws.on("message", (data) => {
        if (extensionWs !== ws) return;
        let parsed;
        try { parsed = JSON.parse(rawDataToString(data)); } catch { return; }
        if (parsed?.id && typeof parsed.id === "number") {
          const pending = pendingExtension.get(parsed.id);
          if (pending) {
            pendingExtension.delete(parsed.id);
            clearTimeout(pending.timer);
            if (parsed.error) pending.reject(new Error(parsed.error));
            else pending.resolve(parsed.result);
          }
        } else if (parsed?.method === "forwardCDPEvent") {
          broadcastToCdpClients({ method: parsed.params.method, params: parsed.params.params, sessionId: parsed.params.sessionId });
          if (parsed.params.method === "Target.attachedToTarget") connectedTargets.set(parsed.params.params.sessionId, { sessionId: parsed.params.params.sessionId, targetId: parsed.params.params.targetInfo.targetId, targetInfo: parsed.params.params.targetInfo });
          else if (parsed.params.method === "Target.detachedFromTarget") connectedTargets.delete(parsed.params.params.sessionId);
        }
      });
      ws.on("close", () => { if (extensionWs === ws) { extensionWs = null; scheduleExtensionDisconnectCleanup(); clearInterval(pingId); } });
    });

    wssCdp.on("connection", (ws) => {
      cdpClients.add(ws);
      ws.on("message", async (data) => {
        let cmd;
        try { cmd = JSON.parse(rawDataToString(data)); } catch { return; }
        try { const res = await routeCdpCommand(cmd); sendResponseToCdp(ws, { id: cmd.id, result: res, sessionId: cmd.sessionId }); }
        catch (err) { sendResponseToCdp(ws, { id: cmd.id, error: { message: err.message }, sessionId: cmd.sessionId }); }
      });
      ws.on("close", () => cdpClients.delete(ws));
    });

    server.listen(info.port, info.host);
    return { host: info.host, port: info.port, baseUrl: info.baseUrl, cdpWsUrl: `ws://${info.host}:${info.port}/cdp`, stop: () => new Promise(resolve => server.close(resolve)) };
  })();

  relayInitByPort.set(info.port, initPromise);
  try { return await initPromise; } finally { relayInitByPort.delete(info.port); }
}

// CLI entry point
const isMain = process.argv[1]?.endsWith("extension-relay.js");
if (isMain) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 18792;
  ensureChromeExtensionRelayServer({ cdpUrl: `http://127.0.0.1:${port}` })
    .then(s => {
      const gatewayToken = process.env.MCP_WEB_ADAPTER_TOKEN || "default-token";
      console.log(`[standalone] Relay running at ${s.baseUrl}`);
      if (loadedEnv) console.log(`[standalone] Config loaded from: ${loadedEnv}`);
      console.log(`[standalone] CDP WebSocket: ${s.cdpWsUrl}`);
      console.log(`[standalone] --- Authentication ---`);
      console.log(`[standalone] Master Token (MCP_WEB_ADAPTER_TOKEN): ${gatewayToken === "default-token" ? "(using default-token)" : gatewayToken}`);
      console.log(`[standalone] Derived Extension Token: ${resolveRelayAuthTokenForPort(port)}`);
      console.log(`[standalone] -----------------------`);
      console.log(`[standalone] Set MCP config to use this cdpUrl.`);
    })
    .catch(e => { console.error("[standalone] Failed to start relay:", e); process.exit(1); });
}
