import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { makeUserMessage as userMessage } from "../../../test/helpers/user-message.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import { createSessionActorFactory } from "../../config/sessions/session-actor-durable.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.types.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import * as contextWorker from "../../config/sessions/session-transcript-read-worker-runtime.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import {
  getOwnedSessionTranscriptReader,
  readOwnedSessionTranscriptEntry,
  runWithoutOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
  type InitialSessionTranscriptWriter,
} from "../../config/sessions/transcript-write-context.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { withPluginRuntimePluginScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withRestoredMocks } from "../../test-utils/vitest-spies.js";
import { sessionManagerOpenTranscriptCohort } from "./session-manager-core.js";
import {
  sessionManagerPrepareCurrentTurnReplay,
  sessionManagerReadInitialContext,
} from "./session-manager-current-turn.js";
import {
  assistantText,
  afterModelRead,
  sessionScope,
  withSessionState,
  withTranscriptState,
} from "./session-manager-fixtures.test-support.js";
import * as managerContext from "./session-manager-incognito.js";
import { readCommittedSessionManagerReload } from "./session-manager-reload.js";
import { SessionManager } from "./session-manager.js";

const memoryOwners: Array<{ agentId: string; path: string }> = [];
afterEach(() => {
  for (const owner of memoryOwners.splice(0)) {
    memorySessionActorOwners.closeDatabase(owner);
  }
});

const questionAndAnswer = [
  { role: "user", content: "question" },
  { role: "assistant", content: [{ text: "answer" }] },
];
const contextLimits = { maxBytes: 8192, maxEvents: 20 };

function privateAnswer(upstreamUserText: string, text = "answer") {
  return Object.assign(assistantText(text), {
    __openclaw: { upstreamUserText },
  });
}
function openCohort(target: Parameters<typeof SessionManager.openAsync>[0], maxEvents = 20) {
  return SessionManager[sessionManagerOpenTranscriptCohort](
    target,
    { ...contextLimits, maxEvents },
    { sessionKey: target.sessionKey, entryIds: [] },
    () => {},
  );
}

type ContextTarget = Parameters<typeof SessionManager.openModelContextAsync>[0];
function readMessages(
  target: ContextTarget,
  options?: Parameters<typeof SessionManager.openModelContextAsync>[1],
) {
  return SessionManager.openModelContextAsync(target, options).then(
    (manager) => manager.buildSessionContext().messages,
  );
}
function withActor<T>(target: ContextTarget, run: (actor?: SessionActor) => Promise<T>) {
  return withSelectedTranscriptReader(target, run, true);
}

async function withSelectedTranscriptReader<T>(
  target: Parameters<typeof SessionManager.openModelContextAsync>[0],
  run: (actor?: SessionActor) => Promise<T>,
  retainActor = false,
): Promise<T> {
  const { databaseClaim } = await loadSessionEntryForAdmission(target);
  let actor: SessionActor | undefined;
  try {
    assert(
      "kind" in databaseClaim && databaseClaim.kind === "worker" && databaseClaim.reader,
      "Expected admitted durable session reader",
    );
    const reader = databaseClaim.reader;
    const assertCurrent = () => reader.assertCurrent();
    if (retainActor) {
      const identity = readDatabasePathIdentitySync(reader.database.path);
      assert(identity.key.startsWith("file:"), "Expected a physical actor database");
      const acquired = await createSessionActorFactory(reader.database).acquire(
        {
          sessionKey: target.sessionKey,
          database: {
            kind: "file",
            physicalIdentity: identity.key.slice(5),
            birthtime: identity.birthtime,
            nativeLocation: reader.database.path,
          },
        },
        { assertCurrent, assertReadable: assertCurrent },
      );
      assert(!("kind" in acquired), "Expected a durable session actor");
      actor = acquired;
      await actor.read({ assertCurrent, authorize: assertCurrent });
    }
    return await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        sessionReader: reader,
        ...(actor && { sessionActor: { actor, database: reader.database } }),
        withTranscriptWrite: async (write) => write(),
      },
      () => run(actor),
    );
  } finally {
    try {
      await actor?.release();
    } finally {
      await databaseClaim.release();
    }
  }
}

