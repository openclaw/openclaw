import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getIMessageRuntime } from "../runtime.js";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import {
  advanceIMessageRecoveryCursor as advanceCursor,
  loadIMessageRecoveryCursor as loadCursor,
  resolveIMessageRecoveryCursorDbIdentity,
} from "./recovery-cursor.js";

const DB = "local:/db-a";
const DB_B = "local:/db-b";

function writeLegacyCatchupCursor(accountId: string, lastSeenRowid: number): void {
  const store = getIMessageRuntime().state.openSyncKeyedStore<{
    lastSeenMs: number;
    lastSeenRowid: number;
  }>({ namespace: "imessage.catchup-cursors", maxEntries: 256 });
  const key = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 32);
  store.register(key, { lastSeenMs: Date.now(), lastSeenRowid });
}

function writeLegacyRecoveryCursor(accountId: string, lastRowid: number): void {
  getIMessageRuntime()
    .state.openSyncKeyedStore<{ lastRowid: number }>({
      namespace: "imessage.recovery-cursor",
      maxEntries: 64,
    })
    .register(accountId, { lastRowid });
}

describe("iMessage recovery cursor", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  it("returns null before anything is recorded", async () => {
    expect(await loadCursor("default", DB)).toBeNull();
  });

  it("persists the last dispatched rowid", async () => {
    await advanceCursor("default", DB, 100);
    expect(await loadCursor("default", DB)).toBe(100);
  });

  it("advances forward only and never rewinds", async () => {
    await advanceCursor("default", DB, 100);
    await advanceCursor("default", DB, 50);
    expect(await loadCursor("default", DB)).toBe(100);
    await advanceCursor("default", DB, 150);
    expect(await loadCursor("default", DB)).toBe(150);
  });

  it("scopes the cursor per account", async () => {
    await advanceCursor("work", DB, 10);
    await advanceCursor("home", DB, 20);
    expect(await loadCursor("work", DB)).toBe(10);
    expect(await loadCursor("home", DB)).toBe(20);
  });

  it("ignores a cursor recorded against a different database (#99638)", async () => {
    await advanceCursor("default", DB, 12396);
    expect(await loadCursor("default", DB_B)).toBeNull();
    expect(await loadCursor("default", DB)).toBe(12396);
  });

  it("re-scopes the cursor to the new database on advance", async () => {
    await advanceCursor("default", DB, 12396);
    await advanceCursor("default", DB_B, 15);
    expect(await loadCursor("default", DB_B)).toBe(15);
    expect(await loadCursor("default", DB)).toBe(12396);
  });

  it("adopts a pre-database-scoping cursor once for the active database (#99638)", async () => {
    writeLegacyRecoveryCursor("default", 12396);
    expect(await loadCursor("default", DB)).toBe(12396);
    expect(await loadCursor("default", DB_B)).toBeNull();
    expect(await loadCursor("default", DB)).toBe(12396);
  });

  it.each([5, 0])(
    "rewinds a replaced database to watermark %i and resumes",
    async (watermarkRowid) => {
      await advanceCursor("default", DB, 9000);
      expect(await loadCursor("default", DB, { watermarkRowid })).toBe(watermarkRowid);
      expect(await loadCursor("default", DB)).toBe(watermarkRowid);
      await advanceCursor("default", DB, watermarkRowid + 1);
      expect(await loadCursor("default", DB)).toBe(watermarkRowid + 1);
    },
  );

  it("keeps a cursor at or below the database watermark", async () => {
    await advanceCursor("default", DB, 4990);
    expect(await loadCursor("default", DB, { watermarkRowid: 5000 })).toBe(4990);
    expect(await loadCursor("default", DB, { watermarkRowid: 4990 })).toBe(4990);
    expect(await loadCursor("default", DB, { watermarkRowid: null })).toBe(4990);
  });

  it("rewinds a migrated legacy catchup cursor above the database watermark", async () => {
    writeLegacyCatchupCursor("default", 9000);
    expect(await loadCursor("default", DB, { watermarkRowid: 5 })).toBe(5);
    expect(await loadCursor("default", DB)).toBe(5);
  });

  it("ignores non-finite rowids", async () => {
    await advanceCursor("default", DB, Number.NaN);
    expect(await loadCursor("default", DB)).toBeNull();
  });

  it("seeds from the retired catchup cursor once on upgrade, then consumes it", async () => {
    writeLegacyCatchupCursor("default", 4321);
    expect(await loadCursor("default", DB)).toBe(4321);
    expect(await loadCursor("default", DB)).toBe(4321);
  });

  it("prefers an existing recovery cursor over the legacy catchup cursor", async () => {
    await advanceCursor("default", DB, 9000);
    writeLegacyCatchupCursor("default", 10);
    expect(await loadCursor("default", DB)).toBe(9000);
  });

  it("unifies the implicit default with explicit spellings of the same chat.db (#99638)", () => {
    const home = (process.env.HOME || os.homedir()).trim();
    const defaultIdentity = `local:${path.resolve(path.join(home, "Library", "Messages", "chat.db"))}`;

    expect(resolveIMessageRecoveryCursorDbIdentity({ cliPath: "imsg" })).toBe(defaultIdentity);
    expect(resolveIMessageRecoveryCursorDbIdentity({ cliPath: "/opt/homebrew/bin/imsg" })).toBe(
      defaultIdentity,
    );
    expect(
      resolveIMessageRecoveryCursorDbIdentity({
        dbPath: path.join(home, "Library/Messages/chat.db"),
      }),
    ).toBe(defaultIdentity);
    expect(resolveIMessageRecoveryCursorDbIdentity({ dbPath: "~/Library/Messages/chat.db" })).toBe(
      defaultIdentity,
    );
  });

  it("keeps distinct databases, wrappers, and remotes on separate identities", () => {
    const defaultId = resolveIMessageRecoveryCursorDbIdentity({ cliPath: "imsg" });
    const otherDb = resolveIMessageRecoveryCursorDbIdentity({ dbPath: "/Users/other/chat.db" });
    const wrapperA = resolveIMessageRecoveryCursorDbIdentity({
      cliPath: "/usr/local/bin/imsg-a.sh",
    });
    const wrapperB = resolveIMessageRecoveryCursorDbIdentity({
      cliPath: "/usr/local/bin/imsg-b.sh",
    });
    const remote = resolveIMessageRecoveryCursorDbIdentity({
      remoteHost: "bot@host",
      dbPath: "/Users/b/chat.db",
    });
    expect(new Set([defaultId, otherDb, wrapperA, wrapperB, remote]).size).toBe(5);
    expect(otherDb).toBe(
      resolveIMessageRecoveryCursorDbIdentity({ dbPath: "/Users/other/chat.db" }),
    );
  });
});
