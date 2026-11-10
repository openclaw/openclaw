import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

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

const ledgerSchema = `
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
        `;

// Additive, same-version bookkeeping: frozen v3 readers still own their holds.
const lifetimeSchema = `
  CREATE TABLE IF NOT EXISTS pending_lifetimes (
    anchor_path TEXT NOT NULL, anchor_dev TEXT NOT NULL, anchor_ino TEXT NOT NULL,
    anchor_uid TEXT NOT NULL, anchor_mode TEXT NOT NULL,
    lease_path TEXT NOT NULL, creator_pid INTEGER NOT NULL, created_ms INTEGER NOT NULL,
    PRIMARY KEY (anchor_path, anchor_dev, anchor_ino)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS operation_lifetimes (
    anchor_path TEXT NOT NULL, anchor_dev TEXT NOT NULL, anchor_ino TEXT NOT NULL,
    anchor_uid TEXT NOT NULL, anchor_mode TEXT NOT NULL,
    lease_path TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL,
    uid TEXT NOT NULL, mode TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (anchor_path, anchor_dev, anchor_ino)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS dependency_transitions (
    path TEXT PRIMARY KEY, entry_key TEXT NOT NULL, kind TEXT NOT NULL,
    anchor_path TEXT, anchor_dev TEXT, anchor_ino TEXT,
    dev TEXT, ino TEXT, uid TEXT, mode TEXT
  ) STRICT;
`;

// Creator retirement can remove this module's source tree before settlement.
const lifetimeProcessSource = readFileSync(
  new URL("./cache-lifetime-process.py", import.meta.url),
  "utf8",
);

function processLifetime(command, payload, mutexFd) {
  const stdio = ["pipe", "pipe", "pipe"];
  if (mutexFd !== undefined) {
    while (stdio.length < 6) {
      stdio.push("ignore");
    }
    stdio.push(mutexFd);
  }
  const result = spawnSync(
    "python3",
    ["-I", "-B", "-c", lifetimeProcessSource, ...(Array.isArray(command) ? command : [command])],
    {
      input: JSON.stringify(payload),
      encoding: "utf8",
      stdio,
      timeout: 60_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `PR dependency lifetime inspection failed: ${result.stderr || result.error || result.status}`,
    );
  }
  return JSON.parse(result.stdout || "null");
}

function recordLifetime(context, anchor) {
  const path = process.env.OPENCLAW_PR_LIFETIME_FILE;
  if (!path) {
    return;
  }
  if (dirname(path) !== context.cache || !/^lifetime-[0-9]+-[a-f0-9-]+$/.test(basename(path))) {
    throw new Error("PR lifetime file is outside the cache");
  }
  const file = physicalFile(path);
  if (!same(file, fstatSync(7, { bigint: true }))) {
    throw new Error("PR lifetime descriptor changed");
  }
  const existing = context.db
    .prepare(
      "SELECT * FROM operation_lifetimes WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
    )
    .get(anchor.path, String(anchor.dev), String(anchor.ino));
  if (existing) {
    if (existing.lease_path !== path || !rowMatches(existing, "", file) || existing.retired) {
      throw new Error("PR operation lifetime changed");
    }
    return;
  }
  context.db
    .prepare("INSERT INTO operation_lifetimes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)")
    .run(anchor.path, ...identityValues(anchor), path, ...identityValues(file));
}

