import {
  buildRelayWsUrl,
  isLastRemainingTab,
  isMissingTabError,
  isRetryableReconnectError,
  reconnectDelayMs,
} from "./background-utils.js";

// ---------------------------------------------------------------------------
// Zero-config bootstrap: if a bundled `config.local.json` ships with the
// extension, seed chrome.storage.local from it on install/startup so the
// extension is preconfigured (gatewayUrl, gatewayToken, relayPort, autoAttach)
// without touching the Options page. Only fills keys that aren't already set,
// so user overrides in Options always win. config.local.json is gitignored
// (it holds the gateway token) — ship a per-device copy, not in source.
// ---------------------------------------------------------------------------
async function seedConfigFromBundle() {
  try {
    const res = await fetch(chrome.runtime.getURL("config.local.json"));
    if (!res.ok) return;
    const cfg = await res.json();
    const keys = Object.keys(cfg || {});
    if (!keys.length) return;
    const cur = await chrome.storage.local.get(keys);
    const toSet = {};
    for (const k of keys) if (cur[k] === undefined) toSet[k] = cfg[k];
    if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  } catch {
    /* no bundled config — fall back to Options */
  }
}
chrome.runtime.onInstalled.addListener(() => void seedConfigFromBundle());
chrome.runtime.onStartup?.addListener(() => void seedConfigFromBundle());
void seedConfigFromBundle();

// ---------------------------------------------------------------------------
// Side panel + tab group: like Claude, clicking the icon creates a tab group
// and opens the side panel for tabs in that group.
// ---------------------------------------------------------------------------
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});

// Group ids live in chrome.storage.session, not SW memory: MV3 kills idle
// service workers (~30s), which would otherwise forget which tabs are ours.
async function getCopilotGroups() {
  const { copilotGroups = [] } = await chrome.storage.session.get("copilotGroups");
  return new Set(copilotGroups);
}

async function setCopilotGroups(groups) {
  await chrome.storage.session.set({ copilotGroups: [...groups] });
}

async function findLiveGroup(groups) {
  for (const gId of groups) {
    try {
      await chrome.tabGroups.get(gId);
      return gId;
    } catch {
      /* stale */
    }
  }
  return null;
}

async function addTabToCopilotGroup(tab) {
  const groups = await getCopilotGroups();
  const existingGroup = await findLiveGroup(groups);
  let groupId;
  if (existingGroup !== null && tab.groupId !== existingGroup) {
    groupId = existingGroup;
    await chrome.tabs.group({ tabIds: [tab.id], groupId });
  } else if (existingGroup !== null) {
    groupId = existingGroup;
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: "OpenClaw", color: "orange" });
  }
  groups.add(groupId);
  await setCopilotGroups(groups);
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  // sidePanel.open() must be issued synchronously while the click's user
  // gesture is alive — any await first and Chrome rejects it (silently broke
  // icon clicks on Chrome 149/macOS). Fire setOptions+open back-to-back
  // un-awaited (the browser processes them in order), bookkeeping after.
  chrome.sidePanel
    .setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true })
    .catch((err) => console.warn("Copilot setOptions failed:", err));
  chrome.sidePanel
    .open({ tabId: tab.id })
    .catch((err) => console.warn("Copilot open failed:", err));
  addTabToCopilotGroup(tab).catch((err) => console.warn("Copilot grouping failed:", err));
  // Opening the panel on a tab means "pilot this tab" — attach it so the agent
  // session immediately has control of it. Idempotent: never detach here (only
  // attach if not already attached), so re-opening the panel can't drop control.
  void whenReady(async () => {
    try {
      if (!tabs.has(tab.id)) await handleToggleAttach(tab.id);
    } catch (err) {
      console.warn(
        "Copilot attach-on-open failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  });
});

// Keyboard shortcut (Cmd/Ctrl+Shift+Y): attach/detach the active tab so the
// node's relay picks it up and the gateway's agent can pilot it. This is the
// user-facing trigger for the pilot relay (the side panel is chat-only).
chrome.commands.onCommand.addListener(
  (command) =>
    void whenReady(async () => {
      if (command !== "toggle-attach") return;
      try {
        const res = await handleToggleAttach();
        console.log("toggle-attach ->", res && res.attached ? "attached" : "detached");
      } catch (err) {
        console.warn("toggle-attach failed:", err instanceof Error ? err.message : String(err));
      }
    }),
);

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groups = await getCopilotGroups();
    if (groups.has(tab.groupId)) {
      await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  } catch {}
});

chrome.tabGroups.onRemoved?.addListener(async (group) => {
  try {
    const groups = await getCopilotGroups();
    if (groups.delete(group.id)) await setCopilotGroups(groups);
  } catch {}
});

// ---------------------------------------------------------------------------
// Strip frame-blocking headers so the gateway Control UI loads in the side
// panel iframe. Uses declarativeNetRequest dynamic rules scoped to sub_frame
// resource types (only affects iframes, not top-level navigation).
// ---------------------------------------------------------------------------
const FRAME_STRIP_RULE_ID = 1;

