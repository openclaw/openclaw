import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  inspectTranscriptEventsSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as transcriptScope from "../../config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import type { Message } from "../../llm/types.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { SessionManager as SdkSessionManager } from "../../plugin-sdk/agent-sessions.js";
import * as asyncWork from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentResources from "../../state/openclaw-agent-db-resources.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import * as writeAdmission from "../../state/openclaw-agent-write-admission.js";
import * as stateResources from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { appendSessionTranscriptNote } from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";

describe("released agent-sessions SDK static append", () => {
  const cases: Array<{
    name: string;
    message: Message | CustomMessage | BashExecutionMessage;
  }> = [
    { name: "ordinary", message: makeUserMessage("SDK user message", 1) },
    {
      name: "custom",
      message: {
        role: "custom",
        customType: "sdk-note",
        content: "SDK custom message",
        display: true,
        timestamp: 2,
      },
    },
    {
      name: "bash",
      message: {
        role: "bashExecution",
        command: "echo synthetic",
        output: "synthetic",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 3,
      },
    },
  ];
  it.each(cases)(
    "returns a synchronous ID with immediately persisted $name content",
    async ({ message }) => {
      await withOpenClawTestState({ label: "sdk-static-append-contract" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "sdk-static",
          sessionKey: "agent:main:sdk-static",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const id: string = SdkSessionManager.appendMessageToTranscript(target, message);
        try {
          expect(typeof id).toBe("string");
          expect(inspectTranscriptEventsSync(target).events.at(-1)).toMatchObject({
            type: "message",
            id,
            message,
          });
        } finally {
          // Join the broken asynchronous implementation when exercising the regression.
          await Promise.resolve(id);
        }
      });
    },
  );
});