function createDependencyLifetime(anchor, creatorPid) {
  const cache = dependencyCacheRoot();
  return withDependencyCacheLock(cache, (lock) => {
    assertAnchor(anchor);
    const context = ledger(lock);
    const path = join(cache, `lifetime-${creatorPid}-${randomUUID()}`);
    // Commit before creating the file: SIGKILL on either side leaves replayable
    // bootstrap intent. No dependency operation starts before shared-lock registration.
    transaction(context, () => {
      context.db
        .prepare("INSERT INTO pending_lifetimes VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(anchor.path, ...identityValues(anchor), path, creatorPid, Date.now());
    });
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    return path;
  });
}

function registerDependencyLifetime(anchor) {
  return withDependencyCacheLock(dependencyCacheRoot(), (lock) => {
    assertAnchor(anchor);
    const context = ledger(lock);
    transaction(context, () => {
      const pending = context.db
        .prepare(
          "SELECT * FROM pending_lifetimes WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
        )
        .get(anchor.path, String(anchor.dev), String(anchor.ino));
      if (
        !pending ||
        pending.lease_path !== process.env.OPENCLAW_PR_LIFETIME_FILE ||
        !rowMatches(pending, "anchor_", anchor)
      ) {
        throw new Error("PR pending lifetime changed");
      }
      recordLifetime(context, anchor);
      context.db
        .prepare("DELETE FROM pending_lifetimes WHERE lease_path = ?")
        .run(pending.lease_path);
    });
  });
}

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

function openLedger(cache, cacheIdentity, create, readOnly, recovery = false) {
  const path = join(cache, ledgerName);
  // Opening a hot journal could repair the database before the sealed preimage
  // is checked. Explicit identity recovery never adopts unfinished SQL work.
  if (recovery && readdirSync(cache).some((name) => name.startsWith(`${ledgerName}-`))) {
    throw new Error("PR dependency recovery requires a journal-free ledger");
  }
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
          db.exec(ledgerSchema);
          db.prepare("INSERT INTO owner VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0)").run(
            ...identityValues(cacheIdentity),
            ...identityValues(file),
          );
        },
        true,
      );
    }
    // Only the explicit sealed recovery path may admit a mismatched owner.
    // It validates the complete preimage inside its synchronous transaction.
    if (!recovery) {
      assertLedgerOwner(context);
      if (!readOnly) {
        db.exec(lifetimeSchema);
      }
    }
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

