/** Integration coverage: Claude CLI synthetic placeholder propagates through runPreparedCliAgent into the model-fallback classifier as empty_result. */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../context-engine/types.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";

const {
  executePreparedCliRunMock,
  loadCliSessionContextEngineMessagesMock,
  loadCliSessionHistoryMessagesMock,
  getGlobalHookRunnerMock,
} = vi.hoisted(() => ({
  executePreparedCliRunMock: vi.fn(),
  loadCliSessionContextEngineMessagesMock: vi.fn(),
  loadCliSessionHistoryMessagesMock: vi.fn(),
  getGlobalHookRunnerMock: vi.fn(() => null),
}));

let runPreparedCliAgent: typeof import("./cli-runner.js").runPreparedCliAgent;
let restoreCliRunnerTestDeps: typeof import("./cli-runner.js").restoreCliRunnerTestDeps;
let setCliRunnerTestDeps: typeof import("./cli-runner.js").setCliRunnerTestDeps;

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("./cli-runner/session-history.js", () => ({
  loadCliSessionContextEngineMessages: loadCliSessionContextEngineMessagesMock,
  loadCliSessionHistoryMessages: loadCliSessionHistoryMessagesMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

function textMessage(role: "user" | "assistant", text: string, timestamp: number): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function createContextEngine(): ContextEngine {
  return {
    info: { id: "test-context-engine", name: "Test context engine" },
    ingest: vi.fn(async () => ({ ingested: true })),
    assemble: vi.fn(async (params) => ({
      messages: params.messages,
      estimatedTokens: 0,
    })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
  };
}

function buildPreparedContext(contextEngine: ContextEngine): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["--print"],
    output: "text" as const,
    input: "arg" as const,
    sessionMode: "existing" as const,
    serialize: true,
  };

  return {
    params: {
      sessionId: "openclaw-session-synthetic-placeholder",
      sessionKey: "agent:main:main",
      agentId: "main",
      sessionFile: "session.jsonl",
      workspaceDir: "/tmp/openclaw-cli-synthetic-placeholder",
      prompt: "visible ask",
      transcriptPrompt: "transcript visible ask",
      provider: "claude-cli",
      model: "Claude-Opus-4.7",
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId: "run-synthetic-placeholder",
    },
    started: Date.now(),
    workspaceDir: "/tmp/openclaw-cli-synthetic-placeholder",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "anthropic",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {
      sessionId: "external-cli-session-synthetic-placeholder",
    },
    hadSessionFile: true,
    contextEngineConfig: {},
    contextEngine,
    contextEngineTurnPrompt: "transcript visible ask",
    modelId: "Claude-Opus-4.7",
    normalizedModel: "Claude-Opus-4.7",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

describe("runPreparedCliAgent synthetic-placeholder propagation", () => {
  beforeAll(async () => {
    ({ restoreCliRunnerTestDeps, runPreparedCliAgent, setCliRunnerTestDeps } =
      await import("./cli-runner.js"));
  });

  beforeEach(() => {
    executePreparedCliRunMock.mockReset();
    loadCliSessionContextEngineMessagesMock.mockReset();
    loadCliSessionContextEngineMessagesMock.mockResolvedValue([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    loadCliSessionHistoryMessagesMock.mockReset();
    loadCliSessionHistoryMessagesMock.mockResolvedValue([]);
    getGlobalHookRunnerMock.mockReset();
    getGlobalHookRunnerMock.mockReturnValue(null);
    restoreCliRunnerTestDeps();
    setCliRunnerTestDeps({
      claudeCliSessionTranscriptHasContent: vi.fn(async () => true),
    });
  });

  it("marks runs with synthetic-placeholder terminal reply kind and triggers empty_result fallback", async () => {
    // Claude Code CLI emitted a `<synthetic>` assistant placeholder
    // ("No response requested.") and a subsequent empty result event,
    // so the parser surfaced syntheticPlaceholder=true with no visible text.
    executePreparedCliRunMock.mockResolvedValue({
      text: "",
      rawText: "",
      sessionId: "external-cli-session-synthetic-placeholder",
      usage: { input: 11, output: 0, total: 11 },
      finalPromptText: "prompt sent to cli",
      syntheticPlaceholder: true,
    });

    const result = await runPreparedCliAgent(buildPreparedContext(createContextEngine()));

    expect(result.meta.terminalReplyKind).toBe("synthetic-placeholder");
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.finalAssistantRawText).toBeUndefined();

    const classification = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "Claude-Opus-4.7",
      result,
    });

    expect(classification).toMatchObject({
      reason: "format",
      code: "empty_result",
    });
    expect(classification && "message" in classification ? classification.message : "").toContain(
      "synthetic placeholder",
    );
  });

  it("does not mark ordinary CLI runs and leaves the classifier null", async () => {
    executePreparedCliRunMock.mockResolvedValue({
      text: "real answer",
      rawText: "real answer",
      sessionId: "external-cli-session-synthetic-placeholder",
      usage: { input: 11, output: 7, total: 18 },
      finalPromptText: "prompt sent to cli",
    });

    const result = await runPreparedCliAgent(buildPreparedContext(createContextEngine()));

    expect(result.meta.terminalReplyKind).toBeUndefined();
    expect(result.meta.finalAssistantVisibleText).toBe("real answer");

    const classification = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "Claude-Opus-4.7",
      result,
    });
    expect(classification).toBeNull();
  });
});
