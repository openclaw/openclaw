import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.sqlite-compaction-runtime.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import { readSessionTranscriptModelContextAsync } from "../../config/sessions/session-transcript-context-read.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { applyLoggingConfig, resetLogger } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { withSessionCompactionPersistenceAsync } from "./session-compaction-persistence.js";
import {
  sessionManagerReadInitialContext,
  sessionManagerPrepareCurrentTurnReplay,
} from "./session-manager-current-turn.js";
import { readSessionManagerModelContextAsync } from "./session-manager-incognito.js";
import { SessionTranscriptMessageCommittedError } from "./session-manager-message-error.js";
import {
  appendSessionTranscriptNote,
  withSessionManagerWrite,
  withSessionManagerWriteAssertion,
} from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("session-manager-actor-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});
afterAll(async () => {
  await actor?.close();
});

async function create(name: string) {
  const target = {
    agentId: "main",
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: name,
    storePath: actor.path,
    env,
  };
  await actor.sessions.create(authority, {
    sessionKey: target.sessionKey,
    entry: {
      sessionId: name,
      lifecycleRevision: "initial",
      incognito: true,
      createdAt: 1,
      updatedAt: 1,
    },
  });
  return target;
}

it("keeps manager reads and writes on the original actor outside its opening scope", async () => {
  const target = await create("retained-manager");
  const manager = await withIncognitoSessionActor(actor, () => SessionManager.openAsync(target));
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  try {
    const first = await manager.appendMessageAsync(makeUserMessage("retained owner", 1));
    assert(first);
    await manager.appendThinkingLevelChange("high");
    await manager.reloadPersistedTranscriptAsync();
    const bounded = await withIncognitoSessionActor(actor, () =>
      SessionManager.openBoundedAsync(target, { maxEvents: 2, maxBytes: 8192 }),
    );
    expect((await bounded[sessionManagerReadInitialContext]()).messages).toMatchObject([
      { role: "user", content: "retained owner" },
    ]);
    const admission = new AbortController();
    await withIncognitoSessionActor(
      actor,
      async () => {
        admission.abort(new Error("initial context admission closed"));
        await expect(bounded[sessionManagerReadInitialContext]()).rejects.toThrow(
          "initial context admission closed",
        );
      },
      admission.signal,
    );
    expect(
      await bounded[sessionManagerPrepareCurrentTurnReplay](
        () => false,
        (entry) => entry?.id === first,
      ),
    ).toMatchObject({ anchor: { entryId: first } });
    const rewrite = await manager.prepareTranscriptRewriteAsync();
    await rewrite.sessionManager.resetLeafAsync();
    const replacement = await rewrite.sessionManager.appendMessageAsync(
      makeUserMessage("rewritten", 2),
    );
    assert(replacement);
    await rewrite.commit(new Map([[first, replacement]]));
    await manager.reloadPersistedTranscriptAsync();
    expect(manager.buildSessionContext().messages).toMatchObject([{ content: "rewritten" }]);
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    exec.mockRestore();
  }
});

it("refuses a released manager borrow even inside another live actor scope", async () => {
  const target = await create("released-manager");
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  const manager = await withIncognitoSessionActor(borrowed, () => SessionManager.openAsync(target));
  await borrowed.release();
  await withIncognitoSessionActor(actor, async () => {
    await expect(manager.reloadPersistedTranscriptAsync()).rejects.toThrow("reference is released");
    await expect(manager.setSessionTargetAsync(target)).rejects.toThrow("reference is released");
    await expect(
      manager.appendMessageAsync(makeUserMessage("must not redirect", 1)),
    ).rejects.toThrow("reference is released");
    expect((await SessionManager.openAsync(target)).getEntries()).toEqual([]);
    const destination = await create("retargeted-manager");
    await manager.setSessionTargetAsync(destination);
  });
  await manager.appendMessageAsync(makeUserMessage("explicitly retargeted", 2));
  await manager.reloadPersistedTranscriptAsync();
  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "explicitly retargeted" },
  ]);
});

