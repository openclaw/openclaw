import { randomUUID } from "node:crypto";
import path from "node:path";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { assert, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  loadTranscriptEventsSync as readEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { isIndexedSessionEntry } from "../../../config/sessions/session-entry-codec.js";
import { captureSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import {
  SessionTranscriptWriterClaimReboundError as WriterReboundError,
  runWithoutOwnedSessionTranscriptWrites as outsideWriter,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import {
  isSessionControllerWorkActive,
  runSessionMutation,
} from "../../../sessions/session-controller.lifecycle.js";
import { onSessionIdentityMutation } from "../../../sessions/session-lifecycle-events.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { runOpenClawAgentWriteTransaction } from "../../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
  type PreparedAgentRunAdmission,
} from "../../admitted-run-context.js";
import { isRecordedModelFallbackStop } from "../../model-fallback-stop.js";
import { createAgentRunRestartAbortError } from "../../run-termination.js";
import { attachInternalToolResultAcknowledgement } from "../../runtime/internal-hooks.js";
import { installSessionToolResultGuard } from "../../session-tool-result-guard.js";
import {
  createAssistant,
  createTestSession,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionMetadataCommittedError } from "../../sessions/session-manager-metadata-error.js";
import { sessionManagerAppendInitialMetadata } from "../../sessions/session-manager-metadata.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { rewriteTranscriptEntriesInSessionManager } from "../transcript-rewrite.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import { preparePersistedCurrentUserTurn } from "./pre-persisted-user-turn.js";
import { claimAgentSessionWriter, prepareInitialSessionWriter } from "./session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

const userMessage = { role: "user" as const, content: "First user turn", timestamp: 1 };
type Transcript = Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>>;
type Attempt = Parameters<typeof prepareEmbeddedAttemptTranscriptLifecycle>[0]["attempt"];

function prepareTranscript(
  attempt: Attempt,
  throwIfFiredAfterPrepCleanup = async () => {},
  arm = () => {},
) {
  return prepareEmbeddedAttemptTranscriptLifecycle({
    attempt,
    externalAbortController: { arm, throwIfFiredAfterPrepCleanup },
  });
}

function observeCreation(
  sessionId: string,
  listener: Parameters<typeof onSessionIdentityMutation>[0],
) {
  const unsubscribe = onSessionIdentityMutation((event) => {
    if (event.kind === "create" && event.current.sessionId === sessionId) {
      listener(event);
    }
  });
  return { [Symbol.dispose]: unsubscribe };
}
async function appendInitial(
  kind: "message" | "model" | "thinking",
  manager: SessionManager,
): Promise<string> {
  return kind === "model"
    ? manager.appendModelChange("test-provider", "test-model")
    : kind === "thinking"
      ? manager.appendThinkingLevelChange("high")
      : manager.appendMessage(userMessage);
}

type InitialWriterFixture = {
  admission: PreparedAgentRunAdmission;
  controller: AbortController;
  manager: SessionManager;
  openManager: () => Promise<SessionManager>;
  promptState: Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;
  preparedSessionTarget: NonNullable<EmbeddedRunAttemptInternalParams["preparedSessionTarget"]>;
  replaceAdmission: () => Promise<void>;
  runParams: PreparedEmbeddedRunInput["runParams"];
  target: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
  transcript: Transcript;
};

async function withInitialWriter(
  run: (fixture: InitialWriterFixture) => Promise<void>,
  options: { existing?: boolean; outsideTranscriptWrite?: boolean; incognito?: boolean } = {},
) {
  await withOpenClawTestState({ label: "initial-session-writer" }, async (state) => {
    const sessionId = randomUUID();
    const runId = randomUUID();
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: options.incognito
        ? `agent:main:dashboard:incognito-${sessionId}`
        : `agent:main:${sessionId}`,
      storePath: options.incognito
        ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
        : path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    const controller = new AbortController();
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "initial-writer-test");
    const admissions = [admission];
    let prepared: Transcript | undefined;
    try {
      const admittedRunContext = await admission.admit("embedded");
      const runParams: PreparedEmbeddedRunInput["runParams"] = {
        admittedRunContext,
        abortSignal: controller.signal,
        agentId: target.agentId,
        sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        workspaceDir: state.workspaceDir,
        prompt: "hello",
        timeoutMs: 30_000,
        runId,
      };
      if (options.existing) {
        const entry: InternalSessionEntry = {
          sessionId,
          updatedAt: 1,
          lifecycleRevision: "existing-revision",
          ...(options.incognito ? { incognito: true } : {}),
        };
        if (options.incognito) {
          await replaceSessionEntry(target, entry);
        } else {
          replaceSessionEntrySync(target, entry);
        }
        const claim = await claimAgentSessionWriter(runParams);
        expect(claim?.expectedWriterRunId).toBe(runId);
        runParams.sessionTarget = { ...target, ...claim };
      }
      await using promptState = await createEmbeddedRunSessionPromptState({
        runParams,
        sessionAgentId: target.agentId,
        resolvedSessionKey: target.sessionKey,
        lifecycleGeneration: getAgentRunLifecycleGeneration(),
        onInterrupt: (reason) => controller.abort(reason),
      });
      const arm = vi.fn();
      const assertCurrent = resolveAdmittedRunActiveAssertion(
        admittedRunContext,
        controller.signal,
      );
      assert(assertCurrent, "Expected active fixture admission");
      const preparedSessionTarget = {
        target: captureSessionTranscriptTargetBinding({
          ...target,
          ...promptState.sessionWriterFence,
        }),
        assertCurrent,
      };
      await promptState.withSessionWriterContext(async () => {
        const transcript = await prepareTranscript(
          { ...runParams, preparedSessionTarget },
          async () => controller.signal.throwIfAborted(),
          arm,
        );
        prepared = transcript;
        const openManager = async () => {
          const selected = { ...target, ...promptState.sessionWriterFence };
          return options.incognito
            ? SessionManager.openAsync(selected, state.workspaceDir)
            : SessionManager.open(selected, state.workspaceDir);
        };
        const runFixture = async () =>
          run({
            admission,
            controller,
            manager: await transcript.withOwnedTranscriptWrite(openManager),
            openManager,
            promptState,
            preparedSessionTarget,
            replaceAdmission: async () => {
              const replacement = prepareSystemAgentRunAdmission(
                {},
                runId,
                "main",
                "replacement-test",
              );
              admissions.push(replacement);
              await replacement.admit("embedded");
            },
            runParams,
            target,
            transcript,
          });
        return options.outsideTranscriptWrite
          ? runFixture()
          : transcript.withOwnedTranscriptWrite(runFixture);
      });
      await prepared?.transcriptLifecycle.dispose();
      expect(arm).toHaveBeenCalledOnce();
    } finally {
      try {
        await prepared?.transcriptLifecycle.dispose();
        expect(isSessionControllerWorkActive(target.storePath, [target.sessionKey])).toBe(false);
      } finally {
        for (const owner of admissions) {
          owner.close();
        }
        if (options.incognito) {
          memorySessionActorOwners.closeDatabase({
            agentId: target.agentId,
            path: target.storePath,
          });
        }
      }
    }
  });
}

it.each([
  { existing: false, text: "Already streamed answer" },
  { existing: true, text: "Already streamed answer" },
  { existing: true, text: "" },
  { existing: true, text: "Already streamed answer", closeAdmission: true },
  { existing: true, text: "Already streamed answer", incognito: true },
  { existing: true, text: "Already streamed answer", incognito: true, closeAdmission: true },
])(
  "settles a restart-aborted stream (existing=$existing, text=$text, closed=$closeAdmission, incognito=$incognito)",
  ({ existing, text, closeAdmission, incognito }) =>
    withInitialWriter(
      async ({ manager, controller, target, transcript, admission }) =>
        withOwnedSessionTranscriptWrites(transcript.ownedTranscriptWriteContext, async () => {
          const { session } = await createTestSession({
            sessionManager: manager,
            withSessionWriteSettlement: (write) =>
              transcript.transcriptLifecycle.withTranscriptWrite(write),
          });
          const reason = createAgentRunRestartAbortError();
          session.agent.streamFn = (_model, _context, options) => {
            const stream = createAssistantMessageEventStream();
            const output = createAssistant(testModel, []);
            options?.signal?.addEventListener(
              "abort",
              () => {
                Object.assign(output, {
                  stopReason: "aborted",
                  errorCode: "OPENCLAW_RESTART_ABORT",
                  errorMessage: reason.message,
                });
                stream.push({ type: "error", reason: "aborted", error: output });
                stream.end();
              },
              { once: true },
            );
            queueMicrotask(() => {
              stream.push({ type: "start", partial: output });
              if (text) {
                output.content.push({ type: "text", text });
                output.content.push({
                  type: "toolCall",
                  id: "unfinished",
                  name: "read",
                  arguments: {},
                  async: true,
                });
                stream.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: text,
                  partial: output,
                });
              }
            });
            return stream;
          };
          session.subscribe((event) => {
            if (
              ((text && event.type === "message_update") ||
                (!text && event.type === "message_start")) &&
              event.message.role === "assistant"
            ) {
              if (closeAdmission) {
                admission.close();
              }
              controller.abort(reason);
              session.agent.abort(reason);
            }
          });
          try {
            // The canceled run may reject after its terminal row; storage is the contract here.
            await Promise.allSettled([
              session.prompt("Keep my answer", { expandPromptTemplates: false }),
            ]);
            const events = incognito
              ? await outsideWriter(() => loadTranscriptEvents(target))
              : readEvents(target);
            const assistants = events.flatMap((entry) =>
              isIndexedSessionEntry(entry) &&
              entry.type === "message" &&
              entry.message.role === "assistant"
                ? [entry.message]
                : [],
            );
            expect(assistants).toHaveLength(1);
            expect(assistants[0]).toMatchObject({
              stopReason: "aborted",
              errorCode: "OPENCLAW_RESTART_ABORT",
              content: text ? [{ type: "text", text }] : [],
            });
            await expect(manager.appendMessageAsync(userMessage)).rejects.toThrow();
            if (incognito) {
              await expect(
                outsideWriter(() => manager.appendMessageAsync(userMessage)),
              ).rejects.toThrow();
            }
          } finally {
            session.dispose();
          }
        }),
      { existing, incognito, outsideTranscriptWrite: true },
    ),
);

