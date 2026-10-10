import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import * as transcriptReaders from "../../config/sessions/session-transcript-execution-read.js";
import * as contextWorker from "../../config/sessions/session-transcript-read-worker-runtime.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { readGlobalSingleton } from "../../shared/global-singleton.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { sessionManagerOpenTranscriptCohort } from "./session-manager-core.js";
import { sessionManagerReadInitialContext } from "./session-manager-current-turn.js";
import { SessionManager } from "./session-manager.js";

async function withSelectedTranscriptReader<T>(
  target: Parameters<typeof SessionManager.openModelContextAsync>[0],
  run: () => Promise<T>,
): Promise<T> {
  const { databaseClaim } = await loadSessionEntryForAdmission(target);
  try {
    if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
      throw new Error("Expected admitted durable session reader");
    }
    return await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        sessionReader: databaseClaim.reader,
        withTranscriptWrite: async (write) => write(),
      },
      run,
    );
  } finally {
    await databaseClaim.release();
  }
}

it("refuses full context after a rewrite between validation and acceptance", async () => {
  await withOpenClawTestState({ label: "full-context-validation-reply" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "full-context-rewrite",
      sessionKey: "agent:main:full-context-rewrite",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(target);
    await source.appendMessageAsync(makeUserMessage("original", 1));
    const validated = createDeferred();
    const release = createDeferred();
    const createReaders = transcriptReaders.createPreparedSessionTranscriptReads;
    const spy = vi
      .spyOn(transcriptReaders, "createPreparedSessionTranscriptReads")
      .mockImplementation((params) => {
        const readers = createReaders(params);
        return {
          ...readers,
          readAnchors: async (input, signal) => {
            const facts = await readers.readAnchors(input, signal);
            if (facts.contextValidated === true) {
              validated.resolve();
              await release.promise;
            }
            return facts;
          },
        };
      });
    const pending = SessionManager.readSessionContextAsync(target, (messages) => [...messages]);
    try {
      await awaitGateBeforeSettlement(
        validated.promise,
        pending,
        "Context validation was not reached",
      );
      expect(source.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
      release.resolve();
      await expect(pending).rejects.toThrow(/transcript|context/i);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      spy.mockRestore();
    }
  });
});

it("retains the full-context read owner until an awaited consumer settles", async () => {
  await withOpenClawTestState({ label: "full-context-owner-close" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "full-context-close",
      sessionKey: "agent:main:full-context-close",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(target);
    await source.appendMessageAsync(makeUserMessage("original", 1));
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
  });
});

it.each(["key", "path"] as const)(
  "rejects a replaced native owner selected by %s",
  async (route) => {
    await withOpenClawTestState({ label: "native-context-owner" }, async (state) => {
      const pathname = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const options = { agentId: "main", path: pathname, env: state.env };
      const original = openOpenClawAgentDatabase(options);
      const target = {
        agentId: "main",
        sessionId: "empty-native-context",
        sessionKey:
          route === "key"
            ? "agent:main:dashboard:incognito-context-owner"
            : "agent:main:context-owner",
        storePath:
          route === "key" ? path.join(state.agentDir("main"), "openclaw-agent.sqlite") : pathname,
        env: state.env,
      };
      await expect(
        SessionManager.readSessionContextAsync(target, async (messages) => {
          expect([...messages]).toEqual([]);
          await closeOpenClawAgentDatabaseByPathAsync(pathname, "main");
          expect(openOpenClawAgentDatabase(options)).not.toBe(original);
          return "stale owner result";
        }),
      ).rejects.toThrow("incognito database owner is no longer current");
      expect(
        await SessionManager.readSessionContextAsync(target, (messages) => [...messages]),
      ).toEqual([]);
      expect(fs.existsSync(pathname)).toBe(false);
    });
  },
);

it("reads full durable context through workers and preserves the deprecated synchronous result", async () => {
  await withOpenClawTestState({ label: "context-read-async" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "full-context",
      sessionKey: "agent:main:full-context",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target);
    const seeded = await manager.appendMessageWithTranscriptAnchorAsync(
      Object.assign(makeUserMessage("full fidelity", 1), {
        __openclaw: { upstreamUserText: "synthetic-private-native-text" },
      }),
    );
    if (!seeded.anchor) {
      throw new Error("Missing initial transcript anchor");
    }
    const warned = readGlobalSingleton(Symbol.for("openclaw.sessionPersistenceDeprecations"));
    if (!(warned instanceof Set)) {
      throw new Error("Missing session persistence warning budget");
    }
    const warningKey = "SessionManager.readSessionContext";
    const previouslyWarned = warned.delete(warningKey);
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    let expected: unknown;
    try {
      expected = SessionManager.readSessionContext(target, (messages) => [...messages]);
      expect(SessionManager.readSessionContext(target, () => 7)).toBe(7);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("readSessionContextAsync"),
        { code: "DEP_SESSION_PERSISTENCE", type: "DeprecationWarning" },
      );
    } finally {
      warn.mockRestore();
      if (previouslyWarned) {
        warned.add(warningKey);
      } else {
        warned.delete(warningKey);
      }
    }
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      expect(
        await SessionManager.readSessionContextAsync(target, async (messages, header) => {
          expect(header).toMatchObject({ id: target.sessionId });
          await Promise.resolve();
          return [...messages];
        }),
      ).toEqual(expected);
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      exec.mockRestore();
    }
    await expect(
      SessionManager.readSessionContextAsync(target, async (messages) => {
        await manager.appendMessageAsync(makeUserMessage("changed", 2));
        return [...messages];
      }),
    ).resolves.toEqual(expected);
    const missing = { ...target, storePath: path.join(state.agentDir("main"), "absent.sqlite") };
    await expect(
      SessionManager.readSessionContextAsync(missing, () => "unreadable", {
        admission: {
          ...seeded.anchor,
          storePath: missing.storePath,
          role: "user",
          logicalTurnId: "missing-source",
        },
      }),
    ).rejects.toThrow("Session transcript changed during context read");
    expect(fs.existsSync(missing.storePath)).toBe(false);
    const alias = path.join(state.stateDir, "context-alias");
    const successor = path.join(state.stateDir, "missing-successor");
    fs.mkdirSync(successor);
    fs.symlinkSync(path.dirname(target.storePath), alias, "junction");
    await expect(
      SessionManager.readSessionContextAsync(
        { ...target, storePath: path.join(alias, path.basename(target.storePath)) },
        async () => {
          fs.unlinkSync(alias);
          fs.symlinkSync(successor, alias, "junction");
        },
      ),
    ).rejects.toThrow(/captured|identity|owner/);
  });
});

