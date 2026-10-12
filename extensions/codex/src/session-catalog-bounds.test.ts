import { createHash } from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { CodexCatalogPersistence, type CodexCatalogState } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { CodexCatalogProjections } from "./session-catalog-projection.js";
import { idleThread } from "./session-catalog.test-helpers.js";

describe("resident catalog bounded bookkeeping", () => {
  it("settles admitted projections and restores capacity after rejecting overflow", async () => {
    const projections = new CodexCatalogProjections();
    const gate = createDeferred<void>();
    const admitted = Array.from({ length: 20_000 }, () => projections.run(() => gate.promise));
    const overflow = vi.fn(async () => {});
    await expect(projections.run(overflow)).rejects.toThrow("resident row limit");
    expect(overflow).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all(admitted);
    await expect(projections.run(overflow)).resolves.toBeUndefined();
    expect(overflow).toHaveBeenCalledOnce();
  });

  it("rejects oversized notification rollout paths before retaining a catalog row", async () => {
    const thread = idleThread({
      id: "oversized-path",
      path: "/" + "p".repeat(4096),
      source: "cli",
    });
    const index = new CodexCatalogIndex({
      homeId: "oversized-notification-path",
      assertCurrent: () => {},
      readNative: async () => ({ rows: [] }),
    });
    try {
      await expect(index.upsertThread(thread)).rejects.toThrow("rollout path");
    } finally {
      await index.close();
    }
  });

  it("invalidates an overflowing persistence backlog without dropping admitted writes", async () => {
    const gate = createDeferred<void>();
    const started = createDeferred<void>();
    const deleted: string[] = [];
    const state: CodexCatalogState = {
      entries: async () => [],
      register: async () => {},
      delete: async (key) => {
        started.resolve();
        await gate.promise;
        deleted.push(key);
        return true;
      },
    };
    const report = vi.fn();
    const persistence = new CodexCatalogPersistence(state, report);
    persistence.remove("in-flight");
    await started.promise;
    for (let i = 0; i < 20_002; i++) {
      persistence.remove(`pending-${i}`);
    }
    gate.resolve();
    await persistence.retire();
    expect(deleted).toHaveLength(20_002);
    expect(deleted).toContain("complete");
    const key = (id: string) => `thread:${createHash("sha256").update(id).digest("hex")}`;
    expect(deleted).toContain(key("in-flight"));
    expect(deleted).toContain(key("pending-0"));
    expect(deleted).toContain(key("pending-19999"));
    expect(deleted).not.toContain(key("pending-20000"));
    expect(deleted).not.toContain(key("pending-20001"));
    expect(report).toHaveBeenCalledOnce();
  });
});