it("retargets another session on its retained actor outside the opening scope", async () => {
  const source = await create("retarget-outside-source");
  const destination = await create("retarget-outside-destination");
  const admission = new AbortController();
  const manager = await withIncognitoSessionActor(
    actor,
    async () => {
      const seeded = await SessionManager.openAsync(destination);
      await seeded.appendMessageAsync(makeUserMessage("destination history", 1));
      return SessionManager.openAsync(source);
    },
    admission.signal,
  );

  await manager.setSessionTargetAsync(destination);
  expect(manager.getSessionTarget()).toMatchObject(destination);
  expect(manager.buildSessionContext().messages).toMatchObject([
    { role: "user", content: "destination history" },
  ]);
  await expect(
    manager.setSessionTargetAsync(
      captureSessionTranscriptTargetBinding({
        ...destination,
        env: { OPENCLAW_STATE_DIR: tempDirs.make("retarget-other-namespace-") },
      }),
    ),
  ).rejects.toThrow("Explicit incognito database target does not match its agent and state root");
  expect(manager.getSessionTarget()).toMatchObject(destination);
  await manager.appendMessageAsync(makeUserMessage("retained destination write", 2));
  await manager.reloadPersistedTranscriptAsync();
  expect(manager.buildSessionContext().messages).toMatchObject([
    { role: "user", content: "destination history" },
    { role: "user", content: "retained destination write" },
  ]);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = actor.run(authority, async () => {
    entered.resolve();
    await release.promise;
  });
  let reloading: Promise<void> | undefined;
  try {
    await entered.promise;
    reloading = manager.reloadPersistedTranscriptAsync();
    admission.abort(new Error("retarget owner closing"));
    release.resolve();
    await expect(reloading).rejects.toThrow("retarget owner closing");
  } finally {
    release.resolve();
    await Promise.allSettled([held, reloading]);
  }
  await expect(
    manager.appendMessageAsync(makeUserMessage("must not outlive admission", 3)),
  ).rejects.toThrow("retarget owner closing");
  await expect(manager.reloadPersistedTranscriptAsync()).rejects.toThrow("retarget owner closing");
  await expect(manager.setSessionTargetAsync(source)).rejects.toThrow("retarget owner closing");
  expect(manager.getSessionTarget()).toMatchObject(destination);
});

it("settles accepted branch hydration after its retained admission closes", async () => {
  const target = await create("accepted-branch-hydration");
  const admission = new AbortController();
  const { manager, first } = await withIncognitoSessionActor(
    actor,
    async () => {
      const opened = await SessionManager.openAsync(target);
      const entryId = await opened.appendMessageAsync(makeUserMessage("accepted branch source", 1));
      assert(entryId);
      return { manager: opened, first: entryId };
    },
    admission.signal,
  );
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = withSessionManagerWrite(manager, async () => {
    entered.resolve();
    await release.promise;
  });
  let branching: ReturnType<SessionManager["createBranchedSession"]> | undefined;
  try {
    await entered.promise;
    branching = manager.createBranchedSession(first);
    admission.abort(new Error("branch admission closed"));
    release.resolve();
    const sessionId = await branching;
    assert(sessionId);
    expect(sessionId).not.toBe(target.sessionId);
    const destination = manager.getSessionTarget();
    assert(destination);
    expect(destination.sessionId).toBe(sessionId);
    const reopened = await withIncognitoSessionActor(actor, () =>
      SessionManager.openAsync(destination),
    );
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "accepted branch source" },
    ]);
  } finally {
    release.resolve();
    await Promise.allSettled([held, branching]);
  }
});

