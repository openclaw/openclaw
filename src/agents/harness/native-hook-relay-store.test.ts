import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "../../infra/state-database-coordinator.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import {
  deleteNativeHookRelayBridgeRecordIfOwned,
  pruneNativeHookRelayBridgeRecords,
  readNativeHookRelayBridgeRecord,
  renewOrRestoreNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
  writeNativeHookRelayBridgeRecord,
} from "./native-hook-relay-store.js";

let testRoot = "";
let primaryStateDbPath = "";
let secondaryStateDbPath = "";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

beforeEach(() => {
  testRoot = tempDirs.make("openclaw-native-hook-relay-store-");
  primaryStateDbPath = path.join(testRoot, "primary.sqlite");
  secondaryStateDbPath = path.join(testRoot, "secondary.sqlite");
});

function bridgeRecord(
  relayId: string,
  overrides: Partial<NativeHookRelayBridgeRecord> = {},
): NativeHookRelayBridgeRecord {
  return {
    relayId,
    pid: 100,
    hostname: "127.0.0.1",
    port: 18_789,
    token: "test-token-placeholder",
    expiresAtMs: 20_000,
    ...overrides,
  };
}

describe("native hook relay store", () => {
  it("persists bridge records off thread while retaining host coordinator SQL", async () => {
    type ObservedSql = { databasePath: string | null; sql: string };
    const observed: ObservedSql[] = [];
    const prepared = new WeakMap<object, ObservedSql>();
    // oxlint-disable-next-line typescript/unbound-method -- The observation wrapper forwards its database receiver with .call.
    const prepare = DatabaseSync.prototype.prepare;
    // oxlint-disable-next-line typescript/unbound-method -- The observation wrapper forwards its database receiver with .call.
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
      function (this: DatabaseSync, sql) {
        const observation = { databasePath: this.location(), sql };
        observed.push(observation);
        const statement = prepare.call(this, sql);
        prepared.set(statement, observation);
        return statement;
      },
    );
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      observed.push({ databasePath: this.location(), sql });
      return exec.call(this, sql);
    });
    const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    );
    expect(
      await readNativeHookRelayBridgeRecord({ relayId: "absent", stateDbPath: primaryStateDbPath }),
    ).toBeUndefined();
    expect(fs.existsSync(primaryStateDbPath)).toBe(false);
    const first = bridgeRecord("relay-upsert");
    const replacement = bridgeRecord("relay-upsert", {
      pid: 101,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });

    await writeNativeHookRelayBridgeRecord({
      record: first,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: first.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(first);

    await writeNativeHookRelayBridgeRecord({
      record: replacement,
      updatedAtMs: 2_000,
      stateDbPath: primaryStateDbPath,
    });
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);

    expect(
      await renewOrRestoreNativeHookRelayBridgeRecord({
        record: { ...replacement, expiresAtMs: 40_000 },
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      await deleteNativeHookRelayBridgeRecordIfOwned({
        ...replacement,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      await renewOrRestoreNativeHookRelayBridgeRecord({
        record: replacement,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      await pruneNativeHookRelayBridgeRecords({
        currentPid: replacement.pid,
        isPidDead: () => {
          throw new Error("Expired rows do not need a PID probe");
        },
        nowMs: 30_001,
        stateDbPath: primaryStateDbPath,
      }),
    ).toEqual([{ relayId: replacement.relayId, pid: replacement.pid, reason: "expired" }]);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
    for (const counter of statements) {
      for (const receiver of counter.mock.contexts) {
        const observation = receiver instanceof StatementSync ? prepared.get(receiver) : undefined;
        if (!observation) {
          throw new Error("Unattributed caller-thread SQLite statement");
        }
        observed.push(observation);
      }
    }
    const coordinatorPath = fs.realpathSync(
      resolveStateDatabaseCoordinatorPath({
        databasePath: primaryStateDbPath,
        runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
        uid: process.getuid?.(),
      }),
    );
    const probes = new Set([
      "SELECT sqlite_version() AS version",
      "SELECT sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted",
    ]);
    const control = new Set([
      "PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;",
      "ROLLBACK",
    ]);
    expect(observed.some(({ databasePath }) => databasePath !== null)).toBe(true);
    for (const { databasePath, sql } of observed) {
      if (databasePath === null) {
        expect(probes.has(sql), sql).toBe(true);
      } else {
        expect(fs.realpathSync(databasePath)).toBe(coordinatorPath);
        expect(control.has(sql), sql).toBe(true);
      }
    }
  });

  it("requires matching token and pid to renew or delete a bridge", async () => {
    const record = bridgeRecord("relay-owned");
    await writeNativeHookRelayBridgeRecord({
      record,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(
      await renewOrRestoreNativeHookRelayBridgeRecord({
        record: { ...record, pid: record.pid + 1, expiresAtMs: 30_000 },
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      await renewOrRestoreNativeHookRelayBridgeRecord({
        record: { ...record, token: "decoy-token", expiresAtMs: 30_000 },
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      await renewOrRestoreNativeHookRelayBridgeRecord({
        record: { ...record, expiresAtMs: 30_000 },
        updatedAtMs: 2_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual({ ...record, expiresAtMs: 30_000 });

    expect(
      await deleteNativeHookRelayBridgeRecordIfOwned({
        ...record,
        pid: record.pid + 1,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      await deleteNativeHookRelayBridgeRecordIfOwned({
        ...record,
        token: "decoy-token",
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      await deleteNativeHookRelayBridgeRecordIfOwned({
        ...record,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
  });

  it("restores a missing record without overwriting another owner", async () => {
    const record = bridgeRecord("relay-restored");
    expect(
      await renewOrRestoreNativeHookRelayBridgeRecord({
        record,
        updatedAtMs: 1_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(record);

    const otherOwner = bridgeRecord(record.relayId, {
      pid: record.pid + 1,
      token: "test-auth-token",
    });
    await writeNativeHookRelayBridgeRecord({
      record: otherOwner,
      updatedAtMs: 2_000,
      stateDbPath: primaryStateDbPath,
    });
    expect(
      await renewOrRestoreNativeHookRelayBridgeRecord({
        record,
        updatedAtMs: 3_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(otherOwner);
  });

  it("does not let an old owner delete its replacement", async () => {
    const oldOwner = bridgeRecord("relay-replaced", {
      pid: 100,
      token: "secret-token",
    });
    const replacement = bridgeRecord("relay-replaced", {
      pid: 101,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });
    await writeNativeHookRelayBridgeRecord({
      record: oldOwner,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });
    await writeNativeHookRelayBridgeRecord({
      record: replacement,
      updatedAtMs: 2_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(
      await deleteNativeHookRelayBridgeRecordIfOwned({
        ...oldOwner,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("prunes expired and dead bridges while preserving live and unknown pids", async () => {
    const expired = bridgeRecord("relay-expired", { pid: 200, expiresAtMs: 9_999 });
    const dead = bridgeRecord("relay-dead", { pid: 201 });
    const live = bridgeRecord("relay-live", { pid: 202 });
    const unknown = bridgeRecord("relay-unknown", { pid: 203 });
    for (const [index, record] of [expired, dead, live, unknown].entries()) {
      await writeNativeHookRelayBridgeRecord({
        record,
        updatedAtMs: 1_000 + index,
        stateDbPath: primaryStateDbPath,
      });
    }
    const isPidDead = vi.fn((pid: number) => pid === dead.pid);

    const pruned = await pruneNativeHookRelayBridgeRecords({
      currentPid: 100,
      isPidDead,
      nowMs: 10_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(pruned).toHaveLength(2);
    expect(pruned).toEqual(
      expect.arrayContaining([
        { relayId: expired.relayId, pid: expired.pid, reason: "expired" },
        { relayId: dead.relayId, pid: dead.pid, reason: "dead-pid" },
      ]),
    );
    expect(new Set(isPidDead.mock.calls.map(([pid]) => pid))).toStrictEqual(
      new Set([dead.pid, live.pid, unknown.pid]),
    );
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: expired.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: dead.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: live.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(live);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: unknown.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(unknown);
  });

  it("preserves a replacement published during dead-pid planning", async () => {
    const stale = bridgeRecord("relay-prune-race", {
      pid: 201,
      token: "secret-token",
    });
    const replacement = bridgeRecord("relay-prune-race", {
      pid: 202,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });
    await writeNativeHookRelayBridgeRecord({
      record: stale,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });

    const pruned = await pruneNativeHookRelayBridgeRecords({
      currentPid: 100,
      isPidDead: async (pid) => {
        expect(pid).toBe(stale.pid);
        await writeNativeHookRelayBridgeRecord({
          record: replacement,
          updatedAtMs: 2_000,
          stateDbPath: primaryStateDbPath,
        });
        return true;
      },
      nowMs: 10_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(pruned).toStrictEqual([]);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("isolates records by the exact state database path", async () => {
    const primary = bridgeRecord("relay-isolated", {
      pid: 100,
      token: "config-token",
    });
    const secondary = bridgeRecord("relay-isolated", {
      pid: 200,
      port: 18_790,
      token: "gateway-token",
    });
    await writeNativeHookRelayBridgeRecord({
      record: primary,
      stateDbPath: primaryStateDbPath,
    });
    await writeNativeHookRelayBridgeRecord({
      record: secondary,
      stateDbPath: secondaryStateDbPath,
    });

    expect(fs.existsSync(primaryStateDbPath)).toBe(true);
    expect(fs.existsSync(secondaryStateDbPath)).toBe(true);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: primary.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(primary);
    expect(
      await readNativeHookRelayBridgeRecord({
        relayId: secondary.relayId,
        stateDbPath: secondaryStateDbPath,
      }),
    ).toStrictEqual(secondary);
  });
});
