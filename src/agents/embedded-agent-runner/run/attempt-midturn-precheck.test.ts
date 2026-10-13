import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "../../../llm/types.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { createEmbeddedModelState } from "../../embedded-agent-subscribe.model-state.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { makeZeroUsageSnapshot } from "../../usage.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput } from "./attempt-prompt-submit.test-support.js";
import { installEmbeddedAttemptContextGuards } from "./attempt-setup.js";

const { createFixture } = await vi.hoisted(
  async () => await import("./attempt-execution-phase.test-support.js"),
);
const { installEmbeddedAttemptStreamGuards } =
  await vi.importActual<typeof import("./attempt-stream.js")>("./attempt-stream.js");

registerAgentSessionLoopTestLifecycle();

describe("mid-turn provider admission", () => {
  it.each([
    { name: "measured unchanged prefix", usage: 15_000, chars: 12_000, cap: 16_000, fits: true },
    {
      name: "counts measured visible completion once",
      usage: 15_000,
      chars: 2_000,
      cap: 16_000,
      fits: true,
      completionTokens: 6_000,
      assistantChars: 24_000,
    },
    {
      name: "counts async completion fragments once when the provider identity arrives late",
      usage: 15_000,
      chars: 2_000,
      cap: 16_000,
      fits: true,
      completionTokens: 6_000,
      assistantChars: 24_000,
      asyncFragments: true,
    },
    {
      name: "counts an unrelated synthetic assistant appended after the measured prefix",
      usage: 15_000,
      chars: 2_000,
      cap: 16_000,
      fits: false,
      syntheticAssistant: true,
    },
    {
      name: "retains opaque reasoning occupancy",
      usage: 15_000,
      chars: 12_000,
      cap: 16_000,
      fits: false,
      opaque: true,
      completionTokens: 16_000,
    },
    {
      name: "retains opaque reasoning after a small system change",
      usage: 15_000,
      chars: 2_000,
      cap: 16_000,
      fits: false,
      opaque: true,
      completionTokens: 16_000,
      tweakSystem: true,
    },
    {
      name: "measured oversized tail after projection",
      usage: 14_000,
      chars: 100_000,
      cap: 16_000,
      fits: true,
    },
    {
      name: "unavailable usage after projection",
      usage: 0,
      chars: 100_000,
      cap: 2_000,
      fits: true,
    },
    {
      name: "genuinely oversized measured tail",
      usage: 23_000,
      chars: 12_000,
      cap: 16_000,
      fits: false,
    },
    {
      name: "unavailable usage with oversized prompt",
      usage: 0,
      chars: 12_000,
      cap: 16_000,
      fits: false,
      growSystem: true,
    },
    {
      name: "changed system invalidates measured prefix",
      usage: 1_000,
      chars: 12_000,
      cap: 16_000,
      fits: false,
      growSystem: true,
    },
  ])(
    "$name",
    async ({
      usage,
      chars,
      cap,
      fits,
      growSystem,
      tweakSystem,
      opaque,
      completionTokens,
      assistantChars,
      asyncFragments,
      syntheticAssistant,
    }) => {
      const fixture = await createFixture({ exerciseTerminalMerges: false });
      const model = {
        ...testModel,
        api: opaque ? ("openai-responses" as const) : ("openai-completions" as const),
        contextWindow: 32_768,
        maxTokens: 1_024,
      };
      const systemPrompt = "Keep these instructions. ".repeat(2_200);
      const requests: Context[] = [];
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 8_192 },
        retry: { enabled: false },
      });
      const { session, sessionManager } = await createTestSession({
        model,
        systemPrompt,
        settingsManager,
        contextOverflowRecoveryOwner: "caller",
        customTools: [
          {
            name: "read",
            label: "Read",
            description: "Read the report",
            parameters: Type.Object({}),
            execute: async () => {
              if (growSystem) {
                session.setBaseSystemPrompt("Additional instructions. ".repeat(6_000));
              } else if (tweakSystem) {
                session.setBaseSystemPrompt(`${systemPrompt}Prefer concise answers.`);
              }
              return { content: [{ type: "text", text: "r".repeat(chars) }], details: {} };
            },
          },
        ],
      });
      if (syntheticAssistant) {
        session.agent.transformContext = async (messages) =>
          messages.some((message) => message.role === "toolResult")
            ? [
                ...messages,
                createAssistant(model, [{ type: "text", text: "s".repeat(40_000) }], "stop", 0),
              ]
            : messages;
      }
      Object.assign(fixture.input.attempt, {
        config: { agents: { defaults: { compaction: { midTurnPrecheck: { enabled: true } } } } },
        contextTokenBudget: model.contextWindow,
        model,
        modelId: model.id,
        provider: model.provider,
        sessionId: session.sessionId,
      });
      const projectionState = createToolResultPromptProjectionState();
      const guards = installEmbeddedAttemptContextGuards({
        activeSession: session,
        agentDir: "/fixture/agent",
        attempt: fixture.input.attempt,
        computerContextEpoch: { value: 0 },
        dropThinkingBlocksForEstimate: false,
        effectiveCwd: "/fixture",
        effectiveFsWorkspaceOnly: true,
        effectiveWorkspace: "/fixture",
        getPrePromptMessageCount: () => 0,
        getPromptCache: () => undefined,
        getPromptCacheRetention: () => "none",
        getCompactionReplayEnabled: () => false,
        getServerToolClearingEnabled: () => false,
        toolResultPromptProjectionState: projectionState,
        getSystemPrompt: () => session.agent.state.systemPrompt,
        isOpenAIResponsesApi: opaque === true,
        repairToolUseResultPairing: false,
        sessionAgentId: "main",
        sessionManager,
        settingsManager,
      });
      const runtime = fixture.input.prepared.sessionRuntime;
      runtime.agentSession.activeSession = session;
      runtime.contextGuards = guards;
      runtime.sessionManager = sessionManager;
      runtime.anthropicPayloadLogger = null;
      runtime.cacheTrace = null;
      runtime.isOpenAIResponsesApi = opaque === true;
      runtime.transcriptPolicy = { ...runtime.transcriptPolicy, repairToolUseResultPairing: false };
      session.agent.streamFn = (_model, context) => {
        requests.push({ ...context, messages: structuredClone(context.messages) });
        const toolCall = {
          type: "toolCall" as const,
          id: "read-report",
          name: "read",
          arguments: {},
          ...(asyncFragments ? { async: true as const } : {}),
        };
        const message = createAssistant(
          model,
          requests.length === 1 ? [toolCall] : [{ type: "text", text: "Report received." }],
          requests.length === 1 ? "toolUse" : "stop",
          usage,
        );
        if (!usage) {
          message.usage.contextUsage = { state: "unavailable" };
        }
        if (opaque && requests.length === 1) {
          message.content.unshift({
            type: "thinking",
            thinking: "Brief summary.",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              id: "rs_fixture",
              encrypted_content: "opaque-fixture",
              summary: [],
            }),
          });
        }
        if (assistantChars && requests.length === 1) {
          message.content.unshift({ type: "text", text: "v".repeat(assistantChars) });
        }
        if (completionTokens !== undefined && requests.length === 1) {
          message.usage.output = completionTokens;
          message.usage.totalTokens = usage + completionTokens;
          message.usage.contextUsage = {
            state: "available",
            promptTokens: usage,
            totalTokens: usage + completionTokens,
          };
        }
        if (asyncFragments && requests.length === 1) {
          const response = createAssistantMessageEventStream();
          response.push({
            type: "start",
            partial: { ...message, content: [], usage: makeZeroUsageSnapshot() },
          });
          response.push({
            type: "toolcall_end",
            contentIndex: message.content.length - 1,
            toolCall,
            partial: { ...message, usage: makeZeroUsageSnapshot() },
          });
          response.push({
            type: "done",
            reason: "toolUse",
            message: { ...message, responseId: "response-with-late-identity" },
          });
          response.end();
          return response;
        }
        return createAssistantResultStream(message);
      };
      const streamGuards = installEmbeddedAttemptStreamGuards(fixture.input, {
        onRejectedProviderReplayRepaired: vi.fn(),
        onIdleTimeout: vi.fn(),
        diagnosticOwner: createDiagnosticEmbeddedRunOwner({
          runId: fixture.input.attempt.runId,
          sessionId: session.sessionId,
        }),
      });
      const modelState = createEmbeddedModelState(
        {
          session,
          runId: fixture.input.attempt.runId,
          onModelUsage: streamGuards.onModelUsage,
        },
        { warn: vi.fn() },
      );
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_start" ||
          event.type === "message_update" ||
          event.type === "message_end"
        ) {
          modelState.captureModelEvent(event);
        }
      });
      try {
        await submitEmbeddedAttemptPrompt({
          ...createBaseInput(),
          attempt: fixture.input.attempt,
          activeSession: session,
          contextTokenBudget: model.contextWindow,
          systemPrompt,
          modelPrompt: "Read the report.",
          transcriptPrompt: "Read the report.",
          prependContext: undefined,
          appendContext: undefined,
          toolResultMaxChars: cap,
          toolResultAggregateMaxChars: cap * 4,
          toolResultPromptProjectionState: projectionState,
          onModelRequest: streamGuards.onModelRequest,
          preparePrimaryModelRequest: () =>
            Promise.resolve(() => ({
              systemPrompt: session.agent.state.systemPrompt,
              tools: session.agent.state.tools,
            })),
          promptActiveSession: (prompt, options) => session.prompt(prompt, options),
        });
        expect(requests, session.agent.state.errorMessage).toHaveLength(fits ? 2 : 1);
        expect(guards.takePendingMidTurnPrecheckRequest() !== null).toBe(!fits);
        if (fits) {
          const sent = requests[1]?.messages.find((message) => message.role === "toolResult");
          expect(sent?.content).toEqual([{ type: "text", text: expect.any(String) }]);
          const text = sent?.content[0];
          expect(text?.type === "text" && text.text.length <= cap).toBe(true);
          expect(session.messages.at(-1)).toMatchObject({
            role: "assistant",
            content: [{ type: "text", text: "Report received." }],
          });
        }
      } finally {
        unsubscribe();
        guards.remove();
      }
    },
  );
});
