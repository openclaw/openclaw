import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
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
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { readSessionActorTranscriptReplica } from "../../config/sessions/session-actor-replica.js";
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.types.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import * as contextWorker from "../../config/sessions/session-transcript-read-worker-runtime.js";
import {
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-transcript-reconcile.js";
import { buildSessionTranscriptTurnExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import {
  historyLane,
  targetDiscoveryLane,
} from "../../config/sessions/session-transcript-worker-resources.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context-store.js";
import {
  getOwnedSessionTranscriptReader,
  readOwnedSessionTranscriptEntry,
  withOwnedSessionTranscriptWrites,
  type InitialSessionTranscriptWriter,
} from "../../config/sessions/transcript-write-context.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { withPluginRuntimePluginScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
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
import { withSelectedTranscriptReader } from "./session-manager-reader.test-support.js";
import { readCommittedSessionManagerReload } from "./session-manager-reload.js";
import { SessionManager } from "./session-manager.js";
import { toolResult } from "./session-message-fixtures.test-support.js";

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

const privateAnswer = (upstreamUserText: string, text = "answer") =>
  Object.assign(assistantText(text), { __openclaw: { upstreamUserText } });
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
async function seedUser(target: ContextTarget, text = "original") {
  const source = await SessionManager.openAsync(target);
  const entryId = await source.appendMessageAsync(userMessage(text, 1));
  return { source, entryId };
}
function assistantMessage(
  message: ReturnType<SessionManager["buildSessionContext"]>["messages"][number] | undefined,
) {
  assert(message?.role === "assistant");
  return message;
}
function toolCall(message: ReturnType<typeof assistantMessage>) {
  const call = message.content.find((part) => part.type === "toolCall");
  assert(call?.type === "toolCall");
  return call;
}

it("reuses resident transcript bytes for admitted reads outside the actor without growing residency", () =>
  withTranscriptState("resident-hydration", async ({ scope: target }) => {
    const source = await SessionManager.openAsync(target);
    const message = userMessage("synthetic transcript ".repeat(8192), 1);
    const entryId = await source.appendMessageAsync(message);
    assert(entryId);
    const limits = { maxBytes: 1024 * 1024, maxEvents: 100 };
    await withActor(target, async (actor) => {
      assert(actor);
      const prepareHydration = () =>
        transcriptHydration.prepareSessionTranscriptHydration(target, limits);
      const cohort = { sessionKey: target.sessionKey, entryIds: [entryId] };
      const expected = await prepareHydration().read();
      await prepareHydration().readCohort!(cohort, () => {});
      const hot = actor.snapshot({ assertCurrent() {}, authorize() {} });
      assert(hot);
      const retained = readSessionActorTranscriptReplica(hot);
      assert(retained?.context);
      const retainedBytes = serialize(retained).byteLength;
      const replies: number[] = [];
      const spies = [historyLane, targetDiscoveryLane].map(({ pool }) => {
        const run = pool.run.bind(pool);
        return vi.spyOn(pool, "run").mockImplementation((input, options) => {
          let hydration = false;
          return run(async () => {
            const request = typeof input === "function" ? await input() : input;
            hydration = request.kind === "transcript-hydration";
            return request;
          }, options).then((reply) => {
            if (hydration) {
              replies.push(serialize(reply).byteLength);
            }
            return reply;
          });
        });
      });
      try {
        await runWithoutOwnedSessionTranscriptWrites(async () => {
          for (let index = 0; index < 10; index++) {
            const actual = await prepareHydration().read();
            expect(actual.snapshot).toEqual(expected.snapshot);
            actual.snapshot.events.length = 0;
            await prepareHydration().readCohort!(cohort, (prepared) => {
              assert(prepared.kind === "bounded");
              expect(prepared.snapshot).toEqual(expected.snapshot);
              const anchor = prepared.transcript?.anchors[0];
              assert(anchor);
              expect(anchor.entryId).toBe(entryId);
              expect(Reflect.set(anchor, "entryId", "caller-owned-edit")).toBe(true);
            });
          }
        });
        expect(replies.reduce((sum, bytes) => sum + bytes, 0)).toBe(0);
        expect(readSessionActorTranscriptReplica(hot)).toBe(retained);
        expect(serialize(retained).byteLength).toBe(retainedBytes);
        await runWithoutOwnedSessionTranscriptWrites(async () => {
          const reader = prepareHydration();
          for (const selection of [
            { sessionKey: "other-session", entryIds: [entryId] },
            { sessionKey: target.sessionKey, entryIds: Array<string>(65).fill(entryId) },
          ]) {
            await expect(reader.readCohort!(selection, () => {})).rejects.toThrow(
              "Transcript hydration cohort must select its own bounded session",
            );
          }
          const compaction = await reader.read({ compaction: true });
          assert(compaction.kind === "bounded");
          expect(compaction.compaction?.sessionTarget.sessionId).toBe(target.sessionId);
          const { anchor } = await reader.readCurrentTurnEntry({
            entryId,
            version: expected.snapshot.version,
            includeEntry: false,
          });
          assert(anchor);
          const fenced = await runWithSessionTranscriptReadFence(
            { ...anchor, logicalTurnId: "resident-fence", role: "user" },
            () => prepareHydration().read(),
          );
          expect(fenced.snapshot.events).toEqual([expected.snapshot.events[0]]);
          await source.appendMessageAsync(userMessage("new revision", 2));
          const changed = await reader.read();
          expect(changed.snapshot.events).toEqual(source.getPersistedEntries());
          expect(replies.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(0);
        });
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });
  }));

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
      const { entryId } = await seedUser(target);
      assert(entryId, "Expected the appended message ID");
      const otherTarget = { ...target, sessionId: "other-session", sessionKey: "agent:main:other" };
      await upsertSessionEntryCore(otherTarget, { sessionId: otherTarget.sessionId, updatedAt: 1 });
      const { entryId: otherEntryId } = await seedUser(otherTarget, "other");
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
            expectedState: buildSessionTranscriptTurnExpectedState(current.entry!),
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
    const { source, entryId: userId } = await seedUser(target);
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
    await seedUser(target);
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
      const { source: seed, entryId: userId } = await seedUser(scope, "question");
      const answer = privateAnswer("synthetic-private-native-payload");
      answer.stopReason = "toolUse";
      answer.content.push({
        type: "toolCall",
        id: "call",
        name: "read",
        arguments: {
          path: "original.txt",
          mode: "read",
          nested: {
            accessor: "original",
            changed: "original",
            proxied: { text: "proxy" },
            cyclic: { inner: { text: "cycle" } },
          },
        },
      });
      const replyId = await seed.appendMessageAsync(answer);
      await seed.appendMessageAsync({
        ...toolResult("result", "call", 2),
        details: { private: "synthetic-private-tool-details" },
      });
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
                (event.kind === "sqlite_writer" &&
                  (event.requestClass === "sessions" || event.requestClass.startsWith("session."))))
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
      const readInitial = () =>
        mode === "admitted" ? withSelectedTranscriptReader(scope, readContext) : readContext();
      const context = await readInitial();
      const user = manager.getEntry(userId!);
      const reply = manager.getEntry(replyId!);
      const projectedReply = assistantMessage(context.messages[1]);
      assert(
        user?.type === "message" && reply?.type === "message" && reply.message.role === "assistant",
        "Missing stored messages",
      );
      expect(context.messages[0]).toEqual(user.message);
      expect(JSON.stringify(context)).not.toMatch(
        /synthetic-private-native-payload|synthetic-private-tool-details/,
      );
      expect(Reflect.set(projectedReply.content[0]!, "text", "changed")).toBe(true);
      const residentCall = toolCall(reply.message);
      const projectedCall = toolCall(projectedReply);
      const projectedNested = asOptionalRecord(projectedCall.arguments.nested);
      assert(projectedNested);
      expect(Reflect.set(projectedNested, "changed", "context edit")).toBe(true);
      expect(reply.message.content[0]).toEqual({ type: "text", text: "answer" });
      expect(residentCall.arguments).toMatchObject({ nested: { changed: "original" } });

      freezeJsonSnapshot(reply.message.content);
      const rereadReply = assistantMessage((await readInitial()).messages[1]);
      expect(Reflect.set(rereadReply.content[0]!, "text", "changed again")).toBe(true);
      const rereadCall = toolCall(rereadReply);
      expect(Reflect.set(rereadCall.arguments, "path", "context edit after freeze")).toBe(true);
      expect(reply.message.content[0]).toEqual({ type: "text", text: "answer" });
      expect(residentCall.arguments.path).toBe("original.txt");

      const trap = vi.fn(() => {
        throw new Error("Initial context invoked a resident property trap");
      });
      const cycle: Record<string, unknown> = { text: "cycle" };
      cycle.inner = cycle;
      const residentNested = Object.defineProperty(
        {
          changed: "unpersisted manager edit",
          proxied: new Proxy(
            { text: "proxy" },
            {
              get: trap,
              getOwnPropertyDescriptor: trap,
              ownKeys: trap,
              getPrototypeOf: trap,
            },
          ),
          cyclic: cycle,
        },
        "accessor",
        {
          get: trap,
          enumerable: true,
        },
      );
      reply.message.content = [
        { type: "text", text: "unpersisted manager edit" },
        {
          ...residentCall,
          arguments: { mode: "read", path: "original.txt", nested: residentNested },
        },
      ];
      const authoritative = await readInitial();
      const authoritativeReply = assistantMessage(authoritative.messages[1]);
      const authoritativeCall = toolCall(authoritativeReply);
      expect(authoritativeReply.content[0]).toEqual({ type: "text", text: "answer" });
      expect(JSON.stringify(authoritativeCall.arguments)).toBe(
        '{"path":"original.txt","mode":"read","nested":{"accessor":"original","changed":"original","proxied":{"text":"proxy"},"cyclic":{"inner":{"text":"cycle"}}}}',
      );
      expect(JSON.stringify(authoritative)).not.toMatch(/synthetic-private|unpersisted/);
      expect(rereadCall.arguments).toMatchObject({ nested: { changed: "original" } });
      expect(trap).not.toHaveBeenCalled();
    }),
);

