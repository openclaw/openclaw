/**
 * ws-bridge.ts — Multi-robot WebSocket bridge for OpenClaw robot kinematic plugin.
 *
 * Each viewer tab registers with {cmd:"register", robotId, instanceId}.
 * The bridge tracks every session and routes commands from the MCP tool.
 * HTTP GET /status returns live connection info (JSON).
 *
 * Port: 9877 (default, matches viewer)
 * Usage:
 *   bun        models/Plugin/src/ws-bridge.ts [port]
 *   node --import tsx models/Plugin/src/ws-bridge.ts [port]
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROBOTS_DIR = path.resolve(__dirname, "../robots");
const parsedPort = Number.parseInt(process.argv[2] ?? "", 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
  ? parsedPort
  : 9877;

// ── Robot config cache ───────────────────────────────────────────────────────

export interface RobotMeta {
  id: string;
  manufacturer: string;
  model: string;
  dof: number;
}

const robotConfigCache = new Map<string, RobotMeta>();

function loadRobotMeta(robotId: string): RobotMeta | null {
  if (robotConfigCache.has(robotId)) return robotConfigCache.get(robotId)!;
  const safeName = path.basename(robotId);
  const cfgPath  = path.join(ROBOTS_DIR, `${safeName}.json`);
  if (!existsSync(cfgPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    const meta: RobotMeta = {
      id:           String(raw["id"] ?? robotId),
      manufacturer: String(raw["manufacturer"] ?? "Unknown"),
      model:        String(raw["model"] ?? robotId),
      dof:          Number(raw["dof"] ?? 6),
    };
    robotConfigCache.set(robotId, meta);
    return meta;
  } catch {
    return null;
  }
}

export function listKnownRobots(): string[] {
  try {
    return readdirSync(ROBOTS_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("robot-config"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// ── Session registry ─────────────────────────────────────────────────────────

export interface ViewerSession {
  ws:          WebSocket;
  robotId:     string;
  instanceId:  string;
  connectedAt: number;
  lastSeen:    number;
  meta:        RobotMeta | null;
  joints:      number[];
}

// key = "<robotId>::<instanceId>"
const sessions = new Map<string, ViewerSession>();

// reply waiters: key -> queue of resolvers
const replyWaiters = new Map<string, Array<(data: string) => void>>();

export function sessionKey(robotId: string, instanceId: string): string {
  return `${robotId}::${instanceId}`;
}

export function getSessionsForRobot(robotId: string): ViewerSession[] {
  return [...sessions.values()].filter((s) => s.robotId === robotId);
}

export function getAllSessions(): ViewerSession[] {
  return [...sessions.values()];
}

// ── HTTP status endpoint ─────────────────────────────────────────────────────

function handleHttp(_req: IncomingMessage, res: ServerResponse): void {
  const connected = [...sessions.values()].map((s) => ({
    robotId:      s.robotId,
    instanceId:   s.instanceId,
    manufacturer: s.meta?.manufacturer ?? "?",
    model:        s.meta?.model ?? s.robotId,
    dof:          s.meta?.dof ?? 0,
    connectedAt:  new Date(s.connectedAt).toISOString(),
    lastSeen:     new Date(s.lastSeen).toISOString(),
    joints:       s.joints,
  }));
  const body = JSON.stringify(
    { connected, knownRobots: listKnownRobots(), totalSessions: connected.length },
    null,
    2,
  );
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// ── WebSocket server ─────────────────────────────────────────────────────────

const httpServer = createServer(handleHttp);
const wss = new WebSocketServer({ server: httpServer });

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err?.code === "EADDRINUSE") {
    console.warn(`[bridge] port ${PORT} already in use; reusing existing bridge process.`);
    return;
  }
  console.error(`[bridge] server error: ${err.message}`);
});

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const remote = req.socket.remoteAddress ?? "?";
  let session: ViewerSession | null = null;
  console.log(`[bridge] new connection from ${remote}`);

  ws.on("message", (raw) => {
    const text = raw.toString();
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text); } catch { return; }

    const cmd = String(msg["cmd"] ?? "");
    if (session) session.lastSeen = Date.now();

    // ── Register ─────────────────────────────────────────────────────────
    if (cmd === "register") {
      const robotId    = String(msg["robotId"]    ?? "unknown");
      const instanceId = String(msg["instanceId"] ?? `auto-${Date.now()}`);
      const key        = sessionKey(robotId, instanceId);

      if (sessions.has(key)) sessions.delete(key);

      const meta = loadRobotMeta(robotId);
      session = {
        ws, robotId, instanceId, meta,
        connectedAt: Date.now(), lastSeen: Date.now(), joints: [],
      };
      sessions.set(key, session);

      ws.send(JSON.stringify({
        cmd:            "registered",
        robotId,
        instanceId,
        configFound:    meta !== null,
        manufacturer:   meta?.manufacturer ?? "?",
        model:          meta?.model ?? robotId,
        dof:            meta?.dof ?? 6,
        totalConnected: sessions.size,
        knownRobots:    listKnownRobots(),
      }));
      console.log(
        `[bridge] registered  robot=${robotId}  instance=${instanceId}` +
        `  configFound=${meta !== null}  total=${sessions.size}`,
      );
      return;
    }

    // ── Update cached joints ──────────────────────────────────────────────
    if (session && (cmd === "joints" || cmd === "ok" || cmd === "movj_done") && Array.isArray(msg["joints"])) {
      session.joints = msg["joints"] as number[];
    }

    // ── Dispatch reply to waiting MCP caller ──────────────────────────────
    if (session) {
      const key      = sessionKey(session.robotId, session.instanceId);
      const robotKey = `robot::${session.robotId}`;

      for (const k of [key, robotKey, "any"]) {
        const waiters = replyWaiters.get(k);
        if (waiters && waiters.length > 0) {
          const resolve = waiters.shift()!;
          if (waiters.length === 0) replyWaiters.delete(k);
          resolve(text);
          return;
        }
      }
    }
  });

  ws.on("close", () => {
    if (session) {
      sessions.delete(sessionKey(session.robotId, session.instanceId));
      console.log(
        `[bridge] disconnected  robot=${session.robotId}  instance=${session.instanceId}` +
        `  remaining=${sessions.size}`,
      );
    }
  });

  ws.on("error", (err) => console.warn(`[bridge] ws error: ${err.message}`));
});

httpServer.listen(PORT, "127.0.0.1", () => {
  const robots = listKnownRobots();
  console.log(`[bridge] listening on ws://127.0.0.1:${PORT}`);
  console.log(`[bridge] status: http://127.0.0.1:${PORT}/status`);
  console.log(`[bridge] known configs: ${robots.length ? robots.join(", ") : "(none)"}`);
});

// ── Public send API ───────────────────────────────────────────────────────────

export interface SendOptions {
  robotId?:    string;
  instanceId?: string;
}

function resolveTargets(opts: SendOptions): ViewerSession[] {
  if (opts.robotId && opts.instanceId) {
    const s = sessions.get(sessionKey(opts.robotId, opts.instanceId));
    return s ? [s] : [];
  }
  if (opts.robotId) {
    return getSessionsForRobot(opts.robotId);
  }
  return getAllSessions();
}

/**
 * Send a command to one viewer and await its reply.
 * Targets: specific instance > first instance of robot > any connected viewer.
 */
