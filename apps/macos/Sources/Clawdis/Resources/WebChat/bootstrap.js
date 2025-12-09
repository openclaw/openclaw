// Bundled entry point for the macOS WKWebView web chat.
// This replaces the inline module script in index.html so we can ship a single JS bundle.

/* global window, document */

if (!globalThis.process) {
  // Some vendor modules peek at process.env; provide a minimal stub for browser.
  globalThis.process = { env: {} };
}

const logStatus = (msg) => {
  try {
    console.log(msg);
    const el = document.getElementById("app");
    if (el && !el.dataset.booted) el.textContent = msg;
  } catch {
    // Ignore logging failures—never block bootstrap.
  }
};

// Keep the WebChat UI in lockstep with the host system theme.
const setupSystemThemeSync = () => {
  const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mql) return;

  const apply = (isDark) => {
    document.documentElement.classList.toggle("dark", isDark);
    document.body?.classList.toggle("dark", isDark);
  };

  // Set initial theme immediately.
  apply(mql.matches);

  // React to live theme switches (e.g., macOS Light <-> Dark).
  const onChange = (event) => apply(event.matches);
  if (mql.addEventListener) {
    mql.addEventListener("change", onChange);
  } else {
    mql.addListener(onChange); // Safari < 14 fallback
  }
};

async function fetchBootstrap() {
  const params = new URLSearchParams(window.location.search);
  const sessionKey = params.get("session") || "main";
  const infoUrl = new URL(`./info?session=${encodeURIComponent(sessionKey)}`, window.location.href);
  const infoResp = await fetch(infoUrl, { credentials: "omit" });
  if (!infoResp.ok) {
    throw new Error(`webchat info failed (${infoResp.status})`);
  }
  const info = await infoResp.json();
  return {
    sessionKey,
    basePath: info.basePath || "/webchat/",
    initialMessages: Array.isArray(info.initialMessages) ? info.initialMessages : [],
    thinkingLevel: typeof info.thinkingLevel === "string" ? info.thinkingLevel : "off",
  };
}

function latestTimestamp(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const withTs = messages.filter((m) => typeof m?.timestamp === "number");
  if (withTs.length === 0) return messages.length; // best-effort monotonic fallback
  return withTs[withTs.length - 1].timestamp;
}

class NativeTransport {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
  }

  async *run(messages, userMessage, cfg, signal) {
    const attachments = userMessage.attachments?.map((a) => ({
      type: a.type,
      mimeType: a.mimeType,
      fileName: a.fileName,
      content:
        typeof a.content === "string"
          ? a.content
          : btoa(String.fromCharCode(...new Uint8Array(a.content))),
    }));
    const rpcUrl = new URL("./rpc", window.location.href);
    const rpcBody = {
      text: userMessage.content?.[0]?.text ?? "",
      session: this.sessionKey,
      attachments,
    };
    if (cfg?.thinkingOnce) {
      rpcBody.thinkingOnce = cfg.thinkingOnce;
    } else if (cfg?.thinkingOverride) {
      rpcBody.thinking = cfg.thinkingOverride;
    }
    const resultResp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcBody),
      signal,
    });

    if (!resultResp.ok) {
      throw new Error(`rpc failed (${resultResp.status})`);
    }
    const body = await resultResp.json();
    if (!body.ok) {
      throw new Error(body.error || "rpc error");
    }
    const first = Array.isArray(body.payloads) ? body.payloads[0] : undefined;
    const text = (first?.text ?? "").toString();

    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: cfg.model.api,
      provider: cfg.model.provider,
      model: cfg.model.id,
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    yield { type: "turn_start" };
    yield { type: "message_start", message: assistant };
    yield { type: "message_end", message: assistant };
    yield { type: "turn_end" };
    yield { type: "agent_end" };
  }
}

