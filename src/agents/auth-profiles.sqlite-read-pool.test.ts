import { AsyncLocalStorage } from "node:async_hooks";
import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { captureSqliteAuthSchema as captureSchema } from "../infra/sqlite-readonly-auth-schema.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { openSqliteReadOnlyDatabase as openReadonly } from "../infra/sqlite-snapshot-source.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { loadPersistedAuthProfileStore as loadStore } from "./auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots as clearSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots as replaceSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import { writeAuthProfileJsonCell } from "./auth-profiles/sqlite-json-write.js";
import {
  inspectAgentAuthProfileJsonCellReadOnly,
  readAuthProfileRowsReadOnly as readRowsFromDatabase,
} from "./auth-profiles/sqlite-json.js";
import {
  acquireAuthProfileReadDatabase,
  closeAuthProfileReadDatabase,
} from "./auth-profiles/sqlite-read-pool.js";
import {
  closeAuthProfileReadPool as closePool,
  resolveAuthProfileDatabasePath as databasePath,
} from "./auth-profiles/sqlite.js";
import { apiKeyStore, withAgentDirEnv } from "./auth-profiles/sqlite.test-support.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { PersistedAuthProfileStoreInspection } from "./auth-profiles/types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  resolveExternalCliAuthProfiles: () => [],
}));

// mock-isolation: Reader lifecycle and SQL counts cover seeded databases only; provider discovery opens unrelated stores.
vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
    withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
  }),
}));

const storeSchema = `CREATE TABLE auth_profile_store (
  store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL
)`;
const missingTable = { status: "missing", reason: "table" } as const;

function acquire(pathname: string) {
  return acquireAuthProfileReadDatabase(pathname, openReadonly);
}
function inspectStore(pathname: string) {
  return inspectAgentAuthProfileJsonCellReadOnly(pathname, "store", openReadonly);
}
function readRows(pathname: string) {
  return readRowsFromDatabase(
    pathname,
    openReadonly,
    captureSchema(pathname, readDatabasePathIdentitySync(pathname).key),
  );
}

function writerFixture() {
  const dbPath = path.join(tempDirs.make("auth-schema-"), "agent.sqlite");
  const writer = nodeSqlite.openNodeSqliteDatabase(dbPath);
  registerOpenClawAgentDatabaseIdentity(writer, dbPath);
  writer.exec(storeSchema);
  admitSqliteSchema(writer);
  return {
    dbPath,
    writer,
    write(store: unknown, state?: unknown) {
      runSqliteImmediateTransactionSync(writer, () => {
        writeAuthProfileJsonCell(writer, "store", "agent", store);
        if (state !== undefined) {
          writeAuthProfileJsonCell(writer, "state", "agent", state);
        }
      });
    },
    [Symbol.dispose]() {
      closeAuthProfileReadDatabase(dbPath);
      if (writer.isOpen) {
        writer.close();
      }
    },
  };
}
function observeReads() {
  const observed = observeSqliteReadSql(StatementSync.prototype);
  return {
    ...observed,
    matching: (pattern: RegExp) => observed.queries.filter((sql) => pattern.test(sql)),
    [Symbol.dispose]: () => observed.restore(),
  };
}

const failClose = (message: string) => () => {
  throw new Error(message);
};

function withReaders(
  run: (agentDir: string, open: MockInstance<typeof nodeSqlite.openNodeSqliteDatabase>) => void,
  sibling = false,
) {
  return withAgentDirEnv("openclaw-auth-readers-", (agentDir) => {
    saveAuthProfileStore(apiKeyStore("qa-main"), agentDir);
    if (sibling) {
      saveAuthProfileStore(apiKeyStore("qa-sibling"), `${agentDir}-sibling`);
    }
    closeOpenClawAgentDatabasesForTest();
    clearSnapshots();
    using open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    try {
      run(agentDir, open);
    } finally {
      vi.restoreAllMocks();
      closePool();
      vi.useRealTimers();
    }
  });
}