it.each(["durable", "admitted", "incognito"] as const)(
  "shares immutable initial messages (%s)",
  async (mode) => {
    await withOpenClawTestState({ label: "shared-model-context" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "shared-context",
        sessionKey:
          mode === "incognito"
            ? "agent:main:dashboard:incognito-shared-context"
            : "agent:main:shared-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const seed = await SessionManager.openAsync(scope);
      const userId = await seed.appendMessageAsync({
        role: "user",
        content: "question",
        timestamp: 1,
      });
      const replyId = await seed.appendMessageAsync(
        Object.assign(makeAgentAssistantMessage({ content: [{ type: "text", text: "answer" }] }), {
          __openclaw: { upstreamUserText: "synthetic-private-native-payload" },
        }),
      );
      const manager = await SessionManager.openAsync(scope, undefined, {
        maxEvents: 20,
        maxBytes: 8192,
      });
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
      if (
        user?.type !== "message" ||
        reply?.type !== "message" ||
        reply.message.role !== "assistant" ||
        projectedReply?.role !== "assistant"
      ) {
        throw new Error("Missing stored messages");
      }
      expect(context.messages[0]).toBe(user.message);
      expect(projectedReply.content).toBe(reply.message.content);
      expect(Object.isFrozen(user.message)).toBe(true);
      expect(Object.isFrozen(reply.message.content)).toBe(true);
      expect(JSON.stringify(context)).not.toContain("synthetic-private-native-payload");
      expect(Reflect.set(projectedReply.content[0]!, "text", "changed")).toBe(false);
      expect(reply.message.content).toEqual([{ type: "text", text: "answer" }]);
    });
  },
);