it("reads missing actor context as empty and rejects a row created during consumption", async () => {
  const target = {
    agentId: "main",
    env,
    storePath: actor.path,
    sessionKey: "agent:main:dashboard:incognito-missing-context",
    sessionId: "missing-context",
  };
  await withIncognitoSessionActor(actor, async () => {
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      expect(
        await SessionManager.readSessionContextAsync(target, (messages, header) => ({
          messages: [...messages],
          header,
        })),
      ).toEqual({ messages: [], header: undefined });
      expect(await readSessionManagerModelContextAsync(target, {}, (context) => context)).toEqual({
        events: [],
        version: { generation: null, rawSeq: null, updatedAt: null },
      });
      expect(await readSessionTranscriptModelContextAsync(target, (context) => context)).toEqual({
        events: [],
        version: { generation: null, rawSeq: null, updatedAt: null },
      });
      for (const kind of ["full", "model"] as const) {
        const current = {
          ...target,
          sessionKey: `${target.sessionKey}-${kind}`,
          sessionId: `${target.sessionId}-${kind}`,
        };
        const createDuringRead = async () => {
          await actor.sessions.create(authority, {
            sessionKey: current.sessionKey,
            entry: { sessionId: current.sessionId, updatedAt: 1, incognito: true },
          });
        };
        const reading =
          kind === "full"
            ? SessionManager.readSessionContextAsync(current, async (messages) => {
                expect([...messages]).toEqual([]);
                await createDuringRead();
              })
            : readSessionManagerModelContextAsync(current, {}, async (context) => {
                expect(context.events).toEqual([]);
                await createDuringRead();
              });
        await expect(reading).rejects.toThrow("generation is no longer current");
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      exec.mockRestore();
    }
  });
});

it("reads full context without caller SQL and retains its prefix across an awaited append", async () => {
  const target = await create("context-consumer");
  await withIncognitoSessionActor(actor, async () => {
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync(
      Object.assign(makeUserMessage("full fidelity", 1), {
        __openclaw: { upstreamUserText: "synthetic-private-native-text" },
      }),
    );
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      let retained: Iterable<unknown> | undefined;
      const messages = await SessionManager.readSessionContextAsync(
        target,
        async (context, header) => {
          retained = context;
          expect(header).toMatchObject({ id: target.sessionId });
          const model = await SessionManager.openModelContextAsync(target);
          expect(JSON.stringify(model.buildSessionContext())).not.toContain(
            "synthetic-private-native-text",
          );
          return [...context];
        },
      );
      expect(messages).toMatchObject([
        {
          role: "user",
          __openclaw: { upstreamUserText: "synthetic-private-native-text" },
        },
      ]);
      expect([...retained!]).toEqual([]);
      await expect(
        SessionManager.readSessionContextAsync(target, async (context) => {
          await manager.appendMessageAsync(makeUserMessage("changed during consumption", 2));
          return [...context];
        }),
      ).resolves.toEqual(messages);
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      exec.mockRestore();
    }
  });
});

it("rejects context disclosure after its consumer releases the original actor borrow", async () => {
  const target = await create("released-context-consumer");
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  let releasing: Promise<void> | undefined;
  try {
    await expect(
      withIncognitoSessionActor(borrowed, () =>
        SessionManager.readSessionContextAsync(target, () => {
          // Release joins this accepted callback, so its settlement is awaited after the read.
          releasing = borrowed.release();
          return "released actor result";
        }),
      ),
    ).rejects.toThrow("reference is released");
  } finally {
    await (releasing ?? borrowed.release());
  }
});

it("rejects context disclosure when its admission closes during the awaited consumer", async () => {
  const target = await create("closed-context-admission");
  const admission = new AbortController();
  await withIncognitoSessionActor(
    actor,
    async () => {
      const manager = await SessionManager.openAsync(target);
      await manager.appendMessageAsync(makeUserMessage("private admitted context", 1));
      await expect(
        SessionManager.readSessionContextAsync(target, async (messages) => {
          await Promise.resolve();
          admission.abort(new Error("context admission closed"));
          expect(() => [...messages]).toThrow("context admission closed");
          return "revoked context result";
        }),
      ).rejects.toThrow("context admission closed");
    },
    admission.signal,
  );
});

it("publishes model context before following work enters its actor", async () => {
  const target = await create("model-context-publication");
  await withIncognitoSessionActor(actor, async () => {
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync(makeUserMessage("publish inside validation", 1));
    const order: string[] = [];
    const history = actor.sessions.history;
    const forward: typeof history = async (grant, command, signal, onRead) => {
      const result = await history(grant, command, signal, onRead);
      if (onRead) {
        await actor.run(authority, async () => {
          order.push("following actor work");
        });
      }
      return result;
    };
    const spy = vi.spyOn(actor.sessions, "history").mockImplementation(forward);
    try {
      const entries = await readSessionManagerModelContextAsync(target, {}, (context) => {
        order.push("context publication");
        return context.events;
      });
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ content: "publish inside validation" }),
        }),
      );
      expect(order).toEqual(["context publication", "following actor work"]);
    } finally {
      spy.mockRestore();
    }
  });
});

