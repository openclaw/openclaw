import assert from "node:assert/strict";
import fs from "node:fs";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { makeUserMessage as userMessage } from "../../../test/helpers/user-message.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.types.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import {
  getOwnedSessionTranscriptReader,
  runWithoutOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
  type InitialSessionTranscriptWriter,
} from "../../config/sessions/transcript-write-context.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withRestoredMocks } from "../../test-utils/vitest-spies.js";
import { sessionManagerOpenTranscriptCohort } from "./session-manager-core.js";
import {
  sessionManagerPrepareCurrentTurnReplay,
  sessionManagerReadInitialContext,
} from "./session-manager-current-turn.js";
import {
  assistantText,
  afterModelRead,
  withSessionState,
  withTranscriptState,
} from "./session-manager-fixtures.test-support.js";
import { withSelectedTranscriptReader } from "./session-manager-reader.test-support.js";
import { SessionManager } from "./session-manager.js";

const questionAndAnswer = [
  { role: "user", content: "question" },
  { role: "assistant", content: [{ text: "answer" }] },
];
const contextLimits = { maxBytes: 8192, maxEvents: 20 };

function privateAnswer(upstreamUserText: string, text = "answer") {
  return { ...assistantText(text), __openclaw: { upstreamUserText } };
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
async function readMessages(
  target: ContextTarget,
  options?: Parameters<typeof SessionManager.openModelContextAsync>[1],
) {
  return (await SessionManager.openModelContextAsync(target, options)).buildSessionContext()
    .messages;
}
function withActor<T>(target: ContextTarget, run: (actor?: SessionActor) => Promise<T>) {
  return withSelectedTranscriptReader(target, run, true);
}

async function seed(target: ContextTarget, text = "original") {
  const source = await SessionManager.openAsync(target);
  const entryId = await source.appendMessageAsync(userMessage(text, 1));
  assert(entryId, "Expected the appended message ID");
  return { source, entryId };
}

const readInitial = (manager: SessionManager) => manager[sessionManagerReadInitialContext]();
const bounded = { limits: contextLimits };

it.each(["bounded", "anchors"] as const)(
  "reads current actor entry facts through %s history after writes and replacement",
  (route) =>
    withTranscriptState("actor-entry", async ({ scope: target }) => {
      const { entryId } = await seed(target);
      const otherTarget = { ...target, sessionId: "other-session", sessionKey: "agent:main:other" };
      await upsertSessionEntryCore(otherTarget, { sessionId: otherTarget.sessionId, updatedAt: 1 });
      const { entryId: otherEntryId } = await seed(otherTarget, "other");
      await withActor(target, async (actor) => {
        assert(actor, "Expected retained session actor");
        const read = async (readTarget = target, readEntryId = entryId) => {
          const hydration = transcriptHydration.prepareSessionTranscriptHydration(
            readTarget,
            contextLimits,
          );
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
              () => {},
            );
          }
          return facts;
        };
        expect((await read(otherTarget, otherEntryId))?.contextAuthority?.entry?.sessionId).toBe(
          otherTarget.sessionId,
        );
        expect((await read())?.contextAuthority?.entry?.activeWriterRunId).toBeUndefined();
        const authority = { assertCurrent() {}, authorize() {} };
        await actor.adoptRun(
          {
            commandId: "adopt-current-run",
            phaseId: "turn",
            sessionId: target.sessionId,
            expectedState: buildRestartRecoveryExpectedState(actor.snapshot(authority)!.entry!),
            lifecycle: {},
            runId: "current-run",
          },
          authority,
        );
        expect((await read())?.contextAuthority?.entry?.activeWriterRunId).toBe("current-run");

        await upsertSessionEntryCore(target, { sessionId: "replacement", updatedAt: 2 });
        const replaced = await read();
        expect(replaced?.contextAuthority?.entry?.sessionId).toBe("replacement");
        expect(replaced?.anchors).toEqual([]);
      });
    }),
);