export function sendToViewer(
  msg: unknown,
  opts: SendOptions = {},
  timeoutMs = 6000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const targets = resolveTargets(opts);
    if (targets.length === 0) {
      return reject(new Error(
        opts.robotId
          ? `No viewer connected for robot "${opts.robotId}". Open the viewer and click Connect.`
          : "No viewer connected. Open robot_kinematic_viewer.html and click Connect.",
      ));
    }

    const target = targets[0];
    const replyKey = opts.instanceId
      ? sessionKey(target.robotId, target.instanceId)
      : `robot::${target.robotId}`;

    const timer = setTimeout(() => {
      const ws = replyWaiters.get(replyKey);
      if (ws) { const i = ws.indexOf(wrapped); if (i >= 0) ws.splice(i, 1); }
      reject(new Error(`Reply timeout (${timeoutMs}ms) from ${replyKey}`));
    }, timeoutMs);

    const wrapped = (data: string) => { clearTimeout(timer); resolve(data); };
    if (!replyWaiters.has(replyKey)) replyWaiters.set(replyKey, []);
    replyWaiters.get(replyKey)!.push(wrapped);

    target.ws.send(JSON.stringify(msg), (err) => {
      if (err) {
        clearTimeout(timer);
        const ws = replyWaiters.get(replyKey);
        if (ws) { const i = ws.indexOf(wrapped); if (i >= 0) ws.splice(i, 1); }
        reject(new Error(`WS send error: ${err.message}`));
      }
    });
  });
}

/**
 * Broadcast a command to all instances of one robot (or ALL robots).
 * Fire-and-forget — no reply expected.
 */
export function broadcastToRobot(msg: unknown, opts: SendOptions = {}): void {
  const targets = resolveTargets(opts);
  const text = JSON.stringify(msg);
  for (const t of targets) {
    if (t.ws.readyState === WebSocket.OPEN) t.ws.send(text);
  }
}

/** Return a snapshot of all connected viewer sessions. */
export function getConnectionStatus(): object[] {
  return getAllSessions().map((s) => ({
    robotId:     s.robotId,
    instanceId:  s.instanceId,
    model:       s.meta ? `${s.meta.manufacturer} ${s.meta.model}` : s.robotId,
    dof:         s.meta?.dof ?? 0,
    joints:      s.joints,
    connectedAt: new Date(s.connectedAt).toISOString(),
  }));
}
