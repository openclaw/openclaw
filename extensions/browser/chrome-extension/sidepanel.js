// OpenClaw side-panel copilot: a chat client pinned to the active tab.
//
// The panel talks to the gateway over its OWN operator WebSocket (protocol v4,
// Ed25519 device identity) — the extension relay stays a pure CDP/tab-consent
// plane. Each pinned tab converses in its own deterministic gateway session
// (modules/panel-core.js), and browser actions run through the normal agent
// browser tool against the tab the user shared into the OpenClaw group.
import { buildDeviceBlock, getOrCreateIdentity } from "./device-identity.js";
import {
  applyChatDelta,
  applyToolBoundary,
  buildTabPreamble,
  createChatStream,
  deriveTabSessionKey,
  friendlyToolName,
  gatewayUrlFromRelayUrl,
  isLoopbackUrl,
  renderMarkdownLite,
  resetChatStream,
} from "./modules/panel-core.js";
import { reconnectDelayMs } from "./modules/relay-core.js";

const DEFAULT_GATEWAY = "http://127.0.0.1:18789";
// A chat side panel is a webchat surface: the gateway enums client.id/mode to
// known values, and "webchat" earns display-normalized chat.history plus
// silent local pairing on loopback (no manual device approval on the same host).
const CLIENT_ID = "webchat";
const CLIENT_MODE = "webchat";
const ROLE = "operator";
// Least privilege: read (events/history) + write (sessions.create/send). The
// panel never needs admin — "New chat" bumps the per-tab key generation
// instead of calling the admin-only sessions.reset.
const SCOPES = ["operator.read", "operator.write"];

const messagesEl = document.getElementById("messages");
const msgInput = document.getElementById("msg-input");
const sendBtn = document.getElementById("send-btn");
const wsDot = document.getElementById("ws-dot");
const wsLbl = document.getElementById("ws-lbl");
const tabLbl = document.getElementById("tab-lbl");
const shareBtn = document.getElementById("share-btn");
const newBtn = document.getElementById("new-btn");
const settingsBtn = document.getElementById("settings-btn");
const settingsEl = document.getElementById("settings");
const gatewayUrlInput = document.getElementById("gateway-url");
const gatewayTokenInput = document.getElementById("gateway-token");
const saveBtn = document.getElementById("save-btn");

let ws = null;
let gatewayToken = "";
let reqCounter = 0;
const pendingReqs = new Map();
let reconnectTimer = null;
let reconnectAttempt = 0;
let cachedIdentity = null;

let mainSessionKey = null;
let sessionKey = null;
let subscribedKey = null;
let pinnedTabId = null;

const stream = createChatStream();
let streamingEl = null;
let streamingText = "";

function setWsStatus(state, label) {
  wsDot.className = `dot ${state}`;
  wsLbl.textContent = label;
}

