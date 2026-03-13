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
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./pi-embedded-runner/runs.js";
import {
  cleanupEmbeddedPiRunnerTestWorkspace,
  createEmbeddedPiRunnerOpenAiConfig,
  createEmbeddedPiRunnerTestWorkspace,
  type EmbeddedPiRunnerTestWorkspace,
  immediateEnqueue,
} from "./test-helpers/pi-embedded-runner-e2e-fixtures.js";

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

let streamCallCount = 0;
let multiToolMode = false;
let responsePlan: Array<"toolUse" | "stop"> = [];
let observedContexts: Array<Array<{ role?: string; content?: unknown }>> = [];

vi.mock("@mariozechner/pi-coding-agent", async () => {
  return await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
});

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildToolUseMessage = (model: { api: string; provider: string; id: string }) => {
    const toolCalls: Array<{
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [
      {
        type: "toolCall" as const,
        id: "tc-yield-e2e-1",
        name: "sessions_yield",
        arguments: { message: "Yielding turn." },
      },
    ];
    if (multiToolMode) {
      toolCalls.push({
        type: "toolCall" as const,
        id: "tc-post-yield-2",
        name: "read",
        arguments: { file_path: "/etc/hostname" },
      });
    }
    return {
      role: "assistant" as const,
      content: toolCalls,
      stopReason: "toolUse" as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createMockUsage(1, 1),
      timestamp: Date.now(),
    };
  };

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
      const next = responsePlan.shift() ?? "stop";
      return next === "toolUse" ? buildToolUseMessage(model) : buildStopMessage(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount++;
      const next = responsePlan.shift() ?? "stop";
      return next === "toolUse" ? buildToolUseMessage(model) : buildStopMessage(model);
    },
    streamSimple: (
      model: { api: string; provider: string; id: string },
      context: { messages?: Array<{ role?: string; content?: unknown }> },
    ) => {
      streamCallCount++;
      observedContexts.push((context.messages ?? []).map((message) => ({ ...message })));
      const next = responsePlan.shift() ?? "stop";
      const message = next === "toolUse" ? buildToolUseMessage(model) : buildStopMessage(model);
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: next === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    },
  };
});

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let e2eWorkspace: EmbeddedPiRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;

beforeAll(async () => {
  vi.useRealTimers();
  streamCallCount = 0;
  responsePlan = [];
  observedContexts = [];
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  e2eWorkspace = await createEmbeddedPiRunnerTestWorkspace("openclaw-yield-e2e-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedPiRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

const readSessionMessages = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } },
    )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message) as Array<{ role?: string; content?: unknown }>;
};

const readSessionEntries = async (sessionFile: string) =>
  (await fs.readFile(sessionFile, "utf-8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("sessions_yield e2e", () => {
  it(
    "parent session is idle after yield and preserves the follow-up payload",
    { timeout: 15_000 },
    async () => {
      streamCallCount = 0;
      responsePlan = ["toolUse"];
      observedContexts = [];

      const sessionId = "yield-e2e-parent";
      const sessionFile = path.join(workspaceDir, "session-yield-e2e.jsonl");
      const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-yield"]);

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

      // 5. The yield stops at tool time — there is no second provider call.
      expect(streamCallCount).toBe(1);

      // 6. Session transcript contains only the original assistant tool call.
      const messages = await readSessionMessages(sessionFile);
      const roles = messages.map((m) => m?.role);
      expect(roles).toContain("user");
      expect(roles.filter((r) => r === "assistant")).toHaveLength(1);

      const firstAssistant = messages.find((m) => m?.role === "assistant");
      const content = firstAssistant?.content;
      expect(Array.isArray(content)).toBe(true);
      const toolCall = (content as Array<{ type?: string; name?: string }>).find(
        (c) => c.type === "toolCall" && c.name === "sessions_yield",
      );
      expect(toolCall).toBeDefined();

      const entries = await readSessionEntries(sessionFile);
      const yieldContext = entries.find(
        (entry) =>
          entry.type === "custom_message" && entry.customType === "openclaw.sessions_yield",
      );
      expect(yieldContext).toMatchObject({
        content: expect.stringContaining("Yielding turn."),
      });

      streamCallCount = 0;
      responsePlan = ["stop"];
      observedContexts = [];
      await runEmbeddedPiAgent({
        sessionId,
        sessionKey: "agent:test:yield-e2e",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "Subagent finished with the requested result.",
        provider: "openai",
        model: "mock-yield",
        timeoutMs: 10_000,
        agentDir,
        runId: "run-yield-e2e-2",
        enqueue: immediateEnqueue,
      });

      const resumeContext = observedContexts[0] ?? [];
      const resumeTexts = resumeContext.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as Array<{ type?: string; text?: string }>)
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text ?? "")
          : [],
      );
      expect(resumeTexts.some((text) => text.includes("Yielding turn."))).toBe(true);
      expect(
        resumeTexts.some((text) => text.includes("Subagent finished with the requested result.")),
      ).toBe(true);
    },
  );

  it(
    "abort prevents subsequent tool calls from executing after yield",
    { timeout: 15_000 },
    async () => {
      streamCallCount = 0;
      multiToolMode = true;
      responsePlan = ["toolUse"];
      observedContexts = [];

      const sessionId = "yield-e2e-abort";
      const sessionFile = path.join(workspaceDir, "session-yield-abort.jsonl");
      const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-yield-abort"]);

      const result = await runEmbeddedPiAgent({
        sessionId,
        sessionKey: "agent:test:yield-abort",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "Yield and then read a file.",
        provider: "openai",
        model: "mock-yield-abort",
        timeoutMs: 10_000,
        agentDir,
        runId: "run-yield-abort-1",
        enqueue: immediateEnqueue,
      });

      // Reset for other tests
      multiToolMode = false;

      // 1. Run completed with end_turn despite the extra queued tool call
      expect(result.meta.stopReason).toBe("end_turn");

      // 2. Session is idle
      expect(isEmbeddedPiRunActive(sessionId)).toBe(false);

      // 3. The yield prevented a post-tool provider call.
      expect(streamCallCount).toBe(1);

      // 4. Transcript should contain sessions_yield but NOT a successful read result
      const messages = await readSessionMessages(sessionFile);
      const allContent = messages.flatMap((m) =>
        Array.isArray(m?.content) ? (m.content as Array<{ type?: string; name?: string }>) : [],
      );
      const yieldCall = allContent.find(
        (c) => c.type === "toolCall" && c.name === "sessions_yield",
      );
      expect(yieldCall).toBeDefined();

      // The read tool call should be in the assistant message (LLM requested it),
      // but its result should NOT show a successful file read.
      const readCall = allContent.find((c) => c.type === "toolCall" && c.name === "read");
      expect(readCall).toBeDefined(); // LLM asked for it...

      // ...but the file was never actually read (no tool result with file contents)
      const toolResults = messages.filter((m) => m?.role === "toolResult");
      const readResult = toolResults.find((tr) => {
        const content = tr?.content;
        if (typeof content === "string") {
          return content.includes("/etc/hostname");
        }
        if (Array.isArray(content)) {
          return (content as Array<{ text?: string }>).some((c) =>
            c.text?.includes("/etc/hostname"),
          );
        }
        return false;
      });
      // If the read tool ran, its result would reference the file path.
      // The abort should have prevented it from executing.
      expect(readResult).toBeUndefined();
    },
  );
});