it.each([
  "unchanged",
  "default-selector",
  "mutable-message",
  "native-append",
  "worker-append",
  "truncated",
] as const)(
  "reuses complete hydration without losing durable model bytes after %s",
  async (change) => {
    await withOpenClawTestState({ label: "hydrated-model-context" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "hydrated-model-context",
        sessionKey: "agent:main:hydrated-model-context",
        storePath:
          change === "default-selector"
            ? resolveDefaultSessionStorePath("main")
            : state.statePath("transcript.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(target);
      await source.appendMessageAsync(makeUserMessage("question", 1));
      const replyId = await source.appendMessageAsync(
        Object.assign(makeAgentAssistantMessage({ content: [{ type: "text", text: "answer" }] }), {
          __openclaw: { upstreamUserText: "private-durable-context" },
        }),
      );
      await withSelectedTranscriptReader(target, async () => {
        const manager = await SessionManager[sessionManagerOpenTranscriptCohort](
          target,
          { maxBytes: 8192, maxEvents: change === "truncated" ? 1 : 20 },
          { sessionKey: target.sessionKey, entryIds: [] },
          () => {},
        );
        if (change === "mutable-message") {
          const reply = manager.getEntry(replyId!);
          if (reply?.type !== "message" || reply.message.role !== "assistant") {
            throw new Error("Missing mutable assistant entry");
          }
          reply.message.content = [{ type: "text", text: "unpersisted replacement" }];
        } else if (change === "native-append") {
          source.appendMessage(makeUserMessage("native successor", 2));
        } else if (change === "worker-append") {
          await source.appendMessageAsync(makeUserMessage("worker successor", 2));
        }
        const readModel = vi.spyOn(contextWorker, "readSessionTranscriptModelContextInWorker");
        try {
          const context = await manager[sessionManagerReadInitialContext]();
          expect(JSON.stringify(context)).not.toMatch(/private-durable-context|unpersisted/);
          expect(context.messages).toMatchObject(
            change === "truncated"
              ? [{ role: "assistant", content: [{ text: "answer" }] }]
              : [
                  { role: "user", content: "question" },
                  { role: "assistant", content: [{ text: "answer" }] },
                  ...(change === "native-append"
                    ? [{ role: "user", content: "native successor" }]
                    : change === "worker-append"
                      ? [{ role: "user", content: "worker successor" }]
                      : []),
                ],
          );
          expect(readModel).toHaveBeenCalledTimes(
            change === "unchanged" || change === "default-selector" || change === "mutable-message"
              ? 0
              : 1,
          );
        } finally {
          readModel.mockRestore();
        }
      });
    });
  },
);

it.each(["append", "rewrite"] as const)(
  "rejects a native %s before consuming bounded admitted model context",
  async (mutation) => {
    await withOpenClawTestState({ label: "admitted-context-native-mutation" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "admitted-context",
        sessionKey: "agent:main:admitted-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      await source.appendMessageAsync(makeUserMessage("original", 1));
      await withSelectedTranscriptReader(scope, async () => {
        const options = { limits: { maxBytes: 8192, maxEvents: 20 } };
        const read = contextWorker.readSessionTranscriptModelContextInWorker;
        let changed = false;
        const spy = vi
          .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
          .mockImplementationOnce(async (...args) => {
            const context = await read(...args);
            if (mutation === "rewrite") {
              expect(source.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
            }
            source.appendMessage(makeUserMessage("changed", 2));
            changed = true;
            return context;
          });
        try {
          await expect(SessionManager.openModelContextAsync(scope, options)).rejects.toThrow(
            "Session entry changed during read",
          );
          expect(changed).toBe(true);
        } finally {
          spy.mockRestore();
        }
        const current = await SessionManager.openModelContextAsync(scope, options);
        expect(current.buildSessionContext().messages).toMatchObject(
          mutation === "rewrite"
            ? [{ content: "changed" }]
            : [{ content: "original" }, { content: "changed" }],
        );
      });
    });
  },
);

it("allows a queued writer to finish during an unbounded admitted context read", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "unbounded-context-writer-fifo" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "unbounded-context",
      sessionKey: "agent:main:unbounded-context",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(scope);
    await source.appendMessageAsync(makeUserMessage("original", 1));
    await withSelectedTranscriptReader(scope, async () => {
      const scanned = createDeferred();
      const release = createDeferred();
      const read = contextWorker.readSessionTranscriptModelContextInWorker;
      const spy = vi
        .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
        .mockImplementationOnce(async (...args) => {
          const context = await read(...args);
          scanned.resolve();
          await release.promise;
          return context;
        });
      const pending = SessionManager.openModelContextAsync(scope);
      let writer: ReturnType<SessionManager["appendMessageAsync"]> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(scanned.promise, pending, "Context scan was not reached"),
          signal,
        );
        writer = source.appendMessageAsync(makeUserMessage("concurrent input", 2));
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
      const current = await SessionManager.openModelContextAsync(scope);
      expect(current.buildSessionContext().messages).toMatchObject([
        { content: "original" },
        { content: "concurrent input" },
      ]);
    });
  });
});