it("reloads a durable sibling transcript under the parent writer without borrowing its actor", () =>
  withOpenClawTestState({ label: "sibling-transcript-reload" }, async (state) => {
    const parent = sessionScope(state.statePath("transcript.sqlite"), "parent");
    const sibling = { ...parent, sessionId: "sibling", sessionKey: "agent:main:sibling" };
    const updatedAt = Date.now();
    await upsertSessionEntryCore(parent, { sessionId: parent.sessionId, updatedAt });
    await upsertSessionEntryCore(sibling, { sessionId: sibling.sessionId, updatedAt });
    const manager = await SessionManager.openAsync(sibling);
    const message = userMessage("sibling transcript", 1);
    const entryId = await manager.appendMessageAsync(message);

    await withActor(parent, async () => {
      const reloaded = await readCommittedSessionManagerReload(sibling, undefined);
      expect(reloaded.kind).toBe("full");
      expect(reloaded.snapshot.events).toEqual([
        expect.objectContaining({ type: "session", id: sibling.sessionId }),
        expect.objectContaining({ type: "message", id: entryId, message }),
      ]);
    });
  }));

it.each(["bounded", "anchors"] as const)(
  "reads current actor entry facts through %s history after writes and replacement",
  (route) =>
    withTranscriptState("actor-entry", async ({ scope: target }) => {
      const source = await SessionManager.openAsync(target);
      const entryId = await source.appendMessageAsync(userMessage("original", 1));
      assert(entryId, "Expected the appended message ID");
      const otherTarget = { ...target, sessionId: "other-session", sessionKey: "agent:main:other" };
      await upsertSessionEntryCore(otherTarget, { sessionId: otherTarget.sessionId, updatedAt: 1 });
      const otherSource = await SessionManager.openAsync(otherTarget);
      const otherEntryId = await otherSource.appendMessageAsync(userMessage("other", 1));
      assert(otherEntryId, "Expected the other session's message ID");
      await withActor(target, async (actor) => {
        assert(actor, "Expected retained session actor");
        const read = async (readTarget = target, readEntryId = entryId) => {
          const hydration = transcriptHydration.prepareSessionTranscriptHydration(readTarget, {
            maxBytes: 4096,
            maxEvents: 3,
          });
          const selection = { entryIds: [readEntryId], contextAuthority: true as const };
          let facts: SessionTranscriptAnchorFacts | undefined;
          if (route === "bounded") {
            await hydration.readCohort!(
              { ...selection, sessionKey: readTarget.sessionKey },
              (prepared) => {
                if (prepared.kind === "bounded") {
                  facts = prepared.transcript;
                }
              },
            );
          } else {
            facts = await transcriptAnchors.readSessionTranscriptAnchorsAsync(
              readTarget,
              { ...selection, afterSeq: 0 },
              undefined,
              (current) => {
                facts = current;
              },
            );
          }
          return facts;
        };
        expect((await read(otherTarget, otherEntryId))?.contextAuthority?.entry?.sessionId).toBe(
          otherTarget.sessionId,
        );
        expect((await read())?.contextAuthority?.entry?.activeWriterRunId).toBeUndefined();
        const authority = { assertCurrent() {}, authorize() {} };
        const current = actor.snapshot(authority)!;
        const adopted = await actor.adoptRun(
          {
            commandId: "adopt-current-run",
            phaseId: "turn",
            sessionId: target.sessionId,
            expectedState: buildRestartRecoveryExpectedState(current.entry!),
            lifecycle: {},
            runId: "current-run",
          },
          authority,
        );
        expect(adopted.kind).toBe("committed");
        expect((await read())?.contextAuthority?.entry?.activeWriterRunId).toBe("current-run");

        await upsertSessionEntryCore(target, { sessionId: "replacement", updatedAt: 2 });
        expect(actor.snapshot(authority)).toBeUndefined();
        expect(readOwnedSessionTranscriptEntry(target)?.sessionId).toBe("replacement");
        const replaced = await read();
        expect(replaced?.contextAuthority?.entry?.sessionId).toBe("replacement");
        expect(replaced?.anchors).toEqual([]);
      });
    }),
);

