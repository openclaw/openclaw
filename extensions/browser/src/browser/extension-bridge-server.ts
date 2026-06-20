// extension-bridge-server.ts — node-managed CDP bridge for the "extension"
// browser-control mode.
//
// Two faces on one loopback port:
//   • EXTENSION side (ws /extension): the OpenClaw Chrome extension dials in and
//     speaks the relay protocol (connect.challenge handshake + forwardCDPCommand
//     /forwardCDPEvent over chrome.debugger).
//   • PLAYWRIGHT side: presents a Chrome-DevTools browser-level CDP endpoint
//     (GET /json/version + ws /devtools/browser/<id>) that the browser engine's
//     existing-session/cdpUrl path connects to via chromium.connectOverCDP.
//
// Flow: gateway browser tool -> node existing-session -> connectOverCDP(this
// bridge) -> extension -> the user's real, logged-in tab.
//
// Ported from the proven sidecar prototype. The non-obvious bits (each load-
// bearing — removing any one reintroduced a node-killing crash or a hang):
//   1. Distinct child session per explicit Target.attachToTarget (newCDPSession):
//      reusing the auto-attach page id makes detaching the child dispose the
//      page's own CRSession -> page.goto hangs.
//   2. Dead-session guard: a late frame for a torn-down session orphans a
//      Playwright CRSession callback -> assert(!object.id) kills the process.
//   3. Browser-level session id for Target.attachToBrowserTarget: returning none
//      keys the browser session under undefined -> responses misroute -> assert.
//   4. Per-socket announce dedup + result-only attach replies: duplicate
//      Target.attachedToTarget makes CRBrowser assert "Duplicate target".

import http from "node:http";
import os from "node:os";
import { WebSocketServer, type WebSocket } from "ws";

const BROWSER_GUID = "openclaw-bridge-browser";
// Playwright calls Target.attachToBrowserTarget for a dedicated browser-level
// session; real Chrome returns a sessionId, so we must too.
const BROWSER_SESSION = "cb-browser";

const GONE =
  /no tab|no target|detached|no session|cannot access|no frame|target closed|not attached/i;

type ExtSessionId = string;
type TargetId = string;

interface TargetInfo {
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
}

interface TrackedTarget {
  sessionId: ExtSessionId;
  targetInfo: TargetInfo;
}

interface PwSocket extends WebSocket {
  _discover?: boolean;
  _autoAttach?: boolean;
  _created?: Set<TargetId>;
  _attached?: Set<ExtSessionId>;
}

interface BridgeIdentity {
  /** Node id surfaced on /whoami so the extension can prefer node-integrated intakes. */
  nodeId?: string;
  /** True when the bridge is backed by a paired node (inherits node trust). */
  nodeIntegrated?: boolean;
}

export interface ExtensionBridgeHandle {
  /** Loopback cdpUrl an existing-session profile points at (http://127.0.0.1:<port>). */
  readonly cdpUrl: string;
  readonly port: number;
  /** Whether the extension is currently dialed in. */
  extensionConnected(): boolean;
  stop(): Promise<void>;
}

interface ExtMessage {
  type?: string;
  id?: number;
  method?: string;
  params?: any;
  result?: unknown;
  error?: unknown;
}

/**
 * Start a node-managed extension CDP bridge on a loopback port.
 * Returns a handle whose cdpUrl an "extension" browser profile attaches to.
 */
