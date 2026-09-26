import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import * as kyselySync from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import {
  closeAuthProfileReadPool,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import { apiKeyStore, withAgentDirEnv } from "./auth-profiles/sqlite.test-support.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { getRuntimeAuthProfileStoreSnapshotRevision } from "./auth-profiles/store.js";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  resolveExternalCliAuthProfiles: () => [],
}));

vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

describe("auth profile sqlite reader lifecycle", () => {
  it("reuses path-keyed read handles until the runtime snapshot revision changes", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-read-reuse-", (agentDir) => {
      const agentDirs = [
        agentDir,
        ...Array.from({ length: 63 }, (_, index) =>
          path.join(path.dirname(path.dirname(agentDir)), `secondary-${index}`, "agent"),
        ),
      ];
      for (const directory of agentDirs) {
        saveAuthProfileStore(apiKeyStore("sk-test"), directory);
      }
      closeOpenClawAgentDatabasesForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const statementCacheSpy = vi.spyOn(kyselySync, "enableNodeSqliteKyselyStatementCache");
      try {
        const initialRevision = getRuntimeAuthProfileStoreSnapshotRevision(agentDir);
        for (const directory of agentDirs) {
          expect(loadPersistedAuthProfileStore(directory)).toMatchObject(apiKeyStore("sk-test"));
        }
        const missingAgentDir = path.join(path.dirname(path.dirname(agentDir)), "later", "agent");
        expect(inspectPersistedAuthProfileStoreRaw(missingAgentDir)).toEqual({
          status: "missing",
          reason: "database",
        });
        for (const opened of openSpy.mock.results.filter((result) => result.type === "return")) {
          expect(opened.value.isOpen).toBe(true);
        }
        for (const directory of agentDirs) {
          expect(loadPersistedAuthProfileStore(directory)).toMatchObject(apiKeyStore("sk-test"));
        }
        expect(openSpy.mock.calls.filter(([, options]) => options?.readOnly === true)).toHaveLength(
          65,
        );
        expect(statementCacheSpy).toHaveBeenCalledTimes(64);
        const firstDatabase = openSpy.mock.results[0]?.value;
        const secondDatabase = openSpy.mock.results[1]?.value;
        expect(firstDatabase?.isOpen).toBe(true);
        expect(secondDatabase?.isOpen).toBe(true);
        const prepare = vi.spyOn(
          expectDefined(firstDatabase, "first pooled auth reader"),
          "prepare",
        );
        const writer = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
        try {
          expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("sk-test"));
          writer
            .prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = 'primary'")
            .run(JSON.stringify(apiKeyStore("synthetic-external")));
          writer
            .prepare(
              `INSERT INTO auth_profile_state (state_key, state_json, updated_at)
               VALUES ('primary', ?, 1)
               ON CONFLICT (state_key) DO UPDATE SET state_json = excluded.state_json`,
            )
            .run(
              JSON.stringify({ version: 1, usageStats: { "openai:default": { lastUsed: 456 } } }),
            );
          expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
            ...apiKeyStore("synthetic-external"),
            usageStats: { "openai:default": { lastUsed: 456 } },
          });
          // Warm reads reuse statements, but each execution still observes committed rows.
          expect(prepare).not.toHaveBeenCalled();
        } finally {
          prepare.mockRestore();
          writer.close();
        }

        fs.mkdirSync(missingAgentDir, { recursive: true });
        const created = new DatabaseSync(resolveAuthProfileDatabasePath(missingAgentDir));
        try {
          created.exec(
            "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT)",
          );
          created
            .prepare("INSERT INTO auth_profile_store VALUES (?, ?)")
            .run("primary", JSON.stringify(apiKeyStore("synthetic-created")));
        } finally {
          created.close();
        }
        expect(loadPersistedAuthProfileStore(missingAgentDir)).toMatchObject(
          apiKeyStore("synthetic-created"),
        );

        replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: apiKeyStore("sk-test") }]);

        expect(getRuntimeAuthProfileStoreSnapshotRevision(agentDir)).toBeGreaterThan(
          initialRevision,
        );
        expect(firstDatabase?.isOpen).toBe(false);
        expect(secondDatabase?.isOpen).toBe(false);
        expect(loadPersistedAuthProfileStore(agentDir)).not.toBeNull();
        expect(openSpy.mock.calls.filter(([, options]) => options?.readOnly === true)).toHaveLength(
          67,
        );
        expect(statementCacheSpy).toHaveBeenCalledTimes(66);
      } finally {
        statementCacheSpy.mockRestore();
        openSpy.mockRestore();
      }
    });
  });

  it("closes each idle reader after thirty minutes and refreshes only reused readers", async () => {
    await withAgentDirEnv("openclaw-auth-reader-idle-", (agentDir) => {
      const sibling = `${agentDir}-sibling`;
      saveAuthProfileStore(apiKeyStore("qa-main"), agentDir);
      saveAuthProfileStore(apiKeyStore("qa-sibling"), sibling);
      closeOpenClawAgentDatabasesForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      vi.useFakeTimers();
      const schedule = vi.spyOn(globalThis, "setTimeout");
      const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
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
        closeAuthProfileReadPool();
        open.mockRestore();
        schedule.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("retries failed idle closes without losing native custody or exit cleanup", async () => {
    await withAgentDirEnv("openclaw-auth-reader-idle-retry-", (agentDir) => {
      saveAuthProfileStore(apiKeyStore("qa-main"), agentDir);
      closeOpenClawAgentDatabasesForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      const exitListeners = process.listenerCount("exit");
      vi.useFakeTimers();
      const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
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
        closeAuthProfileReadPool();
        warning.mockRestore();
        open.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("allocates unref idle timers outside request contexts and reuses them on reads", async () => {
    await withAgentDirEnv("openclaw-auth-reader-idle-context-", (agentDir) => {
      saveAuthProfileStore(apiKeyStore("qa-main"), agentDir);
      closeOpenClawAgentDatabasesForTest();
      clearRuntimeAuthProfileStoreSnapshots();
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
        closeAuthProfileReadPool();
        schedule.mockRestore();
        requestScope.disable();
      }
    });
  });

  it("keeps exit cleanup registered when an unscoped close fails", async () => {
    await withAgentDirEnv("openclaw-auth-reader-exit-retry-", (agentDir) => {
      saveAuthProfileStore(apiKeyStore("qa-main"), agentDir);
      closeOpenClawAgentDatabasesForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      const listeners = process.listeners("exit");
      const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      try {
        expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("qa-main"));
        const reader = expectDefined(
          open.mock.results[0]?.value,
          "auth reader awaiting exit cleanup",
        );
        const close = vi.spyOn(reader, "close").mockImplementationOnce(() => {
          throw new Error("native unscoped close failed");
        });
        try {
          expect(() => closeAuthProfileReadPool()).toThrow("native unscoped close failed");
          expect(reader.isOpen).toBe(true);
          const exitClosers = process
            .listeners("exit")
            .filter((listener) => !listeners.includes(listener));
          expect(exitClosers).toHaveLength(1);
          expectDefined(exitClosers[0], "auth reader exit cleanup listener")(0);
          expect(reader.isOpen).toBe(false);
          expect(process.listeners("exit")).toEqual(listeners);
        } finally {
          close.mockRestore();
        }
      } finally {
        closeAuthProfileReadPool();
        open.mockRestore();
      }
    });
  });

  it("retains scoped readers for a retry when native close fails", async () => {
    await withAgentDirEnv("openclaw-auth-reader-close-", (agentDir) => {
      const siblingAgentDir = `${agentDir}-sibling`;
      saveAuthProfileStore(apiKeyStore("qa-synthetic"), agentDir);
      saveAuthProfileStore(apiKeyStore("qa-sibling"), siblingAgentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      let reader: DatabaseSync | undefined;
      try {
        expect(loadPersistedAuthProfileStore(agentDir)).not.toBeNull();
        reader = openSpy.mock.results[0]?.value as DatabaseSync;
        expect(loadPersistedAuthProfileStore(siblingAgentDir)).not.toBeNull();
        const siblingReader = openSpy.mock.results[1]?.value as DatabaseSync;
        const close = vi.spyOn(reader, "close").mockImplementationOnce(() => {
          throw new Error("native close failed");
        });
        try {
          expect(() => closeAuthProfileReadPool({ kind: "root", rootPath: agentDir })).toThrow(
            "native close failed",
          );
          expect(reader.isOpen).toBe(true);
          closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
          expect(reader.isOpen).toBe(false);
          expect(siblingReader.isOpen).toBe(true);
          expect(loadPersistedAuthProfileStore(siblingAgentDir)).toMatchObject(
            apiKeyStore("qa-sibling"),
          );
        } finally {
          close.mockRestore();
        }
      } finally {
        openSpy.mockRestore();
        if (reader?.isOpen) {
          reader.close();
        }
      }
    });
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
