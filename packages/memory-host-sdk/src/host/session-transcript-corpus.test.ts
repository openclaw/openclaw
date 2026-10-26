import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { markCanonicalSessionValidationPending } from "../../../../src/config/sessions/session-canonical-key.js";
import { seedCanonicalSessionValidation } from "../../../../src/config/sessions/session-canonical-validation.js";
import { runSqliteImmediateTransactionSync } from "../../../../src/infra/sqlite-transaction.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../../src/state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../../../../src/state/openclaw-agent-db-registry.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../../../src/state/openclaw-agent-db.js";
import { tableExists } from "../../../../src/state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "../../../../src/state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../../src/test-utils/openclaw-test-state.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { listSessionTranscriptCorpusEntriesForAgent as listCorpus } from "./session-files.js";

async function withCorpusState(run: (state: OpenClawTestState) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    await run(state);
  });
}

async function configureStore(state: OpenClawTestState, storePath: string) {
  const config = { session: { store: storePath } };
  await state.writeConfig(config);
  clearConfigCache();
  setRuntimeConfigSnapshot(config);
}

async function seedSession(
  storePath: string,
  sessionId: string,
  entry: Parameters<typeof upsertSessionEntryCore>[1] = {},
) {
  const sessionKey = `agent:main:${sessionId}`;
  const persisted = await upsertSessionEntryCore(
    { sessionKey, storePath },
    { sessionId, updatedAt: 10, ...entry },
  );
  return {
    sessionKey,
    expected: {
      agentId: "main",
      artifactKind: "active-session",
      sessionFile: sessionKey,
      sessionId,
      sessionKey,
      sessionKind: "heartbeat",
      storePath,
      transcriptSource: "sqlite",
      updatedAtMs: persisted?.updatedAt,
    },
  };
}

function pauseDirectoryDiscovery(sessionsDir: string) {
  const entered = createDeferred();
  const release = createDeferred();
  const realpath = fs.realpath.bind(fs);
  let paused = false;
  const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (file) => {
    if (!paused && file === sessionsDir) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return realpath(file);
  });
  return { entered, release, realpathSpy };
}

