import fs from "node:fs";
import path from "node:path";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAuditEntry,
  decryptAuditText,
  verifyChain,
  verifyChainSegment,
  type AuditEntry,
} from "../protocol/audit.js";
import type { ReefAuditAppendEvent, ReefAuditOperations } from "./audit-state-operation.js";
import {
  getReefAuditOperationState,
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
} from "./state.test-support.js";

const eventTypes = (entries: readonly AuditEntry[]) => entries.map((entry) => entry.event.type);

async function expectAuditOperationError(result: Promise<unknown>, message: string) {
  await expect(result).rejects.toBeInstanceOf(Error);
  await expect(result).rejects.toMatchObject({
    name: "PluginStateStoreError",
    code: "PLUGIN_STATE_WRITE_FAILED",
    operation: "register",
    cause: { name: "Error", message },
  });
}

describe("Reef SQLite audit state", () => {
  let stateDir = "";
  let runtime: ReturnType<typeof createRuntime>;
  const key = new Uint8Array(32).fill(1);
  const open = (maxEntries = 2, signal?: AbortSignal) =>
    openReefAuditStore(runtime, key, maxEntries, signal);
  const appendGroup = (audit: ReturnType<typeof open>, events: ReefAuditAppendEvent[]) => {
    const state = getReefAuditOperationState(audit)!;
    return state.head.createOperation!<ReefAuditOperations>(
      [state.head, state.migration, state.entries],
      { moduleName: "audit-state-operation-api.js", exportName: "executeReefAuditOperation" },
    ).execute(
      {
        type: "append",
        input: { head: 0, migration: 1, entries: 2, auditKey: key, maxEntries: 2, events },
      },
      { writeStores: [0, 2] },
    );
  };
  const heads = () =>
    runtime.state.openSyncKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
  beforeEach(() => {
    stateDir = createStateTestDirectory();
    runtime = createRuntime(stateDir);
  });
  afterEach(() => cleanupStateTestDirectory(stateDir));

  it("serializes a competing append before linking its successor", async () => {
    const initial = open();
    await initial.appendEvent("initial", { id: 1 }, 10);
    const competing = open();
    beforeNextStateOperation(runtime, () =>
      competing.appendEvent("winner", { id: 2 }, 11).then(() => {}),
    );
    await open().appendEvent("contender", { id: 3 }, 12);
    const retained = await initial.entries();
    expect(eventTypes(retained)).toEqual(["winner", "contender"]);
    expect(retained[1]!.prevHash).toBe(retained[0]!.entryHash);
  });

  it("commits an ordered event group with encryption and the retained suffix", async () => {
    const audit = open();
    await audit.appendEvent("before", {}, 9);
    const result = await appendGroup(audit, [
      { type: "proposal", payload: { text: "private text" }, ts: 10 },
      { type: "verdict", payload: { reason: "private reason" }, ts: 11 },
      { type: "envelope", payload: { id: 3 }, ts: 12 },
    ]);
    expect(result.value.map((entry) => entry.event.seq)).toEqual([2, 3, 4]);
    expect(decryptAuditText(result.value[0]!, key).event.payload).toEqual({ text: "private text" });
    expect(JSON.stringify(result.value)).not.toContain("private");
    const retained = await audit.entries();
    expect(eventTypes(retained)).toEqual(["verdict", "envelope"]);
    expect(retained).toEqual(result.value.slice(1));
    expect(
      verifyChainSegment(retained, {
        previousHash: result.value[0]!.entryHash,
        previousSeq: 2,
        head: result.value[2]!.entryHash,
      }),
    ).toBe(true);
  });

  it("refuses an invalid event group without publishing a partial chain", async () => {
    const audit = open();
    const initial = await audit.appendEvent("before", {}, 9);
    await expectAuditOperationError(
      appendGroup(audit, [
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
    const raw = runtime.state.openSyncKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: 3,
      overflowPolicy: "reject-new",
    });
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

  it.each([1, 2])("retains a verifiable audit suffix with capacity %s", async (maxEntries) => {
    const store = open(maxEntries);
    await store.appendEvent("one", { id: 1 }, 10);
    await store.appendEvent("two", { id: 2 }, 11);
    await store.appendEvent("three", { id: 3 }, 12);
    const retained = await store.entries();
    expect(retained.map((entry) => entry.event.seq)).toEqual(maxEntries === 1 ? [3] : [2, 3]);
    expect(
      verifyChainSegment(retained, {
        previousHash: retained[0]!.prevHash,
        previousSeq: retained[0]!.event.seq - 1,
        head: retained.at(-1)!.entryHash,
      }),
    ).toBe(true);
  });

  it("keeps a committed audit append when its worker acknowledgement is lost", async () => {
    const initial = open();
    await initial.appendEvent("one", { id: 1 }, 10);
    await initial.appendEvent("two", { id: 2 }, 11);
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
    const migration = runtime.state.openKeyedStoreV2<{ pending: true }>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
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

  it("observes foreign appends on a new read of the retained suffix", async () => {
    const current = open(1);
    const reader = open(1);
    await current.appendEvent("old", {}, 10);
    expect(eventTypes(await reader.entries())).toEqual(["old"]);
    await current.appendEvent("new", {}, 11);
    expect(eventTypes(await reader.entries())).toEqual(["new"]);
  });

  it("retains its captured audit source when routing changes before execution", async () => {
    await open(1).appendEvent("original", {}, 10);
    const replacementDir = path.join(stateDir, "replacement");
    await openReefAuditStore(createRuntime(replacementDir), key, 1).appendEvent(
      "replacement",
      {},
      11,
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    runtime.state.openKeyedStoreV2 = <T>(options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreV2ForTests<T>("reef", { ...options, env }, { assertCurrent() {} });
    beforeNextStateOperation(runtime, () => {
      env.OPENCLAW_STATE_DIR = replacementDir;
    });
    expect(eventTypes(await open(1).entries())).toEqual(["original"]);
  });
});
