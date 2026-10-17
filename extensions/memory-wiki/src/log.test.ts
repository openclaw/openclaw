import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, it } from "vitest";
import { loadMemoryWikiVaultIdentity } from "./log.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const open = fs.open;
afterEach(() => {
  fs.open = open;
});

const empty = {
  vaultGeneration: null,
  compiledCacheReservationId: null,
  compiledCachePublicationId: null,
  compiledCacheSourceGeneration: null,
};
const expected = {
  vaultGeneration: "vault",
  compiledCacheReservationId: "reservation",
  compiledCachePublicationId: "publication",
  compiledCacheSourceGeneration: "source",
};
const row = (details: Record<string, unknown>) => JSON.stringify({ details }) + "\n";
const generation = row({ vaultGeneration: "vault" });
const reservation = row({ compiledCacheReservationId: "reservation" });
const publication = row({
  compiledCacheReservationId: "reservation",
  compiledCachePublicationId: "publication",
  compiledCacheParentPublicationId: null,
  compiledCacheSourceGeneration: "source",
});
const journal = generation + reservation + publication;

async function createJournal(raw = journal) {
  const root = tempDirs.make("memory-wiki-log-");
  const file = path.join(root, ".openclaw-wiki", "log.jsonl");
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, raw);
  return { root, file };
}

type Handle = Awaited<ReturnType<typeof fs.open>>;
function observeOpen(configure: (handle: Handle) => void | Promise<void>) {
  fs.open = async (...args) => {
    const handle = await open(...args);
    await configure(handle);
    return handle;
  };
}

