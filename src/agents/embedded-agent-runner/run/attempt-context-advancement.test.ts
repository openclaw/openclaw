import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Message,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
import { Agent, type AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  retainEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { installContextEngineLoopHook } from "../tool-result-context-guard.js";
import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-build.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { installEmbeddedAttemptContextGuards } from "./attempt-setup.js";

registerAgentSessionLoopTestLifecycle();

const model: Model = makeProviderModelFixture({
  id: "synthetic-model",
  name: "Synthetic",
  api: "openai-responses",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:1",
  contextWindow: 8192,
  maxTokens: 1024,
});
const promptText = "Read the fixture.";
function makeStoredPrefix() {
  return [userMessage("Summary of accepted history.")];
}
function userMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: 0 };
}
function text(value: string) {
  return [{ type: "text" as const, text: value }];
}
function toolCall(id: string) {
  return [{ type: "toolCall" as const, id, name: "read_fixture", arguments: {} }];
}
function guardAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  timestamp = 0,
) {
  return {
    ...createAssistant(model, content, stopReason),
    timestamp,
    usage: createZeroUsageFixture(),
  };
}
function fixtureTool<P, E>(parameters: P, execute: E) {
  return {
    name: "read_fixture",
    label: "Read fixture",
    description: "Read fixture",
    parameters,
    execute,
  };
}
function makeEngine(
  storedPrefix = makeStoredPrefix(),
  overrides: Partial<ContextEngine> = {},
): ContextEngine {
  return {
    info: {
      id: "synthetic-engine",
      name: "Synthetic",
      ownsCompaction: true,
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
        turnAdvancementIdempotency: "atomic-idempotent-v1",
      },
    },
    ingest: async () => ({ ingested: true }),
    assemble: async () => ({ messages: storedPrefix, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false, reason: "fits" }),
    commitTurn: async () => ({ status: "committed" }),
    ...overrides,
  };
}

