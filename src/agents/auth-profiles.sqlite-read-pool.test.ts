import { AsyncLocalStorage } from "node:async_hooks";
import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import { acquireAuthProfileReadDatabase } from "./auth-profiles/sqlite-read-pool.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import { apiKeyStore, withAgentDirEnv } from "./auth-profiles/sqlite.test-support.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  resolveExternalCliAuthProfiles: () => [],
}));

vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

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
    clearRuntimeAuthProfileStoreSnapshots();
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    try {
      run(agentDir, open);
    } finally {
      closeAuthProfileReadPool();
      open.mockRestore();
      vi.useRealTimers();
    }
  });
}

describe("auth profile sqlite reader lifecycle", () => {
  it("reuses format admission across pool reopen and validates a replacement file", async () => {
    await withReaders((agentDir) => {
      const pathname = resolveAuthProfileDatabasePath(agentDir);
      const observed = observeSqliteReadSql(nodeSqlite.requireNodeSqlite().StatementSync.prototype);
      const formatQueries = () =>
        observed.queries.filter((sql) =>
          /sqlite_(?:schema|master)|\bPRAGMA\s+(?:user_version|schema_version|table_info|table_xinfo|index_list|index_info|index_xinfo)\b/iu.test(
            sql,
          ),
        );
      try {
        expect(acquireAuthProfileReadDatabase(pathname).status).toBe("readable");
        closeAuthProfileReadPool({ kind: "database", databasePath: pathname });
        observed.queries.length = 0;
        expect(acquireAuthProfileReadDatabase(pathname).status).toBe("readable");
        expect(formatQueries()).toEqual([]);
        closeAuthProfileReadPool({ kind: "database", databasePath: pathname });
        const replacement = `${pathname}.replacement`;
        copyFileSync(pathname, replacement);
        {
          using database = new DatabaseSync(replacement);
          database.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
        }
        renameSync(replacement, pathname);
        observed.queries.length = 0;
        expect(acquireAuthProfileReadDatabase(pathname).status).toBe("unreadable");
        expect(formatQueries().length).toBeGreaterThan(0);
      } finally {
        observed.restore();
      }
    });
  });

  it("observes foreign commits through cached readers and closes them on snapshot replacement", async () => {
    await withReaders((agentDir, open) => {
      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
      const reader = expectDefined(open.mock.results[0]?.value, "pooled auth reader");
      const writer = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      try {
        writer
          .prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = 'primary'")
          .run(JSON.stringify(apiKeyStore("synthetic-external")));
        writer
          .prepare(
            "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, 1)",
          )
          .run(JSON.stringify({ version: 1, usageStats: { "openai:default": { lastUsed: 456 } } }));
        expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
          ...apiKeyStore("synthetic-external"),
          usageStats: { "openai:default": { lastUsed: 456 } },
        });
        expect(open).toHaveBeenCalledOnce();
      } finally {
        writer.close();
      }
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: apiKeyStore("qa-main") }]);
      expect(reader.isOpen).toBe(false);
      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(
        apiKeyStore("synthetic-external"),
      );
      expect(open).toHaveBeenCalledTimes(2);
    });
  });

  it("closes each idle reader after thirty minutes and refreshes only reused readers", async () => {
    await withReaders((agentDir, open) => {
      const sibling = `${agentDir}-sibling`;
      vi.useFakeTimers();
      const schedule = vi.spyOn(globalThis, "setTimeout");
      try {
        expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
        expect(loadPersistedAuthProfileStore(sibling)).toMatchObject(apiKeyStore("qa-sibling"));
        const first = expectDefined(open.mock.results[0]?.value, "first pooled auth reader");
        const staleCallback = expectDefined(
          schedule.mock.calls[0],
          "first auth reader idle timer",
        )[0];
        const second = expectDefined(open.mock.results[1]?.value, "sibling pooled auth reader");
        vi.advanceTimersByTime(20 * 60_000);
        expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
        vi.advanceTimersByTime(10 * 60_000);
        expect(second.isOpen).toBe(false);
        expect(first.isOpen).toBe(true);
        vi.advanceTimersByTime(20 * 60_000);
        expect(first.isOpen).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
        // A previously queued expiry must not close the replacement at the same path.
        staleCallback();
        expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
        expect(open).toHaveBeenCalledTimes(3);
        closeAuthProfileReadPool();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        schedule.mockRestore();
      }
    }, true);
  });

  it("retries failed idle closes without losing native custody or exit cleanup", async () => {
    await withReaders((agentDir, open) => {
      const exitListeners = process.listenerCount("exit");
      vi.useFakeTimers();
      const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      let close: MockInstance<DatabaseSync["close"]> | undefined;
      try {
        expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
        const reader = expectDefined(
          open.mock.results[0]?.value,
          "auth reader awaiting idle close",
        );
        close = vi.spyOn(reader, "close").mockImplementationOnce(() => {
          throw new Error("native idle close failed");
        });
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
      } finally {
        close?.mockRestore();
        warning.mockRestore();
      }
    });
  });

  it("allocates unref idle timers outside request contexts and reuses them on reads", async () => {
    await withReaders((agentDir) => {
      const requestScope = new AsyncLocalStorage<object>();
      const contexts: Array<object | undefined> = [];
      const timers: ReturnType<typeof setTimeout>[] = [];
      const setTimeoutNative = globalThis.setTimeout;
      const schedule = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) => {
          const timer = setTimeoutNative(callback, delay, ...args);
          if (delay === 30 * 60_000) {
            contexts.push(requestScope.getStore());
            timers.push(timer);
          }
          return timer;
        });
      try {
        requestScope.run({}, () => {
          expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
          expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
        });
        expect(contexts).toEqual([undefined]);
        expect(timers).toHaveLength(1);
        expect(timers[0]?.hasRef()).toBe(false);
      } finally {
        schedule.mockRestore();
        requestScope.disable();
      }
    });
  });

  it.each(["unscoped", "root"] as const)("retains readers when a %s close fails", async (scope) => {
    await withReaders((agentDir, open) => {
      const listeners = process.listeners("exit");
      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
      const reader = expectDefined(open.mock.results[0]?.value, "auth reader awaiting cleanup");
      const siblingAgentDir = `${agentDir}-sibling`;
      if (scope === "root") {
        expect(loadPersistedAuthProfileStore(siblingAgentDir)).not.toBeNull();
      }
      const closeScope =
        scope === "root" ? { kind: "root" as const, rootPath: agentDir } : undefined;
      const close = vi.spyOn(reader, "close").mockImplementationOnce(() => {
        throw new Error("native close failed");
      });
      try {
        expect(() => closeAuthProfileReadPool(closeScope)).toThrow("native close failed");
        expect(reader.isOpen).toBe(true);
        if (scope === "root") {
          closeAuthProfileReadPool(closeScope);
          const siblingReader = expectDefined(open.mock.results[1]?.value, "sibling auth reader");
          expect(siblingReader.isOpen).toBe(true);
          expect(loadPersistedAuthProfileStore(siblingAgentDir)).toMatchObject(
            apiKeyStore("qa-sibling"),
          );
        } else {
          const exitClosers = process
            .listeners("exit")
            .filter((listener) => !listeners.includes(listener));
          expect(exitClosers).toHaveLength(1);
          expectDefined(exitClosers[0], "auth reader exit cleanup listener")(0);
          expect(process.listeners("exit")).toEqual(listeners);
        }
        expect(reader.isOpen).toBe(false);
      } finally {
        close.mockRestore();
      }
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
      clearRuntimeAuthProfileStoreSnapshots();
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      try {
        for (const directory of agentDirs.slice(0, 64)) {
          expect(loadPersistedAuthProfileStore(directory)).toMatchObject(
            apiKeyStore("qa-synthetic"),
          );
        }
        const oldest = openSpy.mock.results[0]?.value as DatabaseSync;
        const evictionClose = vi.spyOn(oldest, "close").mockImplementation(() => {
          throw new Error("eviction close failed");
        });
        const candidateAgentDir = expectDefined(agentDirs[64], "candidate agent directory");
        const candidatePath = resolveAuthProfileDatabasePath(candidateAgentDir);
        let candidate: DatabaseSync | undefined;
        let candidateClose: MockInstance<DatabaseSync["close"]> | undefined;
        openSpy.mockImplementationOnce((...args) => {
          candidate = openDatabase(...args);
          candidateClose = vi.spyOn(candidate, "close").mockImplementation(() => {
            throw new Error("candidate close failed");
          });
          return candidate;
        });
        try {
          expect(() => loadPersistedAuthProfileStore(candidateAgentDir)).toThrow(AggregateError);
          expect(oldest.isOpen).toBe(true);
          expect(candidate?.isOpen).toBe(true);
          expect(() => loadPersistedAuthProfileStore(agentDirs[65])).toThrow(
            "candidate close failed",
          );
          expect(() => loadPersistedAuthProfileStore(candidateAgentDir)).toThrow(
            "candidate close failed",
          );
          expect(openSpy).toHaveBeenCalledTimes(65);
          expect(loadPersistedAuthProfileStore(agentDirs[0])).toMatchObject(
            apiKeyStore("qa-synthetic"),
          );
          candidateClose?.mockRestore();
          closeAuthProfileReadPool({ kind: "database", databasePath: candidatePath });
          expect(candidate?.isOpen).toBe(false);
          evictionClose.mockRestore();
          expect(loadPersistedAuthProfileStore(agentDirs[65])).toMatchObject(
            apiKeyStore("qa-synthetic"),
          );
          expect(openSpy).toHaveBeenCalledTimes(66);
        } finally {
          candidateClose?.mockRestore();
          evictionClose.mockRestore();
        }
      } finally {
        openSpy.mockRestore();
        closeAuthProfileReadPool();
      }
    });
  });
});