describe("appendSessionTranscriptNote", () => {
  it.each(["agent", "shared-state"] as const)(
    "retains pre-import append custody through canonical %s close",
    async (owner) => {
      await withOpenClawTestState({ label: "static-note-pre-import-close" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "closing-note",
          sessionKey: "agent:main:closing-note",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        };
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: 1,
          lifecycleRevision: "closing-note-generation",
        });
        SessionManager.open(target).appendMessage(makeUserMessage("Retained before close", 1));
        await waitForSessionTranscriptProjection(target);
        const before = await loadTranscriptEvents(target);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const revoked = createDeferredCore();
        let collectEarlyResources = true;
        const registerAgent = agentResources.registerOpenClawAgentDatabaseAsyncResource;
        const agentSpy = vi
          .spyOn(agentResources, "registerOpenClawAgentDatabaseAsyncResource")
          .mockImplementation((resource) => {
            const early = collectEarlyResources && path.resolve(resource.path) === target.storePath;
            return registerAgent({
              ...resource,
              revoke() {
                resource.revoke();
                if (early) {
                  revoked.resolve();
                }
              },
            });
          });
        const registerCandidate = agentResources.registerOpenClawAgentDatabaseReadCandidateResource;
        const candidateSpy = vi
          .spyOn(agentResources, "registerOpenClawAgentDatabaseReadCandidateResource")
          .mockImplementation((resource) => {
            const early = collectEarlyResources && path.resolve(resource.path) === target.storePath;
            return registerCandidate({
              ...resource,
              revoke() {
                resource.revoke();
                if (early) {
                  revoked.resolve();
                }
              },
            });
          });
        const registerState = stateResources.registerOpenClawStateDatabaseAsyncResource;
        const stateSpy = vi
          .spyOn(stateResources, "registerOpenClawStateDatabaseAsyncResource")
          .mockImplementation((resource) => {
            const early = collectEarlyResources;
            return registerState({
              ...resource,
              close(identity) {
                const closing = resource.close(identity);
                if (early) {
                  revoked.resolve();
                }
                return closing;
              },
            });
          });
        const track = asyncWork.trackAsyncWork;
        const trackSpy = vi
          .spyOn(asyncWork, "trackAsyncWork")
          .mockImplementationOnce(<T>(run: () => T | Promise<T>) =>
            track(async () => {
              collectEarlyResources = false;
              entered.resolve();
              await release.promise;
              return await run();
            }),
          );
        const note = {
          role: "custom" as const,
          customType: "openclaw.system-note",
          content: "Accepted before canonical close",
          display: true,
          timestamp: 2,
        };
        const append = appendSessionTranscriptNote(target, note).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        let closing: Promise<PromiseSettledResult<boolean>> | undefined;
        let closeCompleted = false;
        try {
          await Promise.race([
            entered.promise,
            append.then(() => {
              throw new Error("Static append settled before its pre-import gate");
            }),
          ]);
          const close =
            owner === "agent"
              ? closeOpenClawAgentDatabaseByPathAsync(target.storePath)
              : stateResources.closeOpenClawStateDatabaseByPathAsync(
                  resolveOpenClawStateSqlitePath(target.env),
                );
          closing = close.then(
            (value) => {
              closeCompleted = true;
              return { status: "fulfilled" as const, value };
            },
            (reason: unknown) => {
              closeCompleted = true;
              return { status: "rejected" as const, reason };
            },
          );
          const firstBoundary = await Promise.race([
            revoked.promise.then(() => "revoked" as const),
            closing.then(() => "closed" as const),
          ]);
          const closeCompletedWhileHeld = closeCompleted;
          release.resolve();
          const [appendOutcome, closeOutcome] = await Promise.all([append, closing]);
          const afterClose = await loadTranscriptEvents(target);
          const fresh = await appendSessionTranscriptNote(target, {
            ...note,
            content: "Fresh append after close",
            timestamp: 3,
          }).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          );
          const afterFresh = await loadTranscriptEvents(target);

          expect({
            firstBoundary,
            closeCompletedWhileHeld,
            close: closeOutcome.status,
            append: appendOutcome.status,
            appendedRowsBeforeFreshCall: afterClose.length - before.length,
          }).toEqual({
            firstBoundary: "revoked",
            closeCompletedWhileHeld: false,
            close: "fulfilled",
            append: "rejected",
            appendedRowsBeforeFreshCall: 0,
          });
          expect(afterClose).toEqual(before);
          expect(fresh.status).toBe("fulfilled");
          if (fresh.status !== "fulfilled") {
            throw fresh.reason;
          }
          expect(afterFresh.slice(0, before.length)).toEqual(before);
          expect(afterFresh).toHaveLength(before.length + 1);
          expect(afterFresh.at(-1)).toMatchObject({
            type: "message",
            id: fresh.value.messageId,
            message: { content: "Fresh append after close" },
          });
          expect(afterFresh.at(-1)).toHaveProperty("message", fresh.value.message);
        } finally {
          release.resolve();
          await Promise.allSettled(closing ? [append, closing] : [append]);
          trackSpy.mockRestore();
          stateSpy.mockRestore();
          candidateSpy.mockRestore();
          agentSpy.mockRestore();
        }
      });
    },
  );

  it.each(["canonical", "shared", "custom-family"] as const)(
    "keeps invocation order while the first %s target preparation waits",
    async (layout) => {
      await withOpenClawTestState({ label: "static-note-preparation-order" }, async (state) => {
        const agentId = layout === "custom-family" ? "worker" : "main";
        const target = {
          agentId,
          sessionId: "ordered-notes",
          sessionKey: `agent:${agentId}:ordered-notes`,
          storePath:
            layout === "canonical"
              ? path.join(state.agentDir("main"), "openclaw-agent.sqlite")
              : state.path(layout === "custom-family" ? "shared.json" : "shared.sqlite"),
        };
        if (layout === "custom-family") {
          const external = state.path("external.sqlite");
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: "agent:main:other", storePath: external },
            { sessionId: "other", updatedAt: 1 },
          );
          await fs.symlink(external, state.path("shared.sqlite"), "file");
        }
        const queuedPath =
          layout === "custom-family" ? state.path("shared.sqlite") : target.storePath;
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        await waitForSessionTranscriptProjection(target);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const queued = createDeferredCore();
        const prepare = transcriptScope.prepareSqliteTranscriptReadScope;
        const preparation = vi
          .spyOn(transcriptScope, "prepareSqliteTranscriptReadScope")
          .mockImplementationOnce(async (...args) => {
            entered.resolve();
            await release.promise;
            return await prepare(...args);
          });
        const admit = writeAdmission.runOpenClawAgentWriteAdmission;
        let admissions = 0;
        const admission = vi
          .spyOn(writeAdmission, "runOpenClawAgentWriteAdmission")
          .mockImplementation(
            <T>(
              options: Parameters<typeof admit>[0],
              run: Parameters<typeof admit<T>>[1],
              reentrant?: boolean,
              timing?: Parameters<typeof admit>[3],
            ) => {
              const pending = admit(options, run, reentrant, timing);
              if (options.path === queuedPath && reentrant === true && ++admissions === 2) {
                queued.resolve();
              }
              return pending;
            },
          );
        const note = (content: string) => ({
          role: "custom" as const,
          customType: "openclaw.system-note",
          content,
          display: true,
          timestamp: 1,
        });
        const first = appendSessionTranscriptNote(target, note("first"));
        void first.catch(() => undefined);
        let second: ReturnType<typeof appendSessionTranscriptNote> | undefined;
        try {
          await Promise.race([
            entered.promise,
            first.then(() => {
              throw new Error("First note settled before target preparation was held");
            }),
          ]);
          second = appendSessionTranscriptNote(target, note("second"));
          await Promise.race([queued.promise, second]);
          release.resolve();
          const [firstResult, secondResult] = await Promise.all([first, second]);
          const events = await loadTranscriptEvents(target);
          expect(events.slice(-2)).toMatchObject([
            { id: firstResult.messageId, message: { content: "first" } },
            {
              id: secondResult.messageId,
              parentId: firstResult.messageId,
              message: { content: "second" },
            },
          ]);
        } finally {
          release.resolve();
          await Promise.allSettled(second ? [first, second] : [first]);
          admission.mockRestore();
          preparation.mockRestore();
        }
      });
    },
  );

  it("refuses a replaced custom family after awaited note preparation", async () => {
    await withOpenClawTestState({ label: "static-note-family-replacement" }, async (state) => {
      const original = state.path("original");
      const replacement = state.path("replacement");
      const alias = state.path("selected");
      await fs.mkdir(original);
      await fs.mkdir(replacement);
      await fs.symlink(original, alias, "junction");
      const external = state.path("external.sqlite");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:other", storePath: external },
        { sessionId: "other", updatedAt: 1 },
      );
      await fs.symlink(external, path.join(original, "shared.sqlite"), "file");
      const target = {
        agentId: "worker",
        sessionId: "replaced-family",
        sessionKey: "agent:worker:replaced-family",
        storePath: path.join(alias, "shared.json"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      await waitForSessionTranscriptProjection(target);
      const physicalTarget = { ...target, storePath: path.join(original, "shared.worker.sqlite") };
      const before = await loadTranscriptEvents(physicalTarget);
      const prepare = transcriptScope.prepareSqliteTranscriptReadScope;
      let prepared = false;
      const spy = vi
        .spyOn(transcriptScope, "prepareSqliteTranscriptReadScope")
        .mockImplementationOnce(async (...args) => {
          const result = await prepare(...args);
          prepared = true;
          await fs.unlink(alias);
          await fs.symlink(replacement, alias, "junction");
          return result;
        });
      try {
        await expect(
          appendSessionTranscriptNote(target, {
            role: "custom",
            customType: "openclaw.system-note",
            content: "Must not reach the replacement",
            display: true,
            timestamp: 1,
          }),
        ).rejects.toThrow("Session store alias changed");
        expect(prepared).toBe(true);
        expect(await loadTranscriptEvents(physicalTarget)).toEqual(before);
        expect(await fs.readdir(replacement)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("captures static note inputs before waiting and retains FIFO custody through idempotent replay", async () => {
    await withOpenClawTestState({ label: "static-note-capture" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "original",
        sessionKey: "agent:main:static-original",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        env: { OPENCLAW_STATE_DIR: state.stateDir },
      };
      const originalTarget = structuredClone(target);
      const replacement = {
        ...structuredClone(target),
        sessionId: "other",
        sessionKey: "agent:main:static-other",
      };
      for (const scope of [target, replacement]) {
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          lifecycleRevision: `${scope.sessionId}-generation`,
        });
      }
      const replacementBefore = await loadTranscriptEvents(replacement);
      const note = {
        role: "custom" as const,
        customType: "openclaw.system-note",
        content: "First CAPTURED_PRIVATE safe",
        display: true,
        details: { nested: { value: "original" } },
        idempotencyKey: "static-original-note",
        timestamp: 1,
      };
      const originalNote = structuredClone(note);
      const config = { logging: { redactPatterns: ["CAPTURED_PRIVATE"] } };
      const originalConfig = structuredClone(config);
      const committed = createDeferredCore();
      const release = createDeferredCore();
      const queued = createDeferredCore();
      let commands = 0;
      let admissions = 0;
      const runWrite = writeAdmission.runOpenClawAgentWriteAdmission;
      const admissionSpy = vi
        .spyOn(writeAdmission, "runOpenClawAgentWriteAdmission")
        .mockImplementation(
          <T>(
            options: Parameters<typeof runWrite>[0],
            run: Parameters<typeof runWrite<T>>[1],
            reentrant?: boolean,
            timing?: Parameters<typeof runWrite>[3],
          ) => {
            const pending = runWrite(options, run, reentrant, timing);
            if (++admissions === 2) {
              queued.resolve();
            }
            return pending;
          },
        );
      const runOperation = workerStore.runSqliteWorkerStoreOperation;
      const operationSpy = vi
        .spyOn(workerStore, "runSqliteWorkerStoreOperation")
        .mockImplementation(
          <Operations extends SqliteWorkerOperations, T>(
            store: SqliteWorkerStore<Operations>,
            operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
            stateContext?: Parameters<typeof runOperation>[2],
            assertCurrent?: Parameters<typeof runOperation>[3],
            admission?: Parameters<typeof runOperation>[4],
          ) =>
            runOperation(
              store,
              (scope) =>
                operation({
                  execute: async (command, options) => {
                    const selected =
                      command.type === "database.domain.execute" &&
                      isRecord(command.input) &&
                      isRecord(command.input.command) &&
                      command.input.command.type === "session.transcript.appendMessage";
                    const hold = selected && ++commands === 1;
                    const result = await scope.execute(command, options);
                    if (hold) {
                      committed.resolve();
                      await release.promise;
                    }
                    return result;
                  },
                }),
              stateContext,
              assertCurrent,
              admission,
            ),
        );
      const first = appendSessionTranscriptNote(target, note, { config });
      void first.catch(() => undefined);
      target.sessionId = replacement.sessionId;
      target.sessionKey = replacement.sessionKey;
      target.env.OPENCLAW_STATE_DIR = state.path("later-state");
      note.content = "Changed caller content";
      note.details.nested.value = "changed";
      config.logging.redactPatterns.splice(0, 1, "safe");
      let second: ReturnType<typeof appendSessionTranscriptNote> | undefined;
      let secondSettled = false;
      try {
        await Promise.race([
          committed.promise,
          first.then(() => {
            throw new Error("First note returned before the held commit result");
          }),
        ]);
        const secondNote: typeof originalNote = {
          ...originalNote,
          content: "Second note",
          idempotencyKey: "static-second-note",
          timestamp: 2,
        };
        second = appendSessionTranscriptNote(originalTarget, secondNote);
        void second.then(
          () => {
            secondSettled = true;
          },
          () => {
            secondSettled = true;
          },
        );
        await Promise.race([
          queued.promise,
          second.then(() => {
            throw new Error("Second note returned before queued admission");
          }),
        ]);
        expect(secondSettled).toBe(false);
        expect(commands).toBe(1);
        release.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        const firstId = firstResult.messageId;
        const secondId = secondResult.messageId;
        const beforeReplay = await loadTranscriptEvents(originalTarget);
        expect(
          await appendSessionTranscriptNote(originalTarget, originalNote, {
            config: originalConfig,
          }),
        ).toEqual({ ...firstResult, appended: false, currentTail: false });
        expect(await loadTranscriptEvents(originalTarget)).toEqual(beforeReplay);
        expect(beforeReplay).toMatchObject([
          { type: "session", id: originalTarget.sessionId },
          {
            type: "message",
            id: firstId,
            parentId: null,
            message: {
              ...originalNote,
              content: expect.stringContaining("First"),
            },
          },
          { type: "message", id: secondId, parentId: firstId, message: { content: "Second note" } },
        ]);
        const stored = SessionManager.open(originalTarget).getEntry(firstId);
        expect(stored).toMatchObject({ message: { content: expect.stringContaining("safe") } });
        expect(stored).toHaveProperty("message", firstResult.message);
        expect(beforeReplay.at(-1)).toHaveProperty("message", secondResult.message);
        expect(JSON.stringify(stored)).not.toContain("CAPTURED_PRIVATE");
        expect(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
        await expect(fs.stat(state.path("later-state"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        release.resolve();
        await Promise.allSettled(second ? [first, second] : [first]);
        operationSpy.mockRestore();
        admissionSpy.mockRestore();
      }
    });
  });

  it("rolls back a static note when registered redaction changes before commit", async () => {
    await withOpenClawTestState({ label: "static-note-redaction" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "redaction",
        sessionKey: "agent:main:static-redaction",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        lifecycleRevision: "redaction-generation",
      });
      SessionManager.open(target).appendMessage(makeUserMessage("Retained prefix", 1));
      await waitForSessionTranscriptProjection(target);
      const before = await loadTranscriptEvents(target);
      const marker = "synthetic-static-note-registry-value";
      const note = {
        role: "custom" as const,
        customType: "openclaw.system-note",
        content: `Visible ${marker} end`,
        display: true,
        timestamp: 2,
      };
      resetSecretRedactionRegistryForTest();
      let changed = 0;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const spy = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit" && changed === 0) {
              changed++;
              registerSecretValueForRedaction(marker);
            }
            admit(request, grant);
          }, attachment),
        );
      try {
        const rejected = await appendSessionTranscriptNote(target, note).then(
          () => {
            throw new Error("Expected changed redaction to refuse the commit");
          },
          (error: unknown) => error,
        );
        expect(changed).toBe(1);
        expect(rejected).toMatchObject({
          message: "Transcript message redaction changed before persistence",
        });
        expect(isRecordedModelFallbackStop(rejected)).toBe(false);
        expect(await loadTranscriptEvents(target)).toEqual(before);
        spy.mockRestore();
        const result = await appendSessionTranscriptNote(target, note);
        const after = await loadTranscriptEvents(target);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after).toHaveLength(before.length + 1);
        const stored = SessionManager.open(target).getEntry(result.messageId);
        expect(stored).toMatchObject({
          type: "message",
          message: { content: expect.stringContaining("Visible") },
        });
        expect(JSON.stringify(stored)).not.toContain(marker);
        expect(stored).toHaveProperty("message", result.message);
      } finally {
        spy.mockRestore();
        resetSecretRedactionRegistryForTest();
      }
    });
  });
});
