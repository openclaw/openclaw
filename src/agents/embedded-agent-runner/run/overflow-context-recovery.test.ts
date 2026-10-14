import { describe, expect, it, vi } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import type { ToolResultMessage } from "../../../llm/types.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../../agent-compaction-constants.js";
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

describe("recoverEmbeddedRunOverflow transcript ownership", () => {
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
      const target = {
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        storePath: "/tmp/unused-in-memory-recovery.sqlite",
      };
      const admission = prepareSystemAgentRunAdmission(
        {},
        `run-${mode}`,
        "main",
        "recovery-projection-test",
      );
      try {
        const runParams = {
          admittedRunContext: await admission.admit("embedded"),
          runId: `run-${mode}`,
          sessionId,
          sessionKey: target.sessionKey,
          sessionFile: target.sessionKey,
          sessionTarget: target,
          sessionManager: manager,
          config: {},
          workspaceDir: "/tmp/workspace",
          prompt: "continue",
          timeoutMs: 1_000,
        };
        await using sessionPromptState = await createEmbeddedRunSessionPromptState({
          runParams,
          sessionAgentId: "main",
          resolvedSessionKey: target.sessionKey,
          lifecycleGeneration: getAgentRunLifecycleGeneration(),
          onInterrupt: () => {},
        });
        const contextEngine: ContextEngine = {
          info: { id: "fixture", name: "Fixture engine" },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages: contextMessages }) => ({
            messages: contextMessages,
            estimatedTokens: 0,
          }),
          compact: async () => {
            throw new Error("compaction budget is exhausted");
          },
        };
        const runtime = createEmbeddedRunCompactionRuntime({
          runParams,
          contextEngine,
          hookRunner: null,
          hookContext: {
            agentId: "main",
            sessionId,
            sessionKey: target.sessionKey,
            workspaceDir: runParams.workspaceDir,
          },
          sessionPromptState,
        });
        const state = createEmbeddedRunContextRecoveryState();
        state.overflowCompactionAttempts = MAX_OVERFLOW_COMPACTION_ATTEMPTS;
        const promptError = new Error("Context window exceeded for this request");
        const outcome = await recoverEmbeddedRunOverflow({
          ...runtime,
          runParams,
          state,
          contextEngine,
          contextTokenBudget: 200_000,
          genericCompactionRecoveryAllowed: true,
          aborted: false,
          signalOwnedInterruption: false,
          promptError,
          attempt: makeAttemptResult({
            promptError,
            promptErrorSource: "prompt",
            messagesSnapshot: messages,
          }),
          attemptCompactionCount: 0,
          runtimeAuthPlan: undefined,
          resolvedSessionKey: target.sessionKey,
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
          buildRuntimeSettings: ({ tokenBudget }) =>
            buildContextEngineRuntimeSettings({
              contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
              promptTokenBudget: tokenBudget,
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
        });
        expect(outcome).toEqual({ action: "retry" });
        expect(
          manager.buildSessionContext().messages.find((message) => message.role === "toolResult")
            ?.content,
        ).toEqual(expectedContent);
      } finally {
        admission.close();
      }
    },
  );

  it("rejects a changed active transcript without losing a known compaction", async () => {
    const promptError = new Error("Context window exceeded for this request");
    const state = createEmbeddedRunContextRecoveryState();
    const adoptCompactionTranscript = vi.fn(async () => undefined);
    const afterHook = vi.fn(async () => {});
    const prepareCurrentTranscriptRetry = vi.fn();
    const sessionManager = SessionManager.inMemory("/tmp/workspace");
    const sessionId = sessionManager.getSessionId();
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:session-1",
      storePath: "/tmp/unused-in-memory-recovery.sqlite",
    };
    const admission = prepareSystemAgentRunAdmission(
      {},
      "run-owner-change",
      "main",
      "recovery-owner-test",
    );
    try {
      const runParams = {
        admittedRunContext: await admission.admit("embedded"),
        runId: "run-owner-change",
        sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        sessionManager,
        config: {},
        workspaceDir: "/tmp/workspace",
        prompt: "continue",
        timeoutMs: 1_000,
      };
      await using sessionPromptState = await createEmbeddedRunSessionPromptState({
        runParams,
        sessionAgentId: "main",
        resolvedSessionKey: target.sessionKey,
        lifecycleGeneration: getAgentRunLifecycleGeneration(),
        onInterrupt: () => {},
      });
      const contextEngine: ContextEngine = {
        info: { id: "fixture", name: "Fixture engine" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => {
          sessionPromptState.capturePreparedCompactionTarget({
            sessionId: "session-2",
            sessionFile: "agent:main:session-2",
            sessionTarget: { ...target, sessionId: "session-2" },
          });
          return {
            ok: true,
            compacted: true,
            result: { summary: "done", tokensBefore: 200_001, tokensAfter: 80_000 },
          };
        },
      };
      const runtime = createEmbeddedRunCompactionRuntime({
        runParams,
        contextEngine,
        hookRunner: null,
        hookContext: {
          agentId: "main",
          sessionId,
          sessionKey: target.sessionKey,
          workspaceDir: runParams.workspaceDir,
        },
        sessionPromptState,
      });

      await expect(
        recoverEmbeddedRunOverflow({
          ...runtime,
          runParams,
          state,
          usageAccumulator: createUsageAccumulator(),
          prepareRecoverySession: async () => {
            throw new Error("unexpected transcript rewrite");
          },
          contextEngine,
          contextTokenBudget: 200_000,
          genericCompactionRecoveryAllowed: true,
          aborted: false,
          signalOwnedInterruption: false,
          promptError,
          attempt: makeAttemptResult({
            promptError,
            promptErrorSource: "precheck",
            replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
          }),
          attemptCompactionCount: 0,
          runtimeAuthPlan: undefined,
          resolvedSessionKey: target.sessionKey,
          sessionAgentId: "main",
          agentDir: "/tmp/agent",
          workspaceDir: "/tmp/workspace",
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
          runOwnsCompactionAfterHook: afterHook,
          adoptCompactionTranscript,
          getActiveSession: () => ({
            id: sessionPromptState.sessionId,
            file: sessionPromptState.sessionFile,
            target: sessionPromptState.sessionTarget,
          }),
          prepareCurrentTranscriptRetry,
          prepareCompactedTranscriptRetry: async () => {},
          markOwnedTranscriptRetry: vi.fn(),
          armPostCompactionGuard: vi.fn(),
        }),
      ).rejects.toThrow("active session changed after recovery transcript preparation");

      expect(state).toMatchObject({ autoCompactionCount: 1, lastCompactionTokensAfter: 80_000 });
      expect(adoptCompactionTranscript).not.toHaveBeenCalled();
      expect(afterHook).not.toHaveBeenCalled();
      expect(prepareCurrentTranscriptRetry).not.toHaveBeenCalled();
    } finally {
      admission.close();
    }
  });
});