const startChat = async () => {
  logStatus("boot: fetching session info");
  const { initialMessages, sessionKey, thinkingLevel } = await fetchBootstrap();

  logStatus("boot: starting imports");
  // Align UI theme with host OS preference and keep it updated.
  setupSystemThemeSync();

  const { Agent } = await import("./agent/agent.js");
  const { ChatPanel } = await import("./ChatPanel.js");
  const { AppStorage, setAppStorage } = await import("./storage/app-storage.js");
  const { SettingsStore } = await import("./storage/stores/settings-store.js");
  const { ProviderKeysStore } = await import("./storage/stores/provider-keys-store.js");
  const { SessionsStore } = await import("./storage/stores/sessions-store.js");
  const { CustomProvidersStore } = await import("./storage/stores/custom-providers-store.js");
  const { IndexedDBStorageBackend } = await import("./storage/backends/indexeddb-storage-backend.js");
  const { getModel } = await import("@mariozechner/pi-ai");
  logStatus("boot: modules loaded");

  // Initialize storage with an in-browser IndexedDB backend.
  const backend = new IndexedDBStorageBackend({
    dbName: "clawdis-webchat",
    version: 1,
    stores: [
      new SettingsStore().getConfig(),
      new ProviderKeysStore().getConfig(),
      new SessionsStore().getConfig(),
      SessionsStore.getMetadataConfig(),
      new CustomProvidersStore().getConfig(),
    ],
  });
  const settingsStore = new SettingsStore();
  const providerKeysStore = new ProviderKeysStore();
  const sessionsStore = new SessionsStore();
  const customProvidersStore = new CustomProvidersStore();

  for (const store of [settingsStore, providerKeysStore, sessionsStore, customProvidersStore]) {
    store.setBackend(backend);
  }

  const storage = new AppStorage(
    settingsStore,
    providerKeysStore,
    sessionsStore,
    customProvidersStore,
    backend,
  );
  setAppStorage(storage);

  // Prepopulate a dummy API key so the UI does not block sends in embedded mode.
  const defaultProvider = "anthropic";
  try {
    await providerKeysStore.set(defaultProvider, "embedded");
  } catch (err) {
    logStatus(`storage warn: could not seed provider key: ${err}`);
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are Clawd (primary session).",
      model: getModel("anthropic", "claude-opus-4-5"),
      thinkingLevel,
      messages: initialMessages,
    },
    transport: new NativeTransport(sessionKey),
  });

  const origPrompt = agent.prompt.bind(agent);
  agent.prompt = async (input, attachments) => {
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: input }],
      attachments: attachments?.length ? attachments : undefined,
      timestamp: Date.now(),
    };
    agent.appendMessage(userMessage);
    return origPrompt(input, attachments);
  };

  const panel = new ChatPanel();
  panel.style.height = "100%";
  panel.style.display = "block";
  await panel.setAgent(agent, { sessionThinkingLevel: thinkingLevel });

  const mount = document.getElementById("app");
  if (!mount) throw new Error("#app container missing");
  mount.dataset.booted = "1";
  mount.textContent = "";
  mount.appendChild(panel);
  logStatus("boot: ready");

  // Live sync via WebSocket so other transports (WhatsApp/CLI) appear instantly.
  let lastSyncedTs = latestTimestamp(initialMessages);
  let ws;
  let reconnectTimer;

  const applySnapshot = (info) => {
    const messages = Array.isArray(info?.messages) ? info.messages : [];
    const ts = latestTimestamp(messages);
    const thinking = typeof info?.thinkingLevel === "string" ? info.thinkingLevel : "off";

    if (!agent.state.isStreaming && ts && ts !== lastSyncedTs) {
      agent.replaceMessages(messages);
      lastSyncedTs = ts;
    }

    if (thinking && thinking !== agent.state.thinkingLevel) {
      agent.setThinkingLevel(thinking);
      if (panel?.agentInterface) {
        panel.agentInterface.sessionThinkingLevel = thinking;
        panel.agentInterface.pendingThinkingLevel = null;
        if (panel.agentInterface._messageEditor) {
          panel.agentInterface._messageEditor.thinkingLevel = thinking;
        }
      }
    }
  };

  const connectSocket = () => {
    try {
      const wsUrl = new URL(`./socket?session=${encodeURIComponent(sessionKey)}`, window.location.href);
      wsUrl.protocol = wsUrl.protocol.replace("http", "ws");
      ws = new WebSocket(wsUrl);

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data?.type === "session") applySnapshot(data);
        } catch (err) {
          console.warn("ws message parse failed", err);
        }
      };

      ws.onclose = () => {
        ws = null;
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectSocket();
          }, 2000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    } catch (err) {
      console.warn("ws connect failed", err);
    }
  };

  connectSocket();
};

startChat().catch((err) => {
  const msg = err?.stack || err?.message || String(err);
  logStatus(`boot failed: ${msg}`);
  document.body.dataset.webchatError = "1";
  document.body.style.color = "#e06666";
  document.body.style.fontFamily = "monospace";
  document.body.style.padding = "16px";
  document.body.innerText = "Web chat failed to load:\\n" + msg;
});
