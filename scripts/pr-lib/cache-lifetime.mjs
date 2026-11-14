import { randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

// Older frozen collectors recognize neither namespace. Their PID-only policy
// cannot safely collect an operation whose supervisor exited before its children.
export const ANCHOR_PREFIX = "openclaw-pr-anchor-v3.";
export const dependencyCacheRoot = () => {
  let path = join(realpathSync(homedir()), ".cache/openclaw/pr-dependencies");
  const missing = [];
  while (!existsSync(path)) {
    missing.unshift(basename(path));
    path = dirname(path);
  }
  const cache = join(realpathSync(path), ...missing, "v3");
  const present = lstatSync(cache, { throwIfNoEntry: false });
  // Ancestor aliases are supported, but aliasing the namespace itself would
  // rebase legacy-cache recognition and let an unheld donor look external.
  if (present && (!present.isDirectory() || realpathSync(cache) !== cache)) {
    throw new Error(`Unsafe PR dependency cache namespace: ${cache}`);
  }
  return cache;
};

function directory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    realpathSync(path) !== resolve(path) ||
    stat.uid !== BigInt(process.getuid()) ||
    (stat.mode & 0o7777n) !== 0o700n
  ) {
    throw new Error(`Unsafe PR lifetime directory: ${path}`);
  }
  return stat;
}

function same(left, right) {
  return ["dev", "ino", "uid", "mode"].every((key) => left[key] === right[key]);
}

export function claimCreatedAnchor(path, creatorPid) {
  const current = directory(path);
  const held = fstatSync(9, { bigint: true });
  if (!basename(path).startsWith(`${ANCHOR_PREFIX}${creatorPid}.`) || !same(current, held)) {
    throw new Error("PR anchor creation descriptor differs");
  }
  return { path: resolve(path), dev: held.dev, ino: held.ino, uid: held.uid, mode: held.mode };
}

function assertAnchor(anchor) {
  if (!same(directory(anchor.path), anchor) || !same(fstatSync(9, { bigint: true }), anchor)) {
    throw new Error("PR anchor creation evidence changed");
  }
}

// This owner runs before selecting/installing package dependencies. Kysely here
// would create a bootstrap cycle; use only node:sqlite's synchronous primitives.
const ledgers = new WeakMap();
const ledgerName = "lifetime.sqlite";
const identityKeys = ["dev", "ino", "uid", "mode"];
const identityValues = (stat) => identityKeys.map((key) => String(stat[key]));
const rowMatches = (row, prefix, stat) =>
  identityKeys.every((key) => row[`${prefix}${key}`] === String(stat[key]));

function physicalFile(path) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.uid !== BigInt(process.getuid()) ||
    (stat.mode & 0o7777n) !== 0o600n ||
    stat.nlink !== 1n ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error(`Unsafe PR dependency ledger file: ${path}`);
  }
  return stat;
}

function assertLedgerFiles(cache, identity, path, file, fd) {
  if (
    !same(directory(cache), identity) ||
    !same(physicalFile(path), file) ||
    !same(fstatSync(fd, { bigint: true }), file)
  ) {
    throw new Error("PR dependency ledger identity changed; retain installations");
  }
  for (const name of readdirSync(cache).filter((entry) => entry.startsWith(`${ledgerName}-`))) {
    if (name !== `${ledgerName}-journal`) {
      throw new Error(`Unknown PR dependency ledger auxiliary file: ${name}`);
    }
    physicalFile(join(cache, name));
  }
}

function transaction(context, operation, initialize = false) {
  const { db } = context;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!initialize) {
      assertLedgerOwner(context);
    }
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollback) {
      // oxlint-disable-next-line preserve-caught-error -- Aggregate cause preserves both the operation and rollback failures.
      throw new Error("PR dependency ledger rollback failed; retain installations", {
        cause: new AggregateError([error, rollback]),
      });
    }
    throw error;
  }
}

