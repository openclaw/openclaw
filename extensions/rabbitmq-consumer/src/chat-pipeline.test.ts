import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger, PluginRuntime } from "../api.js";
import { processChatMessage } from "./chat-pipeline.js";
import type { HistoryManager } from "./history-manager.js";
import type { ChatMessage, MercureConfig } from "./types.js";

type AgentEventListener = (evt: {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
}) => void;

const USER_ID = "42";
const SESSION_ID = "s1";
const SESSION_KEY = `agent:rabbitmq-${USER_ID}:rabbitmq:${USER_ID}:${SESSION_ID}`;

function createChatMessage(): ChatMessage {
  return {
    historyId: 1,
    message: "hi there",
    sessionId: SESSION_ID,
    userId: USER_ID,
    useMemory: true,
    useWebsearch: false,
  };
}

function createHistoryManagerMock() {
  const updateResponse = vi.fn(async () => {});
  const historyManager = {
    getRecord: async () => ({
      id: 1,
      sessionId: SESSION_ID,
      userId: USER_ID,
      message: "hi there",
      response: null,
      toolsUsed: null,
      metadata: null,
      createdAt: new Date(),
    }),
    updateResponse,
  } as unknown as HistoryManager;
  return { historyManager, updateResponse };
}

function createRuntimeMock(options: {
  workspaceDir: string;
  onRun: (listener: AgentEventListener | undefined) => void;
  sessionMessages?: unknown[];
}): PluginRuntime {
  let listener: AgentEventListener | undefined;
  return {
    events: {
      onAgentEvent: (fn: AgentEventListener) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    subagent: {
      run: async () => {
        options.onRun(listener);
        return { runId: "r1" };
      },
      waitForRun: async () => ({ status: "ok" as const }),
      getSessionMessages: async () => ({ messages: options.sessionMessages ?? [] }),
    },
    agent: {
      resolveAgentWorkspaceDir: () => options.workspaceDir,
    },
  } as unknown as PluginRuntime;
}

describe("processChatMessage", () => {
  let workspaceDir: string;
  const mercureConfig: MercureConfig = {
    hubUrl: "http://127.0.0.1:9/.well-known/mercure",
    jwtSecret: "test-secret",
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as PluginLogger;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "chat-pipeline-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("forwards only assistant deltas matching this run's sessionKey", async () => {
    // Regression: the listener used to forward EVERY assistant delta in the
    // gateway process; concurrent runs (report subagent, other sessions)
    // leaked into this user's stream as a second "typing" bubble.
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "assistant",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: { delta: "hello" },
        });
        // Concurrent report subagent for another user — must be dropped.
        listener?.({
          runId: "r2",
          seq: 1,
          stream: "assistant",
          ts: 2,
          sessionKey: "agent:rabbitmq-99:report-gen:99:1700000000000",
          data: { delta: "LEAK" },
        });
        // Event without sessionKey — must be dropped.
        listener?.({
          runId: "r3",
          seq: 1,
          stream: "assistant",
          ts: 3,
          data: { delta: "NOKEY" },
        });
        // Non-assistant stream — must be dropped.
        listener?.({
          runId: "r1",
          seq: 2,
          stream: "tool",
          ts: 4,
          sessionKey: SESSION_KEY,
          data: { delta: "TOOL" },
        });
      },
    });
    const { historyManager, updateResponse } = createHistoryManagerMock();

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(result).toBe("hello");
    expect(result).not.toContain("LEAK");
    expect(updateResponse).toHaveBeenCalledWith(1, "hello");
  });

  it("prefers the latest assistant session message as the canonical response", async () => {
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "assistant",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: { delta: "partial stream" },
        });
      },
      sessionMessages: [
        { role: "user", content: "hi there" },
        { role: "assistant", content: "full canonical answer" },
      ],
    });
    const { historyManager, updateResponse } = createHistoryManagerMock();

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(result).toBe("full canonical answer");
    expect(updateResponse).toHaveBeenCalledWith(1, "full canonical answer");
  });
});