function generateId() {
  return `r-${++reqCounter}-${Math.random().toString(36).slice(2, 8)}`;
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
    }, 30_000);
    pendingReqs.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    });
    sendWs({ type: "req", id, method, params });
  });
}

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (role === "system" || role === "step") {
    el.textContent = text;
  } else {
    el.innerHTML = renderMarkdownLite(text);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

// ---------------------------------------------------------------------------
// Gateway connection
// ---------------------------------------------------------------------------

async function resolveGatewayUrl() {
  const stored = await chrome.storage.local.get(["gatewayUrl", "gatewayToken", "relayUrl"]);
  gatewayToken = typeof stored.gatewayToken === "string" ? stored.gatewayToken : "";
  if (typeof stored.gatewayUrl === "string" && stored.gatewayUrl) {
    return stored.gatewayUrl;
  }
  // A gateway-hosted relay pairing already names the gateway origin; reuse it
  // so remote setups need no second URL entry.
  const derived = gatewayUrlFromRelayUrl(stored.relayUrl);
  if (derived) {
    return derived.replace(/^ws/, "http");
  }
  return DEFAULT_GATEWAY;
}

async function connect() {
  const gatewayUrl = await resolveGatewayUrl();
  if (!gatewayToken && !isLoopbackUrl(gatewayUrl)) {
    setWsStatus("err", "No token");
    addMessage("system", "Remote gateway needs a token. Open settings (⚙) to set one.");
    return;
  }
  const wsUrl = `${gatewayUrl.replace(/^http/, "ws")}/`;
  setWsStatus("", "Connecting…");
  let sock;
  try {
    sock = new WebSocket(wsUrl);
  } catch {
    setWsStatus("err", "Failed");
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.addEventListener("open", () => setWsStatus("", "Authenticating…"));
  sock.addEventListener("message", (e) => {
    let msg;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    handleMessage(msg);
  });
  sock.addEventListener("close", () => {
    // A deliberately replaced socket (settings change) must not also
    // schedule a reconnect — only the CURRENT socket's close drives retry.
    if (ws === sock) {
      ws = null;
      // The subscription is per-socket state; the reconnect must resubscribe.
      subscribedKey = null;
      setWsStatus("err", "Disconnected");
      abandonInFlightTurn("Disconnected");
      scheduleReconnect();
    }
  });
}

// The composer only re-enables when a run's terminal chat event arrives, and a
// dead socket can never deliver one, so a drop mid-turn would lock input for
// good. Abandon the turn with the socket: fail waiting requests fast (the 30s
// timeout is the only other escape) and hand the composer back.
function abandonInFlightTurn(reason) {
  for (const [id, pending] of pendingReqs) {
    pendingReqs.delete(id);
    pending.reject(new Error(reason));
  }
  finalizeBubble();
  resetChatStream(stream);
  // Not for a tab that is gone: onRemoved closed the composer deliberately, and
  // handing it back would invite turns into a thread with no tab behind it.
  if (pinnedTabId != null) {
    setInputEnabled(true);
  }
}

// Null `ws` BEFORE close(): the close listener only retries for the CURRENT
// socket, so a deliberate replacement would otherwise race its own reconnect
// against this one. The subscription lives on the socket, so it dies with it.
function dropSocket() {
  const old = ws;
  ws = null;
  subscribedKey = null;
  // A retry scheduled by an earlier close would fire alongside the connect()
  // that follows this drop, leaving two live sockets.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  old?.close();
  abandonInFlightTurn("Disconnected");
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  const delay = reconnectDelayMs(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function handleChallenge(payload) {
  cachedIdentity ??= await getOrCreateIdentity();
  const device = await buildDeviceBlock(cachedIdentity, {
    clientId: CLIENT_ID,
    mode: CLIENT_MODE,
    role: ROLE,
    scopes: SCOPES,
    token: gatewayToken,
    nonce: payload?.nonce || "",
  });
  sendWs({
    type: "req",
    id: generateId(),
    method: "connect",
    params: {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: CLIENT_ID,
        version: chrome.runtime.getManifest().version,
        platform: "chrome-extension",
        mode: CLIENT_MODE,
      },
      role: ROLE,
      scopes: SCOPES,
      // Structured tool lifecycle events let the panel show each browser step
      // and split inter-tool commentary into separate bubbles.
      caps: ["tool-events"],
      commands: [],
      device,
      // The configured credential is the gateway's shared secret; the panel
      // cannot know whether the gateway runs token- or password-mode auth, so
      // send it under both fields (the gateway checks only the active one).
      auth: gatewayToken ? { token: gatewayToken, password: gatewayToken } : undefined,
    },
  });
}

function handleMessage(msg) {
  if (msg.type === "event" && msg.event === "connect.challenge") {
    handleChallenge(msg.payload).catch(() => setWsStatus("err", "Auth failed"));
    return;
  }
  if (msg.type === "res" && msg.ok && msg.payload?.type === "hello-ok") {
    reconnectAttempt = 0;
    setWsStatus("ok", "Connected");
    void handleHelloOk(msg.payload);
    return;
  }
  if (msg.type === "res" && !msg.ok) {
    const code = msg.error?.code || "";
    if (code === "NOT_PAIRED" || code === "PAIRING_REQUIRED") {
      setWsStatus("", "Pairing…");
      if (!document.querySelector(".pairing-msg")) {
        addMessage(
          "system",
          "Device not paired yet. Approve it on the gateway (openclaw devices) — retrying…",
        ).classList.add("pairing-msg");
      }
      setTimeout(() => {
        dropSocket();
        void connect();
      }, 5000);
      return;
    }
    if (msg.id && pendingReqs.has(msg.id)) {
      const p = pendingReqs.get(msg.id);
      pendingReqs.delete(msg.id);
      p.reject(new Error(msg.error?.message || "Request failed"));
      return;
    }
    setWsStatus("err", code || "Error");
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
  if (msg.type === "event" && (msg.event === "agent" || msg.event === "session.tool")) {
    handleToolEvent(msg.payload);
  }
}

async function handleHelloOk(payload) {
  mainSessionKey = payload.snapshot?.sessionDefaults?.mainSessionKey || null;
  try {
    await bindTabSession();
  } catch (err) {
    // The handshake already reported "Connected"; a failed bind would otherwise
    // leave the panel looking healthy over a session that never attached.
    const failure = err instanceof Error ? err.message : String(err);
    setWsStatus("err", "Session failed");
    addMessage("system", `Could not start this tab's conversation: ${failure}`);
  }
}

// ---------------------------------------------------------------------------
// Per-tab session binding
// ---------------------------------------------------------------------------

// Tab ids are per-browser-session, so the generation map lives in
// chrome.storage.session: it survives panel reloads (same tab resumes the
// same thread) and resets with the browser (when tab ids recycle anyway).
async function tabGeneration(tabId) {
  const stored = await chrome.storage.session.get(["tabSessionGen"]);
  return stored.tabSessionGen?.[tabId] ?? 0;
}

async function bumpTabGeneration(tabId) {
  const stored = await chrome.storage.session.get(["tabSessionGen"]);
  const map = stored.tabSessionGen ?? {};
  map[tabId] = (map[tabId] ?? 0) + 1;
  await chrome.storage.session.set({ tabSessionGen: map });
  return map[tabId];
}

async function bindTabSession() {
  if (!mainSessionKey || pinnedTabId == null) {
    return;
  }
  const generation = await tabGeneration(pinnedTabId);
  const key = deriveTabSessionKey(mainSessionKey, pinnedTabId, generation);
  if (!key) {
    return;
  }
  if (key === sessionKey) {
    // Same thread, new socket: the subscription died with the old one, so a
    // reconnect still has to resubscribe even though the key is unchanged.
    // subscribeSession() no-ops when it is already subscribed on this socket.
    await subscribeSession(key);
    return;
  }
  sessionKey = key;
  await ensureSession(key);
  await subscribeSession(key);
  await hydrateHistory(key);
}

// sessions.create with an explicit key adopts the session when it already
// exists, so this is a safe create-or-resume before the first send.
async function ensureSession(key) {
  try {
    const created = await sendReq("sessions.create", { key });
    // The gateway canonicalizes explicit keys; treat its echo as authoritative.
    if (typeof created?.key === "string" && created.key) {
      sessionKey = created.key;
    }
  } catch (e) {
    if (!/exist|in use|already/i.test(e?.message || "")) {
      throw e;
    }
  }
}

async function subscribeSession(key) {
  if (subscribedKey === key) {
    return;
  }
  if (subscribedKey) {
    sendReq("sessions.messages.unsubscribe", { key: subscribedKey }).catch(() => {});
    subscribedKey = null;
  }
  try {
    await sendReq("sessions.messages.subscribe", { key });
    // Only a CONFIRMED subscription may short-circuit the check above; recording
    // the key before the round trip would strand a failed attempt un-retryable.
    subscribedKey = key;
  } catch {
    // Streaming chat events still arrive via the broadcast chat stream.
  }
}

async function hydrateHistory(key) {
  messagesEl.innerHTML = "";
  resetChatStream(stream);
  streamingEl = null;
  try {
    const result = await sendReq("chat.history", { sessionKey: key, limit: 50 });
    const history = Array.isArray(result?.messages) ? result.messages : [];
    for (const message of history) {
      const role = message?.role === "user" ? "user" : "assistant";
      const text = (message?.content ?? [])
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
      if (text.trim()) {
        addMessage(role, text);
      }
    }
  } catch {
    // History is a nicety; an empty pane is fine for a fresh session.
  }
  addMessage("system", "This tab has its own conversation.");
}

// ---------------------------------------------------------------------------
// Streaming render
// ---------------------------------------------------------------------------

function finalizeBubble() {
  streamingEl?.classList.remove("streaming");
  streamingEl = null;
  streamingText = "";
}

function handleChatEvent(payload) {
  if (!payload || payload.sessionKey !== sessionKey) {
    return;
  }
  if (payload.state === "delta") {
    const update = applyChatDelta(stream, payload);
    if (!update) {
      return;
    }
    if (update.newBubble) {
      finalizeBubble();
    }
    if (!streamingEl) {
      streamingEl = addMessage("assistant", "");
      streamingEl.classList.add("streaming");
    }
    streamingText = update.segmentText;
    streamingEl.innerHTML = renderMarkdownLite(streamingText);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }
  if (payload.state === "final" || payload.state === "aborted" || payload.state === "error") {
    if (streamingEl && payload.state === "error" && payload.errorMessage) {
      streamingText += `\n[Error: ${payload.errorMessage}]`;
      streamingEl.innerHTML = renderMarkdownLite(streamingText);
    }
    finalizeBubble();
    resetChatStream(stream);
    setInputEnabled(true);
  }
}

// Tool lifecycle arrives as run-scoped `agent` events (we started the run) or
// session-scoped `session.tool` mirrors; the gateway never sends both to one
// connection. Each tool start is a bubble boundary plus a step line.
function handleToolEvent(payload) {
  if (!payload || payload.stream !== "tool" || payload.sessionKey !== sessionKey) {
    return;
  }
  const data = payload.data || {};
  if (data.phase !== "start") {
    return;
  }
  finalizeBubble();
  applyToolBoundary(stream);
  addMessage("step", `→ ${friendlyToolName(data.toolName || data.name)}`);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function setInputEnabled(enabled) {
  sendBtn.disabled = !enabled;
  msgInput.disabled = !enabled;
  if (enabled) {
    msgInput.focus();
  }
}

async function tabPreamble() {
  if (pinnedTabId == null) {
    return "";
  }
  try {
    const tab = await chrome.tabs.get(pinnedTabId);
    return buildTabPreamble(tab?.url, tab?.title);
  } catch {
    return "";
  }
}

async function deliverTurn(text) {
  await bindTabSession();
  if (!sessionKey) {
    throw new Error("Not connected yet");
  }
  await ensureSession(sessionKey);
  const message = (await tabPreamble()) + text;
  await sendReq("sessions.send", { message, key: sessionKey, idempotencyKey: generateId() });
}

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) {
    return;
  }
  // Say so rather than swallowing the turn: the composer is live while the
  // panel is reconnecting, so a silent no-op reads as the panel being broken.
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addMessage("system", "Not connected to the gateway yet — reconnecting.");
    return;
  }
  msgInput.value = "";
  autoResize();
  addMessage("user", text);
  setInputEnabled(false);
  try {
    await deliverTurn(text);
  } catch (err) {
    let failure = err;
    // Self-heal once: a gateway restart can drop the keyed session.
    if (/session not found/i.test(failure?.message || "")) {
      try {
        await ensureSession(sessionKey);
        await deliverTurn(text);
        return;
      } catch (retryErr) {
        failure = retryErr;
      }
    }
    addMessage("system", `Send failed: ${failure?.message || failure}`);
    setInputEnabled(true);
  }
}

// ---------------------------------------------------------------------------
// Pinned tab + consent (the OpenClaw tab group)
// ---------------------------------------------------------------------------

async function pinToCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (
    tab?.id !== undefined &&
    tab.url &&
    !tab.url.startsWith("chrome://") &&
    !tab.url.startsWith("chrome-extension://")
  ) {
    pinnedTabId = tab.id;
    tabLbl.textContent = (tab.title || "").slice(0, 40) || new URL(tab.url).hostname;
    await bindTabSession();
  }
  await refreshShareState();
}

async function refreshShareState() {
  if (pinnedTabId == null) {
    shareBtn.style.display = "none";
    return;
  }
  try {
    const { shared } = await chrome.runtime.sendMessage({
      type: "isTabShared",
      tabId: pinnedTabId,
    });
    shareBtn.style.display = "";
    shareBtn.textContent = shared ? "Stop sharing" : "Share tab";
    shareBtn.classList.toggle("accent", !shared);
  } catch {
    shareBtn.style.display = "none";
  }
}

async function onToggleShare() {
  if (pinnedTabId == null) {
    return;
  }
  // Same consent path as the popup: membership in the OpenClaw tab group is
  // what the agent may touch; the panel never attaches debuggers itself.
  await chrome.runtime.sendMessage({ type: "toggleShareTab", tabId: pinnedTabId });
  await refreshShareState();
}
shareBtn.addEventListener("click", () => void onToggleShare());

async function onNewChat() {
  if (pinnedTabId == null || !mainSessionKey) {
    return;
  }
  const generation = await bumpTabGeneration(pinnedTabId);
  sessionKey = deriveTabSessionKey(mainSessionKey, pinnedTabId, generation);
  await ensureSession(sessionKey);
  await subscribeSession(sessionKey);
  messagesEl.innerHTML = "";
  resetChatStream(stream);
  streamingEl = null;
  // Starting a fresh thread mid-run swaps sessionKey, so the old run's terminal
  // event is filtered by handleChatEvent and can no longer re-enable the
  // composer. A new conversation always accepts input.
  setInputEnabled(true);
  addMessage("system", "Fresh conversation for this tab.");
}
newBtn.addEventListener("click", () => void onNewChat());

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === pinnedTabId && (info.title || info.url)) {
    chrome.tabs
      .get(pinnedTabId)
      .then((tab) => {
        tabLbl.textContent = (tab.title || "").slice(0, 40) || "Tab";
      })
      .catch(() => {});
  }
  if (tabId === pinnedTabId && info.groupId !== undefined) {
    void refreshShareState();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === pinnedTabId) {
    pinnedTabId = null;
    tabLbl.textContent = "Tab closed";
    shareBtn.style.display = "none";
    // The conversation is pinned to a tab that no longer exists. Release its
    // session and close input, or the panel would keep sending turns into a
    // thread whose tab the agent can never act on.
    if (subscribedKey) {
      sendReq("sessions.messages.unsubscribe", { key: subscribedKey }).catch(() => {});
      subscribedKey = null;
    }
    sessionKey = null;
    setInputEnabled(false);
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function onToggleSettings() {
  const opening = !settingsEl.classList.contains("open");
  settingsEl.classList.toggle("open");
  if (opening) {
    const stored = await chrome.storage.local.get(["gatewayUrl", "gatewayToken"]);
    gatewayUrlInput.value = stored.gatewayUrl || "";
    gatewayTokenInput.value = stored.gatewayToken || "";
  }
}
settingsBtn.addEventListener("click", () => void onToggleSettings());

async function onSaveSettings() {
  await chrome.storage.local.set({
    gatewayUrl: gatewayUrlInput.value.trim(),
    gatewayToken: gatewayTokenInput.value.trim(),
  });
  settingsEl.classList.remove("open");
}
saveBtn.addEventListener("click", () => void onSaveSettings());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.gatewayUrl || changes.gatewayToken)) {
    dropSocket();
    reconnectAttempt = 0;
    messagesEl.innerHTML = "";
    sessionKey = null;
    void connect();
  }
});

// ---------------------------------------------------------------------------
// Input + boot
// ---------------------------------------------------------------------------

function autoResize() {
  msgInput.style.height = "auto";
  msgInput.style.height = `${Math.min(msgInput.scrollHeight, 120)}px`;
}

sendBtn.addEventListener("click", () => void sendMessage());
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});
msgInput.addEventListener("input", autoResize);

void pinToCurrentTab();
void connect();
setInterval(() => void refreshShareState(), 2000);