function openLedger(cache, cacheIdentity, create, readOnly) {
  const path = join(cache, ledgerName);
  const fd = openSync(
    path,
    (create ? constants.O_RDWR | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY) |
      constants.O_NOFOLLOW,
    0o600,
  );
  let db;
  try {
    const file = physicalFile(path);
    assertLedgerFiles(cache, cacheIdentity, path, file, fd);
    db = new DatabaseSync(path, { timeout: 0, allowExtension: false, readOnly });
    assertLedgerFiles(cache, cacheIdentity, path, file, fd);
    if (create) {
      db.exec("PRAGMA journal_mode=DELETE");
    }
    if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "delete") {
      throw new Error("PR dependency ledger requires DELETE journaling");
    }
    db.exec("PRAGMA synchronous=EXTRA");
    if (db.prepare("PRAGMA synchronous").get().synchronous !== 3) {
      throw new Error("PR dependency ledger requires EXTRA synchronization");
    }
    const context = { cache, cacheIdentity, path, file, fd, db };
    if (create) {
      transaction(
        context,
        () => {
          db.exec(`
          CREATE TABLE owner (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            cache_dev TEXT NOT NULL, cache_ino TEXT NOT NULL,
            cache_uid TEXT NOT NULL, cache_mode TEXT NOT NULL,
            db_dev TEXT NOT NULL, db_ino TEXT NOT NULL,
            db_uid TEXT NOT NULL, db_mode TEXT NOT NULL,
            sequence INTEGER NOT NULL DEFAULT 0
          ) STRICT;
          CREATE TABLE installations (
            key TEXT PRIMARY KEY,
            dev TEXT NOT NULL, ino TEXT NOT NULL, uid TEXT NOT NULL, mode TEXT NOT NULL,
            settled INTEGER NOT NULL CHECK (settled IN (0, 1)),
            last_used INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE holds (
            entry_key TEXT NOT NULL REFERENCES installations(key),
            anchor_path TEXT NOT NULL, anchor_dev TEXT NOT NULL, anchor_ino TEXT NOT NULL,
            anchor_uid TEXT NOT NULL, anchor_mode TEXT NOT NULL,
            PRIMARY KEY (entry_key, anchor_path, anchor_dev, anchor_ino)
          ) STRICT;
        `);
          db.prepare("INSERT INTO owner VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0)").run(
            ...identityValues(cacheIdentity),
            ...identityValues(file),
          );
        },
        true,
      );
    }
    assertLedgerOwner(context);
    assertLedgerFiles(cache, cacheIdentity, path, file, fd);
    return context;
  } catch (error) {
    try {
      db?.close();
    } finally {
      closeSync(fd);
    }
    throw error;
  }
}

function closeLedger(context) {
  try {
    context.db.close();
  } finally {
    try {
      assertLedgerFiles(
        context.cache,
        context.cacheIdentity,
        context.path,
        context.file,
        context.fd,
      );
    } finally {
      closeSync(context.fd);
    }
  }
}

function ledger(lock) {
  const context = ledgers.get(lock);
  if (
    !context ||
    !same(directory(context.lockPath), context.lockIdentity) ||
    !same(directory(context.owner), context.ownerIdentity)
  ) {
    throw new Error("PR cache metadata lock ownership changed");
  }
  assertLedgerFiles(context.cache, context.cacheIdentity, context.path, context.file, context.fd);
  return context;
}

function installation(context, entry) {
  const identity = entryIdentity(context.cache, entry);
  const row = context.db.prepare("SELECT * FROM installations WHERE key = ?").get(basename(entry));
  if (!row || !rowMatches(row, "", identity)) {
    throw new Error("PR dependency installation ledger differs; retain installation");
  }
  return { identity, row };
}

function anchorRows(db, anchor) {
  return db
    .prepare(
      "SELECT * FROM holds WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ? ORDER BY entry_key",
    )
    .all(anchor.path, String(anchor.dev), String(anchor.ino));
}