it.each([false, true])("acknowledges only persisted tool results (incognito=%s)", (incognito) =>
  withInitialWriter(
    async ({ manager, runParams, target, transcript }) => {
      const actor = transcript.ownedTranscriptWriteContext.sessionActor!.actor;
      expect(actor.target.database.kind).toBe(incognito ? "memory" : "file");
      const readPersisted = () => {
        if (!incognito) {
          return readEvents(target);
        }
        const result = actor.storage!.readCurrent(
          { type: "session.history.hydrate", input: { sessionId: target.sessionId } },
          { assertCurrent() {}, authorize() {} },
        );
        assert(result.kind === "full", "Expected the committed memory transcript");
        return result.snapshot.events;
      };
      await manager.appendMessageAsync(userMessage);
      installSessionToolResultGuard(manager);
      const toolCall = (id: string) =>
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id, name: "lookup", arguments: {} }],
        });
      const appendResult = (id: string, text: string, timestamp: number, acknowledge: () => void) =>
        manager.appendMessageAsync(
          attachInternalToolResultAcknowledgement(
            makeTextToolResult(id, "lookup", text, false, timestamp),
            acknowledge,
          ),
        );
      await manager.appendMessageAsync(toolCall("committed-result"));
      const acknowledge = vi.fn(() => {
        expect(readPersisted().at(-1)).toMatchObject({
          type: "message",
          message: { role: "toolResult", toolCallId: "committed-result" },
        });
      });
      await appendResult("committed-result", "persist before acknowledge", 3, acknowledge);
      expect(acknowledge).toHaveBeenCalledOnce();

      await manager.appendMessageAsync(toolCall("refused-result"));
      const before = readPersisted();
      await claimAgentSessionWriter({ ...runParams, runId: "replacement-result-writer" });
      const refusedAcknowledgement = vi.fn();
      await expect(
        appendResult("refused-result", "must not acknowledge", 5, refusedAcknowledgement),
      ).rejects.toThrow(WriterReboundError);
      expect(refusedAcknowledgement).not.toHaveBeenCalled();
      expect(readPersisted()).toEqual(before);
    },
    { existing: true, incognito },
  ),
);

