// Bundled entry point for the macOS WKWebView web chat.
// This replaces the inline module script in index.html so we can ship a single JS bundle.

/* global window, document, crypto */

if (!globalThis.process) {
  // Some vendor modules peek at process.env; provide a minimal stub for browser.
  globalThis.process = { env: {} };
}

const logStatus = (msg) => {
  try {
    console.log(msg);
    if (typeof window.__clawdisLog === "function") {
      window.__clawdisLog(msg);
    }
    const el = document.getElementById("app");
    if (el && !el.dataset.booted) el.textContent = msg;
  } catch {
    // Ignore logging failures—never block bootstrap.
  }
};

const getBootstrap = () => {
  const bootstrap = window.__clawdisBootstrap || {};
  return {
    initialMessages: Array.isArray(bootstrap.initialMessages) ? bootstrap.initialMessages : [],
    sessionKey: typeof bootstrap.sessionKey === "string" ? bootstrap.sessionKey : "main",
  };
};

class NativeTransport {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
  }

  async *run(messages, userMessage, cfg, signal) {
    const result = await window.__clawdisSend({
      type: "chat",
      payload: { text: userMessage.content?.[0]?.text ?? "", sessionKey: this.sessionKey },
    });
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: result.text ?? "" }],
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
  const { initialMessages, sessionKey } = getBootstrap();

  logStatus("boot: starting imports");
  const { Agent } = await import("./agent/agent.js");
  const { ChatPanel } = await import("./ChatPanel.js");
  const { AppStorage, setAppStorage } = await import("./storage/app-storage.js");
  const { getModel } = await import("@mariozechner/pi-ai");
  logStatus("boot: modules loaded");

  const storage = new AppStorage();
  setAppStorage(storage);

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are Clawd (primary session).",
      model: getModel("anthropic", "claude-opus-4-5"),
      thinkingLevel: "off",
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
  await panel.setAgent(agent);

  const mount = document.getElementById("app");
  if (!mount) throw new Error("#app container missing");
  mount.dataset.booted = "1";
  mount.textContent = "";
  mount.appendChild(panel);
  logStatus("boot: ready");
};

startChat().catch((err) => {
  const msg = err?.stack || err?.message || String(err);
  logStatus(`boot failed: ${msg}`);
  document.body.style.color = "#e06666";
  document.body.style.fontFamily = "monospace";
  document.body.style.padding = "16px";
  document.body.innerText = "Web chat failed to load:\\n" + msg;
});