async function updateFrameStrippingRule() {
  const gatewayUrl = await getGatewayUrl();
  let hostname;
  try {
    hostname = new URL(gatewayUrl).hostname;
  } catch {
    return;
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [FRAME_STRIP_RULE_ID],
      addRules: [
        {
          id: FRAME_STRIP_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "X-Frame-Options", operation: "remove" },
              { header: "Content-Security-Policy", operation: "remove" },
            ],
          },
          condition: {
            urlFilter: `||${hostname}`,
            resourceTypes: ["sub_frame"],
          },
        },
      ],
    });
  } catch (err) {
    console.warn("Failed to update frame-stripping rule:", err);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.gatewayUrl) {
    void updateFrameStrippingRule();
  }
});

void updateFrameStrippingRule();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_PORT = 18792;

const BADGE = {
  on: { text: "ON", color: "#FF5A36" },
  off: { text: "", color: "#000000" },
  connecting: { text: "...", color: "#F59E0B" },
  error: { text: "!", color: "#B91C1C" },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {WebSocket|null} */
let relayWs = null;
// Whether the current/last connected relay intake is node-hosted (vs a
// gateway-only bridge). Used to fail closed on a failed node turn instead of
// silently running with the unrestricted gateway tool surface.
let relayNodeIntegrated = false;
/** @type {Promise<void>|null} */
let relayConnectPromise = null;
let relayGatewayToken = "";
/** @type {string|null} */
let relayConnectRequestId = null;

let nextSession = 1;

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map();
/** @type {Map<string, number>} */
const tabBySession = new Map();
/** @type {Map<string, number>} */
const childSessionToTab = new Map();

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map();

// Outbound request ids for side-panel turns routed through the node. Kept in a
// high range so they never collide with gateway/CDP request ids.
let nextNodeTurnId = 1_000_000;

// Per-tab operation locks prevent double-attach races.
/** @type {Set<number>} */
const tabOperationLocks = new Set();

// Tabs currently in a detach/re-attach cycle after navigation.
/** @type {Set<number>} */
const reattachPending = new Set();

// Reconnect state for exponential backoff.
let reconnectAttempt = 0;
let reconnectTimer = null;

// Last attach error for debugging via side panel status.
let lastAttachError = "";

const TAB_VALIDATION_ATTEMPTS = 2;
const TAB_VALIDATION_RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowStack() {
  try {
    return new Error().stack || "";
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function validateAttachedTab(tabId) {
  try {
    await chrome.tabs.get(tabId);
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < TAB_VALIDATION_ATTEMPTS; attempt++) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true,
      });
      return true;
    } catch (err) {
      if (isMissingTabError(err)) {
        return false;
      }
      if (attempt < TAB_VALIDATION_ATTEMPTS - 1) {
        await sleep(TAB_VALIDATION_RETRY_DELAY_MS);
      }
    }
  }

  return false;
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(["relayPort"]);
  const raw = stored.relayPort;
  const n = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT;
  return n;
}

async function getGatewayToken() {
  const stored = await chrome.storage.local.get(["gatewayToken"]);
  const token = String(stored.gatewayToken || "").trim();
  return token || "";
}

async function getAutoAttach() {
  const stored = await chrome.storage.local.get(["autoAttach"]);
  // Default to true if not explicitly set.
  return stored.autoAttach !== false;
}

async function getGatewayUrl() {
  const stored = await chrome.storage.local.get(["gatewayUrl"]);
  const url = String(stored.gatewayUrl || "").trim();
  return url || "http://127.0.0.1:18789";
}

async function getRelayHost() {
  // The node-owned CDP bridge is a local loopback intake (the bundled extension
  // drives the user's local Chrome), so the relay defaults to localhost rather
  // than the gateway's hostname (which may be a remote tunnel). An explicit
  // relayHost override is honored for advanced setups.
  const stored = await chrome.storage.local.get(["relayHost"]);
  return String(stored.relayHost || "").trim() || "127.0.0.1";
}

