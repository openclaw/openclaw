import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement as beforeSettlement } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  createSessionEntryWithTranscript,
  inspectTranscriptEventsSync,
  loadTranscriptEvents as readEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import * as transcriptScope from "../../config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import type { SqliteWorkerOperations } from "../../infra/sqlite-worker-store.js";
import type { Message } from "../../llm/types.js";
import { applyLoggingConfig, resetLogger } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { SessionManager as Sdk } from "../../plugin-sdk/agent-sessions.js";
import * as asyncWork from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentResources from "../../state/openclaw-agent-db-resources.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import * as writeAdmission from "../../state/openclaw-agent-write-admission.js";
import * as stateResources from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { appendSessionTranscriptNote as appendNote } from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";

async function linkExternalStore(state: OpenClawTestState, link: string) {
  const external = state.path("external.sqlite");
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: "agent:main:other", storePath: external },
    { sessionId: "other", updatedAt: 1 },
  );
  await fs.symlink(external, link, "file");
}

async function createTarget(
  state: OpenClawTestState,
  sessionId: string,
  sessionKey = sessionId,
  revision = false,
) {
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionKey}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    env: { OPENCLAW_STATE_DIR: state.stateDir },
  };
  await upsertSessionEntryCore(target, {
    sessionId,
    updatedAt: 1,
    ...(revision ? { lifecycleRevision: `${sessionId}-generation` } : {}),
  });
  return target;
}

function makeNote(
  content: string,
  timestamp = 1,
  customType = "openclaw.system-note",
): CustomMessage {
  return { role: "custom", customType, content, display: true, timestamp };
}

function settled<T>(pending: Promise<T>, onSettled = () => {}): Promise<PromiseSettledResult<T>> {
  return pending.then(
    (value) => {
      onSettled();
      return { status: "fulfilled", value };
    },
    (reason: unknown) => {
      onSettled();
      return { status: "rejected", reason };
    },
  );
}

function watchAdmission(onAdmission: (path: string | undefined, reentrant?: boolean) => void) {
  const admit = writeAdmission.runOpenClawAgentWriteAdmission;
  return vi
    .spyOn(writeAdmission, "runOpenClawAgentWriteAdmission")
    .mockImplementation(<T>(...args: Parameters<typeof admit<T>>) => {
      const pending = admit<T>(...args);
      onAdmission(args[0].path, args[2]);
      return pending;
    });
}

const cases: Array<Message | CustomMessage | BashExecutionMessage> = [
  makeUserMessage("SDK user message", 1),
  {
    role: "bashExecution",
    command: "echo synthetic",
    output: "synthetic",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 3,
  },
];
it.each(cases)("returns a synchronous ID with immediately persisted $role content", (message) =>
  withOpenClawTestState({ label: "sdk-static-append-contract" }, async (state) => {
    const target = await createTarget(state, "sdk-static");
    const id: string = Sdk.appendMessageToTranscript(target, message);
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
  }),
);

it("awaits direct static writes while preserving keyed custom replay and admitted user custody", () =>
  withOpenClawTestState({ label: "sdk-static-async-parity" }, async (state) => {
    const target = await createTarget(state, "sdk-static-parity");
    const custom = {
      ...makeNote("Synthetic keyed SDK note", 1, "sdk-keyed-note"),
      idempotencyKey: "static-parity:custom",
    };
    const first = Sdk.appendMessageToTranscript(target, custom);
    expect(typeof first).toBe("string");
    const nextCustom = { ...custom, idempotencyKey: "static-parity:next" };
    const next = await Sdk.appendMessageToTranscriptAsync(target, nextCustom);
    const beforeReplay = await readEvents(target);
    expect(beforeReplay.slice(-2)).toMatchObject([
      { type: "message", id: first, parentId: null, message: custom },
      { id: next, parentId: first },
    ]);
    await expect(Sdk.appendMessageToTranscriptAsync(target, custom)).resolves.toBe(first);
    expect(await readEvents(target)).toEqual(beforeReplay);
    const receipt = expectDefined(
      await stageSessionPendingInput(target, {
        runId: "static-user",
        message: {
          ...makeUserMessage("Synthetic admitted SDK user", 2),
          idempotencyKey: "static-user:user",
        },
        assertCurrent: () => {},
      }),
      "Expected admitted static input",
    );
    const promote = () => Sdk.appendMessageToTranscriptAsync(target, receipt.message);
    try {
      await expect(receipt.run(promote)).resolves.toBe(receipt.inputId);
      expect(receipt.state).toBe("consumed");
      const afterPromotion = await readEvents(target);
      expect(afterPromotion.at(-1)).toMatchObject({
        id: receipt.inputId,
        parentId: next,
        message: receipt.message,
      });
      receipt.finish("cancelled");
      await expect(withSessionPendingInputPersistence(receipt, promote)).resolves.toBe(
        receipt.inputId,
      );
      expect(await readEvents(target)).toEqual(afterPromotion);
    } finally {
      receipt.finish("interrupted");
    }
  }));

