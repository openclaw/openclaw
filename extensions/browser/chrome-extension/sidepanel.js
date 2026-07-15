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
let pairingRetryTimer = null;
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
  // A retry scheduled by an earlier close or pairing response would fire
  // alongside the connect() that follows this drop, leaving two live sockets —
  // or tear down a healthy one once pairing is approved.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pairingRetryTimer) {
    clearTimeout(pairingRetryTimer);
    pairingRetryTimer = null;
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
  try {
    await signChallenge(payload);
  } catch (err) {
    // Why auth failed is the whole diagnostic: an unsupported-Chrome build and a
    // rejected credential both end here, and "Auth failed" alone tells the user
    // neither.
    const failure = err instanceof Error ? err.message : String(err);
    setWsStatus("err", "Auth failed");
    // Auth failures repeat on every reconnect and some (an unsupported Chrome)
    // never clear, so post this once instead of growing the pane forever.
    if (!document.querySelector(".auth-msg")) {
      addMessage("system", failure).classList.add("auth-msg");
    }
  }
}

async function signChallenge(payload) {
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
    void handleChallenge(msg.payload);
    return;
  }
  if (msg.type === "res" && msg.ok && msg.payload?.type === "hello-ok") {
    reconnectAttempt = 0;
    // Pairing succeeded on this socket. The close-driven backoff is faster than
    // the 5s pairing retry, so without this the stale timer would tear down the
    // healthy connection it just raced us to.
    if (pairingRetryTimer) {
      clearTimeout(pairingRetryTimer);
      pairingRetryTimer = null;
    }
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
      // The gateway closes the socket after this response, so its close listener
      // also schedules a retry. Track this timer or a stale one fires later and
      // tears down an already-healthy connection mid-turn.
      clearTimeout(pairingRetryTimer);
      pairingRetryTimer = setTimeout(() => {
        pairingRetryTimer = null;
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
    // A failed response with no waiting request is a refused handshake. The
    // status dot carries a bare code, which reads as an unexplained reconnect
    // loop — the origin allowlist rejection lands exactly here — so say what the
    // gateway actually said, once.
    const detail = msg.error?.message;
    if (detail && !document.querySelector(".conn-error-msg")) {
      addMessage("system", `Gateway refused the connection: ${detail}`).classList.add(
        "conn-error-msg",
      );
    }
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
    // Same thread, new socket. The subscription died with the old one, so a
    // reconnect still has to resubscribe even though the key is unchanged.
    // subscribeSession() no-ops when it is already subscribed on this socket.
    await subscribeSession(key);
    // Deliberately no rehydrate here. Redrawing from chat.history would drop a
    // just-sent user message that the server has not echoed back yet, which is
    // worse than the known cosmetic cost of NOT redrawing: a run that survives
    // the reconnect repeats its text in a second bubble under the frozen
    // partial. Losing nothing beats losing the turn.
    return;
  }
  sessionKey = key;
  await ensureSession(key);
  // ensureSession adopts the gateway's canonical echo into sessionKey, and
  // handleChatEvent filters on that — so subscribe and hydrate the canonical
  // key, not the locally derived one, or a canonicalizing gateway would leave
  // this path listening to a key no event ever carries.
  await subscribeSession(sessionKey);
  await hydrateHistory(sessionKey);
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
    // Always fold the terminal snapshot in. applyChatDelta is snapshot-
    // idempotent, so this costs nothing when the deltas already arrived, and it
    // covers two ways the tail goes missing: the pre-terminal flush is broadcast
    // drop-if-slow while this event is not, so a slow connection can miss the
    // flush and freeze stale partial text as the final answer; and a reconnect
    // mid-run can deliver only this event, carrying the whole reply.
    const update = applyChatDelta(stream, payload);
    if (update?.segmentText) {
      streamingEl ??= addMessage("assistant", "");
      streamingText = update.segmentText;
      streamingEl.innerHTML = renderMarkdownLite(streamingText);
    }
    if (payload.state === "error" && payload.errorMessage) {
      // An error before any delta has no bubble either; say so rather than just
      // handing the composer back with nothing on screen.
      if (!streamingEl) {
        streamingEl = addMessage("assistant", "");
        streamingText = "";
      }
      streamingText += `${streamingText ? "\n" : ""}[Error: ${payload.errorMessage}]`;
      streamingEl.innerHTML = renderMarkdownLite(streamingText);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    finalizeBubble();
    resetChatStream(stream);
    setInputEnabled(true);
  }
}

// Tool lifecycle reaches this panel only as run-scoped `agent` events, on the
// socket that started the run. The gateway's session-scoped `session.tool`
// mirror goes to `sessions.subscribe` subscribers, and the panel subscribes to
// messages, not sessions — so a run it did not start (reattach after a drop)
// shows no steps. Each tool start is a bubble boundary plus a step line.
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
  // Nothing to bump against without a socket: the create would be dropped and
  // the generation spent for nothing.
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addMessage("system", "Not connected to the gateway yet — reconnecting.");
    return;
  }
  try {
    await startFreshThread();
  } catch (err) {
    // The thread already swapped and the pane already shows it, so this reports
    // what is still missing (the gateway session) rather than claiming the
    // fresh conversation never started.
    const failure = err instanceof Error ? err.message : String(err);
    addMessage("system", `This tab's new conversation is not registered yet: ${failure}`);
    setInputEnabled(true);
  }
}

async function startFreshThread() {
  const generation = await bumpTabGeneration(pinnedTabId);
  sessionKey = deriveTabSessionKey(mainSessionKey, pinnedTabId, generation);
  // The bump is persisted and sessionKey has already moved, so show the new
  // thread BEFORE the gateway round trips rather than after. If one of them
  // throws, the pane still matches where sends will actually land and the
  // caller appends the failure to it — instead of leaving the old thread on
  // screen above a swapped key. Swapping also strands the composer, because the
  // old run's terminal event no longer matches sessionKey, so hand it back here.
  messagesEl.innerHTML = "";
  resetChatStream(stream);
  streamingEl = null;
  setInputEnabled(true);
  addMessage("system", "Fresh conversation for this tab.");
  await ensureSession(sessionKey);
  // ensureSession adopts the gateway's canonical echo, so subscribe to that.
  await subscribeSession(sessionKey);
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
