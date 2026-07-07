#!/usr/bin/env node
/**
 * Live repro for issue #101207: Codex guardianWarning notification is silently
 * dropped by the app-server event projector.
 *
 * Verifies that a thread-scoped `guardianWarning` notification (only `threadId`
 * + `message`, no `turnId`) is routed through the projector and emitted on the
 * `codex_app_server.guardian` agent-event stream with `phase: "warning"`.
 *
 * Run with:
 *   node --import tsx scripts/repro/issue-101207-codex-guardian-warning.mts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { CodexAppServerEventProjector } from "../../extensions/codex/src/app-server/event-projector.js";

const THREAD_ID = "thread-repro-101207";
const TURN_ID = "turn-repro-101207";

function codexModel(): Model {
  return {
    id: "gpt-5.4-codex",
    name: "gpt-5.4-codex",
    provider: "openai",
    api: "openai-chatgpt-responses",
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
  } as Model;
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-101207-"));
  const sessionFile = path.join(tmpDir, "session.jsonl");
  SessionManager.open(sessionFile).appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "history" }],
    api: "openai-chatgpt-responses",
    provider: "openai",
    model: "gpt-5.4-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const params = {
    prompt: "hello",
    sessionId: "session-repro-101207",
    sessionFile,
    workspaceDir: tmpDir,
    runId: "run-repro-101207",
    provider: "openai",
    modelId: "gpt-5.4-codex",
    model: codexModel(),
    thinkLevel: "medium",
    onAgentEvent: (event: { stream: string; data: Record<string, unknown> }) => {
      events.push(event);
    },
  } as EmbeddedRunAttemptParams;

  const projector = new CodexAppServerEventProjector(params, THREAD_ID, TURN_ID);

  // Codex emits guardianWarning thread-scoped: only threadId + message, no turnId.
  await projector.handleNotification({
    method: "guardianWarning",
    params: {
      threadId: THREAD_ID,
      message: "Guardian rejection limit reached; ending turn as interrupted.",
    },
  });

  await fs.rm(tmpDir, { recursive: true, force: true });

  const warning = events.find((e) => e.stream === "codex_app_server.guardian");
  if (!warning) {
    console.error("FAIL: no guardian agent event was projected");
    console.error("Events emitted:", JSON.stringify(events, null, 2));
    process.exitCode = 1;
    return;
  }

  if (warning.data.phase !== "warning") {
    console.error(`FAIL: expected phase "warning", got ${JSON.stringify(warning.data.phase)}`);
    process.exitCode = 1;
    return;
  }

  if (warning.data.message !== "Guardian rejection limit reached; ending turn as interrupted.") {
    console.error(`FAIL: unexpected message: ${JSON.stringify(warning.data.message)}`);
    process.exitCode = 1;
    return;
  }

  console.log("=== Reproduction for issue #101207 ===");
  console.log("Thread-scoped guardianWarning routed and projected successfully:");
  console.log(JSON.stringify(warning, null, 2));
  console.log("\nPASS: guardianWarning is projected on codex_app_server.guardian.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
