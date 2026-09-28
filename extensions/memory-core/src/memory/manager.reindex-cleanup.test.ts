import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import * as databaseFiles from "./manager-db.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory reindex cleanup", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["unreleased", "replaced"] as const)(
    "preserves the %s shadow when final cleanup has no custody",
    async (failure) => {
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ provider: "none", sources: ["memory"], vectorEnabled: false }),
      );
      const open = MemoryIndexDatabase.openShadow.bind(MemoryIndexDatabase);
      let shadow: { owner: MemoryIndexDatabase; path: string } | undefined;
      const releaseFailure = new Error("controlled shadow release failure");
      const replacement = "replacement file must survive rejected identity";
      vi.spyOn(MemoryIndexDatabase, "openShadow").mockImplementation((filename, ...args) => {
        const owner = open(filename, ...args);
        shadow = { owner, path: filename };
        if (failure === "unreleased") {
          vi.spyOn(owner, "release").mockImplementation(() => {
            throw releaseFailure;
          });
        } else {
          const close = owner.closeShadow.bind(owner);
          let replaced = false;
          vi.spyOn(owner, "closeShadow").mockImplementation(async () => {
            await close();
            if (!replaced) {
              replaced = true;
              await fs.rename(filename, `${filename}.preserved`);
              await fs.writeFile(filename, replacement);
            }
          });
        }
        return owner;
      });
      try {
        await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow(
          failure === "unreleased" ? releaseFailure.message : "shadow file changed",
        );
        expect(shadow).toBeDefined();
        expect(shadow!.owner.shadowReleased).toBe(failure === "replaced");
        expect(shadow!.owner.db.isOpen).toBe(failure === "unreleased");
        if (failure === "unreleased") {
          expect((await fs.stat(shadow!.path)).isFile()).toBe(true);
        } else {
          expect(await fs.readFile(shadow!.path, "utf8")).toBe(replacement);
        }
      } finally {
        vi.restoreAllMocks();
        // The injected release failure deliberately leaves this fixture-owned handle open.
        if (shadow?.owner.db.isOpen) {
          shadow.owner.release();
        }
      }
    },
  );

  it("keeps closed-shadow cleanup pending while foreground callbacks run", async () => {
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["memory"], vectorEnabled: false }),
    );
    const open = databaseFiles.openMemoryDatabaseAtPath;
    let shadow: DatabaseSync | undefined;
    let shadowPath: string | undefined;
    vi.spyOn(databaseFiles, "openMemoryDatabaseAtPath").mockImplementation((filename, ...args) => {
      shadowPath = filename;
      shadow = open(filename, ...args);
      return shadow;
    });
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const remove = fs.rm;
    let removalStarted = false;
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (args[0] === shadowPath) {
        removalStarted = true;
        entered.resolve();
        await resume.promise;
      }
      return remove(...args);
    });
    let syncSettled = false;
    const sync = manager.sync({ reason: "cli", force: true }).finally(() => {
      syncSettled = true;
    });
    void sync.catch(() => undefined);
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await Promise.race([entered.promise, sync]);
      expect(removalStarted).toBe(true);
      expect(shadow?.isOpen).toBe(false);
      expect(syncSettled).toBe(false);
      await nextTurn();
      expect(manager.status().chunks).toBeGreaterThan(0);
      expect(syncSettled).toBe(false);
      close = manager.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      resume.resolve();
      await Promise.all([sync, close]);
      expect(shadowPath).toBeDefined();
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        await expect(fs.access(`${shadowPath}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([sync, close]);
    }
  });
});
