import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { withPreparedTranscriptCorrection } from "../config/sessions/session-transcript-correction.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import * as codeModeJson from "./code-mode-json.js";
import {
  bindCodeModeSessionStore,
  createCodeModeSessionStoreAccess,
} from "./code-mode-session-store.js";
import { withSessionState } from "./sessions/session-manager-fixtures.test-support.js";
import { withSelectedTranscriptReader } from "./sessions/session-manager-reader.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { fakeTool } from "./test-helpers/fake-tool.js";
import { clearToolSearchCatalog, restrictToolSearchCatalog } from "./tool-search-catalog.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";

const owners: ToolSearchCatalogRef[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) {
    clearToolSearchCatalog({ catalogRef: owner });
  }
  vi.restoreAllMocks();
});

function run(manager = SessionManager.inMemory()) {
  const catalogRef: ToolSearchCatalogRef = {
    current: { entries: [], counterScope: "store", searchCount: 0, describeCount: 0, callCount: 0 },
  };
  owners.push(catalogRef);
  const runId = `run-${owners.length}`;
  const ctx = { catalogRef, sessionId: manager.getSessionId(), runId };
  bindCodeModeSessionStore(catalogRef, manager);
  return {
    manager,
    catalogRef,
    cell: () => createCodeModeSessionStoreAccess(ctx, new AbortController().signal),
    close: () => clearToolSearchCatalog({ catalogRef }),
  };
}

async function saveCell(owner: Pick<ReturnType<typeof run>, "cell">, key: string, value: unknown) {
  const cell = owner.cell();
  await cell.save(key, value, false);
  await cell.commit();
}

async function loadDurableStore(scope: Parameters<typeof withSelectedTranscriptReader>[0]) {
  return withSelectedTranscriptReader(
    scope,
    async () => {
      const owner = run(await SessionManager.openAsync(scope));
      try {
        return await owner.cell().load("key");
      } finally {
        owner.close();
      }
    },
    true,
  );
}

it("reuses committed encodings across admitted turns while isolating loads and branch changes", () =>
  withSessionState("store-replay-turns", async ({ scope }) => {
    const admitted = <T>(operation: () => Promise<T>) =>
      withSelectedTranscriptReader(scope, operation, true);
    const originalLeaf = await admitted(async () => {
      const source = await SessionManager.openAsync(scope);
      const seed = run(source);
      await saveCell(seed, "key", { z: "🦞\n", a: [1, null] });
      seed.close();
      return source.getLeafId()!;
    });

    const stringify = vi.spyOn(codeModeJson, "stringifyCodeModeJsonSafe");
    const first = await loadDurableStore(scope);
    expect(stringify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first.value)).toBe('{"z":"🦞\\n","a":[1,null]}');
    assert(isRecord(first.value));
    first.value.z = "caller mutation";

    await admitted(async () => {
      const source = await SessionManager.openAsync(scope);
      await source.appendMessageAsync(makeUserMessage("Another turn", 1));
    });
    stringify.mockClear();
    const second = await loadDurableStore(scope);
    expect(stringify).not.toHaveBeenCalled();
    expect(second).toEqual({ value: { z: "🦞\n", a: [1, null] }, networkContent: false });
    expect(second.value).not.toBe(first.value);

    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
    stringify.mockClear();
    await expect(loadDurableStore(scope)).resolves.toEqual(second);
    expect(stringify).toHaveBeenCalledTimes(1);

    await admitted(async () => {
      const changed = run(await SessionManager.openAsync(scope));
      await saveCell(changed, "key", "appended value");
      changed.close();
    });
    await expect(loadDurableStore(scope)).resolves.toEqual({
      value: "appended value",
      networkContent: false,
    });
    await admitted(async () => {
      const source = await SessionManager.openAsync(scope);
      await source.branchAsync(originalLeaf);
      const branch = run(source);
      try {
        await expect(branch.cell().load("key")).resolves.toEqual({
          value: { z: "🦞\n", a: [1, null] },
          networkContent: false,
        });
      } finally {
        branch.close();
      }
    });
  }));

it("invalidates cached encodings when a transcript rewrite preserves custom entry IDs", () =>
  withSessionState("store-replay-rewrite", async ({ scope }) => {
    const admitted = <T>(operation: () => Promise<T>) =>
      withSelectedTranscriptReader(scope, operation, true);
    const entryId = await admitted(async () => {
      const source = await SessionManager.openAsync(scope);
      const seed = run(source);
      await saveCell(seed, "key", { before: 1, after: 2 });
      seed.close();
      return source.getLeafId();
    });
    await expect(loadDurableStore(scope)).resolves.toEqual({
      value: { before: 1, after: 2 },
      networkContent: false,
    });

    await admitted(() =>
      withPreparedTranscriptCorrection(scope, async (correction) => {
        const entries = await correction.readEvents();
        const index = entries.findIndex((entry) => isRecord(entry) && entry.id === entryId);
        const original = entries[index];
        assert(isRecord(original));
        const replacement = entries.slice();
        replacement[index] = {
          ...original,
          data: {
            set: { key: { after: 2, before: 1 } },
            delete: [],
            networkContent: { key: true },
          },
        };
        await correction.replaceEvents(replacement);
      }),
    );
    const loaded = await loadDurableStore(scope);
    expect(JSON.stringify(loaded.value)).toBe('{"after":2,"before":1}');
    expect(loaded.networkContent).toBe(true);
  }));

