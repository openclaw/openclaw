import { randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { captureExecRequestCancellation } from "../bash-process-control.js";
import {
  deleteSession,
  getSession,
  waitForExecSession,
  type ProcessSession,
} from "../bash-process-registry.js";
import { createLazyExecTool } from "../lazy-exec-tool.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { acceptCompactionSuccessor } from "./compaction-successor.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import { claimAgentSessionWriter } from "./run/session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";
import { resolveEmbeddedRunTerminal } from "./run/terminal-resolution.js";
import { makeTerminalInput } from "./run/terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./run/terminal-retry-state.js";

const assertActive = () => {};

const CONTINUE_FROM_TRANSCRIPT_PROMPT =
  "Continue the current task from the existing transcript, preserving completed work. If an action was interrupted, inspect its state before deciding whether to retry it. Do not restart the task or repeat completed actions.";
const CONTINUE_AFTER_TOOL_FAILURE_PROMPT = `${CONTINUE_FROM_TRANSCRIPT_PROMPT} If a tool failed, say so; never claim completion or success.`;

const BASE_RUN_PARAMS = {
  admittedRunContext: createTestAdmittedRunContext("run-1"),
  agentId: "main",
  sessionId: "test-session",
  sessionKey: "agent:main:test-key",
  sessionFile: "agent:main:test-key",
  sessionTarget: {
    agentId: "main",
    sessionId: "test-session",
    sessionKey: "agent:main:test-key",
    storePath: "/tmp/openclaw-test.sqlite",
  },
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30_000,
  runId: "run-1",
} satisfies PreparedEmbeddedRunInput["runParams"];

const TEST_ADMISSION = {
  agentId: "main",
  sessionId: BASE_RUN_PARAMS.sessionId,
  sessionKey: BASE_RUN_PARAMS.sessionKey,
  storePath: BASE_RUN_PARAMS.sessionTarget.storePath,
  generation: "test-generation",
  entryId: "msg-user-1",
  rawSeq: 1,
  effectiveParentId: null,
  activeMessagePosition: 0,
  logicalTurnId: "test-logical-turn",
  role: "user" as const,
};

function makeUserMessage(content = BASE_RUN_PARAMS.prompt) {
  return { role: "user" as const, content, timestamp: 1 };
}

function createRecorder(
  overrides: Partial<UserTurnTranscriptRecorder> = {},
): UserTurnTranscriptRecorder {
  let pendingPersistence: Promise<void> | undefined;
  return {
    message: makeUserMessage(),
    resolveMessage: vi.fn(async () => makeUserMessage()),
    getAdmissionReceipt: () => TEST_ADMISSION,
    markRuntimePersistencePending: vi.fn((pending) => {
      pendingPersistence = pending;
    }),
    markRuntimePersisted: vi.fn(),
    markBlocked: vi.fn(),
    hasPersisted: vi.fn(() => false),
    isBlocked: vi.fn(() => false),
    hasRuntimePersistencePending: vi.fn(() => pendingPersistence !== undefined),
    waitForRuntimePersistence: vi.fn(async () => {
      await pendingPersistence;
    }),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createState(overrides: Partial<PreparedEmbeddedRunInput["runParams"]> = {}) {
  return createEmbeddedRunSessionPromptState({
    runParams: { ...BASE_RUN_PARAMS, ...overrides },
    sessionAgentId: "main",
    resolvedSessionKey: BASE_RUN_PARAMS.sessionKey,
    lifecycleGeneration: "test-generation",
    onInterrupt: () => {},
  });
}

describe("embedded run session prompt state", () => {
  it("carries the current request and settled work across repeated recovery without changing legacy prompts", async () => {
    await using state = await createState({ prompt: "Task B: inspect the blue database." });
    state.continueFromCurrentTranscript({ messages: [] });
    expect(state.continuation).toEqual({
      prompt: "Task B: inspect the blue database.",
      messages: [],
    });
    const completed = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "The blue database was inspected." }],
    });
    state.continueFromCurrentTranscript({ messages: [completed] });
    state.continueFromCurrentTranscript({ messages: [] });
    expect(state.continuation).toEqual({
      prompt: "Task B: inspect the blue database.",
      messages: [completed],
    });
    expect(state.activePrompt.override).toBe(CONTINUE_FROM_TRANSCRIPT_PROMPT);
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it.each([
    { name: "moves command cancellation to an accepted compaction successor", replaced: false },
    { name: "preserves command ownership when a replacement rejects compaction", replaced: true },
  ])("$name", async ({ replaced }) => {
    await withOpenClawTestState(
      {
        label: "exec-compaction-handoff",
        scenario: "minimal",
        env: { OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" },
      },
      async (fixture) => {
        const target = {
          agentId: "main",
          sessionId: randomUUID(),
          sessionKey: `agent:main:${randomUUID()}`,
          storePath: path.join(fixture.agentDir(), "openclaw-agent.sqlite"),
        };
        await replaceSessionEntry(target, {
          sessionId: target.sessionId,
          lifecycleRevision: randomUUID(),
          updatedAt: 1,
        });
        const runId = randomUUID();
        const admission = prepareSystemAgentRunAdmission(
          {},
          runId,
          target.agentId,
          "exec-compaction",
        );
        const commands: ProcessSession[] = [];
        const startCommand = async (commandRunId: string) => {
          const tool = createLazyExecTool({
            ...target,
            runId: commandRunId,
            cwd: fixture.workspaceDir,
            scopeKey: target.sessionKey,
            host: "gateway",
            mode: "full",
            ask: "off",
            allowBackground: true,
            notifyOnExit: false,
            preparedStoreEnvironment: {},
          });
          const result = await tool.execute("compaction-command", {
            command: `node -e "require('fs').watch('.', () => {})"`,
            yieldMs: 10,
            timeoutSeconds: 60,
          });
          const details = asOptionalRecord(result.details);
          expect(details?.status).toBe("running");
          if (typeof details?.sessionId !== "string") {
            throw new Error("Expected a running command's process handle");
          }
          const command = expectDefined(getSession(details.sessionId), "running command");
          commands.push(command);
          return command;
        };
        try {
          const previousRunId = randomUUID();
          const unrelated = await withExecRequestTurn(
            { identity: { ...target, runId: previousRunId } },
            () => startCommand(previousRunId),
          );
          const admittedRunContext = await admission.admit("embedded");
          const assertAdmittedActive = expectDefined(
            resolveAdmittedRunActiveAssertion(admittedRunContext),
            "live compaction admission",
          );
          const runParams: PreparedEmbeddedRunInput["runParams"] = {
            ...BASE_RUN_PARAMS,
            ...target,
            admittedRunContext,
            sessionFile: target.sessionKey,
            sessionTarget: target,
            workspaceDir: fixture.workspaceDir,
            runId,
          };
          const writer = expectDefined(await claimAgentSessionWriter(runParams), "claimed writer");
          runParams.sessionTarget = { ...target, ...writer };
          const expectedEntry = expectDefined(loadSessionEntry(target), "original session writer");
          await withExecRequestTurn({ identity: { ...target, runId } }, async () => {
            await using state = await createEmbeddedRunSessionPromptState({
              runParams,
              sessionAgentId: target.agentId,
              resolvedSessionKey: target.sessionKey,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              onInterrupt: () => {},
            });
            const ordinary = await startCommand(runId);
            const successorId = randomUUID();
            const replacementId = randomUUID();
            if (replaced) {
              await replaceSessionEntry(target, {
                ...expectedEntry,
                sessionId: replacementId,
                lifecycleRevision: randomUUID(),
                activeWriterRunId: "replacement-run",
              });
            }
            const acceptance = acceptCompactionSuccessor({
              currentTarget: target,
              currentSessionFile: state.sessionFile,
              expectedEntry: {
                sessionId: expectedEntry.sessionId,
                lifecycleRevision: expectedEntry.lifecycleRevision,
                activeWriterRunId: expectedEntry.activeWriterRunId,
              },
              assertActive: assertAdmittedActive,
              result: {
                ok: true,
                compacted: true,
                result: {
                  summary: "Compacted request context",
                  tokensBefore: 4_097,
                  sessionTarget: { sessionId: successorId },
                },
              },
              onCommitted: state.recordCommittedCompactionSuccessor,
            });
            if (replaced) {
              await expect(acceptance).rejects.toBeInstanceOf(
                SessionTranscriptWriterClaimReboundError,
              );
              expect(state.sessionId).toBe(target.sessionId);
            } else {
              const accepted = await acceptance;
              state.notifyCompactionSessionAdopted(accepted.previousSessionId);
              expect(state.sessionId).toBe(successorId);
            }
            const currentSessionId = replaced ? replacementId : successorId;
            expect(loadSessionEntry(target)?.sessionId).toBe(currentSessionId);
            const stopped = captureExecRequestCancellation({
              sessionKey: target.sessionKey,
              agentId: target.agentId,
              sessionId: currentSessionId,
            });
            expect(stopped.cancel()).toBe(!replaced);
            await stopped.settle();
            if (replaced) {
              expect(ordinary.exited).toBe(false);
              expect(ordinary.cancellationRequested).not.toBe(true);
            } else {
              expect(ordinary).toMatchObject({ exited: true, exitReason: "manual-cancel" });
              expect(ordinary.finalizationFailed).not.toBe(true);
            }
            // An older request sharing the original session is not this run's successor.
            expect(unrelated.exited).toBe(false);
            expect(unrelated.cancellationRequested).not.toBe(true);
          });
        } finally {
          try {
            for (const command of commands) {
              getProcessSupervisor().cancel(command.id, "manual-cancel");
            }
            await Promise.all(commands.map(waitForExecSession));
            for (const command of commands) {
              deleteSession(command.id);
            }
          } finally {
            admission.close();
          }
        }
      },
    );
  });

  it("keeps a compound internal prompt across a missing-assistant retry", async () => {
    await using state = await createState();
    state.activateInternalPrompt("  finish the reasoning exactly  ");
    state.activateCompactionContinuation("continue after compaction");
    const activePrompt = {
      override: "  finish the reasoning exactly  \n\ncontinue after compaction",
      persisted: true,
      internal: true,
    };
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });

    const resolved = await resolveEmbeddedRunTerminal({
      ...makeTerminalInput({
        attempt,
        attemptAssistant: undefined,
      }),
      sessionPromptState: state,
    });

    expect(resolved).toEqual({ action: "retry" });
    expect(state.activePrompt).toEqual(activePrompt);
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it("retains compaction continuation across reasoning and empty retries", async () => {
    await using state = await createState();
    const retryState = createEmbeddedRunTerminalRetryState();
    const compactionAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "length",
      providerReplay: {
        v: 1,
        type: "openai-responses-compaction",
        id: "cmp-shared-state",
        data: "opaque-compaction",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.6-luna",
        baseUrlHash: "base-url-hash",
      },
    });
    const compactionAttempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: compactionAssistant,
      currentAttemptAssistant: compactionAssistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    await expect(
      resolveEmbeddedRunTerminal({
        ...makeTerminalInput({
          retryState,
          attempt: compactionAttempt,
          attemptAssistant: compactionAssistant,
        }),
        sessionPromptState: state,
      }),
    ).resolves.toEqual({ action: "retry" });

    const reasoningAssistant = buildEmbeddedRunnerAssistant({
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs-shared-state", type: "reasoning" }),
        },
      ],
    });
    const reasoningAttempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: reasoningAssistant,
      currentAttemptAssistant: reasoningAssistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    await expect(
      resolveEmbeddedRunTerminal({
        ...makeTerminalInput({
          retryState,
          attempt: reasoningAttempt,
          attemptAssistant: reasoningAssistant,
        }),
        sessionPromptState: state,
      }),
    ).resolves.toEqual({ action: "retry" });

    const emptyResponseAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    await expect(
      resolveEmbeddedRunTerminal({
        ...makeTerminalInput({
          retryState,
          attempt: makeEmbeddedRunnerAttempt({
            assistantTexts: [],
            lastAssistant: emptyResponseAssistant,
            currentAttemptAssistant: emptyResponseAssistant,
            currentAttemptReplayMetadata: {
              hadPotentialSideEffects: false,
              replaySafe: true,
            },
          }),
        }),
        sessionPromptState: state,
      }),
    ).resolves.toEqual({ action: "retry" });

    const prompt = state.activePrompt.override ?? "";
    expect(prompt).toContain("The previous attempt did not produce a user-visible answer.");
    expect(prompt).not.toContain("recorded reasoning");
    expect(prompt.match(/Continue from the compacted transcript/gu)).toHaveLength(1);
  });

  it("keeps a draft revision pending until its owned projection is ready", async () => {
    const reconcile = await import("../../config/sessions/session-transcript-reconcile.js");
    const projection = createDeferred();
    const projectionStarted = createDeferred();
    const waitForProjection = vi
      .spyOn(reconcile, "waitForSessionTranscriptProjection")
      .mockImplementation(async () => {
        projectionStarted.resolve();
        await projection.promise;
      });
    await using state = await createState();
    try {
      state.activateCompactionContinuation("continue after compaction");
      const assistant = buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "Visible draft." }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["Visible draft."],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        beforeAgentFinalizeRevisionReason: "Tighten the final wording.",
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      });

      await expect(
        resolveEmbeddedRunTerminal({
          ...makeTerminalInput({
            attempt,
            attemptAssistant: assistant,
            payloadsWithToolMedia: [{ text: "Visible draft." }],
            finalAssistantVisibleText: "Visible draft.",
          }),
          sessionPromptState: state,
        }),
      ).resolves.toEqual({ action: "retry" });

      expect(state.activePrompt.override).toContain("Tighten the final wording.");
      expect(state.activePrompt.override).not.toContain("continue after compaction");
      let resumed = false;
      const retryReady = state
        .settleOwnedTranscriptProjection(BASE_RUN_PARAMS.sessionTarget)
        .then(() => {
          resumed = true;
        });
      await expect(
        Promise.race([
          projectionStarted.promise.then(() => "projection"),
          retryReady.then(() => "retry"),
        ]),
      ).resolves.toBe("projection");
      await Promise.resolve();
      expect(resumed).toBe(false);
      projection.resolve();
      await retryReady;
      expect(resumed).toBe(true);
    } finally {
      projection.resolve();
      waitForProjection.mockRestore();
    }
  });

  it("adds failed-tool guidance to current-transcript continuation", async () => {
    await using state = await createState();

    state.continueFromCurrentTranscript({ includeToolFailureInstruction: true });

    expect(state.activePrompt).toEqual({
      override: CONTINUE_AFTER_TOOL_FAILURE_PROMPT,
      persisted: true,
      internal: true,
    });
  });

  it("keeps the original prompt for a raw model run retry", async () => {
    await using state = await createState({ promptMode: "none" });

    state.continueFromCurrentTranscript();

    // Raw runs load no transcript history, so a continuation prompt would drop the task.
    expect(state.activePrompt.override).toBeUndefined();
    expect(state.activePrompt.internal).toBe(false);
  });

  it("persists before_agent_run block markers through the blocked path", async () => {
    const blockedMessage = {
      ...makeUserMessage("[blocked by before_agent_run]"),
      __openclaw: {
        beforeAgentRunBlocked: {
          blockedBy: "before_agent_run",
          blockedAt: 123,
        },
      },
    };
    const persistApproved = vi.fn(async () => undefined);
    const persistBlocked = vi.fn(async () => ({
      admission: TEST_ADMISSION,
      sessionFile: BASE_RUN_PARAMS.sessionFile,
      sessionEntry: undefined,
      messageId: "msg-user-blocked",
      message: blockedMessage,
    }));
    const recorder = createRecorder({ persistApproved, persistBlocked });
    const onUserMessagePersisted = vi.fn();
    await using state = await createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(blockedMessage);
    await state.waitForCurrentUserMessagePersistence();

    expect(persistApproved).not.toHaveBeenCalled();
    expect(persistBlocked).toHaveBeenCalledWith(blockedMessage);
    expect(recorder.markRuntimePersistencePending).toHaveBeenCalledOnce();
    expect(recorder.markBlocked).not.toHaveBeenCalled();
    expect(recorder.markRuntimePersisted).not.toHaveBeenCalled();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(blockedMessage);
    expect(state.activePrompt.persisted).toBe(true);
  });

  it("keeps the original prompt when canonical persistence appends nothing", async () => {
    const persistApproved = vi.fn(async () => undefined);
    const recorder = createRecorder({ persistApproved });
    const onUserMessagePersisted = vi.fn();
    await using state = await createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(makeUserMessage());
    await state.prepareCompactedTranscriptRetry(assertActive);

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).not.toHaveBeenCalled();
    expect(state.activePrompt).toEqual({ persisted: false, internal: false });
    expect(state.suppressNextUserMessagePersistence).toBe(false);
  });

  it.each(["active", "closed"] as const)(
    "revalidates the %s owner after pending canonical persistence before retry",
    async (owner) => {
      const persistedMessage = makeUserMessage();
      const callerError = new Error("caller stopped while user persistence was pending");
      let closed = false;
      const assertPersistenceOwnerActive = () => {
        if (closed) {
          throw callerError;
        }
      };
      const persistence =
        createDeferred<Awaited<ReturnType<UserTurnTranscriptRecorder["persistApproved"]>>>();
      const persistApproved = vi.fn(() => persistence.promise);
      const recorder = createRecorder({ persistApproved });
      const onUserMessagePersisted = vi.fn();
      await using state = await createState({
        userTurnTranscriptRecorder: recorder,
        onUserMessagePersisted,
      });

      state.onUserMessagePersisted(persistedMessage);
      let retryPrepared = false;
      const retryPromise = state
        .prepareCompactedTranscriptRetry(assertPersistenceOwnerActive)
        .then(() => {
          retryPrepared = true;
        });
      await Promise.resolve();

      expect(recorder.waitForRuntimePersistence).toHaveBeenCalledOnce();
      expect(retryPrepared).toBe(false);
      expect(state.suppressNextUserMessagePersistence).toBe(false);

      closed = owner === "closed";
      persistence.resolve({
        admission: TEST_ADMISSION,
        sessionFile: BASE_RUN_PARAMS.sessionFile,
        sessionEntry: undefined,
        messageId: "msg-user-delayed",
        message: persistedMessage,
      });
      if (closed) {
        await expect(retryPromise).rejects.toBe(callerError);
        expect(retryPrepared).toBe(false);
        expect(state.activePrompt.override).toBeUndefined();
        expect(state.suppressNextUserMessagePersistence).toBe(false);
      } else {
        await retryPromise;
        expect(state.activePrompt).toEqual({
          override: CONTINUE_FROM_TRANSCRIPT_PROMPT,
          persisted: true,
          internal: true,
        });
        expect(state.suppressNextUserMessagePersistence).toBe(true);
      }
      expect(persistApproved).toHaveBeenCalledOnce();
      expect(recorder.markRuntimePersistencePending).toHaveBeenCalledOnce();
      expect(recorder.markRuntimePersisted).not.toHaveBeenCalled();
      expect(onUserMessagePersisted).toHaveBeenCalledWith(persistedMessage);
    },
  );

  it("keeps an internal reasoning continuation hidden across precheck compaction", async () => {
    const reasoningContinuation =
      "The previous assistant turn recorded reasoning; continue to the visible answer.";
    await using state = await createState();
    state.activateInternalPrompt(reasoningContinuation);

    await state.prepareCompactedTranscriptRetry(assertActive);

    expect(state.activePrompt).toEqual({
      override: reasoningContinuation,
      persisted: true,
      internal: true,
    });
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });
});
