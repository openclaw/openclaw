import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, it } from "vitest";
import { loadMemoryWikiVaultIdentity } from "./log.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const open = fs.open;
afterEach(() => {
  fs.open = open;
});

const expected = {
  vaultGeneration: "vault",
  compiledCacheReservationId: "reservation",
  compiledCachePublicationId: "publication",
  compiledCacheSourceGeneration: "source",
};
const empty = Object.fromEntries(Object.keys(expected).map((key) => [key, null] as const));
const row = (details: Record<string, unknown>) => JSON.stringify({ details }) + "\n";
const generation = row({ vaultGeneration: "vault" });
const reservation = row({ compiledCacheReservationId: "reservation" });
function publish(reservationId: string, id: string, parent: string | null, source?: string) {
  return row({
    compiledCacheReservationId: reservationId,
    compiledCachePublicationId: id,
    compiledCacheParentPublicationId: parent,
    compiledCacheSourceGeneration: source,
  });
}
const publication = publish("reservation", "publication", null, "source");
const reserved = { ...empty, vaultGeneration: "vault", compiledCacheReservationId: "reservation" };
const generationOnly = { ...empty, vaultGeneration: "vault" };
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

function observeIO(
  options: {
    beforeRead?: (buffer: Buffer, length: number, count: number) => void;
    statError?: Error;
    afterStat?: () => Promise<unknown>;
    closeError?: Error;
  } = {},
) {
  const calls = { reads: 0, closes: 0 };
  observeOpen((handle) => {
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    const stat = handle.stat.bind(handle);
    Object.assign(handle, {
      read: async (buffer: Buffer, offset: number, length: number, position: null) => {
        calls.reads++;
        options.beforeRead?.(buffer, length, calls.reads);
        return read(buffer, offset, length, position);
      },
      close: async () => {
        calls.closes++;
        await close();
        if (options.closeError) {
          throw options.closeError;
        }
      },
      stat: async () => {
        if (options.statError) {
          throw options.statError;
        }
        const initial = await stat();
        await options.afterStat?.();
        return initial;
      },
    });
  });
  return calls;
}

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
  assert.deepEqual(await loadMemoryWikiVaultIdentity(root), generationOnly);
});

it("preserves the first generation and reservation/parent/source rollback checks", async () => {
  const { root, file } = await createJournal(generation + publication);
  assert.deepEqual(await loadMemoryWikiVaultIdentity(root), generationOnly);
  await fs.writeFile(
    file,
    journal +
      row({ vaultGeneration: "later" }) +
      row({ compiledCacheReservationId: "next" }) +
      publish("reservation", "stale", "publication", "source") +
      publish("next", "wrong-parent", null, "source") +
      publish("next", "no-source", "publication"),
  );
  const nextReservation = { ...expected, compiledCacheReservationId: "next" };
  assert.deepEqual(await loadMemoryWikiVaultIdentity(root), nextReservation);
});

it("decodes an oversized identity across a UTF-8 chunk boundary", async () => {
  const prefix = '{"details":{"vaultGeneration":"';
  const identity = "a".repeat(64 * 1024 - Buffer.byteLength(prefix) - 1) + "🦊雪";
  const { root } = await createJournal(
    row({ vaultGeneration: identity }) + reservation + publication.trimEnd(),
  );
  const oversized = { ...expected, vaultGeneration: identity };
  assert.deepEqual(await loadMemoryWikiVaultIdentity(root), oversized);
});

it("uses bounded reads on a long journal rather than materializing its history", async () => {
  const { root } = await createJournal(
    generation + row({ note: "x".repeat(1024) }).repeat(1024) + reservation + publication,
  );
  const calls = observeIO({
    beforeRead: (buffer, length) => {
      assert.ok(buffer.byteLength <= 64 * 1024);
      assert.ok(length <= buffer.byteLength);
    },
  });
  assert.deepEqual(await loadMemoryWikiVaultIdentity(root), expected);
  assert.ok(calls.reads > 1);
  assert.equal(calls.closes, 1);
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

it.each(["EIO", "ENOENT"])(
  "never returns partial authority after a %s read failure and closes once",
  async (code) => {
    const { root } = await createJournal(journal + row({ note: "x".repeat(128 * 1024) }));
    const failure = Object.assign(new Error("read failed"), { code });
    const calls = observeIO({
      beforeRead: (_buffer, _length, count) => {
        if (count === 2) {
          throw failure;
        }
      },
    });
    if (code === "ENOENT") {
      assert.deepEqual(await loadMemoryWikiVaultIdentity(root), empty);
    } else {
      await assert.rejects(loadMemoryWikiVaultIdentity(root), (error) => error === failure);
    }
    assert.deepEqual(calls, { reads: 2, closes: 1 });
  },
);

it("closes after stat failure and preserves both read and close errors in order", async () => {
  const { root } = await createJournal();
  const readError = new Error("stat failed");
  const closeError = new Error("close failed");
  const calls = observeIO({ statError: readError, closeError });
  await assert.rejects(loadMemoryWikiVaultIdentity(root), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [readError, closeError]);
    assert.equal(error.cause, closeError);
    assert.equal(error.message, "Memory Wiki journal read and close failed.");
    return true;
  });
  assert.equal(calls.closes, 1);
});

it("does not return an identity when closing the handle fails", async () => {
  const { root } = await createJournal();
  const failure = new Error("close failed");
  const calls = observeIO({ closeError: failure });
  await assert.rejects(loadMemoryWikiVaultIdentity(root), (error) => error === failure);
  assert.equal(calls.closes, 1);
});

it.each([
  ["initial extent", generation + reservation, publication, reserved, true],
  ["empty file", "", journal, expected, false],
  ["truncation", journal, null, reserved, false],
] as const)("handles %s at the stat boundary", async (_name, raw, append, identity, reread) => {
  const { root, file } = await createJournal(raw);
  observeIO({
    afterStat: () =>
      append === null
        ? fs.truncate(file, Buffer.byteLength(generation + reservation) + 10)
        : fs.appendFile(file, append),
  });
  assert.deepEqual(await loadMemoryWikiVaultIdentity(root), identity);
  if (reread) {
    fs.open = open;
    assert.deepEqual(await loadMemoryWikiVaultIdentity(root), expected);
  }
});

it("keeps the opened journal when the path is replaced", async () => {
  const { root, file } = await createJournal();
  observeOpen(async () => {
    await fs.rename(file, file + ".old");
    await fs.writeFile(file, row({ vaultGeneration: "replacement" }));
  });
  assert.deepEqual(await loadMemoryWikiVaultIdentity(root), expected);
});
