import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Message, Usage } from "@mariozechner/pi-ai";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

type MockModelRef = { api: string; provider: string; id: string };
type MockStreamContext = { messages?: Message[] };
type MockAssistantMessage = AssistantMessage;

function createMockUsage(input: number, output: number): Usage {
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

const piAiMockState = vi.hoisted(() => ({
  streamScenarios: new Map<
    string,
    Array<
      (params: { model: MockModelRef; context: MockStreamContext }) => {
        reason: "stop" | "error";
        message: MockAssistantMessage;
      }
    >
  >(),
  capturedContexts: [] as Array<{ modelId: string; messages: Message[] }>,
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  return await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
});

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildAssistantMessage = (model: MockModelRef): MockAssistantMessage => ({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  const buildAssistantErrorMessage = (model: MockModelRef): MockAssistantMessage => ({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "boom",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(0, 0),
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: MockModelRef) => buildAssistantMessage(model),
    completeSimple: async (model: MockModelRef) => buildAssistantMessage(model),
    streamSimple: (model: MockModelRef, context?: MockStreamContext) => {
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        const messages = Array.isArray(context?.messages) ? context.messages : [];
        piAiMockState.capturedContexts.push({ modelId: model.id, messages });
        const scenario = piAiMockState.streamScenarios.get(model.id)?.shift();
        if (scenario) {
          const result = scenario({ model, context: { messages } });
          if (result.reason === "error") {
            stream.push({
              type: "error",
              reason: "error",
              error: result.message,
            });
          } else {
            stream.push({
              type: "done",
              reason: "stop",
              message: result.message,
            });
          }
          stream.end();
          return;
        }
        stream.push({
          type: "done",
          reason: "stop",
          message:
            model.id === "mock-error"
              ? buildAssistantErrorMessage(model)
              : buildAssistantMessage(model),
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
let sessionCounter = 0;
let runCounter = 0;

beforeAll(async () => {
  vi.useRealTimers();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-thinking-signature-"));
  agentDir = path.join(tempRoot, "agent");
  workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
}, 180_000);

afterEach(() => {
  piAiMockState.streamScenarios.clear();
  piAiMockState.capturedContexts.length = 0;
});

afterAll(async () => {
  if (!tempRoot) {
    return;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

const makeAnthropicConfig = (modelId: string) =>
  ({
    models: {
      providers: {
        anthropic: {
          api: "anthropic-messages",
          apiKey: "sk-ant-test",
          baseUrl: "https://example.com",
          models: [
            {
              id: modelId,
              name: `Mock ${modelId}`,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  }) satisfies OpenClawConfig;

const nextSessionFile = () => {
  sessionCounter += 1;
  return path.join(workspaceDir, `session-${sessionCounter}.jsonl`);
};

const nextRunId = (prefix: string) => `${prefix}-${++runCounter}`;

const readSessionMessages = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { message?: { role?: string; content?: unknown } })
    .filter((entry) => entry.message)
    .map((entry) => entry.message) as Array<{ role?: string; content?: unknown }>;
};

function isAssistantMessage(message: Message | undefined): message is AssistantMessage {
  return message?.role === "assistant";
}

function isAssistantWithArrayContent(
  message: { role?: string; content?: unknown } | undefined,
): message is { role: "assistant"; content: unknown[] } {
  return message?.role === "assistant" && Array.isArray(message.content);
}

describe("runEmbeddedPiAgent anthropic thinking signature persistence", () => {
  it("keeps thinking signatures and redacted markers through session replay", async () => {
    const sessionFile = nextSessionFile();
    const sessionKey = "agent:test:thinking-signature";
    const modelId = "mock-anthropic-thinking";
    const cfg = makeAnthropicConfig(modelId);
    const thinkingSignature = "sig-thinking-123";
    const redactedSignature = "sig-redacted-456";
    const expectedContent: AssistantMessage["content"] = [
      {
        type: "thinking",
        thinking: "internal reasoning",
        thinkingSignature,
      },
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: redactedSignature,
        redacted: true,
      },
      { type: "text", text: "first reply" },
    ];

    piAiMockState.streamScenarios.set(modelId, [
      ({ model }) => ({
        reason: "stop",
        message: {
          role: "assistant",
          content: expectedContent,
          stopReason: "stop",
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: createMockUsage(1, 1),
          timestamp: Date.now(),
        },
      }),
      ({ model, context }) => {
        const priorAssistant = (context.messages ?? []).findLast(isAssistantMessage);
        expect(priorAssistant).toBeDefined();
        expect(priorAssistant?.content).toEqual(expectedContent);
        return {
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "second reply" }],
            stopReason: "stop",
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createMockUsage(1, 1),
            timestamp: Date.now(),
          },
        };
      },
    ]);

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "first prompt",
      provider: "anthropic",
      model: modelId,
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("anthropic-thinking-first"),
      disableTools: true,
      enqueue: async (task) => await task(),
    });

    const firstRunMessages = await readSessionMessages(sessionFile);
    const persistedAssistant = firstRunMessages.find((message) =>
      isAssistantWithArrayContent(message),
    );
    expect(persistedAssistant?.content).toEqual(expectedContent);

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "second prompt",
      provider: "anthropic",
      model: modelId,
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("anthropic-thinking-second"),
      disableTools: true,
      enqueue: async (task) => await task(),
    });
  });
});