it("keeps an atomic first append committed when publication revokes its run", () =>
  withInitialWriter(async ({ controller, manager, promptState, target }) => {
    const failure = new Error("revoke after actor commit");
    using observer = observeCreation(target.sessionId, () => controller.abort(failure));
    void observer;
    await expect(manager.appendMessageAsync(userMessage)).rejects.toThrow();
    expect(promptState.sessionWriterFence).toBeDefined();
    expect(readEvents(target)).toMatchObject([
      { type: "session" },
      { type: "message", message: userMessage },
    ]);
  }));

it("does not replay an actor append whose outcome is unknown", () =>
  withInitialWriter(async ({ manager, target, transcript }) => {
    await manager.appendMessageAsync(userMessage);
    const before = readEvents(target);
    const actor = transcript.ownedTranscriptWriteContext.sessionActor!.actor;
    using append = vi.spyOn(actor, "appendTranscriptEvent").mockImplementation(async (command) => ({
      kind: "unknown",
      target: actor.target,
      commandId: command.commandId,
      error: { name: "Error", message: "Synthetic lost worker outcome" },
    }));
    const failure = await manager.appendMessageAsync(userMessage).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(isRecordedModelFallbackStop(failure)).toBe(true);
    expect(append).toHaveBeenCalledOnce();
    expect(readEvents(target)).toEqual(before);
  }));