export function startExtensionBridgeServer(opts: {
  port: number;
  host?: string;
  /**
   * Configured gateway auth token. When set, the extension relay handshake must
   * present a matching HMAC (see the extension's deriveRelayToken) on the
   * /extension?token= query or the connection is rejected, so a local process
   * without the token cannot impersonate the extension. Omitted on a tokenless
   * loopback gateway, where the bridge stays trusted-local.
   */
  authToken?: string;
  identity?: BridgeIdentity;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /**
   * Originate a node-attributed agent turn from a side-panel message. Wired to
   * the node-host's authenticated event emitter so the gateway records this
   * node as the turn's host (enabling gateway.tools.byNode). Absent when the
   * bridge is not running inside a paired node-host.
   */
  onAgentRequest?: (payload: { message: string; sessionKey?: string }) => Promise<void>;
}): Promise<ExtensionBridgeHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;
  const log = opts.logger?.info ?? (() => {});
  const warn = opts.logger?.warn ?? (() => {});

  // ---- extension side -------------------------------------------------------
  let ext: WebSocket | null = null;
  let extCmdId = 1;
  const extPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  // targetId -> { sessionId (extension cb-tab-N), targetInfo }
  const targets = new Map<TargetId, TrackedTarget>();
  // sessions known dead (target gone); never relay their frames to Playwright.
  const deadSessions = new Set<ExtSessionId>();
  // explicit-attach child session id -> underlying extension session id
  const childSessions = new Map<string, ExtSessionId>();
  let childCounter = 0;
  const pwSockets = new Set<PwSocket>();

  function killSession(sessionId: ExtSessionId | undefined, reason?: string): void {
    if (!sessionId || deadSessions.has(sessionId)) return;
    deadSessions.add(sessionId);
    for (const [tid, t] of targets.entries()) if (t.sessionId === sessionId) targets.delete(tid);
    for (const ws of pwSockets) {
      if (ws.readyState === 1 && ws._attached && ws._attached.has(sessionId)) {
        ws._attached.delete(sessionId);
        ws.send(
          JSON.stringify({
            method: "Target.detachedFromTarget",
            params: { sessionId, reason: reason || "target_closed" },
          }),
        );
      }
    }
  }

  function extSend(obj: unknown): void {
    if (ext && ext.readyState === 1) ext.send(JSON.stringify(obj));
  }

  // send a CDP command to a tab via the extension, await the result
  function extCdp(method: string, params: unknown, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!ext || ext.readyState !== 1) return reject(new Error("extension not connected"));
      const id = extCmdId++;
      const timer = setTimeout(() => {
        extPending.delete(id);
        reject(new Error("cdp timeout: " + method));
      }, 30_000);
      extPending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      extSend({
        id,
        method: "forwardCDPCommand",
        params: { method, params: params || {}, sessionId },
      });
    });
  }

  function pwBroadcast(obj: unknown): void {
    const s = JSON.stringify(obj);
    for (const ws of pwSockets) if (ws.readyState === 1) ws.send(s);
  }

  // Announce a target to ONE Playwright socket — exactly once each for
  // targetCreated (discovery on) and attachedToTarget (autoAttach on). A
  // duplicate attachedToTarget makes Playwright recreate the CRSession and
  // orphan in-flight callbacks -> assert. Dedup is mandatory.
  function announceTo(ws: PwSocket, tid: TargetId): void {
    const t = targets.get(tid);
    if (!t || ws.readyState !== 1 || deadSessions.has(t.sessionId)) return;
    const ti: TargetInfo = { ...t.targetInfo, targetId: tid, type: "page" };
    if (ws._discover && !ws._created!.has(tid)) {
      ws._created!.add(tid);
      ws.send(
        JSON.stringify({
          method: "Target.targetCreated",
          params: { targetInfo: { ...ti, attached: !!ws._autoAttach } },
        }),
      );
    }
    if (ws._autoAttach && !ws._attached!.has(t.sessionId)) {
      ws._attached!.add(t.sessionId);
      ws.send(
        JSON.stringify({
          method: "Target.attachedToTarget",
          params: { sessionId: t.sessionId, targetInfo: ti, waitingForDebugger: false },
        }),
      );
    }
  }

  // ---- HTTP (discovery + /whoami intake) ------------------------------------
  const server = http.createServer((req, res) => {
    // Browser-extension service workers reach this loopback intake cross-origin
    // (chrome-extension:// -> http://127.0.0.1) and across a private-network
    // boundary. Current Chrome enforces Private Network Access: without CORS +
    // an Access-Control-Allow-Private-Network ack it silently blocks the
    // discovery probe (the fetch hangs) and the relay never connects. Node-side
    // callers (Playwright connectOverCDP, curl) are not subject to PNA, so this
    // only bites the extension path.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "HEAD" || (req.method === "GET" && req.url === "/")) {
      res.writeHead(200);
      // HEAD must not carry a body or clients wait on the framing.
      return res.end(req.method === "HEAD" ? undefined : "cdp-bridge up");
    }
    if (req.method === "GET" && req.url === "/whoami") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          service: "openclaw-browser-intake",
          version: "1.0.0",
          port,
          host: os.hostname(),
          nodeId: opts.identity?.nodeId,
          nodeIntegrated: opts.identity?.nodeIntegrated ?? false,
        }),
      );
    }
    if (req.method === "GET" && (req.url === "/json/version" || req.url === "/json/version/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          Browser: "Chrome/OpenClaw-Bridge",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://${host}:${port}/devtools/browser/${BROWSER_GUID}`,
        }),
      );
    }
    if (req.method === "GET" && (req.url === "/json" || req.url === "/json/list")) {
      res.writeHead(200, { "content-type": "application/json" });
      const list = [...targets.entries()].map(([targetId, t]) => ({
        id: targetId,
        type: "page",
        title: t.targetInfo?.title || "",
        url: t.targetInfo?.url || "about:blank",
        webSocketDebuggerUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
      }));
      return res.end(JSON.stringify(list));
    }
    res.writeHead(404);
    res.end("nope");
  });

  // ---- WebSocket routing ----------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const url = req.url || "";
      if (url === "/extension" || url.startsWith("/extension?")) validateAndHandleExtension(ws, url);
      else if (url.startsWith("/devtools/browser/")) handlePwBrowser(ws as PwSocket);
      else ws.close();
    });
  });

  // Gate the extension relay on the configured gateway token. The extension
  // dials /extension?token=HMAC-SHA256(gatewayToken, "openclaw-extension-relay-v1:"
  // + port) (see deriveRelayToken). When a token is configured we require a
  // matching HMAC; with none configured the loopback bridge stays trusted-local.
  function validateAndHandleExtension(ws: WebSocket, reqUrl: string): void {
    if (!opts.authToken) {
      handleExtension(ws);
      return;
    }
    let provided = "";
    try {
      provided = new URL(reqUrl, "ws://" + host + ":" + port).searchParams.get("token") || "";
    } catch {
      provided = "";
    }
    void verifyRelayToken(opts.authToken, port, provided)
      .then((ok) => {
        if (ok) {
          handleExtension(ws);
          return;
        }
        warn("extension relay token rejected");
        try {
          ws.close(1008, "unauthorized");
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
  }

  // Recompute the extension's deriveRelayToken HMAC server-side and compare in
  // constant time. WebCrypto mirrors the extension exactly (same key + message).
  async function verifyRelayToken(authToken: string, p: number, provided: string): Promise<boolean> {
    if (!provided) return false;
    const enc = new TextEncoder();
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      enc.encode(authToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode("openclaw-extension-relay-v1:" + p));
    const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (provided.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  }

  // extension relay protocol
  function handleExtension(ws: WebSocket): void {
    ext = ws;
    log("extension connected");
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "bridge-" + BROWSER_GUID },
      }),
    );
    ws.on("message", (data) => {
      let m: ExtMessage;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.type === "req" && m.method === "connect") {
        ws.send(JSON.stringify({ type: "res", id: m.id, ok: true }));
        log("extension handshake ok");
        return;
      }
      // Side-panel turn → originate a node-attributed agent.request so the
      // gateway gates this turn's tools by the hosting node (gateway.tools.byNode).
      // The reply streams back over the side panel's own gateway subscription on
      // the same sessionKey, so the bridge only acks acceptance here.
      if (m.type === "req" && m.method === "agent.request") {
        const params = (m.params || {}) as { message?: unknown; sessionKey?: unknown };
        const message = typeof params.message === "string" ? params.message : "";
        const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : undefined;
        const failTurn = (error: string) =>
          ws.send(JSON.stringify({ type: "res", id: m.id, ok: false, error }));
        if (!message.trim()) return failTurn("message required");
        if (!opts.onAgentRequest) return failTurn("node agent routing unavailable");
        opts
          .onAgentRequest({ message, sessionKey })
          .then(() => ws.send(JSON.stringify({ type: "res", id: m.id, result: { ok: true } })))
          .catch((e: unknown) => failTurn(String((e as Error)?.message ?? e)));
        return;
      }
      if (m.method === "pong") return;
      if (m.method === "forwardCDPEvent") {
        const inner = m.params || {};
        if (inner.method === "Target.attachedToTarget") {
          const sid: ExtSessionId = inner.params?.sessionId;
          const ti: TargetInfo = inner.params?.targetInfo || {};
          const tid: TargetId = ti.targetId || sid;
          // Only real PAGE targets become Playwright pages. Workers, service-
          // workers, blob: docs and cross-origin iframes arrive as child
          // Target.attachedToTarget too; announcing them makes Playwright treat
          // each as a phantom page and the next snapshot hangs (~47s) on heavy
          // flows. Same-origin iframes are reached via the page's frame tree, so
          // skipping non-page targets loses nothing.
          const ttype = String(ti.type || "page");
          const turl = String(ti.url || "");
          if (ttype === "page" && !turl.startsWith("blob:")) {
            const known = targets.has(tid);
            targets.set(tid, { sessionId: sid, targetInfo: ti });
            if (!known) log("tab attached: " + (ti.url || ""));
            for (const pw of pwSockets) announceTo(pw, tid);
          } else {
            log("skip non-page target: " + ttype + " " + turl.slice(0, 40));
          }
        } else if (
          inner.method === "Target.detachedFromTarget" ||
          inner.method === "detachedFromTarget"
        ) {
          killSession(inner.params?.sessionId || inner.sessionId, "extension_detached");
        } else if (inner.sessionId) {
          if (deadSessions.has(inner.sessionId)) return;
          // page-level CDP event -> deliver to Playwright as a flat-session event
          pwBroadcast({ method: inner.method, params: inner.params, sessionId: inner.sessionId });
        }
        return;
      }
      if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined)) {
        const p = extPending.get(m.id);
        if (!p) return;
        extPending.delete(m.id);
        m.error ? p.reject(new Error(String(m.error))) : p.resolve(m.result);
      }
    });
    ws.on("close", () => {
      if (ext === ws) {
        ext = null;
        targets.clear();
      }
      log("extension disconnected");
    });
  }

  // Playwright browser-level CDP endpoint
  function handlePwBrowser(ws: PwSocket): void {
    ws._discover = false;
    ws._autoAttach = false;
    ws._created = new Set();
    ws._attached = new Set();
    pwSockets.add(ws);
    log("playwright connected");
    ws.on("message", async (data) => {
      let m: ExtMessage & { sessionId?: string };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      const { id, method, params, sessionId } = m;
      const browserLevel = !sessionId || sessionId === BROWSER_SESSION;
      // a child (newCDPSession) id resolves to its underlying extension session
      const extSid = (sessionId && childSessions.get(sessionId)) || sessionId;
      if (sessionId && !browserLevel && extSid && deadSessions.has(extSid)) return;
      const reply = (result?: unknown) => {
        if (sessionId && !browserLevel && extSid && deadSessions.has(extSid)) return;
        ws.send(JSON.stringify({ id, result: result || {}, sessionId }));
      };
      const fail = (msg: string, code?: number) =>
        ws.send(JSON.stringify({ id, error: { code: code || -32000, message: msg }, sessionId }));
      try {
        if (browserLevel) {
          if (method === "Target.attachToBrowserTarget")
            return reply({ sessionId: BROWSER_SESSION });
          if (method === "Browser.getVersion")
            return reply({
              protocolVersion: "1.3",
              product: "Chrome/OpenClaw-Bridge",
              userAgent: "OpenClaw-Bridge",
            });
          if (method === "Target.setDiscoverTargets") {
            ws._discover = !!(params && params.discover);
            reply({});
            if (ws._discover) for (const tid of targets.keys()) announceTo(ws, tid);
            return;
          }
          if (method === "Target.setAutoAttach") {
            ws._autoAttach = !!(params && params.autoAttach);
            reply({});
            if (ws._autoAttach) for (const tid of targets.keys()) announceTo(ws, tid);
            return;
          }
          if (method === "Target.setRemoteLocations") return reply({});
          if (method === "Target.getTargets")
            return reply({
              targetInfos: [...targets.entries()].map(([tid, t]) => ({
                ...t.targetInfo,
                targetId: tid,
                type: "page",
                attached: ws._attached!.has(t.sessionId),
              })),
            });
          if (method === "Target.attachToTarget") {
            const t = targets.get(params?.targetId);
            if (!t) return fail("no such target");
            // distinct child session (real Chrome behavior); the result sessionId
            // alone establishes it — no attachedToTarget event (CRBrowser dedupes
            // those by targetId and would assert "Duplicate target").
            const child = t.sessionId + "~" + ++childCounter;
            childSessions.set(child, t.sessionId);
            return reply({ sessionId: child });
          }
          if (method === "Target.detachFromTarget") {
            const sid = params && params.sessionId;
            if (sid && childSessions.has(sid)) {
              // detaching a child must NOT kill the underlying ext/page session
              childSessions.delete(sid);
              reply({});
              ws.send(
                JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: sid } }),
              );
              return;
            }
            return reply({});
          }
          if (method === "Target.createTarget")
            return reply(await extCdp("Target.createTarget", params));
          if (method === "Target.closeTarget")
            return reply(await extCdp("Target.closeTarget", params));
          return reply({}); // unknown browser-level method: best-effort ack
        }
        // flat-session (page) command -> forward to the extension's tab session
        return reply(await extCdp(method!, params, extSid));
      } catch (e: any) {
        const msg = String((e && e.message) || e);
        if (extSid && GONE.test(msg)) {
          // tab gone: answer with -32001 (Playwright ignores even if the callback
          // was torn down), then detach so no further frames orphan a callback.
          fail(msg, -32001);
          killSession(extSid, "target_gone");
          return;
        }
        return fail(msg);
      }
    });
    ws.on("close", () => {
      pwSockets.delete(ws);
      log("playwright disconnected");
    });
  }

  return new Promise<ExtensionBridgeHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      log(`extension bridge listening http://${host}:${port}`);
      resolve({
        cdpUrl: `http://${host}:${port}`,
        port,
        extensionConnected: () => !!ext && ext.readyState === 1,
        stop: () =>
          new Promise<void>((res) => {
            try {
              ext?.close();
            } catch {
              /* ignore */
            }
            for (const ws of pwSockets) {
              try {
                ws.close();
              } catch {
                /* ignore */
              }
            }
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}
