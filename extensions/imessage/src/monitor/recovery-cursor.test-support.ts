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

function writeLegacyCatchupCursor(accountId: string, lastSeenRowid: number): void {
  const store = getIMessageRuntime().state.openSyncKeyedStore<{ lastSeenRowid: number }>({
    namespace: "imessage.catchup-cursors",
    maxEntries: 256,
  });
  const key = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 32);
  store.register(key, { lastSeenRowid });
}

describe("iMessage recovery cursor", () => {
  beforeEach(installIMessageStateRuntimeForTest);

  it("adopts a pre-database-scoping cursor once for the active database (#99638)", async () => {
    getIMessageRuntime()
      .state.openSyncKeyedStore<{ lastRowid: number }>({
        namespace: "imessage.recovery-cursor",
        maxEntries: 64,
      })
      .register("default", { lastRowid: 12396 });
    expect(await loadCursor("default", DB)).toBe(12396);
    expect(await loadCursor("default", "local:/db-b")).toBeNull();
    expect(await loadCursor("default", DB)).toBe(12396);
  });

  it.each([
    [9000, 5, 5],
    [9000, 0, 0],
    [4990, 5000, 4990],
    [4990, 4990, 4990],
    [4990, null, 4990],
  ] as const)(
    "reconciles cursor %s with watermark %s to %s and resumes",
    async (rowid, watermarkRowid, expected) => {
      await advanceCursor("default", DB, rowid);
      expect(await loadCursor("default", DB, { watermarkRowid })).toBe(expected);
      expect(await loadCursor("default", DB)).toBe(expected);
      await advanceCursor("default", DB, expected + 1);
      expect(await loadCursor("default", DB)).toBe(expected + 1);
    },
  );

  it("ignores non-finite rowids", async () => {
    await advanceCursor("default", DB, Number.NaN);
    expect(await loadCursor("default", DB)).toBeNull();
  });

  it.each([
    [4321, undefined, 4321],
    [9000, 5, 5],
  ] as const)(
    "migrates catchup cursor %s with watermark %s to %s",
    async (rowid, watermarkRowid, expected) => {
      writeLegacyCatchupCursor("default", rowid);
      expect(await loadCursor("default", DB, { watermarkRowid })).toBe(expected);
      expect(await loadCursor("default", DB)).toBe(expected);
    },
  );

  it("prefers an existing recovery cursor over the legacy catchup cursor", async () => {
    await advanceCursor("default", DB, 9000);
    writeLegacyCatchupCursor("default", 10);
    expect(await loadCursor("default", DB)).toBe(9000);
  });

  it("canonicalizes default chat.db spellings and isolates other databases (#99638)", () => {
    const home = (process.env.HOME || os.homedir()).trim();
    const defaultIdentity = `local:${path.resolve(path.join(home, "Library", "Messages", "chat.db"))}`;

    for (const [params, expected] of [
      [{ cliPath: "imsg" }, defaultIdentity],
      [{ cliPath: "/opt/homebrew/bin/imsg" }, defaultIdentity],
      [{ dbPath: path.join(home, "Library/Messages/chat.db") }, defaultIdentity],
      [{ dbPath: "~/Library/Messages/chat.db" }, defaultIdentity],
      [{ dbPath: "/Users/other/chat.db" }, `local:${path.resolve("/Users/other/chat.db")}`],
      [{ cliPath: "/usr/local/bin/imsg-a.sh" }, "local:cli:/usr/local/bin/imsg-a.sh"],
      [{ cliPath: "/usr/local/bin/imsg-b.sh" }, "local:cli:/usr/local/bin/imsg-b.sh"],
      [{ remoteHost: "bot@host", dbPath: "/Users/b/chat.db" }, "remote:bot@host:/Users/b/chat.db"],
    ] as const) {
      expect(resolveIMessageRecoveryCursorDbIdentity(params)).toBe(expected);
    }
  });
});
