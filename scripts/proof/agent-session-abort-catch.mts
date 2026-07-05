// Real behavior proof: extension abort fallback catches a rejecting session abort.
// Creates an AgentSession, makes its abort() reject, then invokes the extension
// runtime abort callback and captures the stderr diagnostic.

import { createAgentSession } from "../../src/agents/sessions/sdk.js";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";
import { SettingsManager } from "../../src/agents/sessions/settings-manager.js";
import { ModelRegistry } from "../../src/agents/sessions/model-registry.js";
import { AuthStorage } from "../../src/agents/sessions/auth-storage.js";
import { createExtensionRuntime } from "../../src/agents/sessions/extensions/loader.js";
import type { LoadExtensionsResult } from "../../src/agents/sessions/extensions/types.js";
import type { ResourceLoader } from "../../src/agents/sessions/resource-loader.js";

const testModel = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function createEmptyResourceLoader(): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

const { session } = await createAgentSession({
  model: testModel as never,
  resourceLoader: createEmptyResourceLoader(),
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory(),
  modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
});

// Capture stderr so the proof output is self-contained. Do not echo captured
// chunks back to stderr: abort failures may carry provider/config details, and
// this proof only needs to detect the generic diagnostic.
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const stderrChunks: string[] = [];
process.stderr.write = (chunk: string | Uint8Array) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  stderrChunks.push(text);
  return true;
};

// Force the session abort() promise to reject to exercise the defensive catch.
const originalAbort = session.abort.bind(session);
(session as { abort: () => Promise<void> }).abort = async () => {
  await originalAbort();
  throw new Error("simulated abort rejection");
};

const runner = (session as unknown as { currentExtensionRunner?: { abortFn?: () => void } }).currentExtensionRunner;
if (!runner?.abortFn) {
  throw new Error("extension runner abortFn was not bound");
}

console.log("=== Proof: agent session extension abort catch ===\n");
console.log("Calling extension runtime abort callback with a rejecting session.abort()...\n");

runner.abortFn();

// Wait for the microtask queue to drain so the .catch() handler runs.
await new Promise((resolve) => {
  setTimeout(resolve, 100);
});

process.stderr.write = originalStderrWrite;

const stderr = stderrChunks.join("");
if (stderr.includes("agent-session: extension abort failed")) {
  console.log("\nPASS: rejecting abort is caught and logged instead of becoming an unhandled rejection.");
} else {
  console.log("FAIL: expected diagnostic not found in stderr.");
  process.exitCode = 1;
}
