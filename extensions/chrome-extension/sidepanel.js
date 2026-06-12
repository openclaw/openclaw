import { getOrCreateIdentity, buildDeviceBlock } from "./device-identity.js";

const DEFAULT_GATEWAY = "http://127.0.0.1:18789";
const DEFAULT_TOKEN = "test-token-for-container";

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
      gatewayToken = DEFAULT_TOKEN;
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
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: CLIENT_ID, version: "1.0.0", platform: "chrome-extension", mode: CLIENT_MODE },
      role: ROLE,
      scopes: SCOPES,
      caps: [],
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
}

let mainSessionKey = null;

async function handleHelloOk(payload) {
  const snapshot = payload.snapshot || {};
  const sd = snapshot.sessionDefaults || {};
  mainSessionKey = sd.mainSessionKey || null;
  sessionKey = mainSessionKey;

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

  addMessage("system", "Connected. Select a session or start a new one.");
}

sessionPicker.addEventListener("change", () => {
  sessionKey = sessionPicker.value === "new" ? mainSessionKey : sessionPicker.value;
  messagesEl.innerHTML = "";
  addMessage("system", sessionKey ? "Switched to session." : "Ready.");
});

function handleChatEvent(payload) {
  if (!payload) return;
  const state = payload.state;

  if (state === "delta") {
    const text = payload.deltaText || "";
    if (!text) return;

    if (!streamingEl || currentRunId !== payload.runId) {
      currentRunId = payload.runId;
      streamingText = "";
      streamingEl = addMessage("assistant", "");
      streamingEl.classList.add("streaming");
    }

    streamingText += text;
    streamingEl.innerHTML = renderText(streamingText);
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
    sendBtn.disabled = false;
    msgInput.disabled = false;
    msgInput.focus();
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
    const params = { message: text, idempotencyKey: generateId() };
    if (sessionKey) {
      params.key = sessionKey;
    }
    const result = await sendReq("sessions.send", params);
    if (result?.runId) currentRunId = result.runId;
    if (result?.sessionKey && !sessionKey) {
      sessionKey = result.sessionKey;
      const opt = document.createElement("option");
      opt.value = sessionKey;
      opt.textContent = sessionKey.split(":").pop();
      sessionPicker.appendChild(opt);
      sessionPicker.value = sessionKey;
    }
  } catch (err) {
    addMessage("system", "Send failed: " + err.message);
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