function assertHold(row, anchor) {
  if (row.anchor_path !== anchor.path || !rowMatches(row, "anchor_", anchor)) {
    throw new Error("PR dependency hold identity changed; retain it");
  }
}

function acquire(context, entry, anchor, fresh = false) {
  const identity = entryIdentity(context.cache, entry);
  assertAnchor(anchor);
  if (!fresh) {
    installation(context, entry);
  }
  transaction(context, () => {
    if (fresh) {
      context.db
        .prepare("INSERT INTO installations VALUES (?, ?, ?, ?, ?, 0, 0)")
        .run(basename(entry), ...identityValues(identity));
    } else {
      const row = context.db
        .prepare("SELECT * FROM installations WHERE key = ?")
        .get(basename(entry));
      if (!row || !rowMatches(row, "", identity)) {
        throw new Error("PR dependency installation ledger changed");
      }
    }
    const existing = context.db
      .prepare(
        "SELECT * FROM holds WHERE entry_key = ? AND anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
      )
      .get(basename(entry), anchor.path, String(anchor.dev), String(anchor.ino));
    if (existing) {
      assertHold(existing, anchor);
    } else {
      context.db
        .prepare("INSERT INTO holds VALUES (?, ?, ?, ?, ?, ?)")
        .run(basename(entry), anchor.path, ...identityValues(anchor));
    }
    context.db.exec("UPDATE owner SET sequence = sequence + 1 WHERE id = 1");
    context.db
      .prepare(
        "UPDATE installations SET settled = 0, last_used = (SELECT sequence FROM owner WHERE id = 1) WHERE key = ?",
      )
      .run(basename(entry));
  });
}

function assertLedgerOwner(context) {
  // Earlier PR-format ledgers cannot distinguish a retained path from a later
  // anchor reusing its inode. Refuse that layout rather than adopting its holds.
  const expectedHoldKey = ["entry_key", "anchor_path", "anchor_dev", "anchor_ino"];
  const holdKey = context.db
    .prepare("PRAGMA table_info(holds)")
    .all()
    .filter((column) => column.pk > 0)
    .toSorted((left, right) => left.pk - right.pk);
  if (
    holdKey.length !== expectedHoldKey.length ||
    holdKey.some(
      (column, index) => column.pk !== index + 1 || column.name !== expectedHoldKey[index],
    )
  ) {
    throw new Error("PR dependency hold ledger layout differs; retain installations");
  }
  const owner = context.db.prepare("SELECT * FROM owner WHERE id = 1").get();
  if (
    !owner ||
    !rowMatches(owner, "cache_", context.cacheIdentity) ||
    !rowMatches(owner, "db_", context.file) ||
    context.db.prepare("PRAGMA user_version").get().user_version !== 0 ||
    context.db.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1
  ) {
    throw new Error("PR dependency ledger owner differs; retain installations");
  }
}

export function withDependencyCacheLock(cache, operation) {
  return withCacheOwner(cache, operation, true);
}