it("reuses a reader with a captured owner projection after the writer closes", () => {
  using fixture = writerFixture();
  const { dbPath, writer } = fixture;
  const store = { version: 1, profiles: {} };
  fixture.write(store);
  const identity = readDatabasePathIdentitySync(dbPath).key;
  const schema = expectDefined(captureSchema(dbPath, identity), "auth schema");
  writer.close();
  expect(captureSchema(dbPath, identity)).toBeUndefined();
  using observed = observeReads();
  using open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  for (let index = 0; index < 2; index += 1) {
    expect(readRowsFromDatabase(dbPath, openReadonly, schema)).toMatchObject({
      store: { status: "readable", raw: store },
      state: { status: "missing", reason: "table" },
    });
    expect(open.mock.results[0]?.value.isOpen).toBe(true);
  }
  expect(open).toHaveBeenCalledOnce();
  expect(
    observed.matching(
      /sqlite_(?:schema|master)|\bPRAGMA\s+(?:encoding|user_version|schema_version)\b/iu,
    ),
  ).toEqual([]);
});

it("reuses admitted auth table facts across readers and refreshes them after owner writes", () => {
  using fixture = writerFixture();
  const { dbPath, writer } = fixture;
  const first = { version: 1, profiles: {} };
  const updated = { version: 1, profiles: { synthetic: { type: "api_key", key: "fixture" } } };
  fixture.write(first);
  using reads = observeReads();
  const assertRows = (
    store: PersistedAuthProfileStoreInspection,
    state: PersistedAuthProfileStoreInspection = missingTable,
  ) => {
    reads.queries.length = 0;
    expect(inspectStore(dbPath)).toEqual(store);
    expect(readRows(dbPath)).toMatchObject({ store, state });
    // Both readers borrow the same admitted facts after each committed write.
    expect(inspectStore(dbPath)).toEqual(store);
    expect(reads.matching(/\b(?:sqlite_master|sqlite_schema)\b/iu)).toEqual([]);
  };

  assertRows({ status: "readable", raw: first });
  fixture.write(updated);
  assertRows({ status: "readable", raw: updated });

  writer.exec(
    "DROP TABLE auth_profile_store; CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json",
  );
  assertRows({ status: "unreadable" });
  writer.exec("DROP VIEW auth_profile_store");
  assertRows(missingTable);

  writer.exec(`${storeSchema}; CREATE TABLE auth_profile_state (
    state_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  const state = { lastGood: { fixture: "synthetic" } };
  fixture.write(updated, state);
  assertRows({ status: "readable", raw: updated }, { status: "readable", raw: state });
});

it("reuses sealed format after final pool close and rejects a replacement file", async () => {
  await withReaders((agentDir) => {
    const pathname = databasePath(agentDir);
    using observed = observeReads();
    const formatQueries = () =>
      observed.matching(
        /sqlite_(?:schema|master)|\bPRAGMA\s+(?:user_version|schema_version|table_info|table_xinfo|index_list|index_info|index_xinfo)\b/iu,
      );
    expect(acquire(pathname).status).toBe("readable");
    closePool({ kind: "database", databasePath: pathname });
    observed.queries.length = 0;
    expect(acquire(pathname).status).toBe("readable");
    expect(formatQueries()).toEqual([]);
    observed.queries.length = 0;
    expect(acquire(pathname).status).toBe("readable");
    expect(formatQueries()).toEqual([]);
    closePool({ kind: "database", databasePath: pathname });
    const replacement = `${pathname}.replacement`;
    copyFileSync(pathname, replacement);
    {
      using database = new DatabaseSync(replacement);
      database.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
    }
    renameSync(replacement, pathname);
    observed.queries.length = 0;
    expect(acquire(pathname).status).toBe("unreadable");
    expect(formatQueries().length).toBeGreaterThan(0);
  });
});

it("observes foreign commits through cached readers and retains them on snapshot replacement", async () => {
  await withReaders((agentDir, open) => {
    expect(loadStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
    const reader = expectDefined(open.mock.results[0]?.value, "pooled auth reader");
    {
      using writer = new DatabaseSync(databasePath(agentDir));
      writer
        .prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = 'primary'")
        .run(JSON.stringify(apiKeyStore("synthetic-external")));
      writer
        .prepare(
          "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, 1)",
        )
        .run(JSON.stringify({ version: 1, usageStats: { "openai:default": { lastUsed: 456 } } }));
      expect(loadStore(agentDir)).toMatchObject({
        ...apiKeyStore("synthetic-external"),
        usageStats: { "openai:default": { lastUsed: 456 } },
      });
      expect(open).toHaveBeenCalledOnce();
    }
    replaceSnapshots([{ agentDir, store: apiKeyStore("qa-main") }]);
    expect(reader.isOpen).toBe(true);
    expect(loadStore(agentDir)).toMatchObject(apiKeyStore("synthetic-external"));
    expect(open).toHaveBeenCalledOnce();
    clearSnapshots();
    expect(reader.isOpen).toBe(false);
  });
});

it("closes each idle reader after thirty minutes and refreshes only reused readers", async () => {
  await withReaders((agentDir, open) => {
    const sibling = `${agentDir}-sibling`;
    vi.useFakeTimers();
    const schedule = vi.spyOn(globalThis, "setTimeout");
    expect(loadStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
    expect(loadStore(sibling)).toMatchObject(apiKeyStore("qa-sibling"));
    const first = expectDefined(open.mock.results[0]?.value, "first pooled auth reader");
    const staleCallback = expectDefined(schedule.mock.calls[0], "first auth reader idle timer")[0];
    const second = expectDefined(open.mock.results[1]?.value, "sibling pooled auth reader");
    vi.advanceTimersByTime(20 * 60_000);
    expect(loadStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
    vi.advanceTimersByTime(10 * 60_000);
    expect(second.isOpen).toBe(false);
    expect(first.isOpen).toBe(true);
    vi.advanceTimersByTime(20 * 60_000);
    expect(first.isOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(loadStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
    // A previously queued expiry must not close the replacement at the same path.
    staleCallback();
    expect(loadStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
    expect(open).toHaveBeenCalledTimes(3);
    closePool();
    expect(vi.getTimerCount()).toBe(0);
  }, true);
});

it("retries failed idle closes without losing native custody or exit cleanup", async () => {
  await withReaders((agentDir, open) => {
    const exitListeners = process.listenerCount("exit");
    vi.useFakeTimers();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    expect(loadStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
    const reader = expectDefined(open.mock.results[0]?.value, "auth reader awaiting idle close");
    const close = vi
      .spyOn(reader, "close")
      .mockImplementationOnce(failClose("native idle close failed"));
    vi.advanceTimersByTime(30 * 60_000);
    expect(reader.isOpen).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(reader.isOpen).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitListeners);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("allocates unref idle timers outside request contexts and reuses them on reads", async () => {
  await withReaders((agentDir) => {
    const requestScope = new AsyncLocalStorage<object>();
    const contexts: Array<object | undefined> = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const setTimeoutNative = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      const timer = setTimeoutNative(callback, delay, ...args);
      if (delay === 30 * 60_000) {
        contexts.push(requestScope.getStore());
        timers.push(timer);
      }
      return timer;
    });
    try {
      requestScope.run({}, () => {
        expect(loadStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
        expect(loadStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
      });
      expect(contexts).toEqual([undefined]);
      expect(timers).toHaveLength(1);
      expect(timers[0]?.hasRef()).toBe(false);
    } finally {
      requestScope.disable();
    }
  });
});

it.each(["unscoped", "root"] as const)("retains readers when a %s close fails", async (scope) => {
  await withReaders((agentDir, open) => {
    const listeners = process.listeners("exit");
    expect(loadStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
    const reader = expectDefined(open.mock.results[0]?.value, "auth reader awaiting cleanup");
    const siblingAgentDir = `${agentDir}-sibling`;
    if (scope === "root") {
      expect(loadStore(siblingAgentDir)).not.toBeNull();
    }
    const closeScope = scope === "root" ? { kind: "root" as const, rootPath: agentDir } : undefined;
    vi.spyOn(reader, "close").mockImplementationOnce(failClose("native close failed"));
    expect(() => closePool(closeScope)).toThrow("native close failed");
    expect(reader.isOpen).toBe(true);
    if (scope === "root") {
      closePool(closeScope);
      const siblingReader = expectDefined(open.mock.results[1]?.value, "sibling auth reader");
      expect(siblingReader.isOpen).toBe(true);
      expect(loadStore(siblingAgentDir)).toMatchObject(apiKeyStore("qa-sibling"));
    } else {
      const exitClosers = process
        .listeners("exit")
        .filter((listener) => !listeners.includes(listener));
      expect(exitClosers).toHaveLength(1);
      expectDefined(exitClosers[0], "auth reader exit cleanup listener")(0);
      expect(process.listeners("exit")).toEqual(listeners);
    }
    expect(reader.isOpen).toBe(false);
  }, scope === "root");
});

it("retains failed admission handles without opening more readers until cleanup succeeds", async () => {
  await withAgentDirEnv("openclaw-auth-reader-admission-", (agentDir) => {
    const agentDirs = Array.from({ length: 66 }, (_, index) =>
      path.join(path.dirname(path.dirname(agentDir)), `reader-${index}`, "agent"),
    );
    for (const directory of agentDirs) {
      saveAuthProfileStore(apiKeyStore("qa-synthetic"), directory);
    }
    closeOpenClawAgentDatabasesForTest();
    clearSnapshots();
    const openDatabase = nodeSqlite.openNodeSqliteDatabase;
    const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    try {
      for (const directory of agentDirs.slice(0, 64)) {
        expect(loadStore(directory)).toMatchObject(apiKeyStore("qa-synthetic"));
      }
      const oldest = openSpy.mock.results[0]?.value as DatabaseSync;
      const evictionClose = vi
        .spyOn(oldest, "close")
        .mockImplementation(failClose("eviction close failed"));
      const candidateAgentDir = expectDefined(agentDirs[64], "candidate agent directory");
      const candidatePath = databasePath(candidateAgentDir);
      let candidate: DatabaseSync | undefined;
      let candidateClose: MockInstance<DatabaseSync["close"]> | undefined;
      openSpy.mockImplementationOnce((...args) => {
        candidate = openDatabase(...args);
        candidateClose = vi
          .spyOn(candidate, "close")
          .mockImplementation(failClose("candidate close failed"));
        return candidate;
      });
      expect(() => loadStore(candidateAgentDir)).toThrow(AggregateError);
      expect(oldest.isOpen).toBe(true);
      expect(candidate?.isOpen).toBe(true);
      expect(() => loadStore(agentDirs[65])).toThrow("candidate close failed");
      expect(() => loadStore(candidateAgentDir)).toThrow("candidate close failed");
      expect(openSpy).toHaveBeenCalledTimes(65);
      expect(loadStore(agentDirs[0])).toMatchObject(apiKeyStore("qa-synthetic"));
      candidateClose?.mockRestore();
      closePool({ kind: "database", databasePath: candidatePath });
      expect(candidate?.isOpen).toBe(false);
      evictionClose.mockRestore();
      expect(loadStore(agentDirs[65])).toMatchObject(apiKeyStore("qa-synthetic"));
      expect(openSpy).toHaveBeenCalledTimes(66);
    } finally {
      vi.restoreAllMocks();
      closePool();
    }
  });
});
