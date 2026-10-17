import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
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

type Variant =
  | "plain"
  | "engine"
  | "assembly"
  | "system"
  | "tools"
  | "fragments"
  | "fragments-system"
  | "synthetic"
  | "opaque"
  | "opaque-system"
  | "grow-system";
type Scenario = [
  name: string,
  usage: number,
  chars: number,
  cap: number,
  fits: boolean,
  variant?: Variant,
  completionTokens?: number,
  assistantChars?: number,
];

describe("provider request admission", () => {
  it.each<Scenario>([
    ["engine: oversized first assembly", 15_000, 12_000, 16_000, false, "assembly"],
    ["engine: exaggerated estimate", 15_000, 12_000, 16_000, true, "engine"],
    ["engine: oversized continuation", 23_000, 12_000, 16_000, false, "engine"],
    ["measured unchanged prefix", 15_000, 12_000, 16_000, true],
    ["visible completion counted once", 15_000, 2_000, 16_000, true, "plain", 6_000, 24_000],
    ["completion after system change", 15_000, 2_000, 16_000, true, "system", 5_000, 20_000],
    ["completion after tool change", 15_000, 2_000, 16_000, true, "tools", 5_000, 20_000],
    ["system + fragments", 15_000, 2_000, 16_000, true, "fragments-system", 5_000, 20_000],
    ["fragments with late identity", 15_000, 2_000, 16_000, true, "fragments", 6_000, 24_000],
    ["unrelated synthetic assistant", 15_000, 2_000, 16_000, false, "synthetic"],
    ["opaque reasoning occupancy", 15_000, 12_000, 16_000, false, "opaque", 16_000],
    ["opaque after system change", 15_000, 2_000, 16_000, false, "opaque-system", 16_000],
    ["measured tail after projection", 14_000, 100_000, 16_000, true],
    ["unavailable usage after projection", 0, 100_000, 2_000, true],
    ["genuinely oversized measured tail", 23_000, 12_000, 16_000, false],
    ["unavailable usage, oversized prompt", 0, 12_000, 16_000, false, "grow-system"],
    ["system invalidates measured prefix", 1_000, 12_000, 16_000, false, "grow-system"],
  ])("%s", async (_name, usage, chars, cap, fits, variant, completionTokens, assistantChars) => {
    const ownsCompaction = variant === "engine" || variant === "assembly";
    const oversizedAssembly = variant === "assembly";
    const opaque = variant === "opaque" || variant === "opaque-system";
    const asyncFragments = variant === "fragments" || variant === "fragments-system";
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
            if (variant === "grow-system") {
              session.setBaseSystemPrompt("Additional instructions. ".repeat(6_000));
            } else if (
              variant === "system" ||
              variant === "fragments-system" ||
              variant === "opaque-system"
            ) {
              session.setBaseSystemPrompt(`${systemPrompt}Prefer concise answers.`);
            } else if (variant === "tools") {
              session.agent.state.tools = session.agent.state.tools.map((tool) => ({
                ...tool,
                description: `${tool.description}. Return the report.`,
              }));
            }
            return { content: [{ type: "text", text: "r".repeat(chars) }], details: {} };
          },
        },
      ],
    });
    if (variant === "synthetic") {
      session.agent.transformContext = async (messages) =>
        messages.some((message) => message.role === "toolResult")
          ? [
              ...messages,
              createAssistant(model, [{ type: "text", text: "s".repeat(40_000) }], "stop", 0),
            ]
          : messages;
    }
    const activeContextEngine: ContextEngine | undefined = ownsCompaction
      ? {
          info: { id: "fixture", name: "Fixture", ownsCompaction: true },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }) => ({
            messages: oversizedAssembly
              ? [{ role: "user", content: "history ".repeat(40_000), timestamp: 1 }, ...messages]
              : messages,
            estimatedTokens: oversizedAssembly ? 1 : 1_000_000,
          }),
          compact: async () => ({ ok: false, compacted: false }),
        }
      : undefined;
    fixture.input.activeContextEngine = activeContextEngine;
    Object.assign(fixture.input.attempt, {
      config: ownsCompaction
        ? {}
        : { agents: { defaults: { compaction: { midTurnPrecheck: { enabled: true } } } } },
      contextTokenBudget: model.contextWindow,
      model,
      modelId: model.id,
      provider: model.provider,
      sessionId: session.sessionId,
    });
    const projectionState = createToolResultPromptProjectionState();
    const guards = installEmbeddedAttemptContextGuards({
      activeContextEngine,
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
        promptActiveSession: (prompt, options) => session.prompt(prompt, options),
      });
      const pendingPrecheck = guards.takePendingMidTurnPrecheckRequest();
      expect(requests, JSON.stringify(pendingPrecheck)).toHaveLength(
        oversizedAssembly ? 0 : fits ? 2 : 1,
      );
      expect(pendingPrecheck !== null).toBe(!fits);
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