it("persists messages, metadata, suffixes, rewrites and branches on the actor without caller SQL", async () => {
  const target = {
    ...(await create("maintenance")),
    storePath: path.join(path.dirname(path.dirname(actor.path)), "sessions", "sessions.json"),
  };
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  try {
    await withIncognitoSessionActor(actor, async () => {
      const manager = await SessionManager.openAsync(target);
      const fresh = vi.fn();
      const original = {
        ...makeUserMessage("original", 1),
        idempotencyKey: "original:user",
      };
      const first = await manager.appendMessageWithTranscriptAnchorAsync(original, {
        beforeFreshMessageCommit: fresh,
      });
      expect(first).toMatchObject({ appended: true, anchor: { entryId: first.entryId } });
      const replay = await manager.appendMessageWithTranscriptAnchorAsync(
        { ...original, timestamp: 2 },
        { beforeFreshMessageCommit: fresh },
      );
      expect(replay).toMatchObject({ appended: false, entryId: first.entryId });
      expect(fresh).toHaveBeenCalledTimes(1);
      await manager.appendLeafControlAsync({
        targetId: first.entryId,
        appendParentId: first.entryId,
      });
      await manager.appendModelChange("synthetic", "model");
      await manager.appendThinkingLevelChange("high");
      const temporary = await manager.appendCustomEntryAsync("temporary", { exact: "payload" });
      expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === temporary)).toBe(1);
      const rewrite = await manager.prepareTranscriptRewriteAsync();
      await rewrite.sessionManager.resetLeafAsync();
      const replacement = await rewrite.sessionManager.appendMessageAsync(
        makeUserMessage("replacement", 3),
      );
      assert(replacement);
      await rewrite.commit(new Map([[first.entryId, replacement]]));
      expect(manager.getLeafId()).toBe(replacement);
      const branchedId = await manager.createBranchedSession(replacement);
      expect(branchedId).toBe(manager.getSessionId());
      const currentTarget = manager.getSessionTarget();
      assert(currentTarget);
      await withSessionCompactionPersistenceAsync(
        manager,
        (prepared) =>
          persistCompactionBoundaryWithSessionEntryAsync(currentTarget, {
            prepared,
            transcriptByteCompactionLatch: {
              activeBytes: 2048,
              sessionId: currentTarget.sessionId,
              maxBytes: 1024,
            },
          }),
        () => manager.appendCompactionAsync("summary", replacement, 100),
      );
      expect(
        (await actor.sessions.read(authority, { sessionKey: target.sessionKey })).entry
          ?.compactionCount,
      ).toBe(1);
      const reopened = await SessionManager.openAsync(currentTarget);
      expect(reopened.getBranch()).toEqual(manager.getBranch());
      expect(actor.sessions.readSharing(target.sessionKey)?.entry?.sessionId).toBe(branchedId);
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    exec.mockRestore();
  }
});