it("keeps the consumed durable snapshot after a later rewrite without another history read", () =>
  withTranscriptState("actor-context", async ({ scope: target }) => {
    const source = await SessionManager.openAsync(target);
    const original = userMessage("original", 1);
    await source.appendMessageAsync(original);
    await withActor(target, async () => {
      const validated = vi.spyOn(transcriptAnchors, "readSessionTranscriptAnchorsFromSource");
      await withRestoredMocks([validated], async () => {
        const pending = SessionManager.readSessionContextAsync(target, async (messages) => {
          const selected = [...messages];
          await runWithoutOwnedSessionTranscriptWrites(async () => {
            source.removeTrailingEntries((entry) => entry.type === "message");
          });
          return selected;
        });
        await expect(pending).resolves.toEqual([original]);
        expect(validated).not.toHaveBeenCalled();
      });
    });
  }));

it("replays a durable current turn and rejects it after a rewrite", () =>
  withTranscriptState("actor-replay", async ({ scope: target }) => {
    const source = await SessionManager.openAsync(target);
    const userId = await source.appendMessageAsync(userMessage("original", 1));
    const replayView = await SessionManager.openAsync(target);
    await withActor(target, async () => {
      const replay = () =>
        replayView[sessionManagerPrepareCurrentTurnReplay](
          () => false,
          (entry) => entry?.type === "message" && entry.message.role === "user",
        );
      expect(await replay()).toMatchObject({ entryId: userId });
      runWithoutOwnedSessionTranscriptWrites(() =>
        source.removeTrailingEntries((entry) => entry.type === "message"),
      );
      await expect(replay()).rejects.toThrow(
        /Persisted user turn changed|Session transcript projection is rebuilding/,
      );
    });
  }));

it("retains the full-context read owner until an awaited consumer settles", () =>
  withTranscriptState("full-context-close", async ({ scope: target }) => {
    const source = await SessionManager.openAsync(target);
    await source.appendMessageAsync(userMessage("original", 1));
    const consuming = createDeferred();
    const release = createDeferred();
    const disclose = vi.fn();
    let retained: Iterable<unknown> | undefined;
    const pending = SessionManager.readSessionContextAsync(target, async (messages) => {
      retained = messages;
      consuming.resolve();
      await release.promise;
      return Array.from(messages, disclose);
    });
    let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
    try {
      await awaitGateBeforeSettlement(
        consuming.promise,
        pending,
        "Context consumer was not reached",
      );
      closing = closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      release.resolve();
      await expect(pending).rejects.toThrow(/revoked|closed|current|admission/i);
      expect(disclose).not.toHaveBeenCalled();
      expect([...retained!]).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending, closing]);
    }
  }));