function acquire(context, entry, anchor, fresh, stage) {
  const identity = entryIdentity(context.cache, entry);
  assertAnchor(anchor);
  if (!fresh) {
    installation(context, entry);
  }
  transaction(context, () => {
    recordLifetime(context, anchor);
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
    if (stage) {
      context.db.prepare("DELETE FROM dependency_transitions WHERE path = ?").run(stage);
    }
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

const identityRecord = (stat) =>
  Object.fromEntries(identityKeys.map((key) => [key, String(stat[key])]));

function recoverySnapshot(db) {
  const rows = (sql) =>
    db
      .prepare(sql)
      .all()
      .map((row) => Object.assign({}, row));
  return {
    owner: rows("SELECT * FROM owner ORDER BY id"),
    installations: rows("SELECT * FROM installations ORDER BY key"),
    holds: rows("SELECT * FROM holds ORDER BY entry_key, anchor_path, anchor_dev, anchor_ino"),
  };
}

function assertRecoverySchema(db) {
  const schema = (database) =>
    database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all();
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(ledgerSchema);
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'operation_lifetimes'").get()) {
      expected.exec(lifetimeSchema);
    }
    const integrity = db.prepare("PRAGMA quick_check").all();
    if (
      !isDeepStrictEqual(schema(db), schema(expected)) ||
      db.prepare("PRAGMA user_version").get().user_version !== 0 ||
      db.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1 ||
      integrity.length !== 1 ||
      integrity[0].quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length !== 0
    ) {
      throw new Error("PR dependency recovery ledger schema or integrity differs");
    }
  } finally {
    expected.close();
  }
}

// Device numbers are not durable volume identities. Only an operator-reviewed
// exact-state adoption may change them; ordinary opens must still reject drift.
export function recoverDependencyCache(planPath, planSha256) {
  const bytes = readFileSync(planPath);
  if (
    !/^[a-f0-9]{64}$/.test(planSha256) ||
    createHash("sha256").update(bytes).digest("hex") !== planSha256
  ) {
    throw new Error("PR dependency recovery plan seal differs");
  }
  const plan = JSON.parse(bytes);
  const cache = dependencyCacheRoot();
  if (
    plan.version !== 1 ||
    plan.cache !== cache ||
    typeof plan.reason !== "string" ||
    !plan.reason.trim() ||
    !Array.isArray(plan.before?.owner) ||
    plan.before.owner.length !== 1 ||
    !Array.isArray(plan.before.installations) ||
    !Array.isArray(plan.before.holds)
  ) {
    throw new Error("Invalid PR dependency recovery plan");
  }
  return withCacheOwner(
    cache,
    (lock) => {
      const context = ledger(lock);
      const physical = () => {
        const installations = plan.before.installations.map(({ key }) => ({
          key,
          ...identityRecord(entryIdentity(cache, join(cache, key))),
        }));
        const names = [ledgerName, ".metadata-lock", ...installations.map(({ key }) => key)];
        if (
          !isDeepStrictEqual(
            readdirSync(cache).toSorted((left, right) => left.localeCompare(right)),
            names.toSorted((left, right) => left.localeCompare(right)),
          )
        ) {
          throw new Error("PR dependency recovery namespace inventory differs");
        }
        return {
          cache: identityRecord(directory(cache)),
          database: identityRecord(physicalFile(context.path)),
          installations,
        };
      };
      const observed = physical();
      if (!isDeepStrictEqual(observed, plan.physical)) {
        throw new Error("PR dependency recovery physical identities differ");
      }
      const beforeOwner = plan.before.owner[0];
      const oldDevice = beforeOwner.cache_dev;
      const newDevice = observed.cache.dev;
      const postimage = {
        owner: [{ ...beforeOwner, cache_dev: newDevice, db_dev: newDevice }],
        installations: plan.before.installations.map((row) => ({ ...row, dev: newDevice })),
        holds: plan.before.holds,
      };
      if (
        !/^[0-9]+$/.test(oldDevice) ||
        oldDevice === newDevice ||
        beforeOwner.db_dev !== oldDevice ||
        observed.database.dev !== newDevice ||
        !rowMatches(postimage.owner[0], "cache_", observed.cache) ||
        !rowMatches(postimage.owner[0], "db_", observed.database) ||
        plan.before.installations.some(
          (row, index) =>
            row.dev !== oldDevice ||
            !rowMatches(postimage.installations[index], "", observed.installations[index]),
        )
      ) {
        throw new Error("PR dependency recovery permits only one device-number adoption");
      }
      const result = transaction(
        context,
        () => {
          assertRecoverySchema(context.db);
          const current = recoverySnapshot(context.db);
          if (isDeepStrictEqual(current, postimage)) {
            assertLedgerOwner(context);
            return "already-recovered";
          }
          if (!isDeepStrictEqual(current, plan.before)) {
            throw new Error("PR dependency recovery preimage differs; reconcile before retrying");
          }
          // The metadata mutex excludes native owners; BEGIN IMMEDIATE makes the
          // complete row comparison and these updates one SQLite writer section.
          ledger(lock);
          if (!isDeepStrictEqual(physical(), observed)) {
            throw new Error("PR dependency recovery identities changed before adoption");
          }
          const ownerUpdate = context.db
            .prepare(
              "UPDATE owner SET cache_dev = ?, db_dev = ? WHERE id = 1 AND cache_dev = ? AND db_dev = ?",
            )
            .run(newDevice, newDevice, oldDevice, oldDevice);
          if (ownerUpdate.changes !== 1) {
            throw new Error("PR dependency recovery owner changed");
          }
          const update = context.db.prepare(
            "UPDATE installations SET dev = ? WHERE key = ? AND dev = ?",
          );
          for (const { key } of plan.before.installations) {
            if (update.run(newDevice, key, oldDevice).changes !== 1) {
              throw new Error("PR dependency recovery installation changed");
            }
          }
          if (!isDeepStrictEqual(recoverySnapshot(context.db), postimage)) {
            throw new Error("PR dependency recovery postimage differs");
          }
          assertLedgerOwner(context);
          ledger(lock);
          // Our own DELETE journal exists until COMMIT; compare the sealed
          // objects directly rather than rejecting that transaction artifact.
          if (
            !same(directory(cache), context.cacheIdentity) ||
            observed.installations.some(
              (entry) => !rowMatches(entry, "", entryIdentity(cache, join(cache, entry.key))),
            )
          ) {
            throw new Error("PR dependency recovery physical identities changed");
          }
          return "recovered";
        },
        true,
      );
      return { state: result, installations: plan.before.installations.length, planSha256 };
    },
    false,
    false,
    true,
  );
}

function withCacheOwner(cache, operation, initialize, readOnly = false, recovery = false) {
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
        let owners;
        try {
          owners = readdirSync(path);
        } catch (missing) {
          if (missing.code === "ENOENT") {
            continue;
          }
          throw missing;
        }
        const ownerName = owners.find((name) => /^owner-[0-9]+-[a-f0-9-]+$/.test(name));
        if (ownerName && owners.length === 2 && owners.includes("lifetime")) {
          const pid = Number(ownerName.split("-")[1]);
          let gone = false;
          try {
            process.kill(pid, 0);
          } catch (failure) {
            gone = failure.code === "ESRCH";
          }
          if (gone) {
            // The metadata helper inherits this separate lock too: a killed JS
            // owner cannot release the mutex while its deletion child still runs.
            const leasePath = join(path, "lifetime");
            const checked = processLifetime("retire", {
              candidates: [
                {
                  id: path,
                  path,
                  identity: identityRecord(directory(path)),
                  lease: { path: leasePath, ...identityRecord(physicalFile(leasePath)) },
                  targets: [],
                },
              ],
              limit: 1,
            });
            if (checked.results[0].state === "retired") {
              continue;
            }
          }
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
  const mutexPath = join(path, "lifetime");
  const mutexFd = openSync(
    mutexPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600,
  );
  const lock = { cache, path, identity, owner };
  let context;
  try {
    processLifetime(["shared", "6"], null, mutexFd);
    if (created && readdirSync(cache).some((name) => name !== ".metadata-lock")) {
      throw new Error("New PR dependency namespace changed before initialization");
    }
    context = openLedger(cache, cacheIdentity, created, readOnly, recovery);
    Object.assign(context, {
      lockPath: path,
      lockIdentity: identity,
      owner,
      ownerIdentity,
      mutexFd,
    });
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
      try {
        releaseDependencyCacheLock(path, identity, owner, ownerIdentity, mutexPath, mutexFd);
      } finally {
        closeSync(mutexFd);
      }
    }
  }
}

function releaseDependencyCacheLock(path, identity, owner, ownerIdentity, mutexPath, mutexFd) {
  if (!same(directory(path), identity) || !same(directory(owner), ownerIdentity)) {
    throw new Error("PR cache metadata lock changed; retain it");
  }
  if (!same(physicalFile(mutexPath), fstatSync(mutexFd, { bigint: true }))) {
    throw new Error("PR metadata lifetime changed");
  }
  rmSync(mutexPath);
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

export function stageDependencyCache(lock, entry, anchor) {
  const context = ledger(lock);
  assertAnchor(anchor);
  if (dirname(entry) !== context.cache || !/^[a-f0-9]{64}$/.test(basename(entry))) {
    throw new Error("PR dependency installation is outside the lifetime namespace");
  }
  const stage = join(context.cache, `install-${process.pid}-${randomUUID().replaceAll("-", "")}`);
  // Commit intent before mkdir: neither a killed installer nor a failed publish
  // can create an unexplained directory. The operation lease protects both names.
  transaction(context, () => {
    recordLifetime(context, anchor);
    context.db
      .prepare(
        "INSERT INTO dependency_transitions VALUES (?, ?, 'install', ?, ?, ?, NULL, NULL, NULL, NULL)",
      )
      .run(stage, basename(entry), anchor.path, String(anchor.dev), String(anchor.ino));
  });
  mkdirSync(stage, { mode: 0o700 });
  context.db
    .prepare("UPDATE dependency_transitions SET dev = ?, ino = ?, uid = ?, mode = ? WHERE path = ?")
    .run(...identityValues(directory(stage)), stage);
  return stage;
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
  // Current producers recorded the stage first; old frozen producers retain
  // the explicit >24h orphan policy if they die between rename and commit.
  renameSync(stage, entry);
  acquire(context, entry, anchor, true, stage);
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
  let budget = 4;
  const pending = context.db
    .prepare("SELECT * FROM pending_lifetimes")
    .all()
    .map((row) => {
      if (
        dirname(row.lease_path) !== context.cache ||
        !/^lifetime-[0-9]+-[a-f0-9-]+$/.test(basename(row.lease_path))
      ) {
        throw new Error("PR pending lifetime is outside the cache");
      }
      const lease = lstatSync(row.lease_path, { throwIfNoEntry: false })
        ? { path: row.lease_path, ...identityRecord(physicalFile(row.lease_path)) }
        : undefined;
      return {
        id: row.lease_path,
        path: row.anchor_path,
        identity: Object.fromEntries(identityKeys.map((key) => [key, row[`anchor_${key}`]])),
        lease,
        pending: { pid: row.creator_pid, createdMs: row.created_ms },
        targets: [row.anchor_path, row.lease_path],
      };
    });
  if (pending.length) {
    const { results } = processLifetime(
      "retire",
      { candidates: pending, limit: budget },
      context.mutexFd,
    );
    for (const result of results.filter((item) => item.state === "retired")) {
      const candidate = pending.find((item) => item.id === result.id);
      if (candidate.lease) {
        if (!rowMatches(candidate.lease, "", physicalFile(candidate.id))) {
          throw new Error("PR pending lifetime changed before retirement");
        }
        rmSync(candidate.id);
      }
      context.db.prepare("DELETE FROM pending_lifetimes WHERE lease_path = ?").run(candidate.id);
      budget--;
    }
  }
  const lifetimes = context.db.prepare("SELECT * FROM operation_lifetimes").all();
  const anchors = new Map();
  const anchorKey = (row) => JSON.stringify([row.anchor_path, row.anchor_dev, row.anchor_ino]);
  for (const row of context.db
    .prepare(
      "SELECT DISTINCT anchor_path, anchor_dev, anchor_ino, anchor_uid, anchor_mode FROM holds",
    )
    .all()) {
    anchors.set(anchorKey(row), row);
  }
  for (const row of lifetimes) {
    if (!row.retired) {
      anchors.set(anchorKey(row), row);
    }
  }
  const candidates = [...anchors.values()]
    .map((row) => {
      const identity = Object.fromEntries(identityKeys.map((key) => [key, row[`anchor_${key}`]]));
      const entries = anchorRows(
        context.db,
        Object.assign({ path: row.anchor_path }, identity),
      ).map((hold) => join(context.cache, hold.entry_key));
      const stat = lstatSync(row.anchor_path, { throwIfNoEntry: false });
      return {
        id: anchorKey(row),
        path: row.anchor_path,
        identity,
        lease: row.lease_path
          ? Object.assign({ path: row.lease_path }, identityRecord(row))
          : undefined,
        legacy: row.lease_path
          ? undefined
          : {
              pid: Number(
                basename(row.anchor_path).match(/^openclaw-pr-anchor-v3\.([0-9]+)\./)?.[1],
              ),
              // A missing legacy anchor has no recorded birthday. The ledger's last
              // write is a conservative upper bound on the hold's creation time.
              createdMs: stat?.birthtimeMs || Number(context.file.mtimeMs),
              modifiedMs: stat?.mtimeMs || Number(context.file.mtimeMs),
            },
        targets: [row.anchor_path, ...entries],
      };
    })
    .filter(
      (candidate) => candidate.lease || Date.now() - candidate.legacy.modifiedMs > 86_400_000,
    );
  if (candidates.length) {
    const { results } = processLifetime("retire", { candidates, limit: budget }, context.mutexFd);
    for (const result of results.filter((item) => item.state === "retired")) {
      const row = anchors.get(result.id);
      const anchor = {
        path: row.anchor_path,
        ...Object.fromEntries(identityKeys.map((key) => [key, BigInt(row[`anchor_${key}`])])),
      };
      settleRetirement(context, anchor, retirementSnapshot(context, anchor));
      budget--;
    }
  }
  const retired = [];
  for (const row of context.db
    .prepare(
      "SELECT t.*, l.retired FROM dependency_transitions t LEFT JOIN operation_lifetimes l ON l.anchor_path = t.anchor_path AND l.anchor_dev = t.anchor_dev AND l.anchor_ino = t.anchor_ino ORDER BY t.path",
    )
    .all()) {
    if (budget <= 0) {
      break;
    }
    if (row.kind === "install" && !row.retired) {
      continue;
    }
    const entry = join(context.cache, row.entry_key);
    if (
      dirname(row.path) !== context.cache ||
      !/^[a-f0-9]{64}$/.test(row.entry_key) ||
      !/^(?:install-[0-9]+-[A-Za-z0-9]+|retired-[a-f0-9-]+)$/.test(basename(row.path))
    ) {
      throw new Error("PR dependency transition is outside the lifetime namespace");
    }
    const source = lstatSync(row.path, { throwIfNoEntry: false }) ? row.path : entry;
    const registered = context.db
      .prepare("SELECT 1 FROM installations WHERE key = ?")
      .get(row.entry_key);
    if (source === entry && registered) {
      context.db.prepare("DELETE FROM dependency_transitions WHERE path = ?").run(row.path);
      continue;
    }
    if (!lstatSync(source, { throwIfNoEntry: false })) {
      context.db.prepare("DELETE FROM dependency_transitions WHERE path = ?").run(row.path);
      continue;
    }
    const identity = directory(source);
    if (row.dev !== null && !rowMatches(row, "", identity)) {
      throw new Error("PR dependency transition identity changed");
    }
    if (row.kind === "install") {
      // Do not remove an entry another pending publisher owns.
      if (
        source === entry &&
        context.db
          .prepare(
            "SELECT 1 FROM dependency_transitions WHERE entry_key = ? AND path != ? AND kind = 'install'",
          )
          .get(row.entry_key, row.path)
      ) {
        continue;
      }
      rmSync(source, { recursive: true });
      context.db.prepare("DELETE FROM dependency_transitions WHERE path = ?").run(row.path);
    } else {
      if (source !== row.path) {
        renameSync(source, row.path);
      }
      retired.push(row.path);
    }
    budget--;
  }
  for (const row of lifetimes) {
    if (
      context.db
        .prepare(
          "SELECT 1 FROM holds WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ? UNION ALL SELECT 1 FROM dependency_transitions WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
        )
        .get(
          row.anchor_path,
          row.anchor_dev,
          row.anchor_ino,
          row.anchor_path,
          row.anchor_dev,
          row.anchor_ino,
        )
    ) {
      continue;
    }
    if (
      !context.db
        .prepare(
          "SELECT 1 FROM operation_lifetimes WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ? AND retired = 1",
        )
        .get(row.anchor_path, row.anchor_dev, row.anchor_ino)
    ) {
      continue;
    }
    const checked = processLifetime(
      "retire",
      {
        candidates: [
          {
            id: row.lease_path,
            path: row.anchor_path,
            identity: Object.fromEntries(identityKeys.map((key) => [key, row[`anchor_${key}`]])),
            lease: { path: row.lease_path, ...identityRecord(row) },
            targets: [],
          },
        ],
        limit: 1,
      },
      context.mutexFd,
    );
    if (checked.results[0].state !== "retired") {
      continue;
    }
    if (!rowMatches(row, "", physicalFile(row.lease_path))) {
      throw new Error("PR lifetime file changed before retirement");
    }
    context.db
      .prepare(
        "DELETE FROM operation_lifetimes WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
      )
      .run(row.anchor_path, row.anchor_dev, row.anchor_ino);
    rmSync(row.lease_path);
  }
  const rows = context.db
    .prepare(`
    SELECT * FROM installations i WHERE settled = 1
      AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.entry_key = i.key)
    ORDER BY last_used DESC, key
  `)
    .all()
    .filter((row) => join(context.cache, row.key) !== current);
  const unused = rows
    .map((row) => {
      const entry = join(context.cache, row.key);
      const { identity } = installation(context, entry);
      return { row, entry, identity };
    })
    .slice(4, 4 + budget);
  for (const { row, entry, identity } of unused) {
    const detached = join(context.cache, `retired-${randomUUID()}`);
    // Record detach intent in the same commit that removes reuse eligibility.
    // A kill on either side of rename leaves a recoverable, owned transition.
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
      context.db
        .prepare(
          "INSERT INTO dependency_transitions VALUES (?, ?, 'retire', NULL, NULL, NULL, ?, ?, ?, ?)",
        )
        .run(detached, row.key, ...identityValues(identity));
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
    budget--;
  }
  if (budget > 0) {
    const owned = new Set(
      context.db
        .prepare(
          "SELECT key FROM installations UNION SELECT entry_key AS key FROM dependency_transitions UNION SELECT substr(path, length(?) + 2) AS key FROM dependency_transitions",
        )
        .all(context.cache)
        .map(({ key }) => key),
    );
    const orphans = [];
    for (const name of readdirSync(context.cache)) {
      if (
        owned.has(name) ||
        !/^(?:[a-f0-9]{64}|install-[0-9]+-[A-Za-z0-9]+|retired-[a-f0-9-]+)$/.test(name)
      ) {
        continue;
      }
      const path = join(context.cache, name);
      const stat = lstatSync(path, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.uid !== BigInt(process.getuid()) ||
        (stat.mode & 0o7777n) !== 0o700n
      ) {
        continue;
      }
      if (Date.now() - Number(stat.mtimeMs) <= 86_400_000) {
        continue;
      }
      orphans.push({
        id: name,
        path,
        identity: identityRecord(stat),
        orphan: true,
        targets: [path],
      });
    }
    // Disposable legacy scratch: >24h plus no cwd/fd/maps reference is the
    // approved contract, even for a dormant child with only a pathname in memory.
    if (orphans.length) {
      processLifetime("retire", { candidates: orphans, limit: budget }, context.mutexFd);
    }
  }
  return retired;
}

function retirementSnapshot(context, anchor, reviewed) {
  const rows = anchorRows(context.db, anchor);
  const owned = rows.map((row) => {
    assertHold(row, anchor);
    const entry = join(context.cache, row.entry_key);
    const { identity } = installation(context, entry);
    return { row, entry, identity };
  });
  if (
    reviewed &&
    !isDeepStrictEqual(
      owned.map(({ row, identity }) => ({ key: row.entry_key, ...identityRecord(identity) })),
      reviewed.holds.toSorted((left, right) => left.key.localeCompare(right.key)),
    )
  ) {
    throw new Error("PR dependency reviewed holds differ; retain them");
  }
  return { owned, cacheIdentity: context.cacheIdentity, fileIdentity: context.file };
}

function settleRetirement(context, anchor, snapshot) {
  const { owned, cacheIdentity, fileIdentity } = snapshot;
  if (!same(context.cacheIdentity, cacheIdentity) || !same(context.file, fileIdentity)) {
    throw new Error("PR cache ledger identity changed after anchor retirement");
  }
  for (const { entry, identity } of owned) {
    if (!same(installation(context, entry).identity, identity)) {
      throw new Error("PR dependency installation changed after anchor retirement");
    }
  }
  return transaction(context, () => {
    const rows = anchorRows(context.db, anchor);
    if (
      !isDeepStrictEqual(
        rows,
        owned.map(({ row }) => row),
      )
    ) {
      throw new Error("PR dependency holds changed after retirement; retain them");
    }
    const settled = [],
      retained = [];
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
      const result = context.db
        .prepare(`
        UPDATE installations SET settled = 1 WHERE key = ?
          AND NOT EXISTS (SELECT 1 FROM holds WHERE entry_key = ?)
      `)
        .run(row.entry_key, row.entry_key);
      (result.changes ? settled : retained).push(row.entry_key);
    }
    context.db
      .prepare(
        "UPDATE operation_lifetimes SET retired = 1 WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
      )
      .run(anchor.path, String(anchor.dev), String(anchor.ino));
    return { state: "released", settled, retained };
  });
}

export function readDependencyHolds() {
  const cache = dependencyCacheRoot();
  if (!lstatSync(cache, { throwIfNoEntry: false })) {
    return { cache, holds: [] };
  }
  const holds = withCacheOwner(
    cache,
    (lock) => {
      const rows = ledger(lock)
        .db.prepare(`
      SELECT h.*, i.dev, i.ino, i.uid, i.mode FROM holds h
      JOIN installations i ON i.key = h.entry_key
      ORDER BY anchor_path, anchor_dev, anchor_ino, entry_key
    `)
        .all();
      const anchors = new Map();
      for (const row of rows) {
        const key = JSON.stringify([row.anchor_path, row.anchor_dev, row.anchor_ino]);
        if (!anchors.has(key)) {
          anchors.set(key, {
            path: row.anchor_path,
            ...Object.fromEntries(identityKeys.map((name) => [name, row[`anchor_${name}`]])),
            holds: [],
          });
        }
        anchors.get(key).holds.push({ key: row.entry_key, ...identityRecord(row) });
      }
      return [...anchors.values()];
    },
    false,
    true,
  );
  return { cache, holds };
}

export function dependencyHoldState(hold) {
  const inspect = (read, identity) => {
    try {
      const stat = read();
      return { state: rowMatches(identity, "", stat) ? "present" : "changed", stat };
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        return { state: "missing" };
      }
      if (error.message.startsWith("Unsafe PR lifetime directory:")) {
        return { state: "changed" };
      }
      throw error;
    }
  };
  const anchor = inspect(() => directory(hold.path), hold);
  const cache = dependencyCacheRoot();
  const entries = hold.holds.map((entry) =>
    inspect(() => entryIdentity(cache, join(cache, entry.key)), entry),
  );
  return {
    anchor: anchor.state,
    ...(anchor.state === "present" ? { created: anchor.stat.birthtime.toISOString() } : {}),
    entriesIntact: entries.every((entry) => entry.state === "present"),
  };
}