// Probe localhost for a node-local browser intake (the relay-driver). Prefer a
// node-integrated one (reports a nodeId) so browser control rides the local
// node, inheriting its trust — no separate gateway pairing for the browser.
const RELAY_DISCOVERY_PORTS = [18790, 18792, 18793, 18799];
async function discoverRelayIntake() {
  let fallback = null;
  for (const port of RELAY_DISCOVERY_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/whoami`, {
        signal: AbortSignal.timeout(800),
      });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.service === "openclaw-browser-intake") {
        const hit = {
          host: "127.0.0.1",
          port,
          nodeIntegrated: !!j.nodeIntegrated,
          nodeId: j.nodeId || null,
        };
        if (hit.nodeIntegrated) return hit; // node intake wins immediately
        if (!fallback) fallback = hit;
      }
    } catch {
      /* not listening here */
    }
  }
  return fallback;
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind];
  void chrome.action.setBadgeText({ tabId, text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color });
  void chrome.action.setBadgeTextColor({ tabId, color: "#FFFFFF" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Persistence: survive MV3 service worker restarts
// ---------------------------------------------------------------------------

async function persistState() {
  try {
    const tabEntries = [];
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === "connected" && tab.sessionId && tab.targetId) {
        tabEntries.push({
          tabId,
          sessionId: tab.sessionId,
          targetId: tab.targetId,
          attachOrder: tab.attachOrder,
        });
      }
    }
    await chrome.storage.session.set({
      persistedTabs: tabEntries,
      nextSession,
    });
  } catch {
    // chrome.storage.session may not be available in all contexts.
  }
}

async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(["persistedTabs", "nextSession"]);
    if (stored.nextSession) {
      nextSession = Math.max(nextSession, stored.nextSession);
    }
    const entries = stored.persistedTabs || [];
    // Phase 1: optimistically restore state and badges.
    for (const entry of entries) {
      tabs.set(entry.tabId, {
        state: "connected",
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        attachOrder: entry.attachOrder,
      });
      tabBySession.set(entry.sessionId, entry.tabId);
      setBadge(entry.tabId, "on");
    }
    // Phase 2: validate that tabs are still alive and debugger is responsive.
    for (const entry of entries) {
      const valid = await validateAttachedTab(entry.tabId);
      if (!valid) {
        tabs.delete(entry.tabId);
        tabBySession.delete(entry.sessionId);
        setBadge(entry.tabId, "off");
      }
    }
  } catch {
    // Ignore rehydration errors.
  }
}

// ---------------------------------------------------------------------------
// Relay WebSocket connection
// ---------------------------------------------------------------------------

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return;
  if (relayConnectPromise) return await relayConnectPromise;

  relayConnectPromise = (async () => {
    // With a configured gateway token we present its derived HMAC; when the
    // gateway runs with auth disabled there is no token and the relay URL is
    // tokenless (the node bridge accepts it only because it also has no token).
    const gatewayToken = await getGatewayToken();
    const stored = await chrome.storage.local.get(["relayPort"]);
    let port, relayHost;
    if (stored.relayPort) {
      // explicit config wins
      port = await getRelayPort();
      relayHost = await getRelayHost();
    } else {
      // zero-config: find the node-local intake
      const found = await discoverRelayIntake();
      if (found) {
        port = found.port;
        relayHost = found.host;
        console.log(
          `Discovered browser intake on :${port}` +
            (found.nodeIntegrated ? ` (node ${String(found.nodeId).slice(0, 12)})` : ""),
        );
      } else {
        port = await getRelayPort();
        relayHost = await getRelayHost();
      }
    }
    const isSecure = relayHost !== "127.0.0.1" && relayHost !== "localhost";
    const httpBase = `${isSecure ? "https" : "http"}://${relayHost}:${port}`;
    try {
      const who = await fetch(httpBase + "/whoami", { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
      relayNodeIntegrated = !!who.nodeIntegrated;
    } catch {
      /* keep last-known relayNodeIntegrated on probe failure */
    }
    const wsUrl = await buildRelayWsUrl(port, gatewayToken, relayHost);

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: "HEAD", signal: AbortSignal.timeout(2000) });
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`);
    }

    const ws = new WebSocket(wsUrl);
    relayWs = ws;
    relayGatewayToken = gatewayToken;
    // Bind message handler before open so an immediate first frame (for example
    // gateway connect.challenge) cannot be missed.
    ws.onmessage = (event) => {
      if (ws !== relayWs) return;
      void whenReady(() => onRelayMessage(String(event.data || "")));
    };

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("WebSocket connect failed"));
      };
      ws.onclose = (ev) => {
        clearTimeout(t);
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || "no reason"})`));
      };
    });

    // Bind permanent handlers. Guard against stale socket: if this WS was
    // replaced before its close fires, the handler is a no-op.
    ws.onclose = () => {
      if (ws !== relayWs) return;
      onRelayClosed("closed");
    };
    ws.onerror = () => {
      if (ws !== relayWs) return;
      onRelayClosed("error");
    };
  })();

  try {
    await relayConnectPromise;
    reconnectAttempt = 0;
    // Re-announce any already-attached tabs to the (re)connected relay.
    await reannounceAttachedTabs().catch(() => {});
  } finally {
    relayConnectPromise = null;
  }
}

