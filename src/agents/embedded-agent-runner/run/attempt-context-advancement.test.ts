import type { AssistantMessage, Message } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import {
  clearEmbeddedSessionPromptStates,
  retainEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-build.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { installEmbeddedAttemptContextGuards } from "./attempt-setup.js";

registerAgentSessionLoopTestLifecycle();
const model = makeProviderModelFixture({
  id: "synthetic-model",
  name: "Synthetic",
  api: "openai-responses",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:1",
  contextWindow: 8192,
  maxTokens: 1024,
});
const text = (value: string) => [{ type: "text" as const, text: value }];
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 0 });
const toolCall = (id: string) => [
  { type: "toolCall" as const, id, name: "read_fixture", arguments: {} },
];
const prompt = "Read the fixture.";

it.each([
  { ingestion: "afterTurn", terminal: "stop", stored: true, silentCount: 0, rounds: 1 },
  { ingestion: "ingestBatch", terminal: "aborted", stored: true, silentCount: 0, rounds: 1 },
  { ingestion: "ingest", terminal: "error", stored: false, silentCount: 0, rounds: 1 },
  { ingestion: "ingest", terminal: "stop", stored: true, silentCount: 6, rounds: 2 },
] as const)(
  "retains live exchanges through $terminal with $ingestion, stored=$stored, silent=$silentCount",
  async ({ ingestion, terminal, stored, silentCount, rounds }) => {
    const sessionId = `advancement-${ingestion}-${terminal}-${stored}-${silentCount}-${rounds}`;
    const remembered: AgentMessage[] = [];
    const storedPrefix = [user("Summary of accepted history.")];
    const history = [
      user("Earlier accepted request."),
      createAssistant(model, text("Earlier accepted answer.")),
      ...Array.from({ length: silentCount }, () => createAssistant(model, text("NO_REPLY"))),
    ];
    const assemble = vi.fn<ContextEngine["assemble"]>(async ({ messages }) => ({
      messages: stored ? storedPrefix : messages,
      estimatedTokens: 0,
    }));
    const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
      status: "committed",
    }));
    const engine: ContextEngine = {
      info: {
        id: "synthetic-engine",
        name: "Synthetic",
        ownsCompaction: true,
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      assemble,
      commitTurn,
      compact: async () => ({ ok: true, compacted: false, reason: "fits" }),
      ingest: async ({ message }) => {
        remembered.push(message);
        return { ingested: true };
      },
    };
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
    let toolCalls = 0;
    const { session } = await createTestSession({
      model,
      customTools: [
        {
          name: "read_fixture",
          label: "Read fixture",
          description: "Read fixture",
          parameters: Type.Object({}),
          execute: async () => ({
            content: text(`fixture observation ${++toolCalls}`),
            details: {},
          }),
        },
      ],
    });
    session.agent.state.messages = history;
    const requests: Message[][] = [];
    session.agent.streamFn = (_model, context) => {
      requests.push(structuredClone(context.messages));
      const round = requests.length;
      const stopReason: AssistantMessage["stopReason"] = round <= rounds ? "toolUse" : terminal;
      if (stopReason === "aborted") {
        session.agent.abort();
      }
      return createAssistantResultStream(
        createAssistant(
          model,
          round <= rounds ? toolCall(`call-${round}`) : text("done"),
          stopReason,
        ),
      );
    };
    using lease = retainEmbeddedSessionPromptState(sessionId);
    const projection = lease.state.toolResults;
    const context = await prepareEmbeddedAttemptPromptContext({
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
      toolResultPromptProjectionState: projection,
    });
    const guards = installEmbeddedAttemptContextGuards({
      activeContextEngine: engine,
      activeSession: session,
      agentDir: process.cwd(),
      attempt: {
        config: {},
        prompt,
        contextTokenBudget: 8192,
        model,
        modelId: model.id,
        provider: model.provider,
        sessionId,
        sessionKey: "agent:synthetic:main",
        sessionFile: "unused",
        onContextEngineTurnCandidate: vi.fn(),
      },
      computerContextEpoch: { value: 0 },
      dropThinkingBlocksForEstimate: false,
      effectiveCwd: process.cwd(),
      effectiveFsWorkspaceOnly: true,
      effectiveWorkspace: process.cwd(),
      getPrePromptMessageCount: () => context.prePromptMessageCount,
      getPromptCache: () => ({ retention: "none" }),
      getPromptCacheRetention: () => "none",
      getCompactionReplayEnabled: () => false,
      getServerToolClearingEnabled: () => false,
      toolResultPromptProjectionState: projection,
      getSystemPrompt: () => "system boundary text ".repeat(64),
      isOpenAIResponsesApi: false,
      repairToolUseResultPairing: false,
      sessionAgentId: "synthetic",
      sessionManager: {},
      settingsManager: { getBlockImages: () => false, getCompactionReserveTokens: () => 1024 },
    } as never);
    try {
      await submitEmbeddedAttemptPrompt({
        attempt: { sessionId },
        activeSession: session,
        contextTokenBudget: context.contextTokenBudget,
        images: [],
        modelPrompt: context.promptForModel,
        onFinalPromptText: () => {},
        persistToolResultProjections: async () => {},
        promptActiveSession: (value, options) => session.prompt(value, options),
        runtimeOnly: false,
        systemPrompt: "",
        toolResultAggregateMaxChars: context.promptToolResultAggregateMaxChars,
        toolResultMaxChars: context.promptToolResultMaxChars,
        toolResultPromptProjectionState: projection,
        trajectoryRecorder: null,
        transcriptLeafId: null,
        transcriptPrompt: context.promptForSession,
      });
      expect(requests).toHaveLength(rounds + 1);
      expect(toolCalls).toBe(rounds);
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: terminal });
      for (const [index, messages] of requests.entries()) {
        expect(messages).toMatchObject([
          ...(stored ? storedPrefix : history),
          { role: "user", content: text(prompt) },
          ...Array.from({ length: index }, (_, round) => [
            { role: "assistant", content: toolCall(`call-${round + 1}`) },
            {
              role: "toolResult",
              toolCallId: `call-${round + 1}`,
              content: text(`fixture observation ${round + 1}`),
            },
          ]).flat(),
        ]);
      }
      expect(assemble.mock.calls[1]?.[0]).toMatchObject({
        prompt,
        availableTools: new Set(["read_fixture"]),
      });
      expect(commitTurn).not.toHaveBeenCalled();
      expect(remembered).toEqual([]);
      expect(guards.getAfterTurnCheckpoint()).toBeNull();
    } finally {
      session.agent.abort();
      await session.agent.waitForIdle();
      guards.remove();
      clearEmbeddedSessionPromptStates([sessionId]);
    }
  },
);
