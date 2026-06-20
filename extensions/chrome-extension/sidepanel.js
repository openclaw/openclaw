import { getOrCreateIdentity, buildDeviceBlock } from "./device-identity.js";

const DEFAULT_GATEWAY = "http://127.0.0.1:18789";

// Local OpenClaw endpoints to probe when none is configured. An OpenClaw
// gateway (or a node exposing the operator endpoint) greets every WS with a
// `connect.challenge` event — that's the handshake signature we detect.
const DISCOVERY_CANDIDATES = [
  "ws://127.0.0.1:18789", // default gateway
  "ws://127.0.0.1:18799", // local copilot gateway
  "ws://127.0.0.1:18790", // node-local operator/relay endpoint
  "ws://127.0.0.1:18800", // node-local (clawd profile)
];

function probeOpenclaw(wsUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    let sock;
    const finish = (v) => {
      if (!done) {
        done = true;
        try {
          sock && sock.close();
        } catch {}
        resolve(v);
      }
    };
    try {
      sock = new WebSocket(wsUrl);
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m && m.type === "event" && m.event === "connect.challenge") {
          clearTimeout(timer);
          finish(true);
        }
      } catch {}
    };
    sock.onerror = () => {
      clearTimeout(timer);
      finish(false);
    };
    sock.onclose = () => {
      clearTimeout(timer);
      finish(false);
    };
  });
}

// Probe candidates in parallel; return the first that completes the handshake.
async function discoverEndpoint() {
  const results = await Promise.all(
    DISCOVERY_CANDIDATES.map(async (base) => ((await probeOpenclaw(base + "/")) ? base : null)),
  );
  const hit = results.find(Boolean);
  return hit ? hit.replace(/^ws/, "http") : null;
}

const CLIENT_ID = "webchat";
const CLIENT_MODE = "ui";
const ROLE = "operator";
const SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

const messagesEl = document.getElementById("messages");
const msgInput = document.getElementById("msg-input");
const sendBtn = document.getElementById("send-btn");
const wsDot = document.getElementById("ws-dot");
const wsLbl = document.getElementById("ws-lbl");
const tabDot = document.getElementById("tab-dot");
const tabLbl = document.getElementById("tab-lbl");
const ctxBtn = document.getElementById("ctx-btn");
const optBtn = document.getElementById("opt-btn");
const sessionPicker = document.getElementById("session-picker");

let ws = null;
let sessionKey = null;
let reqCounter = 0;
let pendingReqs = new Map();
let currentRunId = null;
let streamingEl = null;
let streamingText = "";
// Offset into the gateway's authoritative full text where the CURRENT bubble's
// segment begins (advanced at each tool-call boundary), and the last full text
// seen (to detect the gateway resetting/replacing its buffer).
let segStart = 0;
let lastFull = "";
let gatewayToken = "";
let reconnectTimer = null;
let reconnectAttempt = 0;
let cachedIdentity = null;

function debug(msg) {
  console.log("[copilot]", msg);
  const el = document.getElementById("debug");
  if (el) el.textContent = msg;
}

function setWsStatus(state, label) {
  wsDot.className = "dot " + state;
  wsLbl.textContent = label;
}