function withCacheOwner(cache, operation, initialize, readOnly = false) {
  let created = false;
  if (initialize) {
    mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
    try {
      mkdirSync(cache, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  const cacheIdentity = directory(cache);
  const path = join(cache, ".metadata-lock");
  const deadline = performance.now() + 1_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const assertCache = () => {
    if (!same(directory(cache), cacheIdentity)) {
      throw new Error(`PR dependency cache directory changed; retain ${cache}`);
    }
  };
  // Only the atomic namespace creator may initialize. Peers wait for its DB
  // while it holds the mutex; a crashed empty namespace is never adopted.
  for (;;) {
    assertCache();
    if (performance.now() >= deadline) {
      const reason = lstatSync(join(cache, ledgerName), { throwIfNoEntry: false })
        ? "metadata is busy"
        : "ledger is missing";
      throw new Error(`PR dependency cache ${reason}; retain ${path}`);
    }
    if (created || lstatSync(join(cache, ledgerName), { throwIfNoEntry: false })) {
      try {
        mkdirSync(path, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
    }
    Atomics.wait(pause, 0, 0, Math.max(0, Math.min(10, deadline - performance.now())));
  }
  assertCache();
  const identity = directory(path);
  const owner = join(path, `owner-${process.pid}-${randomUUID()}`);
  mkdirSync(owner, { mode: 0o700 });
  const ownerIdentity = directory(owner);
  const lock = { cache, path, identity, owner };
  let context;
  try {
    if (created && readdirSync(cache).some((name) => name !== ".metadata-lock")) {
      throw new Error("New PR dependency namespace changed before initialization");
    }
    context = openLedger(cache, cacheIdentity, created, readOnly);
    Object.assign(context, { lockPath: path, lockIdentity: identity, owner, ownerIdentity });
    ledgers.set(lock, context);
    return operation(lock);
  } finally {
    ledgers.delete(lock);
    try {
      if (context) {
        closeLedger(context);
      }
    } finally {
      // A changed-owner release failure wins even when the operation failed:
      // uncertain ownership must stay visible and retain the lock.
      releaseDependencyCacheLock(path, identity, owner, ownerIdentity);
    }
  }
}

function releaseDependencyCacheLock(path, identity, owner, ownerIdentity) {
  if (!same(directory(path), identity) || !same(directory(owner), ownerIdentity)) {
    throw new Error("PR cache metadata lock changed; retain it");
  }
  rmdirSync(owner);
  rmdirSync(path);
}

function entryIdentity(cache, entry) {
  if (dirname(entry) !== cache || !/^[a-f0-9]{64}$/.test(basename(entry))) {
    throw new Error("PR dependency installation is outside the lifetime namespace");
  }
  return directory(entry);
}

export function holdDependencyCache(lock, entry, anchor) {
  const context = ledger(lock);
  if (dirname(entry) !== context.cache || !/^[a-f0-9]{64}$/.test(basename(entry))) {
    throw new Error("PR dependency installation is outside the lifetime namespace");
  }
  const present = lstatSync(entry, { throwIfNoEntry: false });
  const row = context.db.prepare("SELECT * FROM installations WHERE key = ?").get(basename(entry));
  if (!present && !row) {
    return false;
  }
  if (!present || !row) {
    throw new Error("PR dependency installation ledger differs; retain installation");
  }
  acquire(context, entry, anchor);
  return true;
}

export function publishDependencyCache(lock, stage, entry, anchor) {
  const context = ledger(lock);
  if (holdDependencyCache(lock, entry, anchor)) {
    return;
  }
  if (dirname(stage) !== context.cache || !/^install-[0-9]+-[A-Za-z0-9]+$/.test(basename(stage))) {
    throw new Error("Frozen dependency stage is outside its owned namespace");
  }
  directory(stage);
  // The filesystem transition is outside SQL. A crash/failed commit leaves an
  // unregistered physical entry, which is retain-only rather than reusable.
  renameSync(stage, entry);
  acquire(context, entry, anchor, true);
}

function assertDependencyTargets(targets, destination) {
  const cache = dependencyCacheRoot();
  const privateCache = dirname(cache);
  const privateTargets = targets.filter((target) => target.startsWith(`${privateCache}${sep}`));
  if (privateTargets.length === 0) {
    return;
  }
  const stage = dirname(destination);
  if (
    dirname(stage) === cache &&
    /^install-[0-9]+-[A-Za-z0-9]+$/.test(basename(stage)) &&
    basename(destination) === ".pr-dependency-check" &&
    privateTargets.every((target) => target.startsWith(`${stage}${sep}`))
  ) {
    directory(stage);
    return;
  }
  const anchor = { path: dirname(destination), ...directory(dirname(destination)) };
  if (!basename(anchor.path).startsWith(ANCHOR_PREFIX)) {
    throw new Error("Private cache donor has no anchor owner");
  }
  const entries = [
    ...new Set(
      privateTargets.map((target) => {
        const relative = target.slice(cache.length + 1);
        if (!target.startsWith(`${cache}${sep}`) || !/^[a-f0-9]{64}\//.test(relative)) {
          throw new Error("Legacy private PR dependency caches cannot supply tooling dependencies");
        }
        return join(cache, relative.split(sep)[0]);
      }),
    ),
  ];
  // Selected helpers run only after publication releases the mutex. Serialize
  // read/close too: DELETE-mode readers must not race a timeout-zero commit.
  withCacheOwner(
    cache,
    (lock) => {
      const context = ledger(lock);
      for (const entry of entries) {
        installation(context, entry);
        const hold = context.db
          .prepare(
            "SELECT * FROM holds WHERE entry_key = ? AND anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
          )
          .get(basename(entry), anchor.path, String(anchor.dev), String(anchor.ino));
        if (!hold) {
          throw new Error("Private cache donor has no matching anchor lifetime hold");
        }
        assertHold(hold, anchor);
      }
      if (!same(directory(anchor.path), anchor)) {
        throw new Error("Private dependency anchor changed during membership lookup");
      }
    },
    false,
    true,
  );
}

export function assertDependencyTarget(target, destination) {
  assertDependencyTargets([target], destination);
}

function visitDependencyAliases(modules, visit) {
  const existing = (read) => {
    try {
      return read();
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
      return undefined;
    }
  };
  const target = existing(() => realpathSync(modules));
  if (!target) {
    return;
  }
  // Missing aliases retain the materializer's existing refusal. Errors from
  // lifetime validation itself must propagate, including a missing lifetime hold.
  visit(target);
  for (const name of existing(() => readdirSync(modules)) ?? []) {
    const path = join(modules, name);
    const alias = existing(() => realpathSync(path));
    if (!alias) {
      continue;
    }
    visit(alias);
    if (name.startsWith("@")) {
      for (const child of existing(() => readdirSync(path)) ?? []) {
        const scoped = existing(() => realpathSync(join(path, child)));
        if (scoped) {
          visit(scoped);
        }
      }
    }
  }
}

// Older selected helpers do not know this lifetime contract. Guard every root
// they can project before invoking them, without duplicating their package list.
export function privateDependencyDonor(root, destination) {
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    const assertProjectionDirectory = (path) => {
      const stat = lstatSync(path);
      if (
        !stat.isDirectory() ||
        stat.uid !== process.getuid() ||
        realpathSync(path) !== resolve(path)
      ) {
        throw new Error("PR dependency projection is not an owned physical directory");
      }
    };
    assertProjectionDirectory(destination);
    for (const name of readdirSync(destination).filter((alias) => alias.startsWith("@"))) {
      assertProjectionDirectory(join(destination, name));
    }
  }
  const targets = [];
  visitDependencyAliases(destination, (target) => targets.push(target));
  const privateCache = dirname(dependencyCacheRoot());
  let privateDonor = false;
  for (const modules of [
    join(root, "node_modules"),
    join(root, "packages/markdown-core/node_modules"),
  ]) {
    visitDependencyAliases(modules, (target) => {
      // Self-donor reuse may preserve or complete an existing projection without
      // creator authority; every private input must already have its anchor hold.
      if (root === dirname(destination)) {
        targets.push(target);
      }
      if (target === privateCache || target.startsWith(`${privateCache}${sep}`)) {
        privateDonor = true;
      }
    });
  }
  assertDependencyTargets(targets, destination);
  return privateDonor;
}

export function collectUnusedDependencyCaches(lock, current = "") {
  const context = ledger(lock);
  const rows = context.db
    .prepare(`
    SELECT * FROM installations i WHERE settled = 1
      AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.entry_key = i.key)
    ORDER BY last_used DESC, key
  `)
    .all()
    .filter((row) => join(context.cache, row.key) !== current);
  const candidates = rows
    .map((row) => {
      const entry = join(context.cache, row.key);
      const { identity } = installation(context, entry);
      return { row, entry, identity };
    })
    .slice(4);
  const retired = [];
  for (const { row, entry, identity } of candidates) {
    const detached = join(context.cache, `retired-${randomUUID()}`);
    // Remove eligibility atomically before filesystem detach. A failed rename
    // leaves an unknown physical entry; it never becomes reusable by inference.
    transaction(context, () => {
      const present = context.db.prepare("SELECT * FROM installations WHERE key = ?").get(row.key);
      const held = context.db
        .prepare("SELECT 1 FROM holds WHERE entry_key = ? LIMIT 1")
        .get(row.key);
      if (
        !present ||
        !rowMatches(present, "", identity) ||
        present.settled !== 1 ||
        present.last_used !== row.last_used ||
        held
      ) {
        throw new Error("PR dependency collection eligibility changed");
      }
      context.db.prepare("DELETE FROM installations WHERE key = ?").run(row.key);
    });
    if (!same(entryIdentity(context.cache, entry), identity)) {
      throw new Error("PR dependency installation changed before eviction");
    }
    renameSync(entry, detached);
    if (!same(directory(detached), identity)) {
      throw new Error("PR dependency installation changed after detach; retain it");
    }
    ledger(lock);
    retired.push(detached);
  }
  return retired;
}

export function retireAnchorDependencies(anchor, retire) {
  assertAnchor(anchor);
  const cache = dependencyCacheRoot();
  // Startup without a private projection has nothing to release. Missing
  // ledger state can never authorize settlement of a cache installation.
  if (!lstatSync(cache, { throwIfNoEntry: false })) {
    privateDependencyDonor(anchor.path, join(anchor.path, "node_modules"));
    retire();
    return;
  }
  privateDependencyDonor(anchor.path, join(anchor.path, "node_modules"));
  let cacheIdentity, fileIdentity;
  const owned = withCacheOwner(
    cache,
    (lock) => {
      assertAnchor(anchor);
      const context = ledger(lock);
      cacheIdentity = context.cacheIdentity;
      fileIdentity = context.file;
      return anchorRows(context.db, anchor).map((row) => {
        assertHold(row, anchor);
        const entry = join(cache, row.entry_key);
        const { identity } = installation(context, entry);
        return { row, entry, identity };
      });
    },
    false,
  );
  // Holds stay committed throughout the creator's full-drain retirement.
  // PID death, missing paths, or failed reentry are never release authority.
  assertAnchor(anchor);
  retire();
  if (lstatSync(anchor.path, { throwIfNoEntry: false })) {
    throw new Error("PR anchor retirement not confirmed");
  }
  withCacheOwner(
    cache,
    (lock) => {
      const context = ledger(lock);
      if (!same(context.cacheIdentity, cacheIdentity) || !same(context.file, fileIdentity)) {
        throw new Error("PR cache ledger identity changed after anchor retirement");
      }
      for (const { entry, identity } of owned) {
        if (!same(installation(context, entry).identity, identity)) {
          throw new Error("PR dependency installation changed after anchor retirement");
        }
      }
      transaction(context, () => {
        const rows = anchorRows(context.db, anchor);
        if (
          rows.length !== owned.length ||
          rows.some((row, index) =>
            Object.keys(row).some((key) => row[key] !== owned[index].row[key]),
          )
        ) {
          throw new Error("PR dependency holds changed after retirement; retain them");
        }
        for (const { row, identity } of owned) {
          const entry = context.db
            .prepare("SELECT * FROM installations WHERE key = ?")
            .get(row.entry_key);
          if (!entry || !rowMatches(entry, "", identity)) {
            throw new Error("PR dependency installation ledger changed after retirement");
          }
          context.db
            .prepare(
              "DELETE FROM holds WHERE entry_key = ? AND anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
            )
            .run(row.entry_key, row.anchor_path, row.anchor_dev, row.anchor_ino);
          context.db
            .prepare(`
          UPDATE installations SET settled = 1 WHERE key = ?
            AND NOT EXISTS (SELECT 1 FROM holds WHERE entry_key = ?)
        `)
            .run(row.entry_key, row.entry_key);
        }
      });
    },
    false,
  );
}
