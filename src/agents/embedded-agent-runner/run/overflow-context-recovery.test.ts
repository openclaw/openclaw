import { expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../../../packages/ai/src/host.js";
import { resolveTestOpenAIProviderCapabilities } from "../../../../packages/ai/src/providers/openai-provider.test-support.js";
import { buildOpenAICompletionsParams } from "../../../../packages/ai/src/transports/openai-completions-params.js";
import { makeCompletionsModel } from "../../../../packages/ai/src/transports/openai-completions.test-support.js";
import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.types.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import type { ToolResultMessage } from "../../../llm/types.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../../agent-compaction-constants.js";
import { estimateMessageTokenPressure } from "../../sessions/context-token-pressure.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../test-helpers/agent-message-fixtures.js";
import { makeAttemptResult } from "../run.overflow-compaction.fixture.js";
import {
  persistToolResultProjections,
  retainEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import {
  pruneExpiredCacheTtlToolResults,
  truncateOversizedToolResultsInMessages,
} from "../tool-result-truncation.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { createEmbeddedRunCompactionRuntime } from "./compaction-runtime.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { recoverEmbeddedRunOverflow } from "./overflow-context-recovery.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

type RecoveryParams = Parameters<typeof recoverEmbeddedRunOverflow>[0];
type RecoveryInput = Omit<RecoveryParams, "attempt" | "runParams"> & {
  runParams: RecoveryParams["runParams"] & { sessionTarget: SessionTranscriptRuntimeTarget };
};
type PromptState = Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;

async function withRecovery(
  manager: SessionManager,
  runId: string,
  check: (input: RecoveryInput, promptState: PromptState) => Promise<void>,
  sessionKey = `agent:main:${manager.getSessionId()}`,
) {
  const sessionId = manager.getSessionId();
  const identity = { agentId: "main", sessionId, sessionKey };
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "recovery-test");
  try {
    const runParams = {
      admittedRunContext: await admission.admit("embedded"),
      runId,
      sessionId,
      sessionKey,
      sessionFile: sessionKey,
      sessionTarget: { ...identity, storePath: "/tmp/unused-in-memory-recovery.sqlite" },
      sessionManager: manager,
      config: {},
      workspaceDir: "/tmp/workspace",
      prompt: "continue",
      timeoutMs: 1_000,
    };
    await using sessionPromptState = await createEmbeddedRunSessionPromptState({
      runParams,
      sessionAgentId: "main",
      resolvedSessionKey: sessionKey,
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      onInterrupt: () => {},
    });
    const contextEngine: ContextEngine = {
      info: { id: "fixture", name: "Fixture engine" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => {
        throw new Error("compaction budget is exhausted");
      },
    };
    const promptError = new Error("Context window exceeded for this request");
    const input: RecoveryInput = {
      ...createEmbeddedRunCompactionRuntime({
        runParams,
        contextEngine,
        hookRunner: null,
        hookContext: { ...identity, workspaceDir: runParams.workspaceDir },
        sessionPromptState,
      }),
      runParams,
      state: createEmbeddedRunContextRecoveryState(),
      contextEngine,
      contextTokenBudget: 200_000,
      genericCompactionRecoveryAllowed: true,
      aborted: false,
      signalOwnedInterruption: false,
      promptError,
      attemptCompactionCount: 0,
      runtimeAuthPlan: undefined,
      resolvedSessionKey: sessionKey,
      sessionAgentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: runParams.workspaceDir,
      modelSelection: {
        provider: "fixture-provider",
        model: "fixture-model",
        authProfileIdSource: "auto",
      },
      harnessRuntime: "openclaw",
      thinkLevel: "off",
      resolveContextEnginePluginId: () => undefined,
      buildRuntimeSettings: ({ tokenBudget, degradedReason }) =>
        buildContextEngineRuntimeSettings({
          contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
          promptTokenBudget: tokenBudget,
          degradedReason,
        }),
      getActiveSession: () => ({
        id: sessionPromptState.sessionId,
        file: sessionPromptState.sessionFile,
        target: sessionPromptState.sessionTarget,
      }),
      prepareCurrentTranscriptRetry: () => {},
      prepareCompactedTranscriptRetry: async () => {},
      markOwnedTranscriptRetry: () => {},
      armPostCompactionGuard: () => {},
      usageAccumulator: createUsageAccumulator(),
    };
    await check(input, sessionPromptState);
  } finally {
    admission.close();
  }
}

it.each(["frozen", "cache-ttl"] as const)(
  "restores %s tool bytes after attempt teardown before recovery",
  async (mode) => {
    const manager = SessionManager.inMemory("/tmp/workspace");
    const sessionId = manager.getSessionId();
    const original: ToolResultMessage = {
      role: "toolResult",
      toolName: "read",
      toolCallId: "retained-tool",
      timestamp: 2,
      content: [{ type: "text", text: "original result ".repeat(8_000) }],
      isError: false,
    };
    const messages = [
      makeAgentUserMessage({ content: "read the file", timestamp: 1 }),
      original,
      ...[3, 4, 5].map((timestamp) =>
        makeAgentAssistantMessage({ content: [{ type: "text", text: "continuing" }], timestamp }),
      ),
    ];
    for (const message of messages) {
      await manager.appendMessageAsync(message);
    }
    let expectedContent: ToolResultMessage["content"] | undefined;
    {
      using attemptState = retainEmbeddedSessionPromptState(sessionId);
      const projectionState = attemptState.state.toolResults;
      const projected =
        mode === "frozen"
          ? truncateOversizedToolResultsInMessages(
              messages,
              200_000,
              8_000,
              32_000,
              projectionState,
            ).messages
          : pruneExpiredCacheTtlToolResults({
              messages,
              projectionState,
              contextWindowTokens: 1_000,
              settings: {
                ttlMs: 10,
                hardClear: false,
                placeholder: "cleared",
                isToolPrunable: () => true,
              },
              lastCacheTouchAt: 1,
              now: 100,
              dropThinkingBlocksForEstimate: false,
              pruneNewRounds: true,
            });
      expectedContent = projected.find((message) => message.role === "toolResult")?.content;
      expect(expectedContent).not.toEqual(original.content);
      await persistToolResultProjections(projectionState, (customType, data) =>
        manager.appendCustomEntryAsync(customType, data),
      );
    }
    {
      using idle = retainEmbeddedSessionPromptState(sessionId);
      expect(idle.state.toolResults.frozen.size).toBe(0);
    }
    await withRecovery(manager, `run-${mode}`, async (input) => {
      input.state.overflowCompactionAttempts = MAX_OVERFLOW_COMPACTION_ATTEMPTS;
      const outcome = await recoverEmbeddedRunOverflow({
        ...input,
        attempt: makeAttemptResult({
          promptError: input.promptError,
          promptErrorSource: "prompt",
          messagesSnapshot: messages,
        }),
      });
      expect(outcome).toEqual({ action: "retry" });
      expect(
        manager.buildSessionContext().messages.find((message) => message.role === "toolResult")
          ?.content,
      ).toEqual(expectedContent);
    });
  },
);

it.each(["mid-turn precheck", "strict transport rejection"] as const)(
  "continues a tool run after %s when small results exceed the remaining prompt budget",
  async (source) => {
    const contextTokenBudget = 32_768;
    const promptBudget = contextTokenBudget - 8_192;
    const manager = SessionManager.inMemory("/tmp/workspace");
    await manager.appendMessageAsync(makeAgentUserMessage({ content: "history ".repeat(10_000) }));
    for (let index = 0; index < 12; index += 1) {
      const toolCallId = `read-${index}`;
      await manager.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: {} }],
          stopReason: "toolUse",
        }),
      );
      await manager.appendMessageAsync({
        role: "toolResult",
        toolName: "read",
        toolCallId,
        content: [{ type: "text", text: "r".repeat(4_000) }],
        isError: false,
        timestamp: index + 2,
      });
    }
    const before = manager.buildSessionContext().messages;
    const estimatedPromptTokens = before.reduce(
      (sum, message) => sum + estimateMessageTokenPressure(message),
      0,
    );
    expect(estimatedPromptTokens).toBeGreaterThan(promptBudget);
    const model = makeCompletionsModel({
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow: contextTokenBudget,
      maxTokens: 8_192,
    });
    const request = (messages: typeof before) => {
      const host = getAiTransportHost();
      configureAiTransportHost({
        ...host,
        resolveProviderRequestCapabilities: resolveTestOpenAIProviderCapabilities,
      });
      try {
        const providerMessages = messages.filter(
          (message) =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
        ) as Parameters<typeof buildOpenAICompletionsParams>[1]["messages"];
        return buildOpenAICompletionsParams(
          model,
          { systemPrompt: "", messages: providerMessages },
          { maxTokens: 8_192 },
        );
      } finally {
        configureAiTransportHost(host);
      }
    };
    let providerError: unknown;
    try {
      request(before);
    } catch (error) {
      providerError = error;
    }
    if (!(providerError instanceof Error)) {
      throw new Error("Expected the strict transport to reject the oversized prompt");
    }
    expect(providerError.message).toContain("Context window exceeded");
    await withRecovery(manager, "run-small-results", async (input) => {
      input.contextTokenBudget = contextTokenBudget;
      input.state.overflowCompactionAttempts = MAX_OVERFLOW_COMPACTION_ATTEMPTS;
      const outcome = await recoverEmbeddedRunOverflow({
        ...input,
        promptError: source === "mid-turn precheck" ? input.promptError : providerError,
        attempt: makeAttemptResult({
          promptError: source === "mid-turn precheck" ? input.promptError : providerError,
          promptErrorSource: source === "mid-turn precheck" ? "precheck" : "prompt",
          messagesSnapshot: before,
          replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
          ...(source === "mid-turn precheck"
            ? {
                preflightRecovery: {
                  route: "compact_only" as const,
                  source: "mid-turn" as const,
                  estimatedPromptTokens,
                  promptBudgetBeforeReserve: promptBudget,
                  overflowTokens: estimatedPromptTokens - promptBudget,
                },
              }
            : {}),
        }),
      });
      expect(outcome).toEqual({ action: "retry" });
      const after = manager.buildSessionContext().messages;
      expect(after.filter((message) => message.role === "toolResult")).toHaveLength(12);
      expect(
        after.reduce((sum, message) => sum + estimateMessageTokenPressure(message), 0),
      ).toBeLessThanOrEqual(promptBudget);
      expect(() => request(after)).not.toThrow();
    });
  },
);

