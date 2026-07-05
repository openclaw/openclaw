// Real behavior proof: CrestodianTuiBackend.sendChat catches a rejecting
// this.respond promise and emits a chat error event instead of an unhandled
// rejection.

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

const { backend, finish } = await new Promise<{
  backend: {
    sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
    onEvent?: (evt: { event: string; payload?: { state?: string; errorMessage?: string } }) => void;
    engine: { handle: () => Promise<unknown>; dispose: () => Promise<void> };
  };
  finish: () => void;
}>((resolve) => {
  void runCrestodianTui(
    {
      deps: { loadOverview: async () => overview },
      runTui: async (opts) => {
        resolve({
          backend: opts.backend as never,
          finish: () => undefined,
        });
        return { exitReason: "exit" };
      },
    },
    runtime,
  );
});

backend.engine = {
  handle: async () => {
    throw new Error("simulated engine failure");
  },
  dispose: async () => {},
};

const events: Array<{ event: string; payload?: { state?: string; errorMessage?: string } }> = [];
backend.onEvent = (evt) => events.push(evt);

console.log("=== Proof: crestodian sendChat respond rejection catch ===\n");
console.log("Sending a chat message while the engine handle rejects...\n");

await backend.sendChat({ message: "hello" });

await new Promise((resolve) => {
  setTimeout(resolve, 100);
});

const errorEvent = events.find((e) => e.event === "chat" && e.payload?.state === "error");

if (errorEvent?.payload?.errorMessage?.includes("simulated engine failure")) {
  console.log(`Caught error event: ${JSON.stringify(errorEvent.payload)}`);
  console.log("\nPASS: rejecting respond is caught and emitted as a chat error.");
} else {
  console.log("FAIL: expected chat error event with simulated engine failure.");
  process.exitCode = 1;
}