it("rolls back fresh-message refusal and fences queued authority before mutation", async () => {
  const target = await create("authority");
  await withIncognitoSessionActor(actor, async () => {
    const manager = await SessionManager.openAsync(target);
    await expect(
      manager.appendMessageAsync(makeUserMessage("refused", 1), {
        beforeFreshMessageCommit() {
          throw new Error("fresh grant revoked");
        },
      }),
    ).rejects.toThrow("fresh grant revoked");
    expect((await SessionManager.openAsync(target)).getEntries()).toEqual([]);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const held = actor.run(authority, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let current = true;
    const refused = withSessionManagerWriteAssertion(
      manager,
      () => {
        if (!current) {
          throw new Error("writer revoked");
        }
      },
      () => manager.appendCustomEntryAsync("refused"),
    );
    const rejected = expect(refused).rejects.toThrow("writer revoked");
    current = false;
    release.resolve();
    await Promise.all([held, rejected]);
    const [one, two] = await Promise.all([
      manager.appendCustomEntryAsync("one"),
      manager.appendCustomEntryAsync("two"),
    ]);
    expect(manager.getEntries()).toMatchObject([
      { id: one, parentId: null },
      { id: two, parentId: one },
    ]);
    expect((await SessionManager.openAsync(target)).getEntries()).toEqual(manager.getEntries());
  });
});

it.each(["append", "persist"] as const)(
  "preserves an acknowledged %s after its caller is revoked before publication",
  async (method) => {
    const target = await create(`committed-${method}`);
    await withIncognitoSessionActor(actor, async () => {
      const manager = await SessionManager.openAsync(target);
      await manager.appendCustomEntryAsync("before-revocation");
      let current = true;
      const original = workerAdmission.createSqliteWorkerOperationAdmission;
      const spy = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          original((request, grant) => {
            admit(request, grant);
            if (request.stage === "commit") {
              current = false;
            }
          }, attachment),
        );
      let failure: unknown;
      try {
        await withSessionManagerWriteAssertion(
          manager,
          () => {
            if (!current) {
              throw new Error("retired after commit grant");
            }
          },
          () =>
            method === "append"
              ? manager.appendCustomEntryAsync("committed-once")
              : manager.persistAsync({
                  type: "custom",
                  id: "committed-once",
                  parentId: null,
                  timestamp: new Date().toISOString(),
                  customType: "committed-once",
                  data: {},
                }),
        );
      } catch (error) {
        failure = error;
      } finally {
        spy.mockRestore();
      }
      expect(failure).toBeInstanceOf(Error);
      expect(isRecordedModelFallbackStop(failure)).toBe(true);
      expect(() => manager.getEntries()).toThrow();
      const reopened = await SessionManager.openAsync(target);
      expect(reopened.getEntries()).toMatchObject([
        { type: "custom", customType: "before-revocation" },
        { type: "custom", customType: "committed-once" },
      ]);
    });
  },
);

it.each(["registry", "pattern"] as const)(
  "rolls back actor static notes after %s redaction drift and accepts fresh preparation",
  async (policy) => {
    const target = await create(`static-redaction-${policy}`);
    const marker = `synthetic-actor-note-${policy}-private-value`;
    const note = {
      role: "custom" as const,
      customType: "fixture:actor-note",
      content: `Visible ${marker} end`,
      display: true,
      timestamp: 1,
    };
    const patterns: string[] = [];
    applyLoggingConfig({ redactPatterns: patterns });
    resetSecretRedactionRegistryForTest();
    let changed = false;
    const original = workerAdmission.createSqliteWorkerOperationAdmission;
    const spy = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        original((request, grant) => {
          if (request.stage === "commit" && !changed) {
            changed = true;
            if (policy === "registry") {
              registerSecretValueForRedaction(marker);
            } else {
              patterns.push(marker);
            }
          }
          admit(request, grant);
        }, attachment),
      );
    try {
      await withIncognitoSessionActor(actor, async () => {
        await expect(appendSessionTranscriptNote(target, note)).rejects.toThrow(
          "Transcript message redaction changed before persistence",
        );
        expect(changed).toBe(true);
        expect((await SessionManager.openAsync(target)).getEntries()).toEqual([]);
        spy.mockRestore();
        const committed = await appendSessionTranscriptNote(target, note);
        const reopened = await SessionManager.openAsync(target);
        expect(reopened.getEntries()).toHaveLength(1);
        expect(reopened.getEntry(committed.messageId)).toMatchObject({
          message: committed.message,
        });
        expect(JSON.stringify(committed.message)).not.toContain(marker);
      });
    } finally {
      spy.mockRestore();
      resetSecretRedactionRegistryForTest();
      resetLogger();
    }
  },
);