it("reads full durable context through workers and preserves the deprecated synchronous result", () =>
  withSessionState("full-context", async ({ state, scope: target }) => {
    const manager = await SessionManager.openAsync(target);
    const seeded = await manager.appendMessageWithTranscriptAnchorAsync(
      Object.assign(userMessage("full fidelity", 1), {
        __openclaw: { upstreamUserText: "synthetic-private-native-text" },
      }),
    );
    assert(seeded.anchor, "Missing initial transcript anchor");
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    let expected: unknown;
    withRestoredMocks([warn], () => {
      withPluginRuntimePluginScope({ pluginId: "session-context-compat" }, () => {
        expected = SessionManager.readSessionContext(target, (messages) => [...messages]);
        expect(SessionManager.readSessionContext(target, () => 7)).toBe(7);
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("readSessionContextAsync"),
        { code: "DEP_SESSION_PERSISTENCE", type: "DeprecationWarning" },
      );
    });
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    await withRestoredMocks([prepare, exec], async () => {
      expect(
        await SessionManager.readSessionContextAsync(target, async (messages, header) => {
          expect(header).toMatchObject({ id: target.sessionId });
          await Promise.resolve();
          return [...messages];
        }),
      ).toEqual(expected);
      expect([prepare.mock.calls, exec.mock.calls]).toEqual([[], []]);
    });
    await expect(
      SessionManager.readSessionContextAsync(target, async (messages) => {
        await manager.appendMessageAsync(userMessage("changed", 2));
        return [...messages];
      }),
    ).resolves.toEqual(expected);
    const missing = { ...target, storePath: path.join(state.agentDir("main"), "absent.sqlite") };
    const consumeMissing = vi.fn(() => "unreadable");
    await expect(
      SessionManager.readSessionContextAsync(missing, consumeMissing, {
        admission: {
          ...seeded.anchor,
          storePath: missing.storePath,
          role: "user",
          logicalTurnId: "missing-source",
        },
      }),
    ).rejects.toThrow("Session transcript changed during context read");
    expect(consumeMissing).not.toHaveBeenCalled();
    expect(fs.existsSync(missing.storePath)).toBe(false);
  }));

it.each(["durable", "admitted", "incognito"] as const)(
  "keeps projected initial messages detached from the stored view (%s)",
  (mode) =>
    withOpenClawTestState({ label: "shared-model-context" }, async (state) => {
      const storePath = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
      const scope = {
        ...sessionScope(storePath, "shared-context"),
        sessionKey:
          mode === "incognito"
            ? "agent:main:dashboard:incognito-shared-context"
            : "agent:main:shared-context",
      };
      if (mode === "incognito") {
        memoryOwners.push({
          agentId: "main",
          path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        });
      } else {
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      }
      const seed = await SessionManager.openAsync(scope);
      const userId = await seed.appendMessageAsync(userMessage("question", 1));
      const replyId = await seed.appendMessageAsync(
        privateAnswer("synthetic-private-native-payload"),
      );
      const manager = await SessionManager.openAsync(scope, undefined, contextLimits);
      const readContext = async () => {
        await waitForDiagnosticEventsDrained();
        const requests: { kind: string; requestClass: string }[] = [];
        const unsubscribe = onInternalDiagnosticEvent(
          (event) => {
            if (
              event.type === "worker.request" &&
              event.phase === "queued" &&
              (event.kind === "sessionTranscript" ||
                (event.kind === "sqlite_writer" && event.requestClass === "sessions"))
            ) {
              requests.push({ kind: event.kind, requestClass: event.requestClass });
            }
          },
          { include: ["worker.request"] },
        );
        try {
          const context = await manager[sessionManagerReadInitialContext]();
          await waitForDiagnosticEventsDrained();
          if (mode === "admitted") {
            expect(requests).toEqual([{ kind: "sessionTranscript", requestClass: "task" }]);
            await expect(
              SessionManager.openModelContextAsync(scope, {
                limits: { maxBytes: 1, maxEvents: 1 },
              }),
            ).rejects.toThrow(/context limit/);
          }
          return context;
        } finally {
          unsubscribe();
        }
      };
      const context =
        mode === "admitted"
          ? await withSelectedTranscriptReader(scope, readContext)
          : await readContext();
      const user = manager.getEntry(userId!);
      const reply = manager.getEntry(replyId!);
      const projectedReply = context.messages[1];
      assert(
        user?.type === "message" &&
          reply?.type === "message" &&
          reply.message.role === "assistant" &&
          projectedReply?.role === "assistant",
        "Missing stored messages",
      );
      expect(context.messages[0]).toEqual(user.message);
      expect(projectedReply.content).not.toBe(reply.message.content);
      expect(JSON.stringify(context)).not.toContain("synthetic-private-native-payload");
      expect(Reflect.set(projectedReply.content[0]!, "text", "changed")).toBe(true);
      expect(reply.message.content).toEqual([{ type: "text", text: "answer" }]);
    }),
);

it.each([
  "unchanged",
  "default-selector",
  "mutable-message",
  "native-append",
  "worker-append",
  "worker-reset",
  "worker-compaction",
  "local-reset",
  "local-branch",
  "fork",
  "retarget",
  "truncated",
] as const)("reuses complete hydration without losing durable model bytes after %s", (change) =>
  withOpenClawTestState({ label: "hydrated-model-context" }, async (state) => {
    const target = sessionScope(
      change === "default-selector"
        ? resolveDefaultSessionStorePath("main")
        : state.statePath("transcript.sqlite"),
      "hydrated-model-context",
    );
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(target);
    const questionId = await source.appendMessageAsync(userMessage("question", 1));
    const replyId = await source.appendMessageAsync(privateAnswer("private-durable-context"));
    await withSelectedTranscriptReader(target, async () => {
      const manager = await openCohort(target, change === "truncated" ? 1 : 20);
      let readTarget = target;
      let expectedMessages: unknown[] = [...questionAndAnswer];
      if (change === "mutable-message") {
        const reply = manager.getEntry(replyId!);
        assert(
          reply?.type === "message" && reply.message.role === "assistant",
          "Missing mutable assistant entry",
        );
        reply.message.content = [{ type: "text", text: "unpersisted replacement" }];
      } else if (change === "native-append") {
        source.appendMessage(userMessage("native successor", 2));
        expectedMessages.push({ role: "user", content: "native successor" });
      } else if (change === "worker-append") {
        await source.appendMessageAsync(userMessage("worker successor", 2));
        expectedMessages.push({ role: "user", content: "worker successor" });
      } else if (change === "worker-reset") {
        await source.appendResetBoundaryAsync("new");
        expectedMessages = [];
      } else if (change === "worker-compaction") {
        await source.appendCompactionAsync("Earlier question summarized", replyId!, 100);
        expectedMessages = [
          { role: "compactionSummary", summary: "Earlier question summarized" },
          { role: "assistant", content: [{ text: "answer" }] },
        ];
      } else if (change === "local-reset") {
        manager.resetLeaf();
        expectedMessages = [];
      } else if (change === "local-branch") {
        manager.branch(questionId!);
        expectedMessages = [{ role: "user", content: "question" }];
      } else if (change === "fork") {
        const forkId = await runWithoutOwnedSessionTranscriptWrites(() =>
          manager.createBranchedSession(questionId!),
        );
        expect(forkId).toBe(manager.getSessionId());
        expect(forkId).not.toBe(target.sessionId);
        readTarget = { ...target, sessionId: forkId! };
        expectedMessages = [{ role: "user", content: "question" }];
      } else if (change === "retarget") {
        readTarget = {
          ...target,
          sessionId: "replacement-context",
          sessionKey: "agent:main:replacement-context",
        };
        await runWithoutOwnedSessionTranscriptWrites(async () => {
          await upsertSessionEntryCore(readTarget, {
            sessionId: readTarget.sessionId,
            updatedAt: 2,
          });
          const replacement = await SessionManager.openAsync(readTarget);
          await replacement.appendMessageAsync(userMessage("replacement question", 2));
          await manager.setSessionTargetAsync(readTarget);
        });
        expectedMessages = [{ role: "user", content: "replacement question" }];
      } else if (change === "truncated") {
        expectedMessages = [{ role: "assistant", content: [{ text: "answer" }] }];
      }
      const readModel = vi.spyOn(contextWorker, "readSessionTranscriptModelContextInWorker");
      const readContext = vi.spyOn(managerContext, "readSessionManagerModelContextAsync");
      await withRestoredMocks([readModel, readContext], async () => {
        const consume = () => manager[sessionManagerReadInitialContext]();
        const context =
          change === "retarget" || change === "fork"
            ? await withSelectedTranscriptReader(readTarget, consume)
            : await consume();
        expect(JSON.stringify(context)).not.toMatch(/private-durable-context|unpersisted/);
        expect(context.messages).toMatchObject(expectedMessages);
        const expectedReads = [
          "unchanged",
          "default-selector",
          "mutable-message",
          "local-reset",
          "local-branch",
        ].includes(change)
          ? 0
          : 1;
        expect(readContext).toHaveBeenCalledTimes(expectedReads);
        expect(readModel).toHaveBeenCalledTimes(expectedReads);
      });
      if (change === "local-reset" || change === "local-branch") {
        expect(await readMessages(target)).toMatchObject(questionAndAnswer);
      }
    });
  }),
);

it("rejects prepared context from a revoked writer inside a replacement run", () =>
  withTranscriptState("prepared-context-writer", async ({ scope: target }) => {
    const source = await SessionManager.openAsync(target);
    await source.appendMessageAsync(userMessage("original question", 1));
    await withSelectedTranscriptReader(target, async () => {
      const reader = getOwnedSessionTranscriptReader(target);
      const binding = (initialWriter: InitialSessionTranscriptWriter) => ({
        sessionTarget: target,
        sessionReader: reader,
        initialWriter,
        withTranscriptWrite: initialWriter.withTranscriptWrite,
      });
      const original = new AbortController();
      const writer: InitialSessionTranscriptWriter = {
        writerRunId: "original-run",
        committedFence: undefined,
        assertActive: () => original.signal.throwIfAborted(),
        recordCommitted: () => {},
        withTranscriptWrite: async (write) => await write(),
      };
      const manager = await withOwnedSessionTranscriptWrites(binding(writer), () =>
        openCohort(target),
      );
      original.abort(new Error("Original transcript writer is no longer active"));
      const replacement: InitialSessionTranscriptWriter = {
        ...writer,
        writerRunId: "replacement-run",
        assertActive: () => {},
      };
      await withOwnedSessionTranscriptWrites(binding(replacement), async () => {
        await expect(manager[sessionManagerReadInitialContext]()).rejects.toThrow(
          "Original transcript writer is no longer active",
        );
      });
    });
  }));

it("rejects a removed user admission before the bounded reader captures its witness", () =>
  withOpenClawTestState({ label: "bounded-removed-admission" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = sessionScope(
      path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      "bounded-removed-admission",
    );
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...scope, sessionEntry: undefined },
      input: { text: "current request", idempotencyKey: "bounded-current-input" },
    });
    await recorder.persistApproved();
    const admission = recorder.getAdmissionReceipt();
    assert(admission, "Expected a committed user admission");
    const source = await SessionManager.openAsync(scope);
    await withSelectedTranscriptReader(scope, async () => {
      expect(source.removeTrailingEntries((entry) => entry.id === admission.entryId)).toBe(1);
      await expect(
        SessionManager.openModelContextAsync(scope, {
          admission,
          limits: contextLimits,
        }),
      ).rejects.toMatchObject({
        name: "SessionTranscriptReadFenceError",
        message: "Current-turn transcript admission changed",
      });
    });
  }));