it("keeps one bounded context snapshot and observes a foreign rewrite on the next read", async () => {
  await withOpenClawTestState({ label: "admitted-context-foreign-commit" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "foreign-context",
      sessionKey: "agent:main:foreign-context",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(scope);
    const userId = await source.appendMessageAsync(makeUserMessage("original", 1));
    const databaseOptions = { agentId: scope.agentId, path: scope.storePath };
    const database = openOpenClawAgentDatabase(databaseOptions);
    const row = readTranscriptEventRows(database, scope.sessionId).find(
      ({ eventJson }) => asOptionalRecord(JSON.parse(eventJson))?.id === userId,
    );
    if (!row) {
      throw new Error("Missing committed context fixture message");
    }
    const event = asOptionalRecord(JSON.parse(row.eventJson));
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
    await withSelectedTranscriptReader(scope, async () => {
      expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)).toBeUndefined();
      const options = { limits: { maxBytes: 8192, maxEvents: 20 } };
      const read = contextWorker.readSessionTranscriptModelContextInWorker;
      const spy = vi
        .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
        .mockImplementationOnce(async (...args) => {
          const context = await read(...args);
          const foreign = new DatabaseSync(scope.storePath);
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
          return context;
        });
      try {
        // This operation keeps its coherent snapshot; a new unpinned read observes the rewrite.
        const before = await SessionManager.openModelContextAsync(scope, options);
        expect(before.buildSessionContext().messages).toMatchObject([{ content: "original" }]);
        expect(spy).toHaveBeenCalledOnce();
      } finally {
        spy.mockRestore();
      }
      expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)).toBeUndefined();
      const after = await SessionManager.openModelContextAsync(scope, options);
      expect(after.buildSessionContext().messages).toMatchObject([{ content: "foreign rewrite" }]);
    });
  });
});

it.each(
  [false, true].flatMap((incognito) =>
    (["append", "rewrite"] as const).map((mutation) => ({ incognito, mutation })),
  ),
)(
  "reads the completed-turn snapshot across later $mutation (incognito=$incognito)",
  async ({ incognito, mutation }) => {
    await withOpenClawTestState({ label: "completed-model-context" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "completed-context",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-completed-context"
          : "agent:main:completed-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = SessionManager.open(scope);
      source.appendMessage({ role: "user", content: "completed question", timestamp: 1 });
      await waitForSessionTranscriptProjection(scope);
      const terminal = source.appendMessageWithTranscriptAnchor(
        Object.assign(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "completed answer" }],
          }),
          { __openclaw: { upstreamUserText: "synthetic-private-native-payload" } },
        ),
      );
      if (!terminal.anchor) {
        throw new Error("Missing completed-turn anchor");
      }
      const expected = SessionManager.openModelContext(scope).buildSessionContext();
      source.appendMessage({ role: "user", content: "later question", timestamp: 2 });
      const mutate = () => {
        if (mutation === "rewrite") {
          source.removeTrailingEntries((entry) => entry.type === "message");
        }
        source.appendMessage({ role: "user", content: "newest question", timestamp: 3 });
      };
      const spy = incognito
        ? undefined
        : vi
            .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
            .mockImplementationOnce(async (...args) => {
              spy!.mockRestore();
              const result = await contextWorker.readSessionTranscriptModelContextInWorker(...args);
              mutate();
              return result;
            });
      try {
        const pending = SessionManager.openModelContextAsync(scope, { through: terminal.anchor });
        if (incognito) {
          mutate();
        }
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
      } finally {
        spy?.mockRestore();
      }
    });
  },
);