// Relay closed -- update badges, reject pending requests, auto-reconnect.
// Debugger sessions are kept alive so they survive transient WS drops.
function onRelayClosed(reason) {
  relayWs = null;
  relayGatewayToken = "";
  relayConnectRequestId = null;

  for (const [id, p] of pending.entries()) {
    pending.delete(id);
    p.reject(new Error(`Relay disconnected (${reason})`));
  }

  reattachPending.clear();

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === "connected") {
      setBadge(tabId, "connecting");
      void chrome.action.setTitle({
        tabId,
        title: "OpenClaw Browser Copilot: relay reconnecting...",
      });
    }
  }

  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const delay = reconnectDelayMs(reconnectAttempt);
  reconnectAttempt++;

  console.log(`Scheduling reconnect attempt ${reconnectAttempt} in ${Math.round(delay)}ms`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await ensureRelayConnection();
      reconnectAttempt = 0;
      console.log("Reconnected successfully");
      await reannounceAttachedTabs();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Reconnect attempt ${reconnectAttempt} failed: ${message}`);
      if (!isRetryableReconnectError(err)) {
        return;
      }
      scheduleReconnect();
    }
  }, delay);
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
}

// Re-announce all attached tabs to the relay after reconnect.
async function reannounceAttachedTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== "connected" || !tab.sessionId || !tab.targetId) continue;

    const valid = await validateAttachedTab(tabId);
    if (!valid) {
      tabs.delete(tabId);
      if (tab.sessionId) tabBySession.delete(tab.sessionId);
      setBadge(tabId, "off");
      void chrome.action.setTitle({
        tabId,
        title: "OpenClaw Browser Copilot (click to open panel)",
      });
      continue;
    }

    // Send fresh attach event to relay.
    let targetInfo;
    try {
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo")
      );
      targetInfo = info?.targetInfo;
    } catch {
      targetInfo = tab.targetId ? { targetId: tab.targetId } : undefined;
    }

    try {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      });

      setBadge(tabId, "on");
      void chrome.action.setTitle({
        tabId,
        title: "OpenClaw Browser Copilot: attached",
      });
    } catch {
      setBadge(tabId, "connecting");
      void chrome.action.setTitle({
        tabId,
        title: "OpenClaw Browser Copilot: relay reconnecting...",
      });
    }
  }

  await persistState();
}

// ---------------------------------------------------------------------------
// Relay send / request helpers
// ---------------------------------------------------------------------------

function sendToRelay(payload) {
  const ws = relayWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Relay not connected");
  }
  ws.send(JSON.stringify(payload));
}

function requestFromRelay(command) {
  const id = command.id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Relay request timeout (30s)"));
    }, 30000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      sendToRelay(command);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------------------------------------------------------------------------
// Gateway handshake
// ---------------------------------------------------------------------------

function ensureGatewayHandshakeStarted(payload) {
  if (relayConnectRequestId) return;
  const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : "";
  relayConnectRequestId = `ext-connect-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  sendToRelay({
    type: "req",
    id: relayConnectRequestId,
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-browser-copilot",
        version: "1.0.0",
        platform: "chrome-extension-copilot",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      commands: [],
      nonce: nonce || undefined,
      auth: relayGatewayToken ? { token: relayGatewayToken } : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Relay message handler
// ---------------------------------------------------------------------------

async function onRelayMessage(text) {
  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  // Gateway challenge -- start handshake.
  if (msg && msg.type === "event" && msg.event === "connect.challenge") {
    try {
      ensureGatewayHandshakeStarted(msg.payload);
    } catch (err) {
      console.warn(
        "gateway connect handshake start failed",
        err instanceof Error ? err.message : String(err),
      );
      relayConnectRequestId = null;
      const ws = relayWs;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, "gateway connect failed");
      }
    }
    return;
  }

  // Gateway connect response.
  if (msg && msg.type === "res" && relayConnectRequestId && msg.id === relayConnectRequestId) {
    relayConnectRequestId = null;
    if (!msg.ok) {
      const detail = msg?.error?.message || msg?.error || "gateway connect failed";
      console.warn("gateway connect handshake rejected", String(detail));
      const ws = relayWs;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, "gateway connect failed");
      }
    }
    return;
  }

  // Server ping -- respond with pong.
  if (msg && msg.method === "ping") {
    try {
      sendToRelay({ method: "pong" });
    } catch {
      // ignore
    }
    return;
  }

  // Pending request response.
  if (msg && typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(String(msg.error)));
    else p.resolve(msg.result);
    return;
  }

  // CDP command forwarded from the gateway.
  if (msg && typeof msg.id === "number" && msg.method === "forwardCDPCommand") {
    try {
      const result = await handleForwardCdpCommand(msg);
      sendToRelay({ id: msg.id, result });
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// CDP command routing
// ---------------------------------------------------------------------------

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId);
  if (direct) return { tabId: direct, kind: "main" };
  const child = childSessionToTab.get(sessionId);
  if (child) return { tabId: child, kind: "child" };
  return null;
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId;
  }
  return null;
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || "").trim();
  const params = msg?.params?.params || undefined;
  const sessionId = typeof msg?.params?.sessionId === "string" ? msg.params.sessionId : undefined;

  const bySession = sessionId ? getTabBySessionId(sessionId) : null;
  const targetId = typeof params?.targetId === "string" ? params.targetId : undefined;
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === "connected") return id;
      }
      return null;
    })();

  if (!tabId) throw new Error(`No attached tab for method ${method}`);

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId };

  if (method === "Runtime.enable") {
    try {
      await chrome.debugger.sendCommand(debuggee, "Runtime.disable");
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, "Runtime.enable", params);
  }

  if (method === "Target.createTarget") {
    // SECURITY (My Browser pilot mode): the agent is confined to the tab the
    // user explicitly attached. Never spawn a new tab — that would let the
    // session reach the user's other tabs (logged-in sessions live in the same
    // browser). Reuse the attached pilot tab and navigate it instead.
    const url = typeof params?.url === "string" ? params.url : "about:blank";
    let pilotTabId = null;
    for (const [id, t] of tabs.entries()) {
      if (t.state === "connected") {
        pilotTabId = id;
        break;
      }
    }
    if (!pilotTabId) {
      throw new Error("OpenClaw: no attached tab to pilot (open the side panel on a tab first)");
    }
    const pilot = tabs.get(pilotTabId);
    if (url && url !== "about:blank") {
      await chrome.debugger.sendCommand({ tabId: pilotTabId }, "Page.navigate", { url });
    }
    return { targetId: pilot.targetId };
  }

  if (method === "Target.closeTarget") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toClose = target ? getTabByTargetId(target) : tabId;
    if (!toClose) return { success: false };
    try {
      const allTabs = await chrome.tabs.query({});
      if (isLastRemainingTab(allTabs, toClose)) {
        console.warn("Refusing to close the last tab: this would kill the browser process");
        return { success: false, error: "Cannot close the last tab" };
      }
      await chrome.tabs.remove(toClose);
    } catch {
      return { success: false };
    }
    return { success: true };
  }

  if (method === "Target.activateTarget") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toActivate = target ? getTabByTargetId(target) : tabId;
    if (!toActivate) return {};
    const tab = await chrome.tabs.get(toActivate).catch(() => null);
    if (!tab) return {};
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {});
    return {};
  }

  const tabState = tabs.get(tabId);
  const mainSessionId = tabState?.sessionId;
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee;

  return await chrome.debugger.sendCommand(debuggerSession, method, params);
}

