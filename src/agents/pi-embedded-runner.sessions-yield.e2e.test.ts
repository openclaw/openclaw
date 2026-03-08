/**
 * End-to-end test proving that when sessions_yield is called:
 * 1. The attempt completes with yieldDetected
 * 2. The run exits with stopReason "end_turn" and no pendingToolCalls
 * 3. The parent session is idle (clearActiveEmbeddedRun has run)
 *
 * This exercises the full path: mock LLM → agent loop → tool execution → callback → attempt result → run result.
 * Follows the same pattern as pi-embedded-runner.e2e.test.ts.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./pi-embedded-runner/runs.js";

function createMockUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

// Track call sequence to return tool_use first, then stop.
let streamCallCount = 0;

vi.mock("@mariozechner/pi-coding-agent", async () => {
  return await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
});

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildToolUseMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [
      {
        type: "toolCall" as const,
        id: "tc-yield-e2e-1",
        name: "sessions_yield",
        arguments: { message: "Yielding turn." },
      },
    ],
    stopReason: "toolUse" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  const buildStopMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Acknowledged." }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount++;
      return streamCallCount === 1 ? buildToolUseMessage(model) : buildStopMessage(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount++;
      return streamCallCount === 1 ? buildToolUseMessage(model) : buildStopMessage(model);
    },
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      streamCallCount++;
      const isFirstCall = streamCallCount === 1;
      const message = isFirstCall ? buildToolUseMessage(model) : buildStopMessage(model);
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: isFirstCall ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    },
  };
});

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let tempRoot: string | undefined;
let agentDir: string;
let workspaceDir: string;

beforeAll(async () => {
  vi.useRealTimers();
  streamCallCount = 0;
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-yield-e2e-"));
  agentDir = path.join(tempRoot, "agent");
  workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  if (!tempRoot) {
    return;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

const makeConfig = (modelIds: string[]) =>
  ({
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            id,
            name: `Mock ${id}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_000,
            maxTokens: 2048,
          })),
        },
      },
    },
  }) satisfies OpenClawConfig;

const immediateEnqueue = async <T>(task: () => Promise<T>) => task();

describe("sessions_yield e2e", () => {
  it(
    "parent session is idle after yield — full path through attempt",
    { timeout: 15_000 },
    async () => {
      // Reset call counter so first call returns tool_use
      streamCallCount = 0;

      const sessionId = "yield-e2e-parent";
      const sessionFile = path.join(workspaceDir, "session-yield-e2e.jsonl");
      const cfg = makeConfig(["mock-yield"]);

      const result = await runEmbeddedPiAgent({
        sessionId,
        sessionKey: "agent:test:yield-e2e",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "Spawn subagent and yield.",
        provider: "openai",
        model: "mock-yield",
        timeoutMs: 10_000,
        agentDir,
        runId: "run-yield-e2e-1",
        enqueue: immediateEnqueue,
      });

      // 1. Run completed with end_turn (yield causes clean exit)
      expect(result.meta.stopReason).toBe("end_turn");

      // 2. No pending tool calls (yield is NOT a client tool call)
      expect(result.meta.pendingToolCalls).toBeUndefined();

      // 3. Parent session is IDLE — clearActiveEmbeddedRun ran in finally block
      expect(isEmbeddedPiRunActive(sessionId)).toBe(false);

      // 4. Steer would fail — session not in ACTIVE_EMBEDDED_RUNS
      expect(queueEmbeddedPiMessage(sessionId, "subagent result")).toBe(false);

      // 5. The mock LLM was called twice (tool_use + stop)
      expect(streamCallCount).toBe(2);
    },
  );
});
