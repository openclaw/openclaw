import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  bindCodeModeSessionStore,
  createCodeModeSessionStoreAccess,
} from "./code-mode-session-store.js";
import { SessionManager } from "./sessions/session-manager.js";
import { clearToolSearchCatalog, restrictToolSearchCatalog } from "./tool-search-catalog.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";

const owners: ToolSearchCatalogRef[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) {
    clearToolSearchCatalog({ catalogRef: owner });
  }
  vi.restoreAllMocks();
});

function run(manager: SessionManager) {
  const catalogRef: ToolSearchCatalogRef = {
    current: {
      entries: [],
      counterScope: "store-test",
      searchCount: 0,
      describeCount: 0,
      callCount: 0,
    },
  };
  owners.push(catalogRef);
  const runId = `run-${owners.length}`;
  bindCodeModeSessionStore(catalogRef, manager);
  return {
    catalogRef,
    cell: () =>
      createCodeModeSessionStoreAccess(
        { catalogRef, sessionId: manager.getSessionId(), runId },
        new AbortController().signal,
      ),
    close: () => clearToolSearchCatalog({ catalogRef }),
  };
}

describe("Code Mode session store", () => {
  it("appends one hidden entry per cell and replays writes, deletes, and provenance in the next run", async () => {
    const manager = SessionManager.inMemory();
    const first = run(manager);
    const cell = first.cell();
    await cell.save("report", { title: "remote" }, true);
    await cell.save("draft", 1, false);
    await cell.save("draft", undefined, false);
    await cell.commit();
    expect(manager.getEntries()).toEqual([
      expect.objectContaining({
        type: "custom",
        customType: "openclaw.code-mode-store",
        data: {
          set: { report: { title: "remote" } },
          delete: ["draft"],
          networkContent: { report: true },
        },
      }),
    ]);
    expect(manager.buildSessionContext().messages).toEqual([]);
    first.close();
    const second = run(manager);
    await expect(second.cell().load("report")).resolves.toEqual({
      value: { title: "remote" },
      networkContent: true,
    });
    await expect(second.cell().load("draft")).resolves.toEqual({ networkContent: false });
  });

  it("replays only the selected branch, preserves earlier values through compaction, and forks that path", async () => {
    const manager = SessionManager.inMemory();
    const rootRun = run(manager);
    const rootCell = rootRun.cell();
    await rootCell.save("inherited", "root", false);
    await rootCell.commit();
    const root = manager.getLeafId()!;
    rootRun.close();

    const branchA = run(manager);
    const cellA = branchA.cell();
    await cellA.save("branch", "A", false);
    await cellA.commit();
    const leafA = manager.getLeafId()!;
    branchA.close();

    await manager.branchAsync(root);
    const branchB = run(manager);
    await expect(branchB.cell().load("branch")).resolves.toEqual({ networkContent: false });
    const cellB = branchB.cell();
    await cellB.save("branch", "B", false);
    await cellB.commit();
    branchB.close();
    const kept = await manager.appendMessageAsync({
      role: "user",
      content: "Keep this turn",
      timestamp: 1,
    });
    await manager.appendCompactionAsync("Earlier conversation summarized", kept!, 100);

    const compacted = run(manager);
    await expect(compacted.cell().load("inherited")).resolves.toMatchObject({ value: "root" });
    await expect(compacted.cell().load("branch")).resolves.toMatchObject({ value: "B" });
    compacted.close();
    await manager.createBranchedSession(leafA);
    const fork = run(manager);
    await expect(fork.cell().load("inherited")).resolves.toMatchObject({ value: "root" });
    await expect(fork.cell().load("branch")).resolves.toMatchObject({ value: "A" });
  });

  it("keeps the projection unchanged after failed persistence and admits a later cell", async () => {
    const manager = SessionManager.inMemory();
    const owner = run(manager);
    const seed = owner.cell();
    await seed.save("key", "original", false);
    await seed.commit();
    const failed = owner.cell();
    await failed.save("key", "lost", true);
    vi.spyOn(manager, "appendCustomEntryAsync").mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
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
    const manager = SessionManager.inMemory();
    const owner = run(manager);
    const value = "x".repeat(256 * 1024 - 2);
    const seed = owner.cell();
    for (const key of ["a", "b", "c"]) {
      await seed.save(key, value, false);
    }
    await seed.commit();
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
    const manager = SessionManager.inMemory();
    const owner = run(manager);
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
    const manager = SessionManager.inMemory();
    const owner = run(manager);
    const seed = owner.cell();
    await seed.save("retained", true, false);
    await seed.commit();
    const old = owner.cell();
    await old.save("discarded", true, false);
    owner.catalogRef.current!.entries.push({
      id: "fixture",
      name: "fixture",
      source: "openclaw",
      description: "Fixture tool",
      tool: {
        name: "fixture",
        label: "Fixture",
        description: "Fixture tool",
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: {} }),
      },
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
});
