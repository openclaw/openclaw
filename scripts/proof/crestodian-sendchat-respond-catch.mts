// Real behavior proof: CrestodianTuiBackend.sendChat catches a rejecting
// this.respond promise and emits a chat error event instead of an unhandled
// rejection. We replace the private respond() method itself so the error
// escapes respond's internal try/catch and must be caught by sendChat's outer
// .catch() -- which does not exist on current main.

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

type ReplacableRespond = (runId: string, sessionKey: string, text: string) => Promise<void>;

const { backend } = await new Promise<{
  backend: {
    sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
    onEvent?: (evt: { event: string; payload?: { state?: string; errorMessage?: string } }) => void;
    respond?: ReplacableRespond;
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

const events: Array<{ event: string; payload?: { state?: string; errorMessage?: string } }> = [];
backend.onEvent = (evt) => events.push(evt);

// Replace the private respond() method so it rejects; current main would leak
// this as an unhandled rejection because sendChat fires respond as void.
backend.respond = async () => {
  throw new Error("simulated respond failure");
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);

console.log("=== Proof: crestodian sendChat respond rejection catch ===\n");
console.log("Sending a chat message while respond() itself rejects...\n");

try {
  await backend.sendChat({ message: "hello" });

  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });

  const errorEvent = events.find((e) => e.event === "chat" && e.payload?.state === "error");

  if (unhandled.length === 0 && errorEvent?.payload?.errorMessage?.includes("simulated respond failure")) {
    console.log(`Caught error event: ${JSON.stringify(errorEvent.payload)}`);
    console.log("\nPASS: rejecting respond is caught and emitted as a chat error.");
  } else {
    console.log(`FAIL: unhandled=${unhandled.length}, errorEvent=${JSON.stringify(errorEvent?.payload)}`);
    process.exitCode = 1;
  }
} finally {
  process.off("unhandledRejection", onUnhandled);
}
