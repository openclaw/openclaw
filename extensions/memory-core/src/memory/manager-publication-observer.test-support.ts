import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withSessionTranscriptWriteLock } from "openclaw/plugin-sdk/session-transcript-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { vi } from "vitest";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";

export function observePublishedReservations(publishedDb: DatabaseSync, onReserved: () => void) {
  const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStore;
  vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStore").mockImplementation(
    async (...args) => {
      const worker = await open(...args);
      if (
        args[1] === publishedDb &&
        args[2].moduleUrl.href ===
          resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication).href
      ) {
        const run = worker.run.bind(worker);
        vi.spyOn(worker, "run").mockImplementation((...runArgs) => {
          const result = run(...runArgs);
          onReserved();
          return result;
        });
      }
      return worker;
    },
  );
}

/** Observe executions on statements prepared by this published handle during the fixture. */
export function observePublishedSql(publishedDb: DatabaseSync) {
  const { StatementSync } = requireNodeSqlite();
  const statements = new WeakMap<object, string>();
  const prepare = publishedDb.prepare.bind(publishedDb);
  const preparing = vi.spyOn(publishedDb, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    statements.set(statement, sql);
    return statement;
  });
  const executions = [
    ["get", vi.spyOn(StatementSync.prototype, "get")],
    ["all", vi.spyOn(StatementSync.prototype, "all")],
    ["run", vi.spyOn(StatementSync.prototype, "run")],
    ["iterate", vi.spyOn(StatementSync.prototype, "iterate")],
  ] as const;
  const exec = vi.spyOn(publishedDb, "exec");
  return {
    calls: () => [
      ...executions.flatMap(([method, observed]) =>
        observed.mock.contexts.flatMap((statement) => {
          if (!(statement instanceof StatementSync)) {
            return [];
          }
          const sql = statements.get(statement);
          return sql === undefined ? [] : [{ method, sql }];
        }),
      ),
      ...exec.mock.calls.map(([sql]) => ({ method: "exec", sql })),
    ],
    clear() {
      for (const [, observed] of executions) {
        observed.mockClear();
      }
      exec.mockClear();
    },
    restore() {
      preparing.mockRestore();
      for (const [, observed] of executions) {
        observed.mockRestore();
      }
      exec.mockRestore();
    },
  };
}

export async function reservePublishedWriter(mutate?: () => void | Promise<void>) {
  const target = {
    agentId: "main",
    sessionKey: "agent:main:cache-admission",
    sessionId: "cache-admission",
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  const done = withSessionTranscriptWriteLock(target, async () => {
    entered.resolve();
    await released.promise;
    await mutate?.();
  });
  void done.catch(() => undefined);
  await Promise.race([entered.promise, done]);
  return { done, release: released.resolve };
}