// ---------------------------------------------------------------------------
// Tab attach / detach
// ---------------------------------------------------------------------------

async function attachTab(tabId, opts = {}) {
  // Idempotency guard: re-attaching an already-connected tab would crash
  // Playwright on the gateway side with a Duplicate target error. If this tab
  // is already fully connected, return its existing connection unchanged.
  const existing = tabs.get(tabId);
  if (existing && existing.state === "connected" && existing.sessionId && existing.targetId) {
    return { sessionId: existing.sessionId, targetId: existing.targetId };
  }

  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  await chrome.debugger.sendCommand(debuggee, "Page.enable").catch(() => {});

  const info = /** @type {any} */ (
    await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo")
  );
  const targetInfo = info?.targetInfo;
  const targetId = String(targetInfo?.targetId || "").trim();
  if (!targetId) {
    throw new Error("Target.getTargetInfo returned no targetId");
  }

  const sid = nextSession++;
  const sessionId = `cb-tab-${sid}`;
  const attachOrder = sid;

  tabs.set(tabId, { state: "connected", sessionId, targetId, attachOrder });
  tabBySession.set(sessionId, tabId);
  void chrome.action.setTitle({
    tabId,
    title: "OpenClaw Browser Copilot: attached",
  });

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: "forwardCDPEvent",
      params: {
        method: "Target.attachedToTarget",
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    });
  }

  setBadge(tabId, "on");
  await persistState();

  return { sessionId, targetId };
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId);

  // Send detach events for child sessions first.
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      try {
        sendToRelay({
          method: "forwardCDPEvent",
          params: {
            method: "Target.detachedFromTarget",
            params: { sessionId: childSessionId, reason: "parent_detached" },
          },
        });
      } catch {
        // Relay may be down.
      }
      childSessionToTab.delete(childSessionId);
    }
  }

  // Send detach event for main session.
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      });
    } catch {
      // Relay may be down.
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId);
  tabs.delete(tabId);

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // May already be detached.
  }

  setBadge(tabId, "off");
  void chrome.action.setTitle({
    tabId,
    title: "OpenClaw Browser Copilot (click to open panel)",
  });

  await persistState();
}

