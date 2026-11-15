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
  const observe =
    <Args extends unknown[], Result>(run: (...args: Args) => Result) =>
    (...args: Args) => {
      const result = run(...args);
      onReserved();
      return result;
    };
  const publishedPath = publishedDb.location();
  const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
  vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2").mockImplementation(
    async (...args) => {
      const worker = await open(...args);
      if (
        args[0].path === publishedPath &&
        args[2].moduleUrl.href ===
          resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication).href
      ) {
        const run = worker.run.bind(worker);
        vi.spyOn(worker, "run").mockImplementation(observe(run));
        const execute = worker.execute.bind(worker);
        vi.spyOn(worker, "execute").mockImplementation(observe(execute));
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
  const executions = (["get", "all", "run", "iterate"] as const).map(
    (method) => [method, vi.spyOn(StatementSync.prototype, method)] as const,
  );
  const exec = vi.spyOn(publishedDb, "exec");
  const executionSpies = [...executions.map(([, spy]) => spy), exec];
  return {
    calls: () => [
      ...executions.flatMap(([method, observed]) =>
        observed.mock.contexts.flatMap((statement) => {
          const sql = statement instanceof StatementSync ? statements.get(statement) : undefined;
          return sql === undefined ? [] : [{ method, sql }];
        }),
      ),
      ...exec.mock.calls.map(([sql]) => ({ method: "exec", sql })),
    ],
    clear: () => executionSpies.forEach((spy) => spy.mockClear()),
    restore: () => [preparing, ...executionSpies].forEach((spy) => spy.mockRestore()),
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
