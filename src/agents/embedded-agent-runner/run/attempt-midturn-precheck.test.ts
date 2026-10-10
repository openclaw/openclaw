import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "../../../llm/types.js";
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
  ])("$name", async ({ usage, chars, cap, fits, growSystem }) => {
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    const model = {
      ...testModel,
      api: "openai-completions" as const,
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
            }
            return { content: [{ type: "text", text: "r".repeat(chars) }], details: {} };
          },
        },
      ],
    });
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
      isOpenAIResponsesApi: false,
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
    runtime.isOpenAIResponsesApi = false;
    runtime.transcriptPolicy = { ...runtime.transcriptPolicy, repairToolUseResultPairing: false };
    session.agent.streamFn = (_model, context) => {
      requests.push({ ...context, messages: structuredClone(context.messages) });
      const message = createAssistant(
        model,
        requests.length === 1
          ? [{ type: "toolCall", id: "read-report", name: "read", arguments: {} }]
          : [{ type: "text", text: "Report received." }],
        requests.length === 1 ? "toolUse" : "stop",
        usage,
      );
      if (!usage) {
        message.usage.contextUsage = { state: "unavailable" };
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
  });
});
