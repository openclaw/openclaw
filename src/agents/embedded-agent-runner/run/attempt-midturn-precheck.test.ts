import { Type } from "typebox";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../../../packages/ai/src/host.js";
import { createOpenAICompletionsTransportStreamFn } from "../../../../packages/ai/src/transports/openai-completions-transport.js";
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
import { SessionManager } from "../../sessions/session-manager.js";
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

describe("provider request admission", () => {
  it.each([
    {
      name: "measured compatible reasoning output budget",
      usage: 1_500,
      chars: 15_500,
      cap: 16_000,
      fits: true,
      compatibleBudget: true,
    },
    {
      name: "unchanged response schema is not charged twice on a tool continuation",
      usage: 24_000,
      chars: 100,
      cap: 16_000,
      fits: true,
      compatibleBudget: true,
      responseSchema: true,
    },
    {
      name: "owning engine cannot submit oversized assembled history on its first request",
      usage: 15_000,
      chars: 12_000,
      cap: 16_000,
      fits: false,
      ownsCompaction: true,
      oversizedAssembly: true,
    },
    {
      name: "owning engine admits fitting requests despite an exaggerated engine estimate",
      usage: 15_000,
      chars: 12_000,
      cap: 16_000,
      fits: true,
      ownsCompaction: true,
    },
    {
      name: "owning engine blocks an oversized measured continuation without opt-in",
      usage: 23_000,
      chars: 12_000,
      cap: 16_000,
      fits: false,
      ownsCompaction: true,
    },
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
      name: "counts visible completion once after a small system change",
      usage: 15_000,
      chars: 2_000,
      cap: 16_000,
      fits: true,
      completionTokens: 5_000,
      assistantChars: 20_000,
      tweakSystem: true,
    },
    {
      name: "counts visible completion once after tool definitions change",
      usage: 15_000,
      chars: 2_000,
      cap: 16_000,
      fits: true,
      completionTokens: 5_000,
      assistantChars: 20_000,
      tweakTools: true,
    },
    {
      name: "counts split visible completion once after a small system change",
      usage: 15_000,
      chars: 2_000,
      cap: 16_000,
      fits: true,
      completionTokens: 5_000,
      assistantChars: 20_000,
      asyncFragments: true,
      tweakSystem: true,
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
      tweakTools,
      opaque,
      completionTokens,
      assistantChars,
      asyncFragments,
      syntheticAssistant,
      ownsCompaction,
      oversizedAssembly,
      compatibleBudget,
      responseSchema,
    }) => {
      const fixture = await createFixture({ exerciseTerminalMerges: false });
      const model = {
        ...testModel,
        api: opaque ? ("openai-responses" as const) : ("openai-completions" as const),
        contextWindow: 32_768,
        maxTokens: compatibleBudget ? 8_192 : 1_024,
        ...(compatibleBudget
          ? {
              provider: "reasoning-proof",
              baseUrl: "http://127.0.0.1:19831/v1",
              reasoning: true,
              compat: { maxTokensField: "max_tokens" as const },
            }
          : {}),
      };
      const systemPrompt = compatibleBudget
        ? "Read the report."
        : "Keep these instructions. ".repeat(2_200);
      const reasoningHistory = "synthetic reasoning ".repeat(3_500);
      const seededManager =
        compatibleBudget && !responseSchema ? SessionManager.inMemory() : undefined;
      if (seededManager) {
        await seededManager.appendMessageAsync({
          role: "user",
          content: "Earlier question.",
          timestamp: 1,
        });
        await seededManager.appendMessageAsync({
          ...createAssistant(model, [
            {
              type: "thinking",
              thinking: reasoningHistory,
              thinkingSignature: "reasoning_content",
            },
            { type: "text", text: "Earlier answer." },
          ]),
          usage: makeZeroUsageSnapshot(),
        });
      }
      const requests: Context[] = [];
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 8_192 },
        retry: { enabled: false },
      });
      const { session, sessionManager } = await createTestSession({
        model,
        systemPrompt,
        ...(seededManager ? { sessionManager: seededManager } : {}),
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
              } else if (tweakTools) {
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
      if (syntheticAssistant) {
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
      const wireRequests: Array<{
        max_tokens?: number;
        messages: Array<Record<string, unknown>>;
        response_format?: unknown;
      }> = [];
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
      if (compatibleBudget) {
        const host = getAiTransportHost();
        onTestFinished(() => configureAiTransportHost(host));
        configureAiTransportHost({
          ...host,
          resolveProviderRequestCapabilities: (input) => ({
            ...host.resolveProviderRequestCapabilities(input),
            usesExplicitProxyLikeEndpoint: true,
          }),
          buildModelFetch: () => async (input, init) => {
            wireRequests.push(await new Request(input, init).json());
            const first = wireRequests.length === 1;
            const event = {
              id: `chatcmpl-fixture-${wireRequests.length}`,
              object: "chat.completion.chunk",
              created: 1,
              model: model.id,
              choices: [
                {
                  index: 0,
                  finish_reason: first ? "tool_calls" : "stop",
                  delta: first
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: "read-report",
                            type: "function",
                            function: { name: "read", arguments: "{}" },
                          },
                        ],
                      }
                    : { content: "Report received." },
                },
              ],
              usage: { prompt_tokens: usage, completion_tokens: 64, total_tokens: usage + 64 },
            };
            return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
              headers: { "content-type": "text/event-stream" },
            });
          },
        });
        const transport = createOpenAICompletionsTransportStreamFn();
        const responseFormat = responseSchema
          ? {
              type: "json_schema",
              json_schema: {
                name: "report",
                schema: { type: "string", description: "x".repeat(16_000) },
              },
            }
          : undefined;
        session.agent.streamFn = (activeModel, context, options) => {
          requests.push({ ...context, messages: structuredClone(context.messages) });
          return transport(activeModel, context, {
            ...options,
            apiKey: "synthetic-key",
            responseFormat,
          });
        };
      }
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
        if (compatibleBudget) {
          if (responseSchema) {
            expect(wireRequests[0]?.response_format).toMatchObject({ type: "json_schema" });
            expect(wireRequests[1]?.response_format).toEqual(wireRequests[0]?.response_format);
          } else {
            expect(
              wireRequests.every((request) =>
                request.messages.some((message) => message.reasoning_content === reasoningHistory),
              ),
            ).toBe(true);
          }
          expect(wireRequests.map((request) => request.max_tokens)).toEqual([8_192, 8_192]);
        }
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