it("refuses an explicitly stale actor append without replay or persistence", () =>
  withInitialWriter(
    async ({ manager, target, transcript }) => {
      await manager.appendMessageAsync(userMessage);
      const before = readEvents(target);
      const actor = transcript.ownedTranscriptWriteContext.sessionActor!.actor;
      const append = actor.appendTranscriptEvent.bind(actor);
      using stale = vi
        .spyOn(actor, "appendTranscriptEvent")
        .mockImplementationOnce((command, authority, observer) =>
          append(
            { ...command, expected: { epoch: "superseded-test-epoch", sequence: 0 } },
            authority,
            observer,
          ),
        );
      using read = vi.spyOn(actor, "read");
      await expect(manager.appendCustomEntryAsync("after-stale-version")).rejects.toMatchObject({
        name: "SessionActorStaleVersionError",
      });
      expect(stale).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
      expect(readEvents(target)).toEqual(before);
    },
    { existing: true },
  ));

it("refuses a prepared target whose owner closes during lifecycle preparation", () =>
  withInitialWriter(
    async ({ admission, preparedSessionTarget, runParams }) => {
      const arm = vi.fn();
      await expect(
        prepareTranscript(
          { ...runParams, preparedSessionTarget },
          async () => admission.close(),
          arm,
        ),
      ).rejects.toThrow("admitted run authority is no longer active");
      expect(arm).not.toHaveBeenCalled();
    },
    { existing: true },
  ));

it("retains its prepared target after managed replacement and refuses successor writes", () =>
  withInitialWriter(
    async ({ manager, preparedSessionTarget, runParams, target }) => {
      await manager.appendMessageAsync(userMessage);
      const replacement = {
        ...target,
        sessionId: "replacement-session",
      };
      outsideWriter(() =>
        replaceSessionEntrySync(replacement, { sessionId: replacement.sessionId, updatedAt: 2 }),
      );
      const before = readEvents(target);
      const replacementBefore = readEvents(replacement);
      let rebound: Transcript | undefined;
      try {
        rebound = await prepareTranscript({ ...runParams, preparedSessionTarget });
        expect(rebound.ownedTranscriptWriteContext.sessionTarget).toMatchObject(target);
        await expect(
          rebound.withOwnedTranscriptWrite(() => manager.appendMessageAsync(userMessage)),
        ).rejects.toThrow();
        expect(readEvents(target)).toEqual(before);
        expect(readEvents(replacement)).toEqual(replacementBefore);
      } finally {
        await rebound?.transcriptLifecycle.dispose();
      }
    },
    { existing: true },
  ));