it("retains the static note message receipt after acknowledged actor authority loss", async () => {
  const target = await create("static-acknowledged");
  await withIncognitoSessionActor(actor, async () => {
    let current = true;
    const original = workerAdmission.createSqliteWorkerOperationAdmission;
    const spy = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        original((request, grant) => {
          admit(request, grant);
          if (request.stage === "commit") {
            current = false;
          }
        }, attachment),
      );
    let failure: unknown;
    try {
      await withSessionTranscriptWriteAssertion(
        target,
        () => {
          if (!current) {
            throw new Error("static note authority retired after commit grant");
          }
        },
        () =>
          appendSessionTranscriptNote(target, makeUserMessage("acknowledged static note", 1), {
            config: { logging: { redactPatterns: [] } },
          }),
      );
    } catch (error) {
      failure = error;
    } finally {
      spy.mockRestore();
    }
    expect(failure).toBeInstanceOf(SessionTranscriptMessageCommittedError);
    assert(failure instanceof SessionTranscriptMessageCommittedError);
    expect(isRecordedModelFallbackStop(failure)).toBe(true);
    expect(failure.committedTarget).toMatchObject(target);
    expect(failure.committedVersion).toMatchObject({
      generation: expect.any(String),
      rawSeq: expect.any(Number),
    });
    expect(failure.committedLifecycleRevision).toBe("initial");
    const reopened = await SessionManager.openAsync(target);
    expect(reopened.getEntries()).toMatchObject([
      { id: failure.committedMessageId, type: "message" },
    ]);
    expect(reopened.getEntries()).toHaveLength(1);
  });
});

it("keeps acknowledged rewrite content out of error diagnostics", async () => {
  const target = await create("private-rewrite-receipt");
  await withIncognitoSessionActor(actor, async () => {
    const manager = await SessionManager.openAsync(target);
    const source = await manager.appendMessageAsync(makeUserMessage("original", 1));
    assert(source);
    const rewrite = await manager.prepareTranscriptRewriteAsync();
    await rewrite.sessionManager.resetLeafAsync();
    const marker = "synthetic-incognito-private-receipt-content";
    const replacement = await rewrite.sessionManager.appendMessageAsync(makeUserMessage(marker, 2));
    assert(replacement);
    let current = true;
    const original = workerAdmission.createSqliteWorkerOperationAdmission;
    const spy = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        original((request, grant) => {
          admit(request, grant);
          if (request.stage === "commit") {
            current = false;
          }
        }, attachment),
      );
    let failure: unknown;
    try {
      await withSessionManagerWriteAssertion(
        manager,
        () => {
          if (!current) {
            throw new Error("rewrite owner retired after commit grant");
          }
        },
        () => rewrite.commit(new Map([[source, replacement]])),
      );
    } catch (error) {
      failure = error;
    } finally {
      spy.mockRestore();
    }
    expect(failure).toBeInstanceOf(Error);
    expect(inspect(failure, { depth: null })).not.toContain(marker);
    expect(() => manager.getEntries()).toThrow();
    const reopened = await SessionManager.openAsync(target);
    expect(reopened.getEntries()).toMatchObject([
      { id: source, message: { content: "original" } },
      { id: replacement, message: { content: marker } },
    ]);
    expect(reopened.getEntries()).toHaveLength(2);
  });
});

it.each(["entry", "leaf"] as const)(
  "retains acknowledged %s failure when a public reload publishes its view during projection",
  async (method) => {
    const target = await create(`reload-race-${method}`);
    await withIncognitoSessionActor(actor, async () => {
      const manager = await SessionManager.openAsync(target);
      const first = await manager.appendCustomEntryAsync("first");
      await manager.appendCustomEntryAsync("second");
      if (method === "entry") {
        await manager.branchAsync(first);
      }
      let current = true;
      let reloaded = false;
      const withCompute = actor.sessions.withCompute;
      const spy = vi
        .spyOn(actor.sessions, "withCompute")
        .mockImplementation((computeAuthority, computeTarget, operation, signal) =>
          withCompute(
            computeAuthority,
            computeTarget,
            async (compute) => {
              await manager.reloadPersistedTranscriptAsync();
              reloaded = true;
              current = false;
              return operation(compute);
            },
            signal,
          ),
        );
      let failure: unknown;
      try {
        await withSessionManagerWriteAssertion(
          manager,
          () => {
            if (!current) {
              throw new Error("actor projection authority retired after public reload");
            }
          },
          () =>
            method === "entry"
              ? manager.appendCustomEntryAsync("committed-before-reload")
              : manager.appendLeafControlAsync({ targetId: first, appendParentId: first }),
        );
      } catch (error) {
        failure = error;
      } finally {
        spy.mockRestore();
      }
      expect(reloaded).toBe(true);
      expect(failure).toBeInstanceOf(Error);
      expect(isRecordedModelFallbackStop(failure)).toBe(true);
      expect(() => manager.getEntries()).toThrow();
      const reopened = await SessionManager.openAsync(target);
      expect(reopened.getEntries()).toHaveLength(method === "entry" ? 3 : 2);
      expect(reopened.getBranch()).toMatchObject([
        { id: first },
        ...(method === "entry" ? [{ type: "custom", customType: "committed-before-reload" }] : []),
      ]);
    });
  },
);

