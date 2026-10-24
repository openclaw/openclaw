import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "../../state/openclaw-state-db-cache.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
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

function read(relayId: string, stateDbPath = primaryStateDbPath) {
  return readNativeHookRelayBridgeRecord({ relayId, stateDbPath });
}
function write(
  record: NativeHookRelayBridgeRecord,
  updatedAtMs?: number,
  stateDbPath = primaryStateDbPath,
) {
  return writeNativeHookRelayBridgeRecord({ record, updatedAtMs, stateDbPath });
}
function renew(record: NativeHookRelayBridgeRecord, updatedAtMs?: number) {
  return renewOrRestoreNativeHookRelayBridgeRecord({
    record,
    updatedAtMs,
    stateDbPath: primaryStateDbPath,
  });
}
function remove(record: NativeHookRelayBridgeRecord) {
  return deleteNativeHookRelayBridgeRecordIfOwned({ ...record, stateDbPath: primaryStateDbPath });
}

describe("native hook relay store", () => {
  it("persists bridge records and closes their worker without caller-thread SQLite", async () => {
    const sql = observeMainThreadSql();
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(await read("absent")).toBeUndefined();
    expect(fs.existsSync(primaryStateDbPath)).toBe(false);
    const first = bridgeRecord("relay-upsert");
    const replacement = bridgeRecord("relay-upsert", {
      pid: 101,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });

    await write(first, 1_000);
    expect(await read(first.relayId)).toStrictEqual(first);

    await write(replacement, 2_000);
    expect(await read(replacement.relayId)).toStrictEqual(replacement);

    expect(await renew({ ...replacement, expiresAtMs: 40_000 })).toBe(true);
    expect(await remove(replacement)).toBe(true);
    expect(await renew(replacement)).toBe(true);
    using _ = vi.spyOn(Date, "now").mockReturnValue(30_001);
    expect(
      await pruneNativeHookRelayBridgeRecords({
        currentPid: replacement.pid,
        isPidDead: () => {
          throw new Error("Expired rows do not need a PID probe");
        },
        stateDbPath: primaryStateDbPath,
      }),
    ).toEqual([{ relayId: replacement.relayId, pid: replacement.pid, reason: "expired" }]);
    expect(await read(replacement.relayId)).toBeUndefined();
    await closeOpenClawStateDatabaseByPathAsync(primaryStateDbPath);
    sql.expectIdle();
    expect(close).not.toHaveBeenCalled();
  });

  it("requires matching token and pid to renew or delete a bridge", async () => {
    const record = bridgeRecord("relay-owned");
    await write(record, 1_000);

    expect(await renew({ ...record, pid: record.pid + 1, expiresAtMs: 30_000 })).toBe(false);
    expect(await renew({ ...record, token: "decoy-token", expiresAtMs: 30_000 })).toBe(false);
    expect(await renew({ ...record, expiresAtMs: 30_000 }, 2_000)).toBe(true);
    expect(await read(record.relayId)).toStrictEqual({ ...record, expiresAtMs: 30_000 });

    expect(await remove({ ...record, pid: record.pid + 1 })).toBe(false);
    expect(await remove({ ...record, token: "decoy-token" })).toBe(false);
    expect(await remove(record)).toBe(true);
    expect(await read(record.relayId)).toBeUndefined();
  });

  it("prunes expired and dead bridges while preserving live and unknown pids", async () => {
    const expired = bridgeRecord("relay-expired", { pid: 200, expiresAtMs: 9_999 });
    const dead = bridgeRecord("relay-dead", { pid: 201 });
    const live = bridgeRecord("relay-live", { pid: 202 });
    const unknown = bridgeRecord("relay-unknown", { pid: 203 });
    for (const [index, record] of [expired, dead, live, unknown].entries()) {
      await write(record, 1_000 + index);
    }
    const isPidDead = vi.fn((pid: number) => pid === dead.pid);

    using _ = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const pruned = await pruneNativeHookRelayBridgeRecords({
      currentPid: 100,
      isPidDead,
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
    expect(await read(expired.relayId)).toBeUndefined();
    expect(await read(dead.relayId)).toBeUndefined();
    expect(await read(live.relayId)).toStrictEqual(live);
    expect(await read(unknown.relayId)).toStrictEqual(unknown);
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
    await write(stale, 1_000);

    using _ = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const pruned = await pruneNativeHookRelayBridgeRecords({
      currentPid: 100,
      isPidDead: async (pid) => {
        expect(pid).toBe(stale.pid);
        await write(replacement, 2_000);
        return true;
      },
      stateDbPath: primaryStateDbPath,
    });

    expect(pruned).toStrictEqual([]);
    expect(await read(replacement.relayId)).toStrictEqual(replacement);
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
    await write(primary);
    await write(secondary, undefined, secondaryStateDbPath);

    expect(fs.existsSync(primaryStateDbPath)).toBe(true);
    expect(fs.existsSync(secondaryStateDbPath)).toBe(true);
    expect(await read(primary.relayId)).toStrictEqual(primary);
    expect(await read(secondary.relayId, secondaryStateDbPath)).toStrictEqual(secondary);
  });
});