// ---------------------------------------------------------------------------
// Debugger event / detach handlers
// ---------------------------------------------------------------------------

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId;
  if (!tabId) return;
  const tab = tabs.get(tabId);
  if (!tab?.sessionId) return;

  if (method === "Target.attachedToTarget" && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId);
  }

  if (method === "Target.detachedFromTarget" && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId));
  }

  try {
    sendToRelay({
      method: "forwardCDPEvent",
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    });
  } catch {
    // Relay may be down.
  }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId;
  if (!tabId) return;
  if (!tabs.has(tabId)) return;

  // User explicitly cancelled or DevTools replaced the connection.
  if (reason === "canceled_by_user" || reason === "replaced_with_devtools") {
    void detachTab(tabId, reason);
    return;
  }

  // Check if tab still exists -- distinguishes navigation from tab close.
  let tabInfo;
  try {
    tabInfo = await chrome.tabs.get(tabId);
  } catch {
    // Tab is gone (closed).
    void detachTab(tabId, reason);
    return;
  }

  if (tabInfo.url?.startsWith("chrome://") || tabInfo.url?.startsWith("chrome-extension://")) {
    void detachTab(tabId, reason);
    return;
  }

  if (reattachPending.has(tabId)) return;

  const oldTab = tabs.get(tabId);
  const oldSessionId = oldTab?.sessionId;
  const oldTargetId = oldTab?.targetId;

  if (oldSessionId) tabBySession.delete(oldSessionId);
  tabs.delete(tabId);
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId);
  }

  if (oldSessionId && oldTargetId) {
    try {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: oldSessionId, targetId: oldTargetId, reason: "navigation-reattach" },
        },
      });
    } catch {
      // Relay may be down.
    }
  }

  reattachPending.add(tabId);
  setBadge(tabId, "connecting");
  void chrome.action.setTitle({
    tabId,
    title: "OpenClaw Browser Copilot: re-attaching after navigation...",
  });

  // Extend re-attach window to ~7.7 s (5 attempts). SPAs and pages with heavy
  // JS can take >2.5 s before the Chrome debugger is attachable.
  const delays = [200, 500, 1000, 2000, 4000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await new Promise((r) => setTimeout(r, delays[attempt]));

    if (!reattachPending.has(tabId)) return;

    try {
      await chrome.tabs.get(tabId);
    } catch {
      reattachPending.delete(tabId);
      setBadge(tabId, "off");
      return;
    }

    const relayUp = relayWs && relayWs.readyState === WebSocket.OPEN;

    try {
      await attachTab(tabId, { skipAttachedEvent: !relayUp });
      reattachPending.delete(tabId);
      if (!relayUp) {
        setBadge(tabId, "connecting");
        void chrome.action.setTitle({
          tabId,
          title: "OpenClaw Browser Copilot: attached, waiting for relay reconnect...",
        });
      }
      return;
    } catch {
      // continue retries
    }
  }

  reattachPending.delete(tabId);
  setBadge(tabId, "off");
  void chrome.action.setTitle({
    tabId,
    title: "OpenClaw Browser Copilot: re-attach failed",
  });
}

// ---------------------------------------------------------------------------
// Page context capture (copilot feature)
// ---------------------------------------------------------------------------

async function capturePageContext(tabId) {
  let targetTabId = tabId;
  if (!targetTabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = active?.id;
  }
  if (!targetTabId) return null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: () => ({
        title: document.title,
        url: window.location.href,
        selection: window.getSelection()?.toString() || "",
        headings: Array.from(document.querySelectorAll("h1,h2,h3"))
          .slice(0, 20)
          .map((h) => h.textContent?.trim())
          .filter(Boolean),
        links: Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 15)
          .map((a) => ({ text: a.textContent?.trim()?.slice(0, 60), href: a.href }))
          .filter((l) => l.text),
        forms: Array.from(document.querySelectorAll("input,textarea,select"))
          .slice(0, 10)
          .map((el) => ({
            tag: el.tagName,
            type: el.type,
            name: el.name || el.id,
            value: el.value?.slice(0, 50),
          })),
        meta: document.querySelector('meta[name="description"]')?.content || "",
      }),
    });
    return result?.result || null;
  } catch {
    return null;
  }
}

/**
 * Format a CDP Accessibility.getFullAXTree response into a compact indented
 * text representation suitable for LLM consumption.
 */
function formatAxTree(axResponse) {
  if (!axResponse) return null;
  const nodes = axResponse.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return "(no accessibility tree)";

  const MAX_LEN = 3000;
  let output = "";
  let truncated = false;

  // Build a lookup of nodeId -> node for tree walking.
  /** @type {Map<string, any>} */
  const nodeById = new Map();
  for (const node of nodes) {
    if (node.nodeId) nodeById.set(node.nodeId, node);
  }

  // Find the root (first node, typically the document root).
  const root = nodes[0];
  if (!root) return "(no accessibility tree)";

  // Iterative depth-first traversal with indent tracking.
  /** @type {Array<{node: any, depth: number}>} */
  const stack = [{ node: root, depth: 0 }];

  while (stack.length > 0) {
    if (truncated) break;

    const { node, depth } = stack.pop();
    const role = node.role?.value || "";
    const name = node.name?.value || "";
    const value = node.value?.value || "";

    // Skip generic/none roles unless they have a meaningful name.
    if ((role === "none" || role === "generic") && !name) {
      // Still traverse children.
      const childIds = node.childIds || [];
      for (let i = childIds.length - 1; i >= 0; i--) {
        const child = nodeById.get(childIds[i]);
        if (child) stack.push({ node: child, depth });
      }
      continue;
    }

    // Build the line for this node.
    const indent = "  ".repeat(depth);
    let line = `${indent}[${role}]`;
    if (name) line += ` "${name}"`;
    if (value) line += ` (${value})`;
    line += "\n";

    if (output.length + line.length > MAX_LEN) {
      output += "...(truncated)\n";
      truncated = true;
      break;
    }
    output += line;

    // Push children in reverse order so the first child is processed first.
    const childIds = node.childIds || [];
    for (let i = childIds.length - 1; i >= 0; i--) {
      const child = nodeById.get(childIds[i]);
      if (child) stack.push({ node: child, depth: depth + 1 });
    }
  }

  return output.trimEnd() || "(no accessibility tree)";
}

