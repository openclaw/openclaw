// Bundled entry point for the macOS WKWebView web chat.
// New version: talks directly to the Gateway WebSocket (chat.* methods), no /rpc or file watchers.

/* global window, document */

if (!globalThis.process) {
  globalThis.process = { env: {} };
}

import { formatError } from "./format-error.js";

const logStatus = (msg) => {
  try {
    console.log(msg);
    const el = document.getElementById("app");
    if (el && !el.dataset.booted) el.textContent = msg;
  } catch {
    // Ignore logging failures—never block bootstrap.
  }
};

const randomId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Math.random().toString(16).slice(2)}-${Date.now()}`;
};

const ensureErrorStyles = () => {
  if (document.getElementById("webchat-error-style")) return;
  const style = document.createElement("style");
  style.id = "webchat-error-style";
  style.textContent = `
    body.webchat-error {
      padding: 28px;
    }
  `;
  document.head.appendChild(style);
};

class GatewaySocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        const hello = {
          type: "hello",
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            name: "webchat-ui",
            version: "dev",
            platform: "browser",
            mode: "webchat",
            instanceId: randomId(),
          },
        };
        ws.send(JSON.stringify(hello));
      };

      ws.onerror = (err) => reject(err);

      ws.onclose = (ev) => {
        if (this.pending.size > 0) {
          for (const [, p] of this.pending)
            p.reject(new Error("gateway closed"));
          this.pending.clear();
        }
        if (ev.code !== 1000) reject(new Error(`gateway closed ${ev.code}`));
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "hello-ok") {
          this.handlers.set("snapshot", msg.snapshot);
          resolve(msg);
          return;
        }
        if (msg.type === "event") {
          const cb = this.handlers.get(msg.event);
          if (cb) cb(msg.payload, msg);
          return;
        }
        if (msg.type === "res") {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          if (msg.ok) pending.resolve(msg.payload);
          else pending.reject(new Error(msg.error?.message || "gateway error"));
        }
      };
    });
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  async request(method, params, { timeoutMs = 30_000 } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    const id = randomId();
    const frame = { type: "req", id, method, params };
    this.ws.send(JSON.stringify(frame));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, timeoutMs);
    });
  }
}

class ChatTransport {
  constructor(sessionKey, gateway, healthOkRef) {
    this.sessionKey = sessionKey;
    this.gateway = gateway;
    this.healthOkRef = healthOkRef;
    this.pendingRuns = new Map();

    this.gateway.on("chat", (payload) => {
      const runId = payload?.runId;
      const pending = runId ? this.pendingRuns.get(runId) : null;
      if (!pending) return;
      if (payload.state === "error") {
        pending.reject(new Error(payload.errorMessage || "chat error"));
        this.pendingRuns.delete(runId);
        return;
      }
      if (payload.state === "delta") return; // ignore partials for now
      pending.resolve(payload);
      this.pendingRuns.delete(runId);
    });
  }

  async *run(_messages, userMessage, cfg, _signal) {
    if (!this.healthOkRef.current) {
      throw new Error("gateway health not OK; cannot send");
    }

    const text = userMessage.content?.[0]?.text ?? "";
    const attachments = (userMessage.attachments || []).map((a) => ({
      type: a.type,
      mimeType: a.mimeType,
      fileName: a.fileName,
      content:
        typeof a.content === "string"
          ? a.content
          : btoa(String.fromCharCode(...new Uint8Array(a.content))),
    }));
    const thinking =
      cfg?.thinkingOnce ?? cfg?.thinkingOverride ?? cfg?.thinking ?? undefined;
    const runId = randomId();

    const pending = new Promise((resolve, reject) => {
      this.pendingRuns.set(runId, { resolve, reject });
      setTimeout(() => {
        if (this.pendingRuns.has(runId)) {
          this.pendingRuns.delete(runId);
          reject(new Error("chat timed out"));
        }
      }, 30_000);
    });

    await this.gateway.request("chat.send", {
      sessionKey: this.sessionKey,
      message: text,
      attachments: attachments.length ? attachments : undefined,
      thinking,
      idempotencyKey: runId,
      timeoutMs: 30_000,
    });

    yield { type: "turn_start" };

    const payload = await pending;
    const message = payload?.message || {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: Date.now(),
    };
    yield { type: "message_start", message };
    yield { type: "message_end", message };
    yield { type: "turn_end" };
    yield { type: "agent_end" };
  }
}

const startChat = async () => {
  logStatus("boot: starting imports");
  const { Agent } = await import("./agent/agent.js");
  const { ChatPanel } = await import("./ChatPanel.js");
  const { AppStorage, setAppStorage } = await import(
    "./storage/app-storage.js"
  );
  const { SettingsStore } = await import("./storage/stores/settings-store.js");
  const { ProviderKeysStore } = await import(
    "./storage/stores/provider-keys-store.js"
  );
  const { SessionsStore } = await import("./storage/stores/sessions-store.js");
  const { CustomProvidersStore } = await import(
    "./storage/stores/custom-providers-store.js"
  );
  const { IndexedDBStorageBackend } = await import(
    "./storage/backends/indexeddb-storage-backend.js"
  );
  const { getModel } = await import("@mariozechner/pi-ai");
  logStatus("boot: modules loaded");

  // Storage init
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
  for (const store of [
    settingsStore,
    providerKeysStore,
    sessionsStore,
    customProvidersStore,
  ]) {
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

  // Seed dummy API key
  try {
    await providerKeysStore.set("anthropic", "embedded");
  } catch (err) {
    logStatus(`storage warn: could not seed provider key: ${err}`);
  }

  // Gateway WS
  const params = new URLSearchParams(window.location.search);
  const sessionKey = params.get("session") || "main";
  const wsUrl = (() => {
    const u = new URL(window.location.href);
    u.protocol = u.protocol.replace("http", "ws");
    u.port = params.get("gatewayPort") || "18789";
    u.pathname = "/";
    u.search = "";
    return u.toString();
  })();
  logStatus("boot: connecting gateway");
  const gateway = new GatewaySocket(wsUrl);
  const hello = await gateway.connect();
  const healthOkRef = { current: Boolean(hello?.snapshot?.health?.ok ?? true) };

  // Update health on demand when we get tick; simplest is to poll health occasionally.
  gateway.on("tick", async () => {
    try {
      const health = await gateway.request("health", {}, { timeoutMs: 5_000 });
      healthOkRef.current = !!health?.ok;
    } catch {
      healthOkRef.current = false;
    }
  });

  logStatus("boot: fetching history");
  const history = await gateway.request("chat.history", { sessionKey });
  const initialMessages = Array.isArray(history?.messages)
    ? history.messages
    : [];
  const thinkingLevel =
    typeof history?.thinkingLevel === "string" ? history.thinkingLevel : "off";

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are Clawd (primary session).",
      model: getModel("anthropic", "claude-opus-4-5"),
      thinkingLevel,
      messages: initialMessages,
    },
    transport: new ChatTransport(sessionKey, gateway, healthOkRef),
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
};

startChat().catch((err) => {
  const msg = formatError(err);
  logStatus(`boot failed: ${msg}`);
  document.body.dataset.webchatError = "1";
  ensureErrorStyles();
  document.body.classList.add("webchat-error");
  document.body.style.color = "#b32d2d";
  document.body.style.fontFamily = "SFMono-Regular, Menlo, Consolas, monospace";
  document.body.style.padding = "28px";
  document.body.style.lineHeight = "1.5";
  document.body.style.whiteSpace = "pre-wrap";
  document.body.innerText = "Web chat failed to connect.\n\n" + msg;
});