it("keeps incognito instance and static async appends in invocation order", () =>
  withOpenClawTestState({ label: "sdk-static-incognito-fifo" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-static-order",
      env: state.env,
    };
    const created = await createSessionEntryWithTranscript(
      scope,
      () => ({
        ok: true as const,
        entry: { sessionId: "incognito-static-order", incognito: true as const, updatedAt: 1 },
      }),
      { cwd: state.workspaceDir },
    );
    assert(created.ok, "Expected incognito session fixture");
    const target = {
      ...scope,
      sessionId: created.entry.sessionId,
      storePath: resolveSessionStorePathCore(undefined, scope),
    };
    const manager = await Sdk.openAsync(target);
    const seed = await manager.appendMessageAsync(makeUserMessage("Synthetic seed", 1));
    const first = manager.appendMessageAsync(makeUserMessage("Instance first", 2));
    const second = Sdk.appendMessageToTranscriptAsync(
      target,
      makeNote("Static second", 3, "static-second"),
    );
    const [firstId, secondId] = await Promise.all([first, second]);
    expect((await readEvents(target)).slice(-3)).toMatchObject([
      { id: seed, parentId: null, message: { content: "Synthetic seed" } },
      { id: firstId, parentId: seed, message: { content: "Instance first" } },
      { id: secondId, parentId: firstId, message: { content: "Static second" } },
    ]);
  }));