it("rejects a changed active transcript without losing a known compaction", async () => {
  const adoptCompactionTranscript = vi.fn(async () => undefined);
  const afterHook = vi.fn(async () => {});
  const prepareCurrentTranscriptRetry = vi.fn();
  await withRecovery(
    SessionManager.inMemory("/tmp/workspace"),
    "run-owner-change",
    async (input, sessionPromptState) => {
      input.contextEngine.compact = async () => {
        sessionPromptState.capturePreparedCompactionTarget({
          sessionId: "session-2",
          sessionFile: "agent:main:session-2",
          sessionTarget: {
            ...input.runParams.sessionTarget,
            sessionId: "session-2",
          },
        });
        return {
          ok: true,
          compacted: true,
          result: { summary: "done", tokensBefore: 200_001, tokensAfter: 80_000 },
        };
      };

      await expect(
        recoverEmbeddedRunOverflow({
          ...input,
          prepareRecoverySession: async () => {
            throw new Error("unexpected transcript rewrite");
          },
          attempt: makeAttemptResult({
            promptError: input.promptError,
            promptErrorSource: "precheck",
            replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
          }),
          runOwnsCompactionAfterHook: afterHook,
          adoptCompactionTranscript,
          prepareCurrentTranscriptRetry,
        }),
      ).rejects.toThrow("active session changed after recovery transcript preparation");

      expect(input.state).toMatchObject({
        autoCompactionCount: 1,
        lastCompactionTokensAfter: 80_000,
      });
      expect(adoptCompactionTranscript).not.toHaveBeenCalled();
      expect(afterHook).not.toHaveBeenCalled();
      expect(prepareCurrentTranscriptRetry).not.toHaveBeenCalled();
    },
    "agent:main:session-1",
  );
});