it("replays a durable current turn and rejects it after a rewrite", () =>
  withTranscriptState("actor-replay", async ({ scope: target }) => {
    const { source, entryId: userId } = await seed(target);
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
    const original = privateAnswer("synthetic-private-native-text");
    await source.appendMessageAsync(original);
    await expect(
      SessionManager.readSessionContextAsync(target, (messages) => [...messages]),
    ).resolves.toEqual([original]);
    const [consuming, release] = [createDeferred(), createDeferred()];
    const disclose = vi.fn();
    let retained: Iterable<unknown> | undefined;
    const pending = SessionManager.readSessionContextAsync(target, async (messages, header) => {
      expect(header).toMatchObject({ id: target.sessionId });
      retained = messages;
      consuming.resolve();
      await release.promise;
      return Array.from(messages, disclose);
    });
    let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
    try {
      await awaitGateBeforeSettlement(consuming.promise, pending, "Context consumer not reached");
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

it("rejects a missing admitted source without creating it or disclosing context", () =>
  withSessionState("full-context", async ({ state, scope: target }) => {
    const manager = await SessionManager.openAsync(target);
    const seeded = await manager.appendMessageWithTranscriptAnchorAsync(
      userMessage("admitted input", 1),
    );
    assert(seeded.anchor, "Missing initial transcript anchor");
    const missing = { ...target, storePath: state.statePath("absent.sqlite") };
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

it.each([
  "mutable-message",
  "worker-append",
  "local-branch",
  "fork",
  "retarget",
  "truncated",
] as const)("preserves the selected model snapshot after %s", (change) =>
  withTranscriptState("hydrated-model-context", async ({ scope: target }) => {
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
      } else if (change === "worker-append") {
        await source.appendMessageAsync(userMessage("successor", 2));
        expectedMessages.push({ role: "user", content: "successor" });
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
      const consume = () => readInitial(manager);
      const context =
        change === "retarget" || change === "fork"
          ? await withSelectedTranscriptReader(readTarget, consume)
          : await consume();
      expect(JSON.stringify(context)).not.toMatch(/private-durable-context|unpersisted/);
      expect(context.messages).toMatchObject(expectedMessages);
      const reply = context.messages.find((message) => message.role === "assistant");
      if (reply) {
        const stored = manager.getEntry(replyId!);
        assert(stored?.type === "message" && stored.message.role === "assistant");
        const originalContent = structuredClone(stored.message.content);
        expect(Reflect.set(reply.content[0]!, "text", "changed")).toBe(true);
        expect(stored.message.content).toEqual(originalContent);
      }
      if (change === "local-branch") {
        expect(await readMessages(target)).toMatchObject(questionAndAnswer);
      }
    });
  }),
);

it("rejects prepared context from a revoked writer inside a replacement run", () =>
  withTranscriptState("prepared-context-writer", async ({ scope: target }) => {
    await seed(target, "original question");
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
        await expect(readInitial(manager)).rejects.toThrow(
          "Original transcript writer is no longer active",
        );
      });
    });
  }));

it("rejects a removed user admission before the bounded reader captures its witness", () =>
  withSessionState("bounded-removed-admission", async ({ scope }) => {
    setRuntimeConfigSnapshot({});
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

it("rejects native writes during a bounded owned read", () =>
  withSessionState("native-context", async ({ scope }) => {
    const { source } = await seed(scope);
    await withSelectedTranscriptReader(scope, async () => {
      const spy = afterModelRead(() => {
        source.appendMessage(userMessage("changed", 2));
      });
      await withRestoredMocks([spy], () =>
        expect(SessionManager.openModelContextAsync(scope, bounded)).rejects.toThrow(
          "Session entry changed during read",
        ),
      );
    });
  }));

it("allows a queued writer to finish during an unbounded admitted context read", ({ signal }) =>
  withSessionState("unbounded-context", async ({ scope }) => {
    const { source } = await seed(scope);
    await withSelectedTranscriptReader(scope, async () => {
      const [scanned, release] = [createDeferred(), createDeferred()];
      const spy = afterModelRead(async () => {
        scanned.resolve();
        await release.promise;
      });
      const pending = SessionManager.openModelContextAsync(scope);
      let writer: ReturnType<SessionManager["appendMessageAsync"]> | undefined;
      const waitFor = (gate: Promise<unknown>) =>
        withinTest(awaitGateBeforeSettlement(gate, pending, "Context settled first"), signal);
      try {
        await waitFor(scanned.promise);
        writer = source.appendMessageAsync(userMessage("concurrent input", 2));
        await waitFor(writer);
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
    const { entryId: userId } = await seed(scope);
    const databaseOptions = { agentId: scope.agentId, path: scope.storePath };
    const database = openOpenClawAgentDatabase(databaseOptions);
    const row = readTranscriptEventRows(database, scope.sessionId).find(
      ({ eventJson }) => asOptionalRecord(JSON.parse(eventJson))?.id === userId,
    );
    assert(row, "Missing committed context fixture message");
    const event = asOptionalRecord(JSON.parse(row.eventJson));
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
    await withSelectedTranscriptReader(scope, async () => {
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
        expect(await readMessages(scope, bounded)).toMatchObject([{ content: "original" }]);
      });
      expect(await readMessages(scope, bounded)).toMatchObject([{ content: "foreign rewrite" }]);
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
