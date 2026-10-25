import fs from "node:fs";
import path from "node:path";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAuditEntry,
  decryptAuditText,
  verifyChain,
  verifyChainSegment,
  type AuditEntry,
} from "../protocol/audit.js";
import {
  openReefAuditStore,
  reefAuditEntryKey,
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_NAMESPACE,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./audit-state.js";
import {
  beforeNextStateOperation,
  cleanupStateTestDirectory,
  createRuntime,
  createStateTestDirectory,
  expectReefStateOperationError as expectAuditOperationError,
} from "./state.test-support.js";

const eventTypes = (entries: readonly AuditEntry[]) => entries.map((entry) => entry.event.type);
const keyedOptions = (namespace: string, maxEntries = 1) => ({
  namespace,
  maxEntries,
  overflowPolicy: "reject-new" as const,
});

describe("Reef SQLite audit state", () => {
  let stateDir = "";
  let runtime: ReturnType<typeof createRuntime>;
  const key = new Uint8Array(32).fill(1);
  const open = (maxEntries = 2, signal?: AbortSignal) =>
    openReefAuditStore(runtime, key, maxEntries, signal);
  const heads = () =>
    runtime.state.openSyncKeyedStore<ReefAuditHeadRecord>(keyedOptions(REEF_AUDIT_HEAD_NAMESPACE));
  beforeEach(() => {
    stateDir = createStateTestDirectory();
    runtime = createRuntime(stateDir);
  });
  afterEach(() => cleanupStateTestDirectory(stateDir));

  it.each([1, 2])("commits an encrypted event group and retains %s entries", async (capacity) => {
    const audit = open(capacity);
    await audit.appendEvent("before", {}, 9);
    const result = await audit.appendEvents([
      { type: "proposal", payload: { text: "private text" }, ts: 10 },
      { type: "verdict", payload: { reason: "private reason" }, ts: 11 },
      { type: "envelope", payload: { id: 3 }, ts: 12 },
    ]);
    expect(result.map((entry) => entry.event.seq)).toEqual([2, 3, 4]);
    expect(decryptAuditText(result[0]!, key).event.payload).toEqual({ text: "private text" });
    expect(JSON.stringify(result)).not.toContain("private");
    const retained = await audit.entries();
    expect(eventTypes(retained)).toEqual(["verdict", "envelope"].slice(-capacity));
    expect(retained).toEqual(result.slice(-capacity));
    const previous = result.at(-capacity - 1)!;
    expect(
      verifyChainSegment(retained, {
        previousHash: previous.entryHash,
        previousSeq: previous.event.seq,
        head: result[2]!.entryHash,
      }),
    ).toBe(true);
  });

  it("refuses an invalid event group without publishing a partial chain", async () => {
    const audit = open();
    const initial = await audit.appendEvent("before", {}, 9);
    await expectAuditOperationError(
      audit.appendEvents([
        { type: "valid", payload: {}, ts: 10 },
        { type: "invalid", payload: {}, ts: -1 },
      ]),
      "invalid audit event",
    );
    expect(await audit.entries()).toEqual([initial]);
  });

  it("refuses a live legacy append lease without stealing or mutating it", async () => {
    const audit = open();
    const initial = await audit.appendEvent("before", {}, 9);
    const headStore = heads();
    const pending: ReefAuditHeadRecord = {
      ...headStore.lookup(REEF_AUDIT_HEAD_KEY)!,
      pending: { owner: "live-legacy-writer", expiresAt: Number.MAX_SAFE_INTEGER },
    };
    headStore.register(REEF_AUDIT_HEAD_KEY, pending);
    await expectAuditOperationError(
      audit.appendEvent("refused", {}, 10),
      "Reef audit append is owned by an active legacy writer",
    );
    expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).toEqual(pending);
    expect(await audit.entries()).toEqual([initial]);
  });

  it("preserves legacy staged cleanup on failure and recovers it atomically", async () => {
    const initial = await open().appendEvent("initial", { id: 1 }, 10);
    const stale = createAuditEntry("stalled", { id: 2 }, 11, key, {
      hash: initial.entryHash,
      seq: 1,
    });
    const raw = runtime.state.openSyncKeyedStore<ReefAuditStateRecord>(
      keyedOptions(REEF_AUDIT_NAMESPACE, 3),
    );
    const initialKey = reefAuditEntryKey(initial.entryHash);
    const staleKey = reefAuditEntryKey(stale.entryHash);
    const staged = { kind: "entry" as const, entry: stale };
    raw.register(staleKey, staged);
    raw.register("entry:orphan", staged);
    const headStore = heads();
    const legacyHead: ReefAuditHeadRecord = {
      ...headStore.lookup(REEF_AUDIT_HEAD_KEY)!,
      pending: { owner: "retired-writer", expiresAt: 1, entryKey: staleKey },
      garbageEntryKey: "entry:orphan",
    };
    headStore.register(REEF_AUDIT_HEAD_KEY, legacyHead);
    const link = (nextHash: string) =>
      raw.register(initialKey, { kind: "entry", entry: initial, nextHash });
    link("unowned-successor");
    await expectAuditOperationError(
      open().appendEvent("refused", { id: 3 }, 12),
      "Reef audit head already links a committed successor",
    );
    expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).toEqual(legacyHead);
    expect([raw.lookup(staleKey), raw.lookup("entry:orphan")]).toEqual([staged, staged]);
    link(stale.entryHash);
    const recovered = open();
    await recovered.appendEvent("recovered", { id: 4 }, 13);
    expect(eventTypes(await recovered.entries())).toEqual(["initial", "recovered"]);
    expect([raw.lookup(staleKey), raw.lookup("entry:orphan")]).toEqual([undefined, undefined]);
    expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)?.pending).toBeUndefined();
  });

  it("preserves invocation order across shared-source handles without native SQL", async () => {
    const observation = observeHostDataSql();
    try {
      const first = openReefAuditStore(createRuntime(stateDir), key);
      const second = openReefAuditStore(createRuntime(stateDir), key);
      await Promise.all([
        first.appendEvent("one", { id: 1 }, 10),
        first.appendEvent("two", { id: 2 }, 11),
        second.appendEvent("three", { id: 3 }, 12),
      ]);
      const reopened = await openReefAuditStore(createRuntime(stateDir), key).entries();
      expect(eventTypes(reopened)).toEqual(["one", "two", "three"]);
      expect(verifyChain(reopened)).toBe(true);
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
  });

  it("keeps a committed audit append when its worker acknowledgement is lost", async () => {
    const initial = open();
    await initial.appendEvent("one", { id: 1 }, 10);
    await initial.appendEvent("two", { id: 2 }, 11);
    expect(eventTypes(await initial.entries())).toEqual(["one", "two"]);
    beforeNextStateOperation(
      runtime,
      () => {
        throw new Error("simulated lost acknowledgement");
      },
      "after",
    );
    await expect(open().appendEvent("three", { id: 3 }, 12)).rejects.toThrow(
      "simulated lost acknowledgement",
    );
    const recovered = await initial.entries();
    expect(eventTypes(recovered)).toEqual(["two", "three"]);
    expect(recovered.map((entry) => entry.event.seq)).toEqual([2, 3]);
  });

  it("refuses audit writes after channel authority is revoked during worker preparation", async () => {
    const current = open();
    await current.appendEvent("current", {}, 10);
    const controller = new AbortController();
    beforeNextStateOperation(runtime, () => controller.abort(new Error("Reef owner retired")));
    await expect(open(2, controller.signal).appendEvent("revoked", {}, 11)).rejects.toThrow(
      "Reef owner retired",
    );
    expect(eventTypes(await current.entries())).toEqual(["current"]);
  });

  it("rechecks a foreign audit migration marker before committing prepared rows", async () => {
    const migration = runtime.state.openKeyedStoreV2<{ pending: true }>(
      keyedOptions(REEF_AUDIT_MIGRATION_NAMESPACE),
    );
    beforeNextStateOperation(runtime, () =>
      migration.register(REEF_AUDIT_MIGRATION_KEY, { pending: true }),
    );
    const audit = open();
    const message =
      "Reef audit migration is incomplete; repair audit.jsonl and rerun openclaw doctor --fix";
    await expectAuditOperationError(audit.appendEvent("refused", {}, 10), message);
    await expectAuditOperationError(audit.entries(), message);
    await migration.delete(REEF_AUDIT_MIGRATION_KEY);
    expect(await audit.entries()).toEqual([]);
  });

  it("reads empty audit history without creating a state database", async () => {
    const store = open();
    await expect(store.entries()).resolves.toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
  });

  it("retains its captured audit source when routing changes before execution", async () => {
    const env = { OPENCLAW_STATE_DIR: stateDir };
    runtime = createRuntime(env);
    await open(1).appendEvent("original", {}, 10);
    const replacementDir = path.join(stateDir, "replacement");
    await openReefAuditStore(createRuntime(replacementDir), key, 1).appendEvent(
      "replacement",
      {},
      11,
    );
    beforeNextStateOperation(runtime, () => {
      env.OPENCLAW_STATE_DIR = replacementDir;
    });
    expect(eventTypes(await open(1).entries())).toEqual(["original"]);
  });
});