it.each(["agent", "shared-state"] as const)(
  "retains pre-import append custody through canonical %s close",
  (owner) =>
    withOpenClawTestState({ label: "static-note-pre-import-close" }, async (state) => {
      const target = await createTarget(state, "closing-note", "closing-note", true);
      SessionManager.open(target).appendMessage(makeUserMessage("Retained before close", 1));
      await waitForSessionTranscriptProjection(target);
      const before = await readEvents(target);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const revoked = createDeferredCore();
      let collectEarlyResources = true;
      const watchRevoke = <R extends { path: string; revoke(): void }>(resource: R): R => {
        const early = collectEarlyResources && path.resolve(resource.path) === target.storePath;
        return {
          ...resource,
          revoke() {
            resource.revoke();
            if (early) {
              revoked.resolve();
            }
          },
        };
      };
      const registerAgent = agentResources.registerOpenClawAgentDatabaseAsyncResource;
      const agentSpy = vi
        .spyOn(agentResources, "registerOpenClawAgentDatabaseAsyncResource")
        .mockImplementation((resource) => registerAgent(watchRevoke(resource)));
      const registerCandidate = agentResources.registerOpenClawAgentDatabaseReadCandidateResource;
      const candidateSpy = vi
        .spyOn(agentResources, "registerOpenClawAgentDatabaseReadCandidateResource")
        .mockImplementation((resource) => registerCandidate(watchRevoke(resource)));
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
      const message = makeNote("Accepted before canonical close", 2);
      const append = settled(appendNote(target, message));
      let closing: Promise<PromiseSettledResult<boolean>> | undefined;
      let closeCompleted = false;
      try {
        await beforeSettlement(entered.promise, append, "Static append bypassed pre-import gate");
        const close =
          owner === "agent"
            ? closeOpenClawAgentDatabaseByPathAsync(target.storePath)
            : stateResources.closeOpenClawStateDatabaseByPathAsync(
                resolveOpenClawStateSqlitePath(target.env),
              );
        closing = settled(close, () => {
          closeCompleted = true;
        });
        const firstBoundary = await Promise.race([
          revoked.promise.then(() => "revoked" as const),
          closing.then(() => "closed" as const),
        ]);
        const closeCompletedWhileHeld = closeCompleted;
        release.resolve();
        const [appendOutcome, closeOutcome] = await Promise.all([append, closing]);
        const afterClose = await readEvents(target);
        const fresh = await settled(appendNote(target, makeNote("Fresh append after close", 3)));
        const afterFresh = await readEvents(target);
        expect(firstBoundary).toBe("revoked");
        expect(closeCompletedWhileHeld).toBe(false);
        expect(closeOutcome.status).toBe("fulfilled");
        expect(appendOutcome.status).toBe("rejected");
        expect(afterClose).toEqual(before);
        assert(fresh.status === "fulfilled");
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
    }),
);

it.each(["canonical", "custom-family"] as const)(
  "keeps invocation order while the first %s target preparation waits",
  (layout) =>
    withOpenClawTestState({ label: "static-note-preparation-order" }, async (state) => {
      const agentId = layout === "custom-family" ? "worker" : "main";
      const target = {
        agentId,
        sessionId: "ordered-notes",
        sessionKey: `agent:${agentId}:ordered-notes`,
        storePath:
          layout === "canonical"
            ? path.join(state.agentDir("main"), "openclaw-agent.sqlite")
            : state.path("shared.json"),
      };
      if (layout === "custom-family") {
        await linkExternalStore(state, state.path("shared.sqlite"));
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
      let admissions = 0;
      const admission = watchAdmission((pathname, reentrant) => {
        if (pathname === queuedPath && reentrant === true && ++admissions === 2) {
          queued.resolve();
        }
      });
      const first = appendNote(target, makeNote("first"));
      void first.catch(() => undefined);
      let second: ReturnType<typeof appendNote> | undefined;
      try {
        await beforeSettlement(entered.promise, first, "First note bypassed preparation gate");
        second = appendNote(target, makeNote("second"));
        await Promise.race([queued.promise, second]);
        release.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        const events = await readEvents(target);
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
    }),
);

it("refuses a replaced custom family after awaited note preparation", () =>
  withOpenClawTestState({ label: "static-note-family-replacement" }, async (state) => {
    const original = state.path("original");
    const replacement = state.path("replacement");
    const alias = state.path("selected");
    await fs.mkdir(original);
    await fs.mkdir(replacement);
    await fs.symlink(original, alias, "junction");
    await linkExternalStore(state, path.join(original, "shared.sqlite"));
    const target = {
      agentId: "worker",
      sessionId: "replaced-family",
      sessionKey: "agent:worker:replaced-family",
      storePath: path.join(alias, "shared.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    await waitForSessionTranscriptProjection(target);
    const physicalTarget = { ...target, storePath: path.join(original, "shared.worker.sqlite") };
    const before = await readEvents(physicalTarget);
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
      await expect(appendNote(target, makeNote("Must not reach the replacement"))).rejects.toThrow(
        "Session store alias changed",
      );
      expect(prepared).toBe(true);
      expect(await readEvents(physicalTarget)).toEqual(before);
      expect(await fs.readdir(replacement)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }));

it("captures static note inputs before waiting and retains FIFO custody through idempotent replay", () =>
  withOpenClawTestState({ label: "static-note-capture" }, async (state) => {
    const target = await createTarget(state, "original", "static-original", true);
    const originalTarget = structuredClone(target);
    const replacement = await createTarget(state, "other", "static-other", true);
    const replacementBefore = await readEvents(replacement);
    const note = {
      ...makeNote("First CAPTURED_PRIVATE safe"),
      details: { nested: { value: "original" } },
      idempotencyKey: "static-original-note",
    };
    const originalNote = structuredClone(note);
    const config = { logging: { redactPatterns: ["CAPTURED_PRIVATE"] } };
    const originalConfig = structuredClone(config);
    const committed = createDeferredCore();
    const release = createDeferredCore();
    const queued = createDeferredCore();
    let commands = 0;
    let admissions = 0;
    const admissionSpy = watchAdmission(() => {
      if (++admissions === 2) {
        queued.resolve();
      }
    });
    const runOperation = workerStore.runSqliteWorkerStoreOperation;
    const operationSpy = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          ...args: Parameters<typeof runOperation<Operations, T>>
        ) => {
          const [store, operation, ...controls] = args;
          return runOperation(
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
            ...controls,
          );
        },
      );
    const first = appendNote(target, note, { config });
    void first.catch(() => undefined);
    target.sessionId = replacement.sessionId;
    target.sessionKey = replacement.sessionKey;
    target.env.OPENCLAW_STATE_DIR = state.path("later-state");
    note.content = "Changed caller content";
    note.details.nested.value = "changed";
    config.logging.redactPatterns.splice(0, 1, "safe");
    let second: ReturnType<typeof appendNote> | undefined;
    let secondSettled = false;
    try {
      await beforeSettlement(committed.promise, first, "First note bypassed commit gate");
      const secondNote: typeof originalNote = {
        ...originalNote,
        content: "Second note",
        idempotencyKey: "static-second-note",
        timestamp: 2,
      };
      second = appendNote(originalTarget, secondNote);
      void settled(second, () => {
        secondSettled = true;
      });
      await beforeSettlement(queued.promise, second, "Second note bypassed admission queue");
      expect(secondSettled).toBe(false);
      expect(commands).toBe(1);
      release.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      const firstId = firstResult.messageId;
      const secondId = secondResult.messageId;
      const beforeReplay = await readEvents(originalTarget);
      expect(
        await appendNote(originalTarget, originalNote, {
          config: originalConfig,
        }),
      ).toEqual({ ...firstResult, appended: false, currentTail: false });
      expect(await readEvents(originalTarget)).toEqual(beforeReplay);
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
      expect(stored).toMatchObject({ message: { content: originalNote.content } });
      expect(stored).toHaveProperty("message", firstResult.message);
      expect(beforeReplay.at(-1)).toHaveProperty("message", secondResult.message);
      expect(await readEvents(replacement)).toEqual(replacementBefore);
      await expect(fs.stat(state.path("later-state"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      await Promise.allSettled(second ? [first, second] : [first]);
      operationSpy.mockRestore();
      admissionSpy.mockRestore();
    }
  }));

it.each(["registry", "pattern"] as const)(
  "preserves a static note when %s logging redaction changes before commit",
  (policy) =>
    withOpenClawTestState({ label: "static-note-redaction" }, async (state) => {
      const target = await createTarget(state, "redaction", "static-redaction", true);
      SessionManager.open(target).appendMessage(makeUserMessage("Retained prefix", 1));
      await waitForSessionTranscriptProjection(target);
      const before = await readEvents(target);
      const marker = "synthetic-static-note-registry-value";
      const message = makeNote(`Visible ${marker} end`, 2);
      resetSecretRedactionRegistryForTest();
      const patterns: string[] = [];
      if (policy === "pattern") {
        applyLoggingConfig({ redactPatterns: patterns });
      }
      let changed = 0;
      const spy = probe.admission(workerAdmission, (request, grant, admit) => {
        if (request.stage === "commit" && changed === 0) {
          changed++;
          if (policy === "registry") {
            registerSecretValueForRedaction(marker);
          } else {
            patterns.push(marker);
          }
        }
        admit(request, grant);
      });
      try {
        const result = await appendNote(target, message);
        expect(changed).toBe(1);
        const after = await readEvents(target);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after).toHaveLength(before.length + 1);
        const stored = SessionManager.open(target).getEntry(result.messageId);
        expect(stored).toMatchObject({
          type: "message",
          message: { content: message.content },
        });
        expect(stored).toHaveProperty("message", result.message);
      } finally {
        spy.mockRestore();
        resetSecretRedactionRegistryForTest();
        resetLogger();
      }
    }),
);