function generateId() {
  return "r-" + ++reqCounter + "-" + Math.random().toString(36).slice(2, 8);
}

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function sendReq(method, params) {
  return new Promise((resolve, reject) => {
    const id = generateId();
    const timer = setTimeout(() => {
      pendingReqs.delete(id);
      reject(new Error("Request timeout"));
    }, 30000);
    pendingReqs.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    sendWs({ type: "req", id, method, params });
  });
}

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  if (role === "system") {
    el.textContent = text;
  } else {
    el.innerHTML = renderText(text);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function renderText(text) {
  let s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => "<pre>" + code.trim() + "</pre>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Preserve the model's line/paragraph breaks instead of collapsing them into
  // one stacked block.
  s = s.replace(/\n/g, "<br>");
  return s;
}

async function connect() {
  const stored = await chrome.storage.local.get(["gatewayUrl", "gatewayToken"]);
  let gatewayUrl = stored.gatewayUrl;
  gatewayToken = stored.gatewayToken || "";

  // Zero-config: if no gateway is set, autodetect a local OpenClaw endpoint.
  if (!gatewayUrl) {
    setWsStatus("off", "Searching for OpenClaw…");
    const found = await discoverEndpoint();
    if (found) {
      gatewayUrl = found;
      debug("Discovered " + found);
    } else gatewayUrl = DEFAULT_GATEWAY;
  }

  const isLoopback = /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(gatewayUrl);
  // Loopback endpoints are trusted locally — a token isn't required (the local
  // gateway runs with loopback auth). Remote endpoints still need one.
  if (!gatewayToken) {
    if (isLoopback) {
      // Trusted loopback gateway runs with loopback auth: connect with no token
      // (auth is omitted below) rather than sending a fixed placeholder credential.
    } else {
      setWsStatus("err", "No token");
      addMessage(
        "system",
        "Gateway token not set. Open extension options (gear icon) and enter your gateway URL + token.",
      );
      return;
    }
  }

  const wsUrl = gatewayUrl.replace(/^http/, "ws") + "/";
  debug("Connecting to " + wsUrl.slice(0, 40) + "...");
  setWsStatus("off", "Connecting...");

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    setWsStatus("err", "Failed");
    addMessage("system", "Connection failed: " + err.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => setWsStatus("off", "Authenticating...");

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    setWsStatus("err", "Disconnected");
    scheduleReconnect();
  };

  ws.onerror = () => {
    setWsStatus("err", "Error");
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000) + Math.random() * 1000;
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function handleChallenge(payload) {
  const nonce = payload?.nonce || "";
  if (!cachedIdentity) {
    debug("Generating device identity...");
    cachedIdentity = await getOrCreateIdentity();
  }
  const identity = cachedIdentity;
  debug("Device: " + identity.deviceId.slice(0, 12) + "... signing challenge");
  const device = await buildDeviceBlock(identity, {
    clientId: CLIENT_ID,
    mode: CLIENT_MODE,
    role: ROLE,
    scopes: SCOPES,
    token: gatewayToken,
    nonce,
  });

  sendWs({
    type: "req",
    id: generateId(),
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 4,
      client: { id: CLIENT_ID, version: "1.0.0", platform: "chrome-extension", mode: CLIENT_MODE },
      role: ROLE,
      scopes: SCOPES,
      // Opt in to tool-call events so the panel can show each browser step and
      // split inter-tool commentary into its own message.
      caps: ["tool-events"],
      commands: [],
      device,
      auth: gatewayToken ? { token: gatewayToken } : undefined,
    },
  });
}

function handleMessage(msg) {
  if (msg.type === "event" && msg.event === "connect.challenge") {
    handleChallenge(msg.payload).catch((err) => {
      console.warn("Challenge handling failed:", err);
      setWsStatus("err", "Auth failed");
    });
    return;
  }

  if (msg.type === "res" && msg.ok && msg.payload?.type === "hello-ok") {
    reconnectAttempt = 0;
    const scopes = msg.payload.auth?.scopes?.join(",") || "none";
    debug("Connected. Scopes: " + scopes);
    setWsStatus("ok", "Connected");
    messagesEl.innerHTML = "";
    handleHelloOk(msg.payload);
    return;
  }

  if (msg.type === "res" && !msg.ok) {
    const code = msg.error?.code || "";
    const errMsg = msg.error?.message || "Unknown error";

    if (code === "NOT_PAIRED" || code === "PAIRING_REQUIRED") {
      setWsStatus("off", "Pairing...");
      if (!document.querySelector(".pairing-msg")) {
        const el = addMessage(
          "system",
          "Device not yet paired. Approve on the gateway — auto-retrying...",
        );
        el.classList.add("pairing-msg");
      }
      setTimeout(() => {
        if (ws) ws.close();
        connect();
      }, 5000);
      return;
    }

    if (msg.id && pendingReqs.has(msg.id)) {
      const p = pendingReqs.get(msg.id);
      pendingReqs.delete(msg.id);
      p.reject(new Error(errMsg));
      return;
    }

    setWsStatus("err", code || "Error");
    addMessage("system", "Error: " + errMsg);
    return;
  }

  if (msg.type === "res" && msg.ok && msg.id) {
    const p = pendingReqs.get(msg.id);
    if (p) {
      pendingReqs.delete(msg.id);
      p.resolve(msg.payload);
    }
    return;
  }

  if (msg.type === "event" && msg.event === "chat") {
    handleChatEvent(msg.payload);
    return;
  }

  if (msg.type === "event" && msg.event === "agent") {
    handleAgentEvent(msg.payload);
    return;
  }
}

let mainSessionKey = null;

// Per-tab session isolation: each attached tab gets its OWN agent conversation
// session, keyed DETERMINISTICALLY off the tab id so reattaching the same tab
// (or reloading the panel) resumes the same thread. The gateway rejects an
// unknown key on send ("session not found"), so before a tab's first send we
// ensure the keyed session exists via sessions.create (a no-op resume if it
// already does). No client-side storage is needed — the key IS the identity.
function baseSessionKey() {
  if (!mainSessionKey) return null;
  // Thread off the base agent key, stripping any existing :thread:... suffix.
  const i = mainSessionKey.indexOf(":thread:");
  return i === -1 ? mainSessionKey : mainSessionKey.slice(0, i);
}

function perTabSessionKey() {
  const base = baseSessionKey();
  if (!base || !pinnedTabId) return base;
  return base + ":thread:tab-" + pinnedTabId;
}

// Bind this panel to its pinned tab's deterministic session (when both the
// gateway hello and the pinned tab are known — either can arrive first).
function bindTabSession() {
  const key = perTabSessionKey();
  if (key && pinnedTabId) sessionKey = key;
}

// Idempotently ensure the keyed session exists on the gateway before sending to
// it. sessions.create with an explicit key creates it, or resumes if present
// (we swallow an "already exists" style error either way).
async function ensureSession(key) {
  if (!key) return;
  try {
    await sendReq("sessions.create", { key });
  } catch (e) {
    if (!/exist|in use|already/i.test(e?.message || "")) throw e;
  }
}

// Bind the gateway's "current tab" to THIS panel's pinned tab right before a
// turn, so the agent's browser tool drives this tab — not whichever tab the
// profile happened to touch last. Uses a no-op tab focus (sets
// profileState.lastTargetId without navigating). The pinned tab's CDP targetId
// is resolved by the background relay (which owns the attached-tabs map).
async function focusPinnedTab() {
  if (!pinnedTabId) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: "getTargetId", tabId: pinnedTabId });
    const targetId = r && r.targetId;
    if (targetId) {
      await sendReq("browser.request", { method: "POST", path: "/tabs/focus", body: { targetId } });
    }
  } catch {
    // Best-effort: if focus fails, the turn still runs against the default tab.
  }
}