it("keeps the projection unchanged after failed persistence and admits a later cell", async () => {
  const { manager, ...owner } = run();
  await saveCell(owner, "key", "original");
  const failed = owner.cell();
  await failed.save("key", "lost", true);
  vi.spyOn(manager, "appendCustomEntryAsync").mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(failed.commit()).rejects.toThrow("disk unavailable");
  const next = owner.cell();
  await expect(next.load("key")).resolves.toEqual({ value: "original", networkContent: false });
  await next.save("key", "recovered", false);
  await next.commit();
  owner.close();
  await expect(run(manager).cell().load("key")).resolves.toMatchObject({ value: "recovered" });
  expect(manager.getEntries()).toHaveLength(2);
});

it("rechecks total capacity in commit order when cells buffered against the same projection", async () => {
  const { manager, ...owner } = run();
  const value = "x".repeat(256 * 1024 - 2);
  const seed = owner.cell();
  for (const key of ["a", "b", "c"]) {
    await seed.save(key, value, false);
  }
  await seed.commit();
  expect(manager.buildSessionContext().messages).toEqual([]);
  const first = owner.cell();
  const second = owner.cell();
  await first.save("d", value, false);
  await second.save("e", value, false);
  const commits = await Promise.allSettled([first.commit(), second.commit()]);
  expect(commits[0]?.status).toBe("fulfilled");
  expect(commits[1]).toMatchObject({ status: "rejected", reason: expect.any(RangeError) });
  owner.close();
  const reloaded = run(manager).cell();
  await expect(reloaded.load("d")).resolves.toMatchObject({ value });
  await expect(reloaded.load("e")).resolves.toEqual({ networkContent: false });
  expect(manager.getEntries()).toHaveLength(2);
});

it("discards a completed cell's buffer when ownership closes before queued write admission", async () => {
  const { manager, ...owner } = run();
  const entered = createDeferred();
  const release = createDeferred();
  bindCodeModeSessionStore(owner.catalogRef, manager, async (operation) => {
    entered.resolve();
    await release.promise;
    return operation();
  });
  const cell = owner.cell();
  await cell.save("never-committed", true, false);
  const pending = cell.commit();
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "commit missed write admission");
    cell.close();
  } finally {
    release.resolve();
  }
  await expect(pending).rejects.toThrow("after the cell closed");
  expect(manager.getEntries()).toEqual([]);
  await expect(owner.cell().load("never-committed")).resolves.toEqual({ networkContent: false });
});

it("retires old accesses on catalog restriction while keeping the session available to new cells", async () => {
  const owner = run();
  await saveCell(owner, "retained", true);
  const old = owner.cell();
  await old.save("discarded", true, false);
  owner.catalogRef.current!.entries.push({
    id: "fixture",
    name: "fixture",
    source: "openclaw",
    description: "Fixture tool",
    tool: fakeTool("fixture", "Fixture tool"),
  });
  restrictToolSearchCatalog({ catalogRef: owner.catalogRef, allowedToolNames: new Set() });
  await expect(old.load("retained")).rejects.toThrow("active session-bound run");
  await expect(old.commit()).rejects.toThrow("active session-bound run");
  const next = owner.cell();
  await expect(next.load("retained")).resolves.toMatchObject({ value: true });
  await expect(next.load("discarded")).resolves.toEqual({ networkContent: false });
  await next.save("new", true, false);
  await next.commit();
  owner.close();
  await expect(owner.cell().load("new")).rejects.toThrow("active session-bound run");
});

it("replays overwrite history without rescanning every retained value per entry", async () => {
  const manager = SessionManager.inMemory();
  for (let index = 0; index < 100; index++) {
    const key = `key-${index % 20}`;
    await manager.appendCustomEntryAsync("openclaw.code-mode-store", {
      set: { [key]: { index } },
      delete: [],
      networkContent: { [key]: index % 2 === 0 },
    });
  }
  const owner = run(manager);
  const scan = vi.spyOn(Map.prototype, "values");
  const loaded = await owner.cell().load("key-19");
  const scannedValues = scan.mock.contexts.reduce<number>(
    (total, map) => total + (map instanceof Map ? map.size : 0),
    0,
  );
  scan.mockRestore();
  expect(loaded).toEqual({ value: { index: 99 }, networkContent: false });
  expect(scannedValues).toBeLessThanOrEqual(100);
});

it.each(["value", "total"] as const)(
  "rejects historical %s overflow even when a later entry deletes it",
  async (kind) => {
    const manager = SessionManager.inMemory();
    const set =
      kind === "value"
        ? { a: "x".repeat(256 * 1024) }
        : Object.fromEntries(
            ["a", "b", "c", "d", "e"].map((key) => [key, "x".repeat(256 * 1024 - 2)]),
          );
    await manager.appendCustomEntryAsync("openclaw.code-mode-store", {
      set,
      delete: [],
      networkContent: Object.fromEntries(Object.keys(set).map((key) => [key, false])),
    });
    await manager.appendCustomEntryAsync("openclaw.code-mode-store", {
      set: {},
      delete: Object.keys(set),
      networkContent: {},
    });
    await expect(run(manager).cell().load("a")).rejects.toMatchObject({
      message: "Code Mode session store replay failed; repair the session before using store/load.",
      cause: expect.any(RangeError),
    });
  },
);

it("checks total replay capacity after the whole entry, including deletions", async () => {
  const manager = SessionManager.inMemory();
  const value = "x".repeat(256 * 1024 - 2);
  await manager.appendCustomEntryAsync("openclaw.code-mode-store", {
    set: { a: value, b: value, c: value, d: value },
    delete: [],
    networkContent: { a: false, b: false, c: false, d: false },
  });
  await manager.appendCustomEntryAsync("openclaw.code-mode-store", {
    set: { e: value, a: value },
    delete: ["a", "a", "missing"],
    networkContent: { e: true, a: false },
  });
  const cell = run(manager).cell();
  await expect(cell.load("e")).resolves.toEqual({ value, networkContent: true });
  await expect(cell.load("a")).resolves.toEqual({ networkContent: false });
});