describe("loadMemoryWikiVaultIdentity", () => {
  it("replays LF, CRLF and an authoritative final record without a newline", async () => {
    for (const raw of [journal, journal.replaceAll("\n", "\r\n"), journal.trimEnd()]) {
      const { root } = await createJournal(raw);
      assert.deepEqual(await loadMemoryWikiVaultIdentity(root), expected);
    }
  });

  it("ignores malformed records and partial tails without splitting lone CR", async () => {
    const { root, file } = await createJournal(journal + 'not-json\n{"partial":');
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), expected);
    await fs.writeFile(file, generation + reservation.trimEnd() + "\r" + publication.trimEnd());
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), {
      ...empty,
      vaultGeneration: "vault",
    });
  });

  it("preserves the first generation and reservation/parent/source rollback checks", async () => {
    const { root, file } = await createJournal(generation + publication);
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), {
      ...empty,
      vaultGeneration: "vault",
    });
    await fs.writeFile(
      file,
      journal +
        row({ vaultGeneration: "later" }) +
        row({ compiledCacheReservationId: "next" }) +
        row({
          compiledCacheReservationId: "reservation",
          compiledCachePublicationId: "stale",
          compiledCacheParentPublicationId: "publication",
          compiledCacheSourceGeneration: "source",
        }) +
        row({
          compiledCacheReservationId: "next",
          compiledCachePublicationId: "wrong-parent",
          compiledCacheParentPublicationId: null,
          compiledCacheSourceGeneration: "source",
        }) +
        row({
          compiledCacheReservationId: "next",
          compiledCachePublicationId: "no-source",
          compiledCacheParentPublicationId: "publication",
        }),
    );
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), {
      ...expected,
      compiledCacheReservationId: "next",
    });
  });

  it("decodes an oversized identity across a UTF-8 chunk boundary", async () => {
    const prefix = '{"details":{"vaultGeneration":"';
    const identity = "a".repeat(64 * 1024 - Buffer.byteLength(prefix) - 1) + "🦊雪";
    const { root } = await createJournal(
      row({ vaultGeneration: identity }) + reservation + publication.trimEnd(),
    );
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), {
      ...expected,
      vaultGeneration: identity,
    });
  });

  it("uses bounded reads on a long journal rather than materializing its history", async () => {
    const { root } = await createJournal(
      generation + row({ note: "x".repeat(1024) }).repeat(1024) + reservation + publication,
    );
    let reads = 0;
    let closes = 0;
    observeOpen((handle) => {
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      Object.defineProperty(handle, "read", {
        value: async (buffer: Buffer, offset: number, length: number, position: null) => {
          assert.ok(buffer.byteLength <= 64 * 1024);
          assert.ok(length <= buffer.byteLength);
          reads++;
          return read(buffer, offset, length, position);
        },
      });
      Object.defineProperty(handle, "close", {
        value: async () => {
          closes++;
          await close();
        },
      });
    });
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), expected);
    assert.ok(reads > 1);
    assert.equal(closes, 1);
  });

  it("returns empty for a missing journal and propagates other open failures", async () => {
    const { root, file } = await createJournal();
    await fs.unlink(file);
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), empty);
    const failure = Object.assign(new Error("open failed"), { code: "EACCES" });
    fs.open = async () => {
      throw failure;
    };
    await assert.rejects(loadMemoryWikiVaultIdentity(root), (error) => error === failure);
  });

  for (const code of ["EIO", "ENOENT"]) {
    it(`never returns partial authority after a ${code} read failure and closes once`, async () => {
      const { root } = await createJournal(journal + row({ note: "x".repeat(128 * 1024) }));
      const failure = Object.assign(new Error("read failed"), { code });
      let reads = 0;
      let closes = 0;
      observeOpen((handle) => {
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "read", {
          value: async (buffer: Buffer, offset: number, length: number, position: null) => {
            if (++reads === 2) {
              throw failure;
            }
            return read(buffer, offset, length, position);
          },
        });
        Object.defineProperty(handle, "close", {
          value: async () => {
            closes++;
            await close();
          },
        });
      });
      if (code === "ENOENT") {
        assert.deepEqual(await loadMemoryWikiVaultIdentity(root), empty);
      } else {
        await assert.rejects(loadMemoryWikiVaultIdentity(root), (error) => error === failure);
      }
      assert.equal(reads, 2);
      assert.equal(closes, 1);
    });
  }

  it("closes after stat failure and preserves both read and close errors in order", async () => {
    const { root } = await createJournal();
    const readError = new Error("stat failed");
    const closeError = new Error("close failed");
    let closes = 0;
    observeOpen((handle) => {
      const close = handle.close.bind(handle);
      Object.defineProperty(handle, "stat", {
        value: async () => {
          throw readError;
        },
      });
      Object.defineProperty(handle, "close", {
        value: async () => {
          closes++;
          await close();
          throw closeError;
        },
      });
    });
    await assert.rejects(loadMemoryWikiVaultIdentity(root), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [readError, closeError]);
      assert.equal(error.cause, closeError);
      assert.equal(error.message, "Memory Wiki journal read and close failed.");
      return true;
    });
    assert.equal(closes, 1);
  });

  it("does not return an identity when closing the handle fails", async () => {
    const { root } = await createJournal();
    const failure = new Error("close failed");
    let closes = 0;
    observeOpen((handle) => {
      const close = handle.close.bind(handle);
      Object.defineProperty(handle, "close", {
        value: async () => {
          closes++;
          await close();
          throw failure;
        },
      });
    });
    await assert.rejects(loadMemoryWikiVaultIdentity(root), (error) => error === failure);
    assert.equal(closes, 1);
  });

  it("bounds regular journals at their initial extent and sees appends next time", async () => {
    const { root, file } = await createJournal(generation + reservation);
    observeOpen((handle) => {
      const stat = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", {
        value: async () => {
          const initial = await stat();
          await fs.appendFile(file, publication);
          return initial;
        },
      });
    });
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), {
      ...empty,
      vaultGeneration: "vault",
      compiledCacheReservationId: "reservation",
    });
    fs.open = open;
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), expected);
  });

  it("reads an initially empty file to EOF instead of a fixed empty prefix", async () => {
    const { root, file } = await createJournal("");
    observeOpen((handle) => {
      const stat = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", {
        value: async () => {
          const initial = await stat();
          await fs.appendFile(file, journal);
          return initial;
        },
      });
    });
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), expected);
  });

  it("keeps the opened journal when the path is replaced", async () => {
    const { root, file } = await createJournal();
    observeOpen(async () => {
      await fs.rename(file, file + ".old");
      await fs.writeFile(file, row({ vaultGeneration: "replacement" }));
    });
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), expected);
  });

  it("stops at EOF after truncation and ignores a now-partial publication", async () => {
    const { root, file } = await createJournal();
    observeOpen((handle) => {
      const stat = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", {
        value: async () => {
          const initial = await stat();
          await fs.truncate(file, Buffer.byteLength(generation + reservation) + 10);
          return initial;
        },
      });
    });
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), {
      ...empty,
      vaultGeneration: "vault",
      compiledCacheReservationId: "reservation",
    });
  });
});
