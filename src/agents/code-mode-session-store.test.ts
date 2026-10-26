import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  bindCodeModeSessionStore,
  createCodeModeSessionStoreAccess,
} from "./code-mode-session-store.js";
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