it("installs confirmed actor facts when the acknowledgement observer throws", async () => {
  const target = await create("observer-failure");
  const before = actor.sessions.captureSnapshot(target.sessionKey);
  const failure = new Error("acknowledgement observer failed");
  await expect(
    actor.sessions.transcript(
      authority,
      {
        type: "session.message.append",
        input: {
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
          fence: {},
          message: makeUserMessage("committed despite observer failure", 1),
        },
      },
      undefined,
      undefined,
      () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
  expect(() => before.assertCurrent()).toThrow("snapshot changed");
  await withIncognitoSessionActor(actor, async () => {
    const reopened = await SessionManager.openAsync(target);
    expect(reopened.getEntries()).toMatchObject([
      { type: "message", message: { content: "committed despite observer failure" } },
    ]);
    expect(reopened.getEntries()).toHaveLength(1);
  });
});

it("refuses synchronous actor SDK access before SQL, view mutation, and tool-result hooks", async () => {
  const target = await create("sync-preflight");
  const manager = await withIncognitoSessionActor(actor, () => SessionManager.openAsync(target));
  const id = await manager.appendMessageAsync(makeUserMessage("unchanged", 1));
  assert(id);
  const before = structuredClone(manager.getEntries());
  const beforeTarget = manager.getSessionTarget();
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const read = vi.fn();
  const beforeWrite = vi.fn();
  const reject = (run: () => unknown, replacement: string) => {
    expect(run).toThrow(replacement);
    expect(manager.getEntries()).toEqual(before);
    expect(manager.getSessionTarget()).toEqual(beforeTarget);
    expect(manager.getLeafId()).toBe(id);
  };
  try {
    reject(() => manager.appendCustomEntry("forbidden", {}), "appendCustomEntryAsync");
    reject(() => manager.branch("missing"), "branchAsync");
    reject(() => manager.prepareTranscriptRewrite(), "prepareTranscriptRewriteAsync");
    reject(() => manager.removeTrailingEntries(() => true), "removeTrailingEntriesAsync");
    reject(() => manager.reloadPersistedTranscript(), "reloadPersistedTranscriptAsync");
    reject(() => manager.setSessionTarget(target), "setSessionTargetAsync");
    reject(
      () =>
        manager.setSessionTarget({
          ...target,
          sessionKey: "agent:main:dashboard:durable-retarget",
          sessionId: "durable-retarget",
          storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
        }),
      "setSessionTargetAsync",
    );
    reject(
      () => manager.resolveCurrentTurnEntryId(undefined, { includeOmittedCustomMessages: true }),
      "openAsync",
    );
    expect(manager.resolveCurrentTurnEntryId()).toBe(id);
    installSessionToolResultGuard(manager, { beforeMessageWriteHook: beforeWrite });
    reject(() => manager.appendMessage(makeUserMessage("forbidden", 2)), "appendMessageAsync");
    expect(beforeWrite).not.toHaveBeenCalled();
    await withIncognitoSessionActor(actor, async () => {
      const limits = { maxEvents: 2, maxBytes: 8192 };
      reject(() => SessionManager.open(target), "openAsync");
      reject(() => SessionManager.openBounded(target, limits), "openBoundedAsync");
      reject(() => SessionManager.openDetachedBounded(target, limits), "openDetachedBoundedAsync");
      reject(() => SessionManager.openModelContext(target), "openModelContextAsync");
      reject(() => SessionManager.readSessionContext(target, read), "readSessionContextAsync");
      reject(
        () => SessionManager.appendMessageToTranscript(target, makeUserMessage("forbidden", 2)),
        "appendMessageToTranscriptAsync",
      );
    });
    expect(read).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    exec.mockRestore();
  }
  await manager.appendCustomEntryAsync("still writable", {});
});
