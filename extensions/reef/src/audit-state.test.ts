import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import timers from "node:timers/promises";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateOperation,
  PluginStateOperationDefinitions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuditEntry,
  decryptAuditText,
  verifyChain,
  verifyChainSegment,
} from "../protocol/audit.js";
import type { ReefAuditOperations } from "./audit-state-operation.js";
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
  cleanupStateTestDirectory,
  createRuntime,
  createStateTestDirectory,
} from "./state.test-support.js";

function interceptAuditOperation(
  runtime: ReturnType<typeof createRuntime>,
  transform: <Operations extends PluginStateOperationDefinitions>(
    operation: PluginStateOperation<Operations>,
  ) => PluginStateOperation<Operations>,
) {
  const open = runtime.state.openKeyedStore;
  return vi
    .spyOn(runtime.state, "openKeyedStore")
    .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(options);
      if (options.namespace === REEF_AUDIT_HEAD_NAMESPACE && store.createOperation) {
        const createOperation = store.createOperation;
        store.createOperation = (stores, handler, authority) =>
          transform(createOperation(stores, handler, authority));
      }
      return store;
    });
}

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

  beforeEach(() => {
    stateDir = createStateTestDirectory();
  });

  afterEach(async () => {
    await cleanupStateTestDirectory(stateDir);
  });

  it("serializes a competing append before linking its successor", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const initial = openReefAuditStore(runtime, key, 2);
    await initial.appendEvent("initial", { id: 1 }, 10);
    const competing = openReefAuditStore(runtime, key, 2);
    let interleaved = false;
    interceptAuditOperation(runtime, (operation) => ({
      ...operation,
      async execute(command, options) {
        if (!interleaved && command.type === "append") {
          interleaved = true;
          await competing.appendEvent("winner", { id: 2 }, 11);
        }
        return operation.execute(command, options);
      },
    }));
    const contender = openReefAuditStore(runtime, key, 2);
    await contender.appendEvent("contender", { id: 3 }, 12);
    const retained = await initial.entries();
    expect(retained.map((entry) => entry.event.type)).toEqual(["winner", "contender"]);
    expect(retained[1]!.prevHash).toBe(retained[0]!.entryHash);
  });

  it("commits an ordered event group with encryption and the retained suffix", async () => {
    const key = new Uint8Array(32).fill(1);
    const audit = openReefAuditStore(createRuntime(stateDir), key, 2);
    const state = getReefAuditOperationState(audit)!;
    const operation = state.head.createOperation!<ReefAuditOperations>(
      [state.head, state.migration, state.entries],
      {
        moduleName: "audit-state-operation-api.js",
        exportName: "executeReefAuditOperation",
      },
    );
    await audit.appendEvent("before", {}, 9);
    const result = await operation.execute(
      {
        type: "append",
        input: {
          head: 0,
          migration: 1,
          entries: 2,
          auditKey: key,
          maxEntries: 2,
          events: [
            { type: "proposal", payload: { text: "Synthetic private text" }, ts: 10 },
            { type: "verdict", payload: { reason: "Synthetic private reason" }, ts: 11 },
            { type: "envelope", payload: { id: 3 }, ts: 12 },
          ],
        },
      },
      { writeStores: [0, 2] },
    );
    expect(result.value.map((entry) => entry.event.seq)).toEqual([2, 3, 4]);
    expect(decryptAuditText(result.value[0]!, key).event.payload).toEqual({
      text: "Synthetic private text",
    });
    expect(JSON.stringify(result.value)).not.toContain("Synthetic private");
    const retained = await audit.entries();
    expect(retained.map((entry) => entry.event.type)).toEqual(["verdict", "envelope"]);
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
    const key = new Uint8Array(32).fill(1);
    const audit = openReefAuditStore(createRuntime(stateDir), key, 2);
    const initial = await audit.appendEvent("before", {}, 9);
    const state = getReefAuditOperationState(audit)!;
    const operation = state.head.createOperation!<ReefAuditOperations>(
      [state.head, state.migration, state.entries],
      {
        moduleName: "audit-state-operation-api.js",
        exportName: "executeReefAuditOperation",
      },
    );
    await expectAuditOperationError(
      operation.execute(
        {
          type: "append",
          input: {
            head: 0,
            migration: 1,
            entries: 2,
            auditKey: key,
            maxEntries: 2,
            events: [
              { type: "valid", payload: {}, ts: 10 },
              { type: "invalid", payload: {}, ts: -1 },
            ],
          },
        },
        { writeStores: [0, 2] },
      ),
      "invalid audit event",
    );
    expect(await audit.entries()).toEqual([initial]);
  });

  it("refuses a live legacy append lease without stealing or mutating it", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const audit = openReefAuditStore(runtime, key, 2);
    const initial = await audit.appendEvent("before", {}, 9);
    const heads = runtime.state.openSyncKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    const pending: ReefAuditHeadRecord = {
      kind: "head",
      hash: initial.entryHash,
      seq: 1,
      oldestHash: initial.entryHash,
      pending: { owner: "live-legacy-writer", expiresAt: Number.MAX_SAFE_INTEGER },
    };
    heads.register(REEF_AUDIT_HEAD_KEY, pending);
    await expectAuditOperationError(
      audit.appendEvent("refused", {}, 10),
      "Reef audit append is owned by an active legacy writer",
    );
    expect(heads.lookup(REEF_AUDIT_HEAD_KEY)).toEqual(pending);
    expect(await audit.entries()).toEqual([initial]);
  });

  it("preserves legacy staged cleanup on failure and recovers it atomically", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const initial = await openReefAuditStore(runtime, key, 2).appendEvent("initial", { id: 1 }, 10);
    const stale = createAuditEntry("stalled", { id: 2 }, 11, key, {
      hash: initial.entryHash,
      seq: 1,
    });
    const raw = runtime.state.openSyncKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: 3,
      overflowPolicy: "reject-new",
    });
    raw.register(reefAuditEntryKey(initial.entryHash), {
      kind: "entry",
      entry: initial,
      nextHash: stale.entryHash,
    });
    raw.register(reefAuditEntryKey(stale.entryHash), { kind: "entry", entry: stale });
    raw.register("entry:orphan", { kind: "entry", entry: stale });
    const heads = runtime.state.openSyncKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    const legacyHead: ReefAuditHeadRecord = {
      kind: "head",
      hash: initial.entryHash,
      seq: 1,
      oldestHash: initial.entryHash,
      pending: {
        owner: "retired-writer",
        expiresAt: 1,
        entryKey: reefAuditEntryKey(stale.entryHash),
      },
      garbageEntryKey: "entry:orphan",
    };
    heads.register(REEF_AUDIT_HEAD_KEY, legacyHead);
    raw.register(reefAuditEntryKey(initial.entryHash), {
      kind: "entry",
      entry: initial,
      nextHash: "unowned-successor",
    });
    await expectAuditOperationError(
      openReefAuditStore(runtime, key, 2).appendEvent("refused", { id: 3 }, 12),
      "Reef audit head already links a committed successor",
    );
    expect(heads.lookup(REEF_AUDIT_HEAD_KEY)).toEqual(legacyHead);
    expect(raw.lookup(reefAuditEntryKey(stale.entryHash))).toEqual({ kind: "entry", entry: stale });
    expect(raw.lookup("entry:orphan")).toEqual({ kind: "entry", entry: stale });
    raw.register(reefAuditEntryKey(initial.entryHash), {
      kind: "entry",
      entry: initial,
      nextHash: stale.entryHash,
    });
    const recovered = openReefAuditStore(runtime, key, 2);
    await recovered.appendEvent("recovered", { id: 4 }, 13);
    expect((await recovered.entries()).map((entry) => entry.event.type)).toEqual([
      "initial",
      "recovered",
    ]);
    expect(raw.lookup(reefAuditEntryKey(stale.entryHash))).toBeUndefined();
    expect(raw.lookup("entry:orphan")).toBeUndefined();
    expect(heads.lookup(REEF_AUDIT_HEAD_KEY)?.pending).toBeUndefined();
  });

  it("appends and reads audit history on a released host without worker operations", async () => {
    const runtime = createRuntime(stateDir);
    const open = runtime.state.openKeyedStore;
    runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(options);
      delete store.createOperation;
      return store;
    };
    const key = new Uint8Array(32).fill(1);
    const audit = openReefAuditStore(runtime, key, 2);
    await audit.appendEvent("one", {}, 10);
    await audit.appendEvent("two", {}, 11);
    await audit.appendEvent("three", {}, 12);
    const reopened = await openReefAuditStore(runtime, key, 2).entries();
    expect(reopened.map((entry) => entry.event.type)).toEqual(["two", "three"]);
    expect(
      verifyChainSegment(reopened, {
        previousHash: reopened[0]!.prevHash,
        previousSeq: 1,
        head: reopened[1]!.entryHash,
      }),
    ).toBe(true);
    // The retained JSON remains readable when the host gains worker support.
    expect(await openReefAuditStore(createRuntime(stateDir), key, 2).entries()).toEqual(reopened);
  });

  it("rejects revoked legacy audit appends and reads without changing committed history", async () => {
    const runtime = createRuntime(stateDir, "legacy");
    const key = new Uint8Array(32).fill(1);
    const controller = new AbortController();
    const audit = openReefAuditStore(runtime, key, 2, controller.signal);
    await audit.appendEvent("committed", {}, 10);
    const revoked = new Error("legacy audit owner retired");
    controller.abort(revoked);

    await expect(audit.appendEvent("revoked", {}, 11)).rejects.toBe(revoked);
    await expect(audit.entries()).rejects.toBe(revoked);
    expect(
      (await openReefAuditStore(runtime, key, 2).entries()).map((entry) => entry.event.type),
    ).toEqual(["committed"]);
  });

  it("does not claim legacy audit state after authority expires during contention", async () => {
    const runtime = createRuntime(stateDir, "legacy");
    const key = new Uint8Array(32).fill(1);
    const controller = new AbortController();
    const audit = openReefAuditStore(runtime, key, 2, controller.signal);
    const entry = await audit.appendEvent("committed", {}, 10);
    const heads = runtime.state.openSyncKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    const committed: ReefAuditHeadRecord = {
      kind: "head",
      hash: entry.entryHash,
      seq: 1,
      oldestHash: entry.entryHash,
    };
    heads.register(REEF_AUDIT_HEAD_KEY, {
      ...committed,
      pending: { owner: "foreign-writer", expiresAt: Date.now() + 30_000 },
    });
    const revoked = new Error("legacy audit owner retired while waiting");
    const wait = vi.spyOn(timers, "setTimeout").mockImplementationOnce(async () => {
      controller.abort(revoked);
      heads.register(REEF_AUDIT_HEAD_KEY, committed);
    });
    syncBuiltinESMExports();
    try {
      await expect(audit.appendEvent("revoked", {}, 11)).rejects.toBe(revoked);
      expect(heads.lookup(REEF_AUDIT_HEAD_KEY)).toEqual(committed);
    } finally {
      wait.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("settles a claimed legacy audit lease when payload preparation revokes authority", async () => {
    const runtime = createRuntime(stateDir, "legacy");
    const key = new Uint8Array(32).fill(1);
    const controller = new AbortController();
    const audit = openReefAuditStore(runtime, key, 2, controller.signal);
    await audit.appendEvent("committed", {}, 10);
    const revoked = new Error("legacy audit owner retired while preparing");
    const payload = {
      get text() {
        controller.abort(revoked);
        return "Synthetic payload";
      },
    };

    await expect(audit.appendEvent("revoked", payload, 11)).rejects.toBe(revoked);
    const heads = runtime.state.openSyncKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    expect(heads.lookup(REEF_AUDIT_HEAD_KEY)?.pending).toBeUndefined();
    const current = openReefAuditStore(runtime, key, 2);
    await current.appendEvent("recovered", {}, 12);
    expect((await current.entries()).map((entry) => entry.event.type)).toEqual([
      "committed",
      "recovered",
    ]);
  });

  it("preserves invocation order across shared-source handles without native SQL", async () => {
    const key = new Uint8Array(32).fill(1);
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
      expect(reopened.map((entry) => entry.event.type)).toEqual(["one", "two", "three"]);
      expect(verifyChain(reopened)).toBe(true);
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
  });

  it.each([1, 2])("retains a verifiable audit suffix with capacity %s", async (maxEntries) => {
    const store = openReefAuditStore(
      createRuntime(stateDir),
      new Uint8Array(32).fill(1),
      maxEntries,
    );
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
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const initial = openReefAuditStore(runtime, key, 2);
    await initial.appendEvent("one", { id: 1 }, 10);
    await initial.appendEvent("two", { id: 2 }, 11);
    const intercepted = interceptAuditOperation(runtime, (operation) => ({
      ...operation,
      async execute(command, options) {
        await operation.execute(command, options);
        throw new Error("simulated lost acknowledgement");
      },
    }));
    await expect(
      openReefAuditStore(runtime, key, 2).appendEvent("three", { id: 3 }, 12),
    ).rejects.toThrow("simulated lost acknowledgement");
    intercepted.mockRestore();
    const recovered = await initial.entries();
    expect(recovered.map((entry) => entry.event.type)).toEqual(["two", "three"]);
    expect(recovered.map((entry) => entry.event.seq)).toEqual([2, 3]);
  });

  it("refuses audit writes after channel authority is revoked during worker preparation", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const current = openReefAuditStore(runtime, key, 2);
    await current.appendEvent("current", {}, 10);
    const controller = new AbortController();
    interceptAuditOperation(runtime, (operation) => ({
      ...operation,
      async execute(command, options) {
        controller.abort(new Error("Reef owner retired"));
        return operation.execute(command, options);
      },
    }));
    await expect(
      openReefAuditStore(runtime, key, 2, controller.signal).appendEvent("revoked", {}, 11),
    ).rejects.toThrow("Reef owner retired");
    expect((await current.entries()).map((entry) => entry.event.type)).toEqual(["current"]);
  });

  it("rechecks a foreign audit migration marker before committing prepared rows", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const migration = runtime.state.openKeyedStore<{ pending: true }>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    let interleaved = false;
    interceptAuditOperation(runtime, (operation) => ({
      ...operation,
      async execute(command, options) {
        if (!interleaved) {
          interleaved = true;
          await migration.register(REEF_AUDIT_MIGRATION_KEY, { pending: true });
        }
        return operation.execute(command, options);
      },
    }));
    const audit = openReefAuditStore(runtime, key, 2);
    const message =
      "Reef audit migration is incomplete; repair audit.jsonl and rerun openclaw doctor --fix";
    await expectAuditOperationError(audit.appendEvent("refused", {}, 10), message);
    await expectAuditOperationError(audit.entries(), message);
    await migration.delete(REEF_AUDIT_MIGRATION_KEY);
    expect(await audit.entries()).toEqual([]);
  });

  it("reads empty audit history without creating a state database", async () => {
    const store = openReefAuditStore(createRuntime(stateDir), new Uint8Array(32).fill(1));

    await expect(store.entries()).resolves.toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
  });

  it("observes foreign appends on a new read of the retained suffix", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const current = openReefAuditStore(runtime, key, 1);
    const reader = openReefAuditStore(runtime, key, 1);
    await current.appendEvent("old", {}, 10);
    expect((await reader.entries()).map((entry) => entry.event.type)).toEqual(["old"]);
    await current.appendEvent("new", {}, 11);
    expect((await reader.entries()).map((entry) => entry.event.type)).toEqual(["new"]);
  });

  it("retains its captured audit source when routing changes before execution", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const original = openReefAuditStore(runtime, key, 1);
    await original.appendEvent("original", {}, 10);
    const replacementDir = path.join(stateDir, "replacement");
    await openReefAuditStore(createRuntime(replacementDir), key, 1).appendEvent(
      "replacement",
      {},
      11,
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("reef", { ...options, env });
    interceptAuditOperation(runtime, (operation) => ({
      ...operation,
      async execute(command, options) {
        env.OPENCLAW_STATE_DIR = replacementDir;
        return operation.execute(command, options);
      },
    }));
    const reader = openReefAuditStore(runtime, key, 1);

    expect((await reader.entries()).map((entry) => entry.event.type)).toEqual(["original"]);
  });
});