it("retains uncommitted custody beyond bounded teardown without aborting accepted writes", () =>
  withInitialWriter(
    async ({ promptState, transcript, manager, target }) => {
      const entered = createDeferredCore();
      const gate = createDeferredCore();
      const write = transcript.withOwnedTranscriptWrite(async () => {
        entered.resolve();
        await gate.promise;
        manager.appendMessage(userMessage);
      });
      await entered.promise;
      vi.useFakeTimers();
      let closing: Promise<void | undefined> | undefined;
      try {
        const dispose = transcript.transcriptLifecycle.dispose();
        await vi.advanceTimersByTimeAsync(30_000);
        await dispose;
        let closed = false;
        closing = promptState[Symbol.asyncDispose]().then(() => {
          closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(isSessionControllerWorkActive(target.storePath, [target.sessionKey])).toBe(true);
        expect(loadSessionEntry(target)).toBeUndefined();
        gate.resolve();
        await write;
        await closing;
        expect(isSessionControllerWorkActive(target.storePath, [target.sessionKey])).toBe(true);
        expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
      } finally {
        gate.resolve();
        await Promise.allSettled([write, closing]);
        vi.useRealTimers();
      }
    },
    { outsideTranscriptWrite: true },
  ));

it("keeps its uncommitted creator visible inside a same-key lifecycle mutation", () =>
  withInitialWriter(async ({ target }) => {
    await runSessionMutation({
      scope: target.storePath,
      identities: [target.sessionKey],
      prepare: async () => {
        expect(isSessionControllerWorkActive(target.storePath, [target.sessionKey])).toBe(true);
      },
      run: async () => {
        expect(loadSessionEntry(target)).toBeUndefined();
      },
    });
  }));

it("rejects an existing row before reacquiring its enclosing lifecycle mutation", () =>
  withInitialWriter(async ({ manager, runParams, target }) => {
    manager.appendMessage(userMessage);
    await runSessionMutation({
      scope: target.storePath,
      identities: [target.sessionKey],
      run: async () => {
        await expect(
          prepareInitialSessionWriter({ runParams, target, onInterrupt: () => {} }),
        ).rejects.toThrow(WriterReboundError);
      },
    });
  }));

it("prepares a fresh keyed turn before its first append", () =>
  withInitialWriter(async ({ manager, runParams, target }) => {
    const message = { ...userMessage, idempotencyKey: `${runParams.runId}:user` };
    const recorder = createUserTurnTranscriptRecorder({
      message,
      target: { ...target, sessionEntry: undefined },
    });
    expect(loadSessionEntry(target)).toBeUndefined();
    expect(
      await preparePersistedCurrentUserTurn({
        sessionManager: manager,
        message,
        recorder,
        runId: runParams.runId,
      }),
    ).toBeUndefined();
    manager.appendMessage(message);
    expect(loadSessionEntry(target)).toMatchObject({
      sessionId: target.sessionId,
      activeWriterRunId: runParams.runId,
    });
    expect(
      SessionManager.open(target)
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toHaveLength(1);
  }));

it.each([
  { existing: false, kind: "message" },
  { existing: false, kind: "model" },
  { existing: false, kind: "thinking" },
  { existing: true, kind: "message" },
] as const)(
  "retains the exact committed writer for later mutations (existing=$existing initial=$kind)",
  ({ existing, kind }) =>
    withInitialWriter(
      async ({ manager, promptState, runParams, target }) => {
        await appendInitial(kind, manager);
        const entry = loadSessionEntry({ ...target, readConsistency: "latest" });
        expect(entry).toMatchObject({
          sessionId: target.sessionId,
          activeWriterRunId: runParams.runId,
        });
        const expectedFence = {
          expectedLifecycleRevision: existing ? "existing-revision" : undefined,
          expectedWriterRunId: runParams.runId,
        };
        expect(promptState.sessionWriterFence).toEqual(expectedFence);
        expect(manager.getSessionTarget()).toMatchObject(expectedFence);
        manager.appendMessage(userMessage);
        expect(readEvents(target)).toHaveLength(3);
        await claimAgentSessionWriter({ ...runParams, runId: "new-writer" });
        const before = readEvents(target);
        await expect(outsideWriter(() => appendInitial(kind, manager))).rejects.toThrow(
          WriterReboundError,
        );
        expect(readEvents(target)).toEqual(before);
        expect(loadSessionEntry(target)).toMatchObject({ activeWriterRunId: "new-writer" });
      },
      { existing },
    ),
);

it.each(["abort", "closed", "replaced"] as const)(
  "does not create a row when the original owner is %s",
  (loss) =>
    withInitialWriter(
      async ({ admission, controller, manager, promptState, replaceAdmission, target }) => {
        const callerError = new Error("caller cancelled before initial persistence");
        if (loss === "abort") {
          controller.abort(callerError);
        }
        if (loss === "closed") {
          admission.close();
        }
        if (loss === "replaced") {
          await replaceAdmission();
        }
        if (loss === "abort") {
          expect(() => manager.appendMessage(userMessage)).toThrow(callerError);
        } else {
          expect(() => manager.appendMessage(userMessage)).toThrow(
            "admitted run authority is no longer active",
          );
        }
        expect(promptState.sessionWriterFence).toBeUndefined();
        expect(loadSessionEntry(target)).toBeUndefined();
        expect(readEvents(target)).toEqual([]);
      },
    ),
);

it.each(["same-session", "copied-writer", "other-session"] as const)(
  "rejects a competing first row without adopting its %s identity",
  (kind) =>
    withInitialWriter(async ({ manager, promptState, runParams, target }) => {
      const competing: InternalSessionEntry = {
        sessionId: kind === "other-session" ? "competing-session" : target.sessionId,
        updatedAt: 7,
        ...(kind === "copied-writer" ? { activeWriterRunId: runParams.runId } : {}),
      };
      outsideWriter(() => replaceSessionEntrySync(target, competing));
      const before = loadSessionEntry(target);
      await expect(appendInitial("message", manager)).rejects.toThrow(WriterReboundError);
      expect(promptState.sessionWriterFence).toBeUndefined();
      expect(isSessionControllerWorkActive(target.storePath, [target.sessionKey])).toBe(true);
      expect(loadSessionEntry(target)).toEqual(before);
      expect(readEvents(target)).toEqual([]);
    }),
);

it("publishes no initial claim or identity for a rolled-back outer transaction", () =>
  withInitialWriter(async ({ manager, openManager, promptState, runParams, target }) => {
    const rollback = new Error("roll back first persistence");
    const identities: unknown[] = [];
    using observer = observeCreation(target.sessionId, (event) => identities.push(event));
    void observer;
    expect(() =>
      runOpenClawAgentWriteTransaction(
        () => {
          manager.appendMessage(userMessage);
          expect(promptState.sessionWriterFence).toBeUndefined();
          throw rollback;
        },
        { agentId: target.agentId, path: target.storePath },
      ),
    ).toThrow(rollback);
    expect(promptState.sessionWriterFence).toBeUndefined();
    expect(loadSessionEntry(target)).toBeUndefined();
    expect(readEvents(target)).toEqual([]);
    expect(identities).toEqual([]);
    expect(isSessionControllerWorkActive(target.storePath, [target.sessionKey])).toBe(true);

    (await openManager()).appendMessage(userMessage);
    expect(promptState.sessionWriterFence?.expectedWriterRunId).toBe(runParams.runId);
    expect(loadSessionEntry(target)).toMatchObject({ activeWriterRunId: runParams.runId });
    expect(identities).toHaveLength(1);
  }));

it("commits the initial metadata pair in one actor append and adopts later metadata", () =>
  withInitialWriter(async ({ manager, transcript, admission, target }) => {
    const actor = transcript.ownedTranscriptWriteContext.sessionActor!.actor;
    using append = vi.spyOn(actor, "appendTranscriptEvent");
    const { session } = await createTestSession({
      model: { ...testModel, reasoning: true },
      sessionManager: manager,
      thinkingLevel: "high",
    });
    try {
      expect(append).toHaveBeenCalledOnce();
      const model = manager.getEntries()[0]?.id;
      const thinking = manager.getEntries()[1]?.id;
      expect(manager.getEntries()).toMatchObject([
        { id: model, type: "model_change", parentId: null },
        { id: thinking, type: "thinking_level_change", parentId: model, thinkingLevel: "high" },
      ]);
      expect(manager.getPersistedEntries()).toEqual(readEvents(target));

      const changed = await manager.appendThinkingLevelChange("low");
      expect(manager.getEntries().at(-1)).toMatchObject({
        id: changed,
        parentId: thinking,
        thinkingLevel: "low",
      });
      expect(manager.getPersistedEntries()).toEqual(readEvents(target));
      const before = readEvents(target);
      admission.close();
      await expect(
        createTestSession({ sessionManager: manager, thinkingLevel: "off" }),
      ).rejects.toThrow();
      expect(readEvents(target)).toEqual(before);
    } finally {
      session.dispose();
    }
  }));

it.each(["message", "model", "initial metadata"] as const)(
  "captures the committed claim before identity-observer cancellation stops the first %s append",
  (kind) =>
    withInitialWriter(async ({ controller, manager, promptState, runParams, target }) => {
      const callerError = new Error("caller cancelled from committed identity observer");
      let observedFence: typeof promptState.sessionWriterFence;
      using observer = observeCreation(target.sessionId, () => {
        observedFence = promptState.sessionWriterFence;
        controller.abort(callerError);
      });
      void observer;
      const failure = await (
        kind === "initial metadata"
          ? manager[sessionManagerAppendInitialMetadata]("test-provider", "test-model", "high")
          : appendInitial(kind, manager)
      ).catch((error: unknown) => error);
      if (kind === "message") {
        expect(failure).toBe(callerError);
      } else {
        expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
        expect(isRecordedModelFallbackStop(failure)).toBe(true);
      }
      expect(observedFence).toEqual({
        expectedLifecycleRevision: undefined,
        expectedWriterRunId: runParams.runId,
      });
      expect(promptState.sessionWriterFence).toEqual(observedFence);
      expect(loadSessionEntry(target)).toMatchObject({
        sessionId: target.sessionId,
        activeWriterRunId: runParams.runId,
      });
      const events = readEvents(target);
      if (kind === "message") {
        expect(events).toEqual([]);
      } else {
        expect(events).toMatchObject([
          { type: "session" },
          { type: "model_change", provider: "test-provider", modelId: "test-model" },
          ...(kind === "initial metadata"
            ? [{ type: "thinking_level_change", thinkingLevel: "high" }]
            : []),
        ]);
      }
    }),
);

it.each(["active", "closed", "replaced"] as const)(
  "uses the original manager admission for transcript rewrites (%s)",
  (state) =>
    withInitialWriter(async ({ admission, manager, replaceAdmission, target }) => {
      const entryId = manager.appendMessage(userMessage);
      const before = readEvents(target);
      if (state === "closed") {
        admission.close();
      } else if (state === "replaced") {
        await replaceAdmission();
      }
      const rewrite = () =>
        outsideWriter(() =>
          rewriteTranscriptEntriesInSessionManager({
            sessionManager: manager,
            replacements: [
              { entryId, message: { ...userMessage, content: "Rewritten user turn" } },
            ],
          }),
        );
      if (state === "active") {
        expect((await rewrite()).changed).toBe(true);
        expect(SessionManager.open(target).getBranch()).toMatchObject([
          { type: "message", message: { content: "Rewritten user turn" } },
        ]);
      } else {
        await expect(rewrite()).rejects.toThrow();
        expect(readEvents(target)).toEqual(before);
        expect(manager.getBranch()).toMatchObject([{ type: "message", message: userMessage }]);
      }
    }),
);

it.each(["append", "trim", "branch"] as const)(
  "does not let a retained manager %s after its initial admission closes",
  (operation) =>
    withInitialWriter(async ({ admission, manager, target }) => {
      const first = manager.appendMessage(userMessage);
      const before = readEvents(target);
      admission.close();
      if (operation === "branch") {
        await expect(outsideWriter(() => manager.createBranchedSession(first))).rejects.toThrow(
          "admitted run authority is no longer active",
        );
      } else {
        expect(() =>
          outsideWriter(() =>
            operation === "append"
              ? manager.appendMessage(userMessage)
              : manager.removeTrailingEntries(() => true),
          ),
        ).toThrow("admitted run authority is no longer active");
      }
      expect(readEvents(target)).toEqual(before);
      expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
    }),
);

it("retains its initial admission even before the first append", () =>
  withInitialWriter(async ({ admission, manager, target }) => {
    admission.close();
    expect(() => outsideWriter(() => manager.appendMessage(userMessage))).toThrow(
      "admitted run authority is no longer active",
    );
    expect(readEvents(target)).toEqual([]);
    expect(loadSessionEntry(target)).toBeUndefined();
  }));