/**
 * Format the captured page context into a markdown block for the side panel.
 */
function formatContextBlock(ctx) {
  if (!ctx) return "";
  let block = "## Current Tab\n";
  block += `**URL:** ${ctx.url}\n`;
  block += `**Title:** ${ctx.title}\n`;
  if (ctx.meta) block += `**Description:** ${ctx.meta}\n`;
  if (ctx.selection) block += `**Selected text:** ${ctx.selection}\n`;
  if (ctx.headings?.length) {
    block += "\n### Headings\n";
    block += ctx.headings.map((h) => `- ${h}`).join("\n");
  }
  if (ctx.links?.length) {
    block += "\n\n### Key Links\n";
    block += ctx.links.map((l) => `- [${l.text}](${l.href})`).join("\n");
  }
  if (ctx.forms?.length) {
    block += "\n\n### Form Fields\n";
    block += ctx.forms
      .map((f) => `- ${f.tag} ${f.type || ""} ${f.name} = "${f.value || ""}"`)
      .join("\n");
  }
  return block;
}

// ---------------------------------------------------------------------------
// Tab lifecycle listeners
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener(
  (tabId) =>
    void whenReady(() => {
      reattachPending.delete(tabId);
      if (!tabs.has(tabId)) return;
      const tab = tabs.get(tabId);
      if (tab?.sessionId) tabBySession.delete(tab.sessionId);
      tabs.delete(tabId);
      for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
        if (parentTabId === tabId) childSessionToTab.delete(childSessionId);
      }
      if (tab?.sessionId && tab?.targetId) {
        try {
          sendToRelay({
            method: "forwardCDPEvent",
            params: {
              method: "Target.detachedFromTarget",
              params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: "tab_closed" },
            },
          });
        } catch {
          // Relay may be down.
        }
      }
      void persistState();
    }),
);

chrome.tabs.onReplaced.addListener(
  (addedTabId, removedTabId) =>
    void whenReady(() => {
      const tab = tabs.get(removedTabId);
      if (!tab) return;
      tabs.delete(removedTabId);
      tabs.set(addedTabId, tab);
      if (tab.sessionId) {
        tabBySession.set(tab.sessionId, addedTabId);
      }
      for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
        if (parentTabId === removedTabId) {
          childSessionToTab.set(childSessionId, addedTabId);
        }
      }
      setBadge(addedTabId, "on");
      void persistState();
    }),
);

// ---------------------------------------------------------------------------
// Debugger listeners (registered at module scope so they work even when relay
// WebSocket is down).
// ---------------------------------------------------------------------------

chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)));
chrome.debugger.onDetach.addListener((...args) => void whenReady(() => onDebuggerDetach(...args)));

// ---------------------------------------------------------------------------
// Navigation badge refresh
// ---------------------------------------------------------------------------

chrome.webNavigation.onCompleted.addListener(
  ({ tabId, frameId }) =>
    void whenReady(() => {
      if (frameId !== 0) return;
      const tab = tabs.get(tabId);
      if (tab?.state === "connected") {
        setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? "on" : "connecting");
      }
    }),
);

// ---------------------------------------------------------------------------
// Auto-attach on tab switch
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(
  ({ tabId }) =>
    void whenReady(() => {
      const existing = tabs.get(tabId);
      if (existing?.state === "connected") {
        setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? "on" : "connecting");
      }
    }),
);

// ---------------------------------------------------------------------------
// MV3 keepalive via chrome.alarms
// ---------------------------------------------------------------------------