it.each(["append", "rewrite"] as const)(
  "rejects a native %s before consuming bounded admitted model context",
  (mutation) =>
    withSessionState("admitted-context", async ({ scope }) => {
      const source = await SessionManager.openAsync(scope);
      await source.appendMessageAsync(userMessage("original", 1));
      await withSelectedTranscriptReader(scope, async () => {
        const options = { limits: contextLimits };
        let changed = false;
        const spy = afterModelRead(() => {
          if (mutation === "rewrite") {
            expect(source.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
          }
          source.appendMessage(userMessage("changed", 2));
          changed = true;
        });
        await withRestoredMocks([spy], async () => {
          await expect(SessionManager.openModelContextAsync(scope, options)).rejects.toThrow(
            "Session entry changed during read",
          );
          expect(changed).toBe(true);
        });
        expect(await readMessages(scope, options)).toMatchObject(
          mutation === "rewrite"
            ? [{ content: "changed" }]
            : [{ content: "original" }, { content: "changed" }],
        );
      });
    }),
);

it("allows a queued writer to finish during an unbounded admitted context read", ({ signal }) =>
  withSessionState("unbounded-context", async ({ scope }) => {
    const source = await SessionManager.openAsync(scope);
    await source.appendMessageAsync(userMessage("original", 1));
    await withSelectedTranscriptReader(scope, async () => {
      const scanned = createDeferred();
      const release = createDeferred();
      const spy = afterModelRead(async () => {
        scanned.resolve();
        await release.promise;
      });
      const pending = SessionManager.openModelContextAsync(scope);
      let writer: ReturnType<SessionManager["appendMessageAsync"]> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(scanned.promise, pending, "Context scan was not reached"),
          signal,
        );
        writer = source.appendMessageAsync(userMessage("concurrent input", 2));
        expect(
          await withinTest(
            awaitGateBeforeSettlement(writer, pending, "Context returned before its worker reply"),
            signal,
          ),
        ).toBeTruthy();
        release.resolve();
        const accepted = await pending;
        expect(accepted.buildSessionContext().messages).toMatchObject([{ content: "original" }]);
      } finally {
        release.resolve();
        await Promise.allSettled([pending, writer]);
        spy.mockRestore();
      }
      expect(await readMessages(scope)).toMatchObject([
        { content: "original" },
        { content: "concurrent input" },
      ]);
    });
  }));

