import { randomUUID } from "node:crypto";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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
import { createEnteredGate } from "../entered-gate.test-support.js";
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
import {
  compactionAssistantFixture,
  makeTerminalInput,
  textAssistant,
} from "./run/terminal-resolution.test-support.js";
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

function persisted(message: ReturnType<typeof makeUserMessage>, messageId: string) {
  return {
    admission: TEST_ADMISSION,
    sessionFile: BASE_RUN_PARAMS.sessionFile,
    sessionEntry: undefined,
    messageId,
    message,
  };
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

function replaySafeAttempt(assistant: ReturnType<typeof buildEmbeddedRunnerAssistant> | undefined) {
  return makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
}

function terminal(
  sessionPromptState: Awaited<ReturnType<typeof createState>>,
  input: Parameters<typeof makeTerminalInput>[0],
) {
  return resolveEmbeddedRunTerminal({ ...makeTerminalInput(input), sessionPromptState });
}
function retryAssistant(
  state: Awaited<ReturnType<typeof createState>>,
  assistant: Parameters<typeof replaySafeAttempt>[0],
  retryState?: ReturnType<typeof createEmbeddedRunTerminalRetryState>,
) {
  return terminal(state, {
    attempt: replaySafeAttempt(assistant),
    attemptAssistant: assistant,
    ...(retryState ? { retryState } : {}),
  });
}

describe("embedded run session prompt state", () => {
  it("releases completed continuations while session callbacks remain retained", async () => {
    const retainedCallbacks: Array<{
      adoptSessionId: (sessionId: string) => void;
      onUserMessagePersisted: (message: ReturnType<typeof makeUserMessage>) => void;
    }> = [];
    const references: WeakRef<object>[] = [];
    for (let index = 0; index < 20; index++) {
      await using state = await createState();
      state.continueFromCurrentTranscript({ messages: [makeUserMessage(`turn ${index}`)] });
      references.push(new WeakRef(state.continuation!));
      retainedCallbacks.push({
        adoptSessionId: state.adoptSessionId,
        onUserMessagePersisted: state.onUserMessagePersisted,
      });
    }
    const control = new WeakRef({ unowned: true });
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    expect(references.filter((reference) => reference.deref())).toHaveLength(0);
    expect(retainedCallbacks).toHaveLength(20);
  });

  it("releases replaced and completed message payloads through retained attempt parameters", async () => {
    const retainedContinuations: Array<{ prompt: string; messages: unknown[] }> = [];
    const payloads: WeakRef<object>[] = [];
    for (let index = 0; index < 20; index++) {
      await using state = await createState();
      state.continueFromCurrentTranscript({ messages: [makeUserMessage(`first ${index}`)] });
      retainedContinuations.push(state.continuation!);
      payloads.push(new WeakRef(state.continuation!.messages));
      state.continueFromCurrentTranscript({ messages: [makeUserMessage(`second ${index}`)] });
      expect(state.continuation!.messages).toHaveLength(2);
      retainedContinuations.push(state.continuation!);
      payloads.push(new WeakRef(state.continuation!.messages));
    }
    const control = new WeakRef({ unowned: true });
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    expect(payloads.filter((reference) => reference.deref())).toHaveLength(0);
    expect(retainedContinuations.every(({ prompt, messages }) => !prompt && !messages.length)).toBe(
      true,
    );
  });

  it("carries the current request and settled work across repeated recovery without changing legacy prompts", async () => {
    await using state = await createState({ prompt: "Task B: inspect the blue database." });
    state.continueFromCurrentTranscript({ messages: [] });
    expect(state.continuation).toEqual({
      prompt: "Task B: inspect the blue database.",
      messages: [],
    });
    const completed = textAssistant("The blue database was inspected.");
    const messages = [completed];
    state.continueFromCurrentTranscript({ messages });
    const previous = state.continuation!;
    state.continueFromCurrentTranscript({ messages: [] });
    expect(state.continuation).toEqual({
      prompt: "Task B: inspect the blue database.",
      messages: [completed],
    });
    expect(previous).toEqual({ prompt: "", messages: [] });
    expect(messages).toEqual([completed]);
    expect(state.continuation!.messages[0]).toBe(completed);
    const active = state.continuation;
    state.continueFromCurrentTranscript();
    expect(state.continuation).toBe(active);
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
        setRuntimeConfigSnapshot({});
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
    await expect(retryAssistant(state, undefined)).resolves.toEqual({ action: "retry" });
    expect(state.activePrompt).toEqual(activePrompt);
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it("retains compaction continuation across reasoning and empty retries", async () => {
    await using state = await createState();
    const retryState = createEmbeddedRunTerminalRetryState();
    const compactionAssistant = compactionAssistantFixture("cmp-shared-state");
    await expect(retryAssistant(state, compactionAssistant, retryState)).resolves.toEqual({
      action: "retry",
    });

    const reasoningAssistant = buildEmbeddedRunnerAssistant({
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs-shared-state", type: "reasoning" }),
        },
      ],
    });
    await expect(retryAssistant(state, reasoningAssistant, retryState)).resolves.toEqual({
      action: "retry",
    });
    await expect(retryAssistant(state, textAssistant(""), retryState)).resolves.toEqual({
      action: "retry",
    });

    const prompt = state.activePrompt.override ?? "";
    expect(prompt).toContain("Your turn ended without a final reply.");
    expect(prompt).not.toContain("recorded reasoning");
    expect(prompt.match(/Continue from the compacted transcript/gu)).toHaveLength(1);
  });

  it("drops a retained compaction continuation once its internal prompt is persisted", async () => {
    await using state = await createState();
    state.activateCompactionContinuation("continue after compaction");
    state.activateInternalPrompt("visible-answer retry");
    expect(state.activePrompt.override).toBe("visible-answer retry\n\ncontinue after compaction");

    state.onUserMessagePersisted(makeUserMessage(state.activePrompt.override));
    state.activateInternalPrompt("empty-response retry");

    expect(state.activePrompt.override).toBe("empty-response retry");
  });

  it("keeps a draft revision pending until its owned projection is ready", async () => {
    const reconcile = await import("../../config/sessions/session-transcript-reconcile.js");
    const projectionGate = createEnteredGate();
    const waitForProjection = vi
      .spyOn(reconcile, "waitForSessionTranscriptProjection")
      .mockImplementation(projectionGate.wait);
    await using state = await createState();
    try {
      state.activateCompactionContinuation("continue after compaction");
      const assistant = textAssistant("Visible draft.");
      const attempt = {
        ...replaySafeAttempt(assistant),
        assistantTexts: ["Visible draft."],
        beforeAgentFinalizeRevisionReason: "Tighten the final wording.",
      };

      await expect(
        terminal(state, {
          attempt,
          attemptAssistant: assistant,
          payloadsWithToolMedia: [{ text: "Visible draft." }],
          finalAssistantVisibleText: "Visible draft.",
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
          projectionGate.entered.then(() => "projection"),
          retryReady.then(() => "retry"),
        ]),
      ).resolves.toBe("projection");
      await Promise.resolve();
      expect(resumed).toBe(false);
      projectionGate.release();
      await retryReady;
      expect(resumed).toBe(true);
    } finally {
      projectionGate.release();
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

  it.each([
    { turn: "a persisted keyed user turn", key: "run-1:user", stored: true, replays: true },
    { turn: "an unkeyed user turn", key: undefined, stored: true, replays: false },
    { turn: "an unpersisted user turn", key: "run-1:user", stored: false, replays: false },
  ])(
    "replays $turn in place after a rejection without output: $replays",
    async ({ key, stored, replays }) => {
      const message = { ...makeUserMessage(), ...(key ? { idempotencyKey: key } : {}) };
      const recorder = createRecorder({ message, hasPersisted: vi.fn(() => stored) });
      await using state = await createState({ userTurnTranscriptRecorder: recorder });
      state.activePrompt.persisted = stored;
      const messages = [makeUserMessage("attempt snapshot")];

      state.continueFromCurrentTranscript({ messages, replayCurrentUserTurn: true });

      expect(state.continuation?.messages).toEqual(messages);
      expect(state.activePrompt).toEqual(
        replays
          ? { override: undefined, persisted: true, internal: false }
          : { override: CONTINUE_FROM_TRANSCRIPT_PROMPT, persisted: true, internal: true },
      );
    },
  );

  it("keeps an active internal prompt's continuation after a rejection without output", async () => {
    const message = { ...makeUserMessage(), idempotencyKey: "run-1:user" };
    const recorder = createRecorder({ message, hasPersisted: vi.fn(() => true) });
    await using state = await createState({ userTurnTranscriptRecorder: recorder });
    state.activateInternalPrompt("Internal recovery prompt");

    state.continueFromCurrentTranscript({ replayCurrentUserTurn: true });

    // The keyed operator turn is not the active prompt, so replaying it would restart the task.
    expect(state.activePrompt.override).toBe(CONTINUE_FROM_TRANSCRIPT_PROMPT);
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
    const persistBlocked = vi.fn(async () => persisted(blockedMessage, "msg-user-blocked"));
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
      persistence.resolve(persisted(persistedMessage, "msg-user-delayed"));
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