async function handleHelloOk(payload) {
  const snapshot = payload.snapshot || {};
  const sd = snapshot.sessionDefaults || {};
  mainSessionKey = sd.mainSessionKey || null;
  // Default this panel to its pinned tab's own (deterministic) session.
  bindTabSession();

  try {
    const result = await sendReq("sessions.list", {});
    const sessions = result?.sessions || result || [];
    sessionPicker.innerHTML = '<option value="new">+ New session</option>';
    if (Array.isArray(sessions)) {
      for (const s of sessions.slice(0, 20)) {
        const key = s.key || s.sessionKey || "";
        const label = s.label || s.description || key.split(":").pop() || key;
        if (key) {
          const opt = document.createElement("option");
          opt.value = key;
          opt.textContent = label.slice(0, 30);
          sessionPicker.appendChild(opt);
        }
      }
    }
  } catch {
    sessionPicker.innerHTML = '<option value="new">+ New session</option>';
    if (sd.mainSessionKey) {
      const opt = document.createElement("option");
      opt.value = sd.mainSessionKey;
      opt.textContent = "Main";
      sessionPicker.appendChild(opt);
    }
  }

  addMessage(
    "system",
    pinnedTabId && sessionKey
      ? "Connected — this tab has its own session (" + sessionKey.split(":").pop() + ")."
      : "Connected. Select a session or start a new one.",
  );
}

sessionPicker.addEventListener("change", async () => {
  if (sessionPicker.value === "new") {
    // "+ New session" = a fresh start for THIS tab: keep the deterministic
    // per-tab key but clear its thread history on the gateway (best-effort).
    sessionKey = perTabSessionKey();
    try {
      await sendReq("sessions.reset", { key: sessionKey });
    } catch {}
  } else {
    sessionKey = sessionPicker.value;
  }
  messagesEl.innerHTML = "";
  addMessage("system", sessionKey ? "Session ready." : "Ready.");
});

function friendlyToolName(name) {
  if (!name) return "tool";
  let n = String(name).replace(/^mcp__openclaw__/, "").replace(/^mcp__[^_]+__/, "");
  return n.replace(/_/g, " ");
}