chrome.alarms.create("relay-keepalive", { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "relay-keepalive") return;
  await initPromise;

  if (tabs.size === 0) return;

  // Refresh badges (ephemeral in MV3).
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === "connected") {
      setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? "on" : "connecting");
    }
  }

  // If relay is down and no reconnect is in progress, trigger one.
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (!relayConnectPromise && !reconnectTimer) {
      console.log("Keepalive: WebSocket unhealthy, triggering reconnect");
      await ensureRelayConnection().catch(() => {
        if (!reconnectTimer) {
          scheduleReconnect();
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Rehydration on startup
// ---------------------------------------------------------------------------

const initPromise = rehydrateState();

initPromise.then(() => {
  if (tabs.size > 0) {
    ensureRelayConnection()
      .then(() => {
        reconnectAttempt = 0;
        return reannounceAttachedTabs();
      })
      .catch(() => {
        scheduleReconnect();
      });
  }
});

// Shared gate: all state-dependent handlers await this before accessing maps.
async function whenReady(fn) {
  await initPromise;
  return fn();
}

// ---------------------------------------------------------------------------
// Message handler (options page relay check + side panel communication)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  // Relay check handler for the options page.
  if (msg.type === "relayCheck") {
    const { url, token } = msg;
    const headers = token ? { "x-openclaw-relay-token": token } : {};
    fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(2000) })
      .then(async (res) => {
        const contentType = String(res.headers.get("content-type") || "");
        let json = null;
        if (contentType.includes("application/json")) {
          try {
            json = await res.json();
          } catch {
            json = null;
          }
        }
        sendResponse({ status: res.status, ok: res.ok, contentType, json });
      })
      .catch((err) => sendResponse({ status: 0, ok: false, error: String(err) }));
    return true;
  }

  // Side panel: get current extension status.
  if (msg.type === "getStatus") {
    handleGetStatus()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  // Side panel: capture page context for the active (or specified) tab.
  if (msg.type === "requestContext") {
    handleRequestContext(msg.tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, error: String(e) }));
    return true;
  }

  // Side panel: route a turn through the node as a node-originated agent.request
  // (over the relay/bridge socket), so the gateway gates the agent's tools by
  // this hosting node (gateway.tools.byNode). The reply streams back over the
  // side panel's own gateway connection on the same sessionKey. Resolves
  // ok:false (e.g. relay not connected / no node) so the panel can fall back to
  // a direct gateway turn.
  if (msg.type === "nodeTurn") {
    const id = nextNodeTurnId++;
    requestFromRelay({
      type: "req",
      id,
      method: "agent.request",
      params: { message: msg.message, sessionKey: msg.sessionKey },
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) =>
        sendResponse({
          ok: false,
          fallbackAllowed: !relayNodeIntegrated,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    return true;
  }

  // Side panel: resolve a tab's CDP targetId (used to focus the pinned tab).
  if (msg.type === "getTargetId") {
    const entry = tabs.get(msg.tabId);
    sendResponse({
      targetId: entry && entry.state === "connected" ? entry.targetId || null : null,
    });
    return true;
  }

  // Side panel: toggle attach on a tab.
  if (msg.type === "toggleAttach") {
    handleToggleAttach(msg.tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  // Side panel: update auto-attach setting.
  if (msg.type === "setAutoAttach") {
    chrome.storage.local
      .set({ autoAttach: !!msg.enabled })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  // Side panel: get all settings.
  if (msg.type === "getSettings") {
    handleGetSettings()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Message handler implementations
// ---------------------------------------------------------------------------

async function handleGetStatus() {
  const relayConnected = !!(relayWs && relayWs.readyState === WebSocket.OPEN);
  const autoAttach = await getAutoAttach();

  const attachedTabs = [];
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== "connected") continue;
    let url = "";
    let title = "";
    try {
      const info = await chrome.tabs.get(tabId);
      url = info.url || "";
      title = info.title || "";
    } catch {
      // Tab may have been closed.
    }
    attachedTabs.push({
      tabId,
      sessionId: tab.sessionId || "",
      url,
      title,
    });
  }

  return { relayConnected, attachedTabs, autoAttach, lastAttachError };
}

async function handleRequestContext(requestTabId) {
  let tabId = requestTabId;
  if (!tabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = active?.id;
  }
  if (!tabId) {
    return { success: false, error: "No active tab" };
  }

  const ctx = await capturePageContext(tabId);
  if (!ctx) {
    return { success: false, error: "Could not read page (restricted page?)" };
  }

  const context = formatContextBlock(ctx);
  return { success: true, context };
}

async function handleToggleAttach(requestTabId) {
  let tabId = requestTabId;
  if (!tabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = active?.id;
  }
  if (!tabId) {
    throw new Error("No active tab");
  }

  // If already attached, detach.
  if (tabs.has(tabId)) {
    await detachTab(tabId, "toggle");
    return { attached: false };
  }

  // Attach the debugger first (adds the tab to the map), then ensure the relay
  // is connected, then announce — this avoids a race where the inline announce
  // fires before the (autodetected) relay handshake completes.
  cancelReconnect();
  await attachTab(tabId, { skipAttachedEvent: true });
  try {
    await ensureRelayConnection();
  } catch {
    /* relay not available yet; reannounce-on-connect will catch it */
  }
  await reannounceAttachedTabs().catch(() => {});
  return { attached: true, tabId };
}

async function handleGetSettings() {
  const [gatewayUrl, relayPort, autoAttach] = await Promise.all([
    getGatewayUrl(),
    getRelayPort(),
    getAutoAttach(),
  ]);
  return { gatewayUrl, relayPort, autoAttach };
}