it("keeps one bounded context snapshot and observes a foreign rewrite on the next read", () =>
  withSessionState("foreign-context", async ({ scope }) => {
    const source = await SessionManager.openAsync(scope);
    const userId = await source.appendMessageAsync(userMessage("original", 1));
    const databaseOptions = { agentId: scope.agentId, path: scope.storePath };
    const database = openOpenClawAgentDatabase(databaseOptions);
    const row = readTranscriptEventRows(database, scope.sessionId).find(
      ({ eventJson }) => asOptionalRecord(JSON.parse(eventJson))?.id === userId,
    );
    assert(row, "Missing committed context fixture message");
    const event = asOptionalRecord(JSON.parse(row.eventJson));
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
    await withSelectedTranscriptReader(scope, async () => {
      expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)).toBeUndefined();
      const options = { limits: contextLimits };
      const spy = afterModelRead(() => {
        const foreign = openNodeSqliteDatabase(scope.storePath);
        admitSqliteSchema(foreign);
        try {
          foreign.exec("BEGIN IMMEDIATE");
          rewriteSqliteTranscriptEventRowsInTransaction({ ...database, db: foreign }, scope, [
            {
              seq: row.seq,
              expectedEventJson: row.eventJson,
              event: {
                ...event,
                message: { ...asOptionalRecord(event?.message), content: "foreign rewrite" },
              },
            },
          ]);
          foreign.exec("COMMIT");
        } finally {
          if (foreign.isTransaction) {
            foreign.exec("ROLLBACK");
          }
          foreign.close();
        }
      });
      await withRestoredMocks([spy], async () => {
        expect(await readMessages(scope, options)).toMatchObject([{ content: "original" }]);
        expect(spy).toHaveBeenCalledOnce();
      });
      expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)).toBeUndefined();
      expect(await readMessages(scope, options)).toMatchObject([{ content: "foreign rewrite" }]);
    });
  }));

