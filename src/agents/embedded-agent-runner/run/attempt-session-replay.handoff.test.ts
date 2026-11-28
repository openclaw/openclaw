import { assert, expect, it, vi } from "vitest";
import { runSessionCompactionIfNeeded } from "../../../auto-reply/reply/agent-runner-memory.js";
import { createTestFollowupRun } from "../../../auto-reply/reply/agent-runner.test-fixtures.js";
import { loadTranscriptEventsSync } from "../../../config/sessions/session-accessor.sqlite-read.js";
import { FailoverError, resolveModelFallbackError } from "../../failover-error.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import {
  createAssistant,
  createAssistantResultStream,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createFixedRequestTokenEstimator } from "../../sessions/context-token-pressure.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import type { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { withInterruptedTurn, withReplaySession } from "./attempt-session-replay.test-support.js";
import { installEmbeddedAttemptContextGuards } from "./attempt-setup.js";

registerAgentSessionLoopTestLifecycle();

it.each([
  {
    route: "manual switch with a portable cut",
    native: "codex",
    fallback: false,
    cut: true,
    oversized: true,
  },
  {
    route: "fallback with a portable cut",
    native: "claude-cli",
    fallback: true,
    cut: true,
    oversized: true,
  },
  {
    route: "manual switch with only a Codex compaction marker",
    native: "codex",
    fallback: false,
    cut: false,
    oversized: false,
    blocked: true,
  },
  {
    route: "a later Codex turn on the compacted thread",
    laterNative: true,
    blocked: true,
    native: "codex",
    fallback: false,
    cut: false,
    oversized: false,
  },
  {
    route: "a later Codex turn after manual compaction",
    laterNative: true,
    manual: true,
    blocked: true,
    native: "codex",
    fallback: false,
    cut: false,
    oversized: false,
  },
  {
    route: "a return to an earlier Codex thread after a different epoch",
    laterNative: true,
    interveningThread: true,
    native: "codex",
    fallback: false,
    cut: false,
    oversized: false,
  },
  {
    route: "embedded resume after a native receipt",
    resume: true,
    native: "codex",
    fallback: false,
    cut: false,
    oversized: false,
  },
  {
    route: "unrelated native receipt",
    unrelated: true,
    native: "codex",
    fallback: false,
    cut: false,
    oversized: false,
  },
  {
    route: "legacy manual receipt with no turn match",
    manual: true,
    legacy: true,
    native: "codex",
    fallback: false,
    cut: false,
    oversized: false,
  },
  {
    route: "manual native compaction",
    manual: true,
    blocked: true,
    native: "codex",
    fallback: false,
    cut: false,
    oversized: false,
  },
  {
    route: "fallback from Claude CLI without a portable cut",
    native: "claude-cli",
    fallback: true,
    cut: false,
    oversized: false,
  },
  {
    route: "manual switch from an oversized Codex mirror",
    native: "codex",
    fallback: false,
    cut: false,
    oversized: true,
  },
])("admits the first embedded request after $route only if it fits", async (scenario) => {
  const { native, fallback, cut, oversized } = scenario;
  const { blocked, manual, legacy, resume, unrelated, laterNative, interveningThread } = {
    blocked: false,
    manual: false,
    legacy: false,
    resume: false,
    unrelated: false,
    laterNative: false,
    interveningThread: false,
    ...scenario,
  };
  const oldText = "Original conversation before native compaction. ".repeat(
    oversized ? 2_048 : 128,
  );
  const oldAnswer = "Original answer before native compaction";
  const retainedQuestion = "Retained question";
  const retainedAnswer = "Retained native answer";
  const summary = "Prior decisions captured in a portable summary";
  const marker = "Context compacted";
  const laterQuestion = "Question after compaction";
  const laterAnswer = "Later native answer";

  await withInterruptedTurn(
    false,
    async (fixture) => {
      if (fallback) {
        fixture.attempt.fallbackReason = "auth";
      }
      // Prompt submission can annotate the newest, current user row. Compare the
      // durable history before that input, including the untagged receipt itself.
      const legacyRows = legacy ? loadTranscriptEventsSync(fixture.target).slice(0, -1) : undefined;
      const requests: string[] = [];
      streamMocks.streamSimple.mockImplementation((model, context) => {
        requests.push(JSON.stringify(context.messages));
        return createAssistantResultStream(createAssistant(model, "Embedded reply"));
      });
      let onModelRequest: NonNullable<
        Parameters<typeof submitEmbeddedAttemptPrompt>[0]["onModelRequest"]
      >;
      if (blocked || (native === "codex" && !cut && oversized)) {
        const submitEmbedded = () =>
          withReplaySession(fixture, false, async (_session, submit) => submit());
        if (manual && laterNative) {
          const beforeCompaction = vi.fn();
          const onCompactionStart = vi.fn();
          const cfg = { agents: { defaults: { compaction: { maxActiveTranscriptBytes: 1 } } } };
          await expect(
            runSessionCompactionIfNeeded({
              cfg,
              followupRun: createTestFollowupRun({ ...fixture.target, config: cfg }),
              defaultModel: fixture.attempt.modelId,
              sessionEntry: {
                sessionId: fixture.target.sessionId,
                updatedAt: 1,
                totalTokens: 2_000_000,
                totalTokensFresh: true,
                totalTokensVersion: 2,
              },
              storePath: fixture.target.storePath,
              sessionKey: fixture.target.sessionKey,
              agentHarnessId: "openclaw",
              beforeCompaction,
              onCompactionStart,
            }),
          ).rejects.toThrow("no portable compaction summary");
          expect(beforeCompaction).not.toHaveBeenCalled();
          expect(onCompactionStart).not.toHaveBeenCalled();
        } else if (laterNative) {
          const candidates: string[] = [];
          const completed = await runWithModelFallback({
            cfg: {},
            provider: "openai",
            model: "gpt-4.1-mini",
            fallbacksOverride: ["anthropic/claude-haiku-3-5", "openai/gpt-4.1"],
            skipAuthProfileRuntime: true,
            resolveAgentHarnessRuntimeOverride: (provider) =>
              provider === "openai" ? "codex" : "openclaw",
            run: async (provider, model) => {
              candidates.push(`${provider}/${model}`);
              if (candidates.length === 1) {
                throw new FailoverError("Synthetic native login unavailable", {
                  provider,
                  model,
                  reason: "auth",
                });
              }
              if (provider === "anthropic") {
                try {
                  await submitEmbedded();
                } catch (error) {
                  expect(resolveModelFallbackError(error).kind).toBe("coordination");
                  throw error;
                }
                throw new Error("Embedded candidate was admitted");
              }
              return "native continuation";
            },
          });
          expect(completed.result).toBe("native continuation");
          expect(candidates).toEqual([
            "openai/gpt-4.1-mini",
            "anthropic/claude-haiku-3-5",
            "openai/gpt-4.1",
          ]);
        }
        await expect(submitEmbedded()).rejects.toThrow("no portable compaction summary");
        expect(requests).toHaveLength(0);
        expect(JSON.stringify(loadTranscriptEventsSync(fixture.target))).toContain(oldText);
        return;
      }
      await withReplaySession(
        fixture,
        false,
        async (session, submit, manager) => {
          const guards = installEmbeddedAttemptContextGuards({
            activeSession: session,
            agentDir: fixture.attempt.workspaceDir,
            attempt: fixture.attempt,
            computerContextEpoch: { value: 0 },
            dropThinkingBlocksForEstimate: false,
            effectiveCwd: fixture.attempt.workspaceDir,
            effectiveFsWorkspaceOnly: true,
            effectiveWorkspace: fixture.attempt.workspaceDir,
            getPrePromptMessageCount: () => 0,
            getPromptCache: () => undefined,
            getPromptCacheRetention: () => "none",
            getCompactionReplayEnabled: () => false,
            getServerToolClearingEnabled: () => false,
            toolResultPromptProjectionState: createToolResultPromptProjectionState(),
            getSystemPrompt: () => session.agent.state.systemPrompt,
            isOpenAIResponsesApi: false,
            repairToolUseResultPairing: false,
            sessionAgentId: fixture.target.agentId,
            sessionManager: manager,
            settingsManager: session.settingsManager,
          });
          const estimateFixedPressure = createFixedRequestTokenEstimator();
          // This is the first embedded request, so no same-attempt measured prefix exists.
          onModelRequest = async (_model, context) => {
            await guards.checkMidTurnPrecheck({
              context,
              fixedTokenPressure: estimateFixedPressure(context),
            });
            return undefined;
          };
          try {
            await submit();
            if (oversized && !cut) {
              expect(requests).toHaveLength(0);
              expect(guards.takePendingMidTurnPrecheckRequest()).toMatchObject({
                pressure: "overflow",
                route: "compact_only",
                pressureSource: "transcript_estimate",
              });
            } else {
              expect(guards.takePendingMidTurnPrecheckRequest()).toBeNull();
            }
          } finally {
            guards.remove();
          }
        },
        { onModelRequest: (...args) => onModelRequest(...args) },
      );

      const persisted = loadTranscriptEventsSync(fixture.target);
      expect(JSON.stringify(persisted)).toContain(oldText);
      if (legacyRows) {
        expect(legacyRows).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({
              idempotencyKey: "codex-context-compaction:thread-1:compact-turn:compact-1",
              details: {
                kind: "context_compaction",
                backend: "codex-app-server",
                threadId: "thread-1",
                turnId: "compact-turn",
                itemId: "compact-1",
                runId: "manual-run",
              },
            }),
          }),
        );
        expect(persisted.slice(0, legacyRows.length)).toEqual(legacyRows);
      }

      if (oversized && !cut) {
        return;
      }
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request).not.toContain(marker);
      if (cut) {
        expect(request).not.toContain(oldText);
        expect(request).not.toContain(oldAnswer);
        expect(request.split(summary)).toHaveLength(2);
        expect(request.indexOf(summary)).toBeLessThan(request.indexOf(retainedQuestion));
      } else {
        expect(request).toContain(oldText);
        expect(request).toContain(oldAnswer);
        expect(request).not.toContain(summary);
      }
      const remaining = [retainedQuestion, retainedAnswer, laterQuestion, laterAnswer];
      for (const [index, content] of remaining.entries()) {
        expect(request).toContain(content);
        if (index > 0) {
          expect(request.indexOf(content)).toBeGreaterThan(request.indexOf(remaining[index - 1]!));
        }
      }
      expect(request.split(fixture.attempt.prompt)).toHaveLength(2);
      expect(request.indexOf(fixture.attempt.prompt)).toBeGreaterThan(request.indexOf(laterAnswer));
    },
    {
      interruptedTurn: false,
      selectedOwner: native === "codex" && !cut && !oversized,
      seedPriorHistory: async (manager) => {
        await manager.appendMessageAsync({ role: "user", content: oldText, timestamp: 1 });
        const assistant = (content: string) => ({
          ...createAssistant(testModel, content),
          provider: native === "codex" ? "openai-codex" : "claude-cli",
        });
        await manager.appendMessageAsync(assistant(oldAnswer));
        const firstKeptEntryId = await manager.appendMessageAsync({
          role: "user",
          content: retainedQuestion,
          timestamp: 2,
        });
        await manager.appendMessageAsync(assistant(retainedAnswer));
        const appendReceipt = () => {
          const threadId = unrelated ? "other-thread" : "thread-1";
          const turnId = manual ? "compact-turn" : "turn-1";
          const runId = manual ? "manual-run" : "native-run";
          return manager.appendMessageAsync({
            role: "custom",
            customType: "openclaw.context-compaction",
            content: marker,
            display: true,
            excludeFromContext: true,
            timestamp: 3,
            idempotencyKey: `codex-context-compaction:${threadId}:${turnId}:compact-1`,
            details: {
              kind: "context_compaction",
              backend: "codex-app-server",
              threadId,
              turnId,
              itemId: "compact-1",
              runId,
              ...(manual && !legacy ? { trigger: "manual" } : {}),
            },
            __openclaw: { runId, itemId: "compact-1" },
          });
        };
        if (native === "codex" && !manual) {
          await appendReceipt();
        }
        if (cut) {
          assert(firstKeptEntryId);
          await manager.appendCompactionAsync(summary, firstKeptEntryId, 24_000);
        }
        await manager.appendMessageAsync({ role: "user", content: laterQuestion, timestamp: 4 });
        const terminal = assistant(laterAnswer);
        await manager.appendMessageAsync(
          native === "codex"
            ? {
                ...terminal,
                api: "openai-responses",
                provider: "openai",
                idempotencyKey: "codex-app-server:thread-1:turn-1:assistant",
                __openclaw: {
                  runId: "native-run",
                  runTerminal: true,
                  mirrorOrigin: "codex-app-server",
                  mirrorIdentity: "turn-1:assistant",
                },
              }
            : terminal,
        );
        if (manual) {
          await appendReceipt();
        }
        if (laterNative) {
          const appendNativeTerminal = async (threadId: string, turnId: string) => {
            await manager.appendMessageAsync({
              ...createAssistant(testModel, "Another native answer"),
              provider: "openai",
              idempotencyKey: `codex-app-server:${threadId}:${turnId}:assistant`,
              __openclaw: {
                runId: `run-${turnId}`,
                runTerminal: true,
                mirrorOrigin: "codex-app-server",
                mirrorIdentity: `${turnId}:assistant`,
              },
            });
          };
          if (interveningThread) {
            await appendNativeTerminal("thread-2", "turn-2");
          }
          await appendNativeTerminal("thread-1", "turn-3");
        }
        if (resume) {
          await manager.appendMessageAsync({
            role: "user",
            content: "Continue in embedded",
            timestamp: 5,
          });
          await manager.appendMessageAsync({
            ...createAssistant(testModel, "Previous embedded answer"),
            // Fallback candidates can share the native attempt's OpenClaw run ID.
            __openclaw: { runId: "native-run" },
          });
        }
      },
    },
  );
});