function addStep(label) {
  const el = document.createElement("div");
  el.className = "msg step";
  el.textContent = "→ " + label;
  el.style.cssText =
    "font-size:11px;color:#888;font-style:italic;margin:3px 0 3px 4px;";
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Tool-call events arrive on the "agent" channel (we opt in via the
// `tool-events` cap). Each tool "start" is a boundary: finalize the current
// commentary bubble and show a step line, so the assistant's pre-tool and
// post-tool commentary become separate, persisted messages instead of one
// run-together blob.
function handleAgentEvent(payload) {
  if (!payload || payload.stream !== "tool") return;
  const data = payload.data || {};
  if (data.phase !== "start") return;
  if (streamingEl) streamingEl.classList.remove("streaming");
  streamingEl = null;
  // Post-tool commentary begins a fresh segment/bubble after this boundary.
  segStart = lastFull.length;
  addStep(friendlyToolName(data.toolName || data.name || (data.tool && data.tool.name)));
}

function handleChatEvent(payload) {
  if (!payload) return;
  const state = payload.state;

  if (state === "delta") {
    // Render from the gateway's AUTHORITATIVE full text (message.content[0].text)
    // sliced from segStart — this is idempotent, so the gateway re-flushing a
    // cumulative delta at a tool boundary can't duplicate text. The current
    // bubble shows full.slice(segStart); tool boundaries (handleAgentEvent)
    // advance segStart so post-tool commentary becomes a new bubble.
    const full =
      payload.message && payload.message.content && payload.message.content[0]
        ? payload.message.content[0].text
        : null;
    if (full == null) return;

    if (currentRunId !== payload.runId) {
      if (streamingEl) streamingEl.classList.remove("streaming");
      currentRunId = payload.runId;
      segStart = 0;
      lastFull = "";
      streamingEl = null;
    }

    // The gateway reset its buffer (a `replace` / non-monotonic restart) when
    // the new full no longer extends what we last saw.
    if (!full.startsWith(lastFull)) {
      const curSeg = lastFull.slice(segStart);
      if (curSeg && full.startsWith(curSeg)) {
        // New buffer is a continuation of the CURRENT segment → keep the bubble,
        // rebase the offset to the start of this buffer.
        segStart = 0;
      } else {
        // Genuinely different content → finalize and start a fresh bubble.
        if (streamingEl) streamingEl.classList.remove("streaming");
        streamingEl = null;
        segStart = 0;
      }
    }
    lastFull = full;

    const segText = full.slice(segStart);
    if (!segText) return;
    if (!streamingEl) {
      streamingEl = addMessage("assistant", "");
      streamingEl.classList.add("streaming");
    }
    streamingText = segText;
    streamingEl.innerHTML = renderText(segText);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  if (state === "final" || state === "aborted" || state === "error") {
    if (streamingEl) {
      streamingEl.classList.remove("streaming");
      if (state === "error" && payload.errorMessage) {
        streamingText += "\n[Error: " + payload.errorMessage + "]";
        streamingEl.innerHTML = renderText(streamingText);
      }
    }
    streamingEl = null;
    streamingText = "";
    currentRunId = null;
    segStart = 0;
    lastFull = "";
    sendBtn.disabled = false;
    msgInput.disabled = false;
    msgInput.focus();
  }
}

// Live context for the model: which page the pinned tab is on RIGHT NOW. Sent
// as a preamble on every turn so the agent knows the current URL without a
// browser-tool round-trip — and so it won't re-navigate (reload) a page it is
// already on. Not shown in the chat bubble (the user's own text is).
async function tabContextPreamble() {
  if (!pinnedTabId) return "";
  try {
    const tab = await chrome.tabs.get(pinnedTabId);
    if (!tab || !tab.url) return "";
    const title = (tab.title || "").trim();
    return (
      "[Browser context: the active tab is currently on " +
      tab.url +
      (title ? " (" + title + ")" : "") +
      ". If the request is about this page, act on it directly — do NOT re-navigate to it (that reloads and loses state). Navigate only when a different page is needed.]\n\n"
    );
  } catch {
    return "";
  }
}

async function deliverTurn(text) {
  // Bind to this tab's deterministic session and make sure it exists on the
  // gateway before sending (idempotent create / resume).
  if (!sessionKey) bindTabSession();
  await ensureSession(sessionKey);
  // Bind the gateway's current tab to this panel's pinned tab so the turn drives
  // THIS tab rather than the profile-global last-touched tab.
  await focusPinnedTab();
  // Force-feed the live tab context so the agent knows where it already is.
  const sendText = (await tabContextPreamble()) + text;
  // Prefer routing THROUGH the node (node-originated agent.request) so the
  // gateway confines this turn's tools to the hosting node's policy
  // (gateway.tools.byNode). The reply streams back over this panel's gateway
  // subscription on the same sessionKey. Fall back to a direct gateway turn if
  // no node is hosting the bridge.
  let routedThroughNode = false;
  let nodeFallbackAllowed = true;
  try {
    const nodeRes = await chrome.runtime.sendMessage({ type: "nodeTurn", message: sendText, sessionKey });
    routedThroughNode = !!(nodeRes && nodeRes.ok);
    // Only fall back to a direct (unconfined) gateway turn when no node hosts
    // the bridge. If a node WAS hosting (a node-confined turn is expected) and
    // routing failed, fail closed rather than silently dropping the
    // gateway.tools.byNode confinement.
    if (nodeRes && nodeRes.ok === false && nodeRes.fallbackAllowed === false) {
      nodeFallbackAllowed = false;
    }
  } catch {
    // background/relay unavailable — fall through to a direct gateway turn.
  }
  if (!routedThroughNode) {
    if (!nodeFallbackAllowed) {
      addMessage(
        "system",
        "Couldn't reach the hosting node, so this node-confined turn was not sent (it would otherwise run with the unrestricted gateway tool surface). Reconnect the node and retry.",
      );
      return;
    }
    const result = await sendReq("sessions.send", {
      message: sendText,
      idempotencyKey: generateId(),
      key: sessionKey,
    });
    if (result?.runId) currentRunId = result.runId;
  }
}

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  msgInput.value = "";
  autoResize();
  addMessage("user", text);
  sendBtn.disabled = true;
  msgInput.disabled = true;

  try {
    await deliverTurn(text);
  } catch (err) {
    // Self-heal: if the keyed session went missing (e.g. the gateway was
    // restarted), ensureSession will recreate it — retry the turn once.
    if (/session not found/i.test(err?.message || "")) {
      try {
        await ensureSession(perTabSessionKey());
        await deliverTurn(text);
        return;
      } catch (err2) {
        err = err2;
      }
    }
    addMessage("system", "Send failed: " + (err?.message || err));
    sendBtn.disabled = false;
    msgInput.disabled = false;
  }
}

function autoResize() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
}

// Event listeners
sendBtn.addEventListener("click", sendMessage);
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
msgInput.addEventListener("input", autoResize);

optBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

ctxBtn.addEventListener("click", async () => {
  ctxBtn.disabled = true;
  ctxBtn.textContent = "...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "requestContext", tabId: pinnedTabId });
    if (res?.success && res.context) {
      await navigator.clipboard.writeText(res.context);
      ctxBtn.textContent = "Copied!";
      ctxBtn.classList.add("copied");
    } else {
      ctxBtn.textContent = res?.error || "No tab";
    }
  } catch {
    ctxBtn.textContent = "Error";
  }
  setTimeout(() => {
    ctxBtn.textContent = "Context";
    ctxBtn.classList.remove("copied");
    ctxBtn.disabled = false;
  }, 1500);
});