it.each(["append", "rewrite"] as const)(
  "reads the completed durable turn snapshot across later %s",
  (mutation) =>
    withSessionState("completed-context", async ({ scope }) => {
      const source = SessionManager.open(scope);
      source.appendMessage(userMessage("completed question", 1));
      await waitForSessionTranscriptProjection(scope);
      const terminal = source.appendMessageWithTranscriptAnchor(
        privateAnswer("synthetic-private-native-payload", "completed answer"),
      );
      assert(terminal.anchor, "Missing completed-turn anchor");
      const expected = SessionManager.openModelContext(scope).buildSessionContext();
      source.appendMessage(userMessage("later question", 2));
      const mutate = () => {
        if (mutation === "rewrite") {
          source.removeTrailingEntries((entry) => entry.type === "message");
        }
        source.appendMessage(userMessage("newest question", 3));
      };
      const spy = afterModelRead(mutate, true);
      await withRestoredMocks([spy], async () => {
        const pending = SessionManager.openModelContextAsync(scope, { through: terminal.anchor });
        if (mutation === "rewrite") {
          await expect(pending).rejects.toThrow(/transcript|anchor/i);
        } else {
          const context = (await pending).buildSessionContext();
          expect(context).toEqual(expected);
          expect(JSON.stringify(context)).not.toContain("synthetic-private-native-payload");
          expect(source.buildSessionContext().messages.at(-1)).toMatchObject({
            content: "newest question",
          });
        }
      });
    }),
);