describe("context advancement through embedded attempt guards", () => {
  it.each([
    { ingestion: "afterTurn", terminal: "stop", assembly: "stored-prefix" },
    { ingestion: "afterTurn", terminal: "error", assembly: "live-input" },
    { ingestion: "ingestBatch", terminal: "aborted", assembly: "stored-prefix" },
    { ingestion: "ingestBatch", terminal: "stop", assembly: "live-input" },
    { ingestion: "ingest", terminal: "error", assembly: "stored-prefix" },
    { ingestion: "ingest", terminal: "aborted", assembly: "live-input" },
  ] as const)(
    "preserves live context with $assembly assembly and defers $ingestion after $terminal",
    async ({ ingestion, terminal, assembly }) => {
      const remembered: AgentMessage[] = [];
      const storedPrefix = makeStoredPrefix();
      const history: AgentMessage[] = [
        userMessage("Earlier accepted request."),
        guardAssistant(text("Earlier accepted answer.")),
      ];
      const assemble = vi.fn<ContextEngine["assemble"]>(async ({ messages }) => ({
        messages: assembly === "stored-prefix" ? storedPrefix : messages,
        estimatedTokens: 0,
      }));
      const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
        status: "committed",
      }));
      const engine = makeEngine(storedPrefix, {
        ingest: async ({ message }) => {
          remembered.push(message);
          return { ingested: true };
        },
        assemble,
        commitTurn,
      });
      if (ingestion === "afterTurn") {
        engine.afterTurn = async ({ messages, prePromptMessageCount }) => {
          remembered.push(...messages.slice(prePromptMessageCount));
        };
      } else if (ingestion === "ingestBatch") {
        engine.ingestBatch = async ({ messages }) => {
          remembered.push(...messages);
          return { ingestedCount: messages.length };
        };
      }
      let providerCalls = 0;
      let secondModelMessages: Message[] | undefined;
      const execute = vi.fn(async () => ({
        content: text("fixture observation"),
        details: {},
      }));
      const agent = new Agent({
        initialState: {
          model,
          messages: history,
          tools: [fixtureTool({ type: "object", properties: {} }, execute)],
        },
        streamFn: (_model, context) => {
          providerCalls++;
          if (providerCalls === 2) {
            secondModelMessages = structuredClone(context.messages);
          }
          const stopReason = providerCalls === 1 ? "toolUse" : terminal;
          if (stopReason === "aborted") {
            agent.abort();
          }
          const message = guardAssistant(
            stopReason === "toolUse" ? toolCall("read-1") : text("done"),
            stopReason,
            1,
          );
          const stream = createAssistantMessageEventStream();
          stream.push(
            stopReason === "error" || stopReason === "aborted"
              ? { type: "error", reason: stopReason, error: message }
              : { type: "done", reason: stopReason, message },
          );
          stream.end();
          return stream;
        },
      });
      const guards = installEmbeddedAttemptContextGuards({
        activeContextEngine: engine,
        activeSession: { agent },
        agentDir: process.cwd(),
        attempt: {
          config: {},
          prompt: promptText,
          contextTokenBudget: 8192,
          model,
          modelId: model.id,
          provider: model.provider,
          sessionId: "synthetic-session",
          sessionKey: "agent:synthetic:main",
          sessionFile: "unused",
          onContextEngineTurnCandidate: vi.fn(),
        },
        computerContextEpoch: { value: 0 },
        dropThinkingBlocksForEstimate: false,
        effectiveCwd: process.cwd(),
        effectiveFsWorkspaceOnly: true,
        effectiveWorkspace: process.cwd(),
        getPrePromptMessageCount: () => history.length,
        getPromptCache: () => ({ retention: "none" }),
        getPromptCacheRetention: () => "none",
        getCompactionReplayEnabled: () => false,
        getServerToolClearingEnabled: () => false,
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        getSystemPrompt: () => "system boundary text ".repeat(64),
        isOpenAIResponsesApi: false,
        repairToolUseResultPairing: false,
        sessionAgentId: "synthetic",
        sessionManager: {},
        settingsManager: { getBlockImages: () => false, getCompactionReserveTokens: () => 1024 },
      } as never);
      try {
        await agent.prompt(promptText);
        expect(providerCalls).toBe(2);
        expect(execute).toHaveBeenCalledOnce();
        expect(
          agent.state.messages.toReversed().find((message) => message.role === "assistant")
            ?.stopReason,
        ).toBe(terminal);
        expect(assemble).toHaveBeenCalledTimes(2);
        expect(secondModelMessages).toMatchObject([
          ...(assembly === "stored-prefix" ? storedPrefix : history),
          { role: "user", content: text(promptText) },
          { role: "assistant", content: toolCall("read-1") },
          {
            role: "toolResult",
            toolCallId: "read-1",
            content: text("fixture observation"),
          },
        ]);
        expect(assemble.mock.calls[1]?.[0]).toMatchObject({
          prompt: promptText,
          availableTools: new Set(["read_fixture"]),
          // (8192 context - 1024 reserve - 568 precheck pressure for the system
          // prompt, tool schema and pending exchange) / 1.2 safety margin.
          tokenBudget: 5500,
        });
        expect(commitTurn).not.toHaveBeenCalled();
        expect(remembered).toEqual([]);
        expect(guards.getAfterTurnCheckpoint()).toBeNull();
      } finally {
        agent.abort();
        await agent.waitForIdle();
        guards.remove();
      }
    },
  );

  it.each([0, 6])(
    "preserves active content across %i silent replay messages",
    async (silentCount) => {
      const prompt = "Perform task with tools.";
      const sessionId = `replay-boundary-${silentCount}`;
      const engine = makeEngine();
      let toolCalls = 0;
      const { session } = await createTestSession({
        model,
        customTools: [
          fixtureTool(Type.Object({}), async () => ({
            content: text(`fixture observation ${++toolCalls}`),
            details: {},
          })),
        ],
      });
      session.agent.state.messages = [
        userMessage("Earlier accepted request."),
        createAssistant(model, text("Earlier accepted answer.")),
        ...Array.from({ length: silentCount }, () => createAssistant(model, text("NO_REPLY"))),
      ];
      const modelRequests: Message[][] = [];
      session.agent.streamFn = (_model, context) => {
        modelRequests.push(structuredClone(context.messages));
        const round = modelRequests.length;
        return createAssistantResultStream(
          createAssistant(
            model,
            round <= 2 ? toolCall(`call-${round}`) : text("done"),
            round <= 2 ? "toolUse" : "stop",
          ),
        );
      };
      using promptStateLease = retainEmbeddedSessionPromptState(sessionId);
      const sessionPromptState = promptStateLease.state;
      const promptContext = await prepareEmbeddedAttemptPromptContext({
        attempt: { config: {}, contextTokenBudget: 8192, sessionId },
        capabilityToolNames: new Set(["read_fixture"]),
        includeBoundaryTimestamp: false,
        isRawModelRun: false,
        messages: session.messages,
        prompt: { effectivePrompt: prompt, effectiveTranscriptPrompt: prompt },
        replaceSessionMessages: (messages) => {
          session.agent.state.messages = messages;
        },
        sessionAgentId: "synthetic",
        systemPromptText: "",
        toolResultPromptProjectionState: sessionPromptState.toolResults,
      });
      const removeLoopHook = installContextEngineLoopHook({
        agent: session.agent,
        contextEngine: engine,
        sessionId,
        sessionFile: "unused",
        tokenBudget: 8192,
        modelId: model.id,
        getPrePromptMessageCount: () => promptContext.prePromptMessageCount,
        deferredTurn: { prompt, availableTools: new Set(["read_fixture"]) },
      });
      try {
        await submitEmbeddedAttemptPrompt({
          attempt: { sessionId },
          activeSession: session,
          contextTokenBudget: promptContext.contextTokenBudget,
          images: [],
          modelPrompt: promptContext.promptForModel,
          onFinalPromptText: () => {},
          persistToolResultProjections: async () => {},
          promptActiveSession: (value, options) => session.prompt(value, options),
          runtimeOnly: false,
          systemPrompt: "",
          toolResultAggregateMaxChars: promptContext.promptToolResultAggregateMaxChars,
          toolResultMaxChars: promptContext.promptToolResultMaxChars,
          toolResultPromptProjectionState: sessionPromptState.toolResults,
          trajectoryRecorder: null,
          transcriptLeafId: null,
          transcriptPrompt: promptContext.promptForSession,
        });
        expect(modelRequests).toHaveLength(3);
        expect(toolCalls).toBe(2);
        for (const [index, messages] of modelRequests.entries()) {
          const contains = (message: object) =>
            expect(messages).toContainEqual(expect.objectContaining(message));
          contains({ role: "user", content: text(prompt) });
          for (let round = 1; round <= index; round++) {
            contains({ role: "assistant", content: toolCall(`call-${round}`) });
            contains({
              role: "toolResult",
              toolCallId: `call-${round}`,
              content: text(`fixture observation ${round}`),
            });
          }
        }
      } finally {
        removeLoopHook();
        clearEmbeddedSessionPromptStates([sessionId]);
      }
    },
  );
});