it.each([
  ["unchanged", 0],
  ["default-selector", 0],
  ["mutable-message", 0],
  ["native-append", 1],
  ["worker-append", 1],
  ["unrelated-worker-append", 0],
  ["worker-reset", 1],
  ["worker-compaction", 1],
  ["local-reset", 0],
  ["local-branch", 0],
  ["fork", 1],
  ["retarget", 1],
  ["truncated", 1],
] as const)(
  "reuses complete hydration without losing durable model bytes after %s",
  (change, expectedReads) =>
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
        } else if (change === "unrelated-worker-append") {
          await runWithoutOwnedSessionTranscriptWrites(async () => {
            const other = {
              ...target,
              sessionId: "unrelated-session",
              sessionKey: "agent:main:unrelated-session",
            };
            await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 2 });
            const writer = await SessionManager.openAsync(other);
            await writer.appendMessageAsync(userMessage("unrelated question", 2));
          });
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
        await withRestoredMocks([readModel], async () => {
          const consume = () => manager[sessionManagerReadInitialContext]();
          const context =
            change === "retarget" || change === "fork"
              ? await withSelectedTranscriptReader(readTarget, consume)
              : await consume();
          expect(JSON.stringify(context)).not.toMatch(/private-durable-context|unpersisted/);
          expect(context.messages).toMatchObject(expectedMessages);
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
    await seedUser(target, "original question");
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
  "retries a native %s before consuming bounded admitted model context",
  (mutation) =>
    withSessionState("admitted-context", async ({ scope }) => {
      const { source } = await seedUser(scope);
      const expectedMessages =
        mutation === "rewrite"
          ? [{ content: "changed" }]
          : [{ content: "original" }, { content: "changed" }];
      await withSelectedTranscriptReader(scope, async () => {
        const options = { limits: contextLimits };
        const spy = afterModelRead(async () => {
          if (mutation === "rewrite") {
            expect(source.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
          }
          await source.appendMessageAsync(userMessage("changed", 2));
          // Finish the rewrite's derived writes before measuring its single retry.
          await waitForSessionTranscriptIndexReconcile({
            agentId: scope.agentId,
            path: scope.storePath,
          });
        });
        await withRestoredMocks([spy], async () => {
          expect(await readMessages(scope, options)).toMatchObject(expectedMessages);
          expect(spy).toHaveBeenCalledTimes(2);
        });
        expect(await readMessages(scope, options)).toMatchObject(expectedMessages);
      });
    }),
);

it("allows a queued writer to finish during an unbounded admitted context read", ({ signal }) =>
  withSessionState("unbounded-context", async ({ scope }) => {
    const { source } = await seedUser(scope);
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

it("retries a bounded context snapshot after a foreign rewrite before consuming it", () =>
  withSessionState("foreign-context", async ({ scope }) => {
    const { entryId: userId } = await seedUser(scope);
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
        expect(await readMessages(scope, options)).toMatchObject([{ content: "foreign rewrite" }]);
        expect(spy).toHaveBeenCalledTimes(2);
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