describe("listSessionTranscriptCorpusEntriesForAgent", () => {
  it.each([false, true])(
    "observes committed and admitted-raw corpus changes (readOnly: %s)",
    async (readOnly) => {
      await withCorpusState(async (state) => {
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const { sessionKey, expected } = await seedSession(storePath, "corpus-admission");
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const { db } = database;
        const commands: string[] = [];
        // oxlint-disable-next-line typescript/unbound-method -- call preserves the intercepted worker receiver.
        const nativePost = Worker.prototype.postMessage;
        using _ = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
          this: Worker,
          request,
          transferList,
        ) {
          if (
            isRecord(request) &&
            request.type === "execute" &&
            request.input instanceof Uint8Array
          ) {
            const command: unknown = deserialize(request.input);
            if (isRecord(command) && typeof command.type === "string") {
              commands.push(command.type);
            }
          }
          nativePost.call(this, request, transferList);
        });

        const options = { includeContentRevision: false, readOnly };
        await expect(listCorpus("main", options)).resolves.toEqual([
          { ...expected, sessionKind: "interactive" },
        ]);
        const validity = () =>
          db.prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?").get(sessionKey)
            ?.entry_valid;
        if (readOnly) {
          runSqliteImmediateTransactionSync(db, () => seedCanonicalSessionValidation(database));
          db.prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.heartbeatIsolatedBaseSessionKey', ?), entry_valid = 0 WHERE session_key = ?",
          ).run("agent:main:main", sessionKey);
          expect(validity()).toBe(0);
        } else {
          await upsertSessionEntryCore(
            { sessionKey, storePath },
            { heartbeatIsolatedBaseSessionKey: "agent:main:main" },
          );
        }
        await expect(listCorpus("main", options)).resolves.toEqual([
          { ...expected, ...(readOnly ? {} : { updatedAtMs: expect.any(Number) }) },
        ]);
        if (readOnly) {
          expect(validity()).toBe(0);
          expect(db.isOpen).toBe(true);
          expect(getOpenClawAgentDatabaseIfOpen({ agentId: "main", env: state.env })?.db).toBe(db);
          runSqliteImmediateTransactionSync(db, () => {
            markCanonicalSessionValidationPending(database, [sessionKey]);
          });
          await closeOpenClawAgentDatabasesAsync(state.stateDir);
          expect(db.isOpen).toBe(false);
          await expect(listCorpus("main", options)).rejects.toThrow("openclaw doctor --fix");
        } else {
          expect(commands).toContain("session.entry.patch.commit");
          expect(commands.filter((command) => command === "session.entry.read")).toEqual([]);
        }
      });
    },
  );

  it("discovers the caller's configured store without a global runtime snapshot", async () => {
    await withCorpusState(async (state) => {
      const storePath = state.statePath("memory-session-corpus", "sessions.json");
      await upsertSessionEntryCore(
        { sessionKey: "agent:main:chat:owned", storePath },
        { sessionId: "owned", updatedAt: 1 },
      );
      clearRuntimeConfigSnapshot();

      const entries = await listCorpus("main", {
        config: { session: { store: storePath } },
        includeContentRevision: false,
        readOnly: true,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        sessionId: "owned",
        sessionKey: "agent:main:chat:owned",
        storePath,
        transcriptSource: "sqlite",
      });
    });
  });

  it.each([
    { includeContentRevision: true, archiveTablePresent: true, readOnly: false },
    { includeContentRevision: false, archiveTablePresent: true, readOnly: false },
    { includeContentRevision: false, archiveTablePresent: false, readOnly: false },
    { includeContentRevision: false, archiveTablePresent: true, readOnly: true },
    { includeContentRevision: false, archiveTablePresent: false, readOnly: true },
  ])(
    "preserves corpus selection with content revisions $includeContentRevision and archive table $archiveTablePresent (readOnly: $readOnly)",
    async ({ includeContentRevision, archiveTablePresent, readOnly }) => {
      await withCorpusState(async (state) => {
        const sessionsDir = state.sessionsDir();
        await fs.mkdir(sessionsDir, { recursive: true });
        const archivePath = path.join(
          sessionsDir,
          "cron-thread.jsonl.deleted.2026-02-16T22-27-33.000Z",
        );
        await fs.writeFile(archivePath, "retained transcript");
        await fs.writeFile(path.join(sessionsDir, "loose.jsonl"), "unowned live file");
        await upsertSessionEntryCore(
          {
            sessionKey: "agent:main:cron:job-1:run:run-1",
            storePath: path.join(sessionsDir, "sessions.json"),
          },
          { sessionId: "cron-thread", updatedAt: 1 },
        );
        const { db } = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        if (!archiveTablePresent) {
          db.exec("DROP TABLE session_transcript_archives");
        }
        expect(tableExists(db, "session_transcript_archives")).toBe(archiveTablePresent);

        const options = { includeContentRevision, readOnly };
        const actual = await listCorpus("main", options);

        expect(actual).toHaveLength(2);
        expect(actual.find((entry) => entry.artifactKind === "active-session")).toMatchObject({
          agentId: "main",
          sessionFile: "agent:main:cron:job-1:run:run-1",
          sessionId: "cron-thread",
          generatedByCronRun: true,
          sessionKind: "cron",
          transcriptSource: "sqlite",
        });
        const archive = actual.find((entry) => entry.artifactKind === "archive-artifact");
        expect(archive).toMatchObject({
          sessionFile: archivePath,
          sessionId: "cron-thread",
          generatedByCronRun: true,
          sessionKind: "cron",
        });
        expect(archive?.contentRevision !== undefined).toBe(includeContentRevision);
        expect(tableExists(db, "session_transcript_archives")).toBe(archiveTablePresent);
      });
    },
  );

  it.each([
    { readOnly: false, includeRetainedSqlite: true },
    { readOnly: true, includeRetainedSqlite: true },
    { readOnly: true, includeRetainedSqlite: false },
  ])(
    "classifies prompt-rich entries without decoding saved prompts (readOnly: $readOnly, retained: $includeRetainedSqlite)",
    async ({ readOnly, includeRetainedSqlite }) => {
      await withCorpusState(async (state) => {
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const { expected } = await seedSession(storePath, "corpus-metadata", {
          heartbeatIsolatedBaseSessionKey: "agent:main:main",
          skillsSnapshot: { prompt: "unused corpus prompt ".repeat(256), skills: [] },
          systemPromptReport: {
            source: "run",
            generatedAt: 1,
            systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
            injectedWorkspaceFiles: [],
            skills: { promptChars: 0, entries: [] },
            tools: { listChars: 0, schemaChars: 0, entries: [] },
          },
        });

        const parse = vi.spyOn(JSON, "parse");
        const observed = observeSqliteReadSql(StatementSync.prototype);
        const isSummaryRead = (sql: string) =>
          /^\s*select\b[\s\S]*\bfrom\s+["`]?session_nodes\b/i.test(sql) &&
          /\bentry_json\b|\*/i.test(sql.split(/\bfrom\b/i)[0]!);
        try {
          const { db } = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
          expect(
            db.prepare('select "session_key", "entry_json" from "session_nodes" where 0').all(),
          ).toEqual([]);
          expect(observed.queries.filter(isSummaryRead)).toHaveLength(1);
          // A cold reader must perform the real projection, not reuse a warm host snapshot.
          await closeOpenClawAgentDatabasesAsync(state.stateDir);
          observed.queries.length = 0;
          parse.mockClear();
          const entries = await listCorpus("main", {
            includeContentRevision: false,
            includeRetainedSqlite,
            readOnly,
          });
          expect(entries).toEqual([expected]);
          expect(observed.queries).toEqual([]);
          const decodedEntries = parse.mock.calls.filter(([json]) =>
            json.includes('"sessionId":"corpus-metadata"'),
          );
          expect(
            decodedEntries.every(
              ([json]) =>
                !json.includes('"skillsSnapshot"') && !json.includes('"systemPromptReport"'),
            ),
          ).toBe(true);
        } finally {
          parse.mockRestore();
          observed.restore();
        }
      });
    },
  );

  it("reads worker content revisions without claiming an agent database lease", async () => {
    await withCorpusState(async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const { sessionKey } = await seedSession(storePath, "revision-corpus");
      const { path: agentPath } = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const leases = openOpenClawStateDatabase({ env: state.env }).db.prepare(
        "SELECT lease_id FROM agent_database_leases WHERE path = ?",
      );
      const admitted = new Set(leases.all(agentPath).map((row) => row.lease_id));

      const entries = await listCorpus("main", {
        config: { session: { store: storePath } },
        includeContentRevision: true,
      });

      expect(entries).toEqual([
        expect.objectContaining({ sessionKey, contentRevision: expect.stringMatching(/^sqlite:/) }),
      ]);
      // Pooled history Workers outlive the request; a writable open would leave their lease.
      expect(leases.all(agentPath).filter((row) => !admitted.has(row.lease_id))).toEqual([]);
    });
  });

  it.each([
    { readOnly: false, change: "config" },
    { readOnly: true, change: "config" },
    { readOnly: false, change: "registry environment" },
    { readOnly: true, change: "registry environment" },
  ])(
    "retains captured $change while discovery yields (readOnly: $readOnly)",
    async ({ readOnly, change }) => {
      await withCorpusState(async (state) => {
        const sessionsDir = state.statePath("custom-sessions");
        const storePath = path.join(sessionsDir, "sessions.json");
        const unsuffixedDatabase = path.join(sessionsDir, "openclaw-agent.sqlite");
        await fs.mkdir(sessionsDir, { recursive: true });
        await configureStore(state, storePath);
        if (change === "config") {
          await upsertSessionEntryCore(
            { sessionKey: "agent:main:chat:original", storePath },
            { sessionId: "original", updatedAt: 1 },
          );
        } else {
          registerOpenClawAgentDatabase({ agentId: "ops", path: unsuffixedDatabase });
        }
        const { entered, release, realpathSpy } = pauseDirectoryDiscovery(sessionsDir);
        const listing = listCorpus("main", {
          readOnly,
          ...(readOnly ? { includeContentRevision: false } : {}),
        });
        try {
          await expect(
            Promise.race([entered.promise.then(() => "waiting"), listing.then(() => "completed")]),
          ).resolves.toBe("waiting");
          if (change === "config") {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            await configureStore(state, state.statePath("replacement", "sessions.json"));
            await upsertSessionEntryCore(
              { sessionKey: "agent:main:chat:fresh", storePath },
              { sessionId: "fresh", updatedAt: 2 },
            );
          } else {
            Reflect.set(process.env, "OPENCLAW_STATE_DIR", state.statePath("replacement-state"));
          }
          release.resolve();
          const entries = await listing;
          if (change === "config") {
            expect(entries.map((entry) => entry.sessionId).toSorted()).toEqual([
              "fresh",
              "original",
            ]);
            expect(entries.every((entry) => entry.storePath === storePath)).toBe(true);
          } else {
            expect(entries).toEqual([]);
            expect(fsSync.existsSync(path.join(sessionsDir, "openclaw-agent.main.sqlite"))).toBe(
              !readOnly,
            );
            expect(fsSync.existsSync(unsuffixedDatabase)).toBe(false);
            if (readOnly) {
              expect(fsSync.existsSync(state.statePath("replacement-state"))).toBe(false);
            }
          }
        } finally {
          release.resolve();
          await listing.finally(() => {
            Reflect.set(process.env, "OPENCLAW_STATE_DIR", state.stateDir);
            realpathSpy.mockRestore();
          });
        }
      });
    },
  );
});
