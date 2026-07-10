// Standalone runtime-proof script — NOT a test file.
// Imports the real, unmodified production installContextEngineLoopHook and
// drives it with a real (deliberately-failing) ContextEngine implementation,
// to produce genuine runtime log output rather than a vitest-mocked assertion.
//
// Run with: npx tsx scripts/runtime-proof-context-engine-failure.ts

import { installContextEngineLoopHook } from "../src/agents/embedded-agent-runner/tool-result-context-guard.js";
import type { ContextEngine } from "../src/context-engine/types.js";

function makeUserMessage(text: string) {
  return { role: "user", content: text } as any;
}

const flakyEngine: ContextEngine = {
  info: { id: "runtime-proof-engine", name: "Runtime Proof Engine", version: "0.0.1" },
  async ingest() {
    return { ingested: true };
  },
  async ingestBatch(params: { messages: unknown[] }) {
    return { ingestedCount: params.messages.length };
  },
  async afterTurn() {
    // no-op for this proof run
  },
  async assemble() {
    throw new Error("simulated provider timeout during context assemble (runtime proof)");
  },
};

async function main() {
  const agent: {
    transformContext?: (messages: unknown[], signal: AbortSignal) => Promise<unknown>;
  } = {};

  const removeHook = installContextEngineLoopHook({
    agent,
    contextEngine: flakyEngine,
    sessionId: "runtime-proof-session",
    sessionKey: "agent:main:subagent:runtime-proof",
    sessionFile: "/tmp/runtime-proof-session.jsonl",
    tokenBudget: 4096,
    modelId: "runtime-proof-model",
    getPrePromptMessageCount: () => 0,
  });

  const messages = [makeUserMessage("first"), makeUserMessage("second")];

  console.log("--- invoking real transformContext with a genuinely throwing engine ---");
  const result = await agent.transformContext!(messages, new AbortController().signal);
  console.log("--- transformContext returned (fallback path) ---");
  console.log(JSON.stringify(result, null, 2));

  removeHook();
}

main().catch((err) => {
  console.error("runtime proof script failed:", err);
  process.exit(1);
});