export function releaseFinishedAnchor(reviewed) {
  const cache = dependencyCacheRoot();
  const empty = { state: "already-released", settled: [], retained: [] };
  if (!lstatSync(cache, { throwIfNoEntry: false })) {
    return empty;
  }
  const anchor = {
    path: reviewed.path,
    ...Object.fromEntries(identityKeys.map((key) => [key, BigInt(reviewed[key])])),
  };
  const snapshot = withCacheOwner(
    cache,
    (lock) => {
      const context = ledger(lock);
      if (anchorRows(context.db, anchor).length === 0) {
        return undefined;
      }
      return {
        ...retirementSnapshot(context, anchor, reviewed),
        lifetime: context.db
          .prepare(
            "SELECT * FROM operation_lifetimes WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
          )
          .get(anchor.path, String(anchor.dev), String(anchor.ino)),
      };
    },
    false,
  );
  // Holds alone authorize removal. An already released plan never touches its path.
  if (!snapshot) {
    return empty;
  }
  if (snapshot.lifetime) {
    const row = snapshot.lifetime;
    const checked = processLifetime("retire", {
      candidates: [
        {
          id: anchor.path,
          path: anchor.path,
          identity: identityRecord(anchor),
          lease: { path: row.lease_path, ...identityRecord(row) },
          targets: [],
        },
      ],
      limit: 1,
    });
    if (checked.results[0].state !== "retired") {
      throw new Error("PR dependency lifetime remains held; retain anchor");
    }
  } else if (lstatSync(anchor.path, { throwIfNoEntry: false })) {
    if (!same(directory(anchor.path), anchor)) {
      throw new Error("PR anchor identity changed; retain it");
    }
    rmSync(anchor.path, { recursive: true });
    if (lstatSync(anchor.path, { throwIfNoEntry: false })) {
      throw new Error("PR anchor retirement not confirmed");
    }
  }
  return withCacheOwner(cache, (lock) => settleRetirement(ledger(lock), anchor, snapshot), false);
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
  const snapshot = withCacheOwner(
    cache,
    (lock) => {
      assertAnchor(anchor);
      const context = ledger(lock);
      // A drained group/notification pipe is not the new lifetime's authority:
      // an escaped descendant may still hold FD7. The creator also holds it,
      // so let the next invocation acquire EX after the final descriptor closes.
      if (
        context.db
          .prepare(
            "SELECT 1 FROM operation_lifetimes WHERE anchor_path = ? AND anchor_dev = ? AND anchor_ino = ?",
          )
          .get(anchor.path, String(anchor.dev), String(anchor.ino))
      ) {
        return undefined;
      }
      return retirementSnapshot(context, anchor);
    },
    false,
  );
  if (!snapshot) {
    return;
  }
  // Holds stay committed throughout the creator's full-drain retirement.
  // PID death, missing paths, or failed reentry are never release authority.
  assertAnchor(anchor);
  retire();
  if (lstatSync(anchor.path, { throwIfNoEntry: false })) {
    throw new Error("PR anchor retirement not confirmed");
  }
  withCacheOwner(cache, (lock) => settleRetirement(ledger(lock), anchor, snapshot), false);
}

export function sweepDependencyCaches() {
  const cache = dependencyCacheRoot();
  if (!lstatSync(cache, { throwIfNoEntry: false })) {
    return;
  }
  const retired = withDependencyCacheLock(cache, (lock) => collectUnusedDependencyCaches(lock));
  for (const path of retired) {
    rmSync(path, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "create-lifetime") {
    const creatorPid = Number(process.argv[4]);
    process.stdout.write(
      createDependencyLifetime(claimCreatedAnchor(process.argv[3], creatorPid), creatorPid),
    );
  } else if (process.argv[2] === "register-lifetime") {
    registerDependencyLifetime(claimCreatedAnchor(process.argv[3], Number(process.argv[4])));
  } else if (process.argv[2] === "collect") {
    try {
      sweepDependencyCaches();
    } catch (error) {
      console.error(`Warning: retaining PR dependency cache entries: ${error.message}`);
    }
  } else {
    throw new Error("Expected create-lifetime, register-lifetime or collect");
  }
}