// Pin to the tab that was active when the side panel opened
let pinnedTabId = null;

async function pinToCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (
      tab?.id &&
      tab.url &&
      !tab.url.startsWith("chrome://") &&
      !tab.url.startsWith("chrome-extension://")
    ) {
      pinnedTabId = tab.id;
      tabDot.className = "dot ok";
      tabLbl.textContent = (tab.title || "").slice(0, 25) || new URL(tab.url).hostname;
      // Bind this tab's deterministic session (no-op until the gateway hello has
      // set mainSessionKey; handleHelloOk also calls bindTabSession).
      bindTabSession();
    }
  } catch {}
}

function refreshPinnedTab() {
  if (!pinnedTabId) return;
  chrome.tabs
    .get(pinnedTabId)
    .then((tab) => {
      if (tab) {
        tabLbl.textContent = (tab.title || "").slice(0, 25) || "Tab";
      } else {
        tabDot.className = "dot off";
        tabLbl.textContent = "Tab closed";
        pinnedTabId = null;
      }
    })
    .catch(() => {
      tabDot.className = "dot off";
      tabLbl.textContent = "Tab closed";
      pinnedTabId = null;
    });
}

pinToCurrentTab();
chrome.tabs.onUpdated?.addListener((id, info) => {
  if (id === pinnedTabId && (info.title || info.url)) refreshPinnedTab();
});

// Storage change listener
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.gatewayUrl || changes.gatewayToken)) {
    if (ws) ws.close();
    messagesEl.innerHTML = "";
    sessionKey = null;
    connect();
  }
});

// Boot
pinToCurrentTab();
connect();
