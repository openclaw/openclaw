// Real behavior proof: CrestodianTuiBackend isolates a throwing TUI event
// consumer so its fire-and-forget sendChat response does not become an
// unhandled rejection.

import { runCrestodianTui } from "../../src/crestodian/tui-backend.js";
import type { RuntimeEnv } from "../../src/runtime.js";

const overview = {
  defaultAgentId: "main",
  defaultModel: "openai/gpt-5.5",
  agents: [{ id: "main", isDefault: true, model: "openai/gpt-5.5" }],
  config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
  tools: {
    codex: { command: "codex", found: false, error: "not found" },
    claude: { command: "claude", found: false, error: "not found" },
    apiKeys: { openai: true, anthropic: false },
  },
  gateway: {
    url: "ws://127.0.0.1:18789",
    source: "local loopback",
    reachable: false,
    error: "offline",
  },
  references: {
    docsUrl: "https://docs.openclaw.ai",
    sourceUrl: "https://github.com/openclaw/openclaw",
  },
};

const runtime: RuntimeEnv = {
  log: () => undefined,
  error: () => undefined,
  exit: (code) => {
    throw new Error(`exit ${String(code)}`);
  },
};

const { backend } = await new Promise<{
  backend: {
    sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
    onEvent?: (evt: { event: string; payload?: { state?: string; errorMessage?: string } }) => void;
    engine: {
      handle: () => Promise<{ text: string; action: "none" }>;
    };
  };
}>((resolve) => {
  void runCrestodianTui(
    {
      deps: { loadOverview: async () => overview },
      runTui: async (opts) => {
        resolve({ backend: opts.backend as never });
        return { exitReason: "exit" };
      },
    },
    runtime,
  );
});

backend.engine.handle = async () => ({ text: "hello", action: "none" });
backend.onEvent = () => {
  throw new Error("simulated render failure");
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);

console.log("=== Proof: crestodian TUI event consumer isolation ===\n");
console.log("Sending a chat message while the TUI event consumer throws...\n");

try {
  await backend.sendChat({ message: "hello" });

  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });

  if (unhandled.length === 0) {
    console.log("PASS: the listener failure was isolated without an unhandled rejection.");
  } else {
    console.log(`FAIL: unhandled=${String(unhandled.length)}`);
    process.exitCode = 1;
  }
} finally {
  process.off("unhandledRejection", onUnhandled);
}
