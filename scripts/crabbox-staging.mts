import { spawnSync } from "node:child_process";
import { createHash, randomUUID, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  crabboxArtifactEvidenceSchema,
  crabboxArtifactIdentitySchema,
  preserveCrabboxArtifacts,
  verifyPreservedCrabboxArtifacts,
  type CrabboxArtifactEvidence,
  type CrabboxArtifactIdentity,
} from "./crabbox-staging-artifacts.mts";
import {
  captureClaimNamespace,
  claimNamespaceSchema,
  verifyNoStagingClaims,
  type ClaimNamespace,
} from "./crabbox-staging-claims.mts";
import { canRecordStaging, stagingPrefix } from "./crabbox-staging-location.mts";
import {
  selectSourceWitness,
  verifySourceWitness,
  type FrozenSource,
  type SourceWitness,
} from "./crabbox-staging-witness.mts";

const prefix = stagingPrefix;
const receiptName = "staging.json";
const manifestName = "manifest.json";
const cursorName = prefix + "discovery";
const headerLimit = 32 * 1024;
const manifestLimit = 64 * 1024 * 1024;
const identitySchema = crabboxArtifactIdentitySchema;
const witnessSchema = z.strictObject({
  gitDir: z.string(),
  ref: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
});
const receiptSchema = z.strictObject({
  version: z.literal(2),
  id: z.uuid(),
  ownerPid: z.number().int().min(2),
  ownerDomain: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  repository: z.string(),
  repositoryIdentity: identitySchema.optional(),
  claims: claimNamespaceSchema.optional(),
  leases: z.array(z.string().min(1).max(512)).max(16).optional(),
  kind: z.enum(["capsule", "worktree"]),
  rootIdentity: identitySchema,
  payloadIdentity: identitySchema,
  durable: z.boolean(),
  users: z.enum(["none", "admitted", "settled"]),
  state: z.enum(["preparing", "prepared", "admitted", "settled", "preserved", "removing"]),
  manifest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  witness: witnessSchema.optional(),
  artifactManifest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  mirror: z
    .strictObject({
      key: z.string().regex(/^[a-f0-9]{64}$/u),
      slotIdentity: identitySchema,
      idle: z.boolean(),
      disposing: z.literal(true).optional(),
      lastUsed: z.number().int().nonnegative(),
      database: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
    })
    .optional(),
  hold: z.enum(["artifacts", "claims", "writers", "registration"]).optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
const disposalSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  key: z.string().regex(/^[a-f0-9]{64}$/u),
  slotIdentity: identitySchema,
  // An absent receipt records root absence; it never authorizes deleting a root.
  receipt: receiptSchema.optional(),
});
type Disposal = z.infer<typeof disposalSchema>;
type Identity = CrabboxArtifactIdentity;
const entrySchema = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["file", "symlink", "directory"]),
  mode: z.enum(["100644", "100755", "120000"]).optional(),
  blob: z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .optional(),
});
type Entry = z.infer<typeof entrySchema>;
const sourceEntrySchema = z.strictObject({
  path: z.string().min(1),
  mode: z.enum(["100644", "100755", "120000"]),
  blob: z.string().regex(/^[a-f0-9]{40}$/u),
});
const manifestSchema = z.strictObject({
  source: z.strictObject({
    files: z.array(sourceEntrySchema),
    deleted: z.array(z.string()),
  }),
  entries: z.array(entrySchema),
  artifacts: crabboxArtifactEvidenceSchema.optional(),
});
type Manifest = z.infer<typeof manifestSchema>;

let cachedProcessDomain: string | null | undefined;
function processDomain() {
  if (cachedProcessDomain !== undefined) {
    return cachedProcessDomain ?? undefined;
  }
  try {
    let boot: string;
    let namespace = "";
    if (process.platform === "linux") {
      const fd = openSync(
        "/proc/sys/kernel/random/boot_id",
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        const bytes = Buffer.alloc(128);
        boot = bytes.subarray(0, readSync(fd, bytes)).toString("utf8").trim();
      } finally {
        closeSync(fd);
      }
      namespace = readlinkSync("/proc/self/ns/pid");
      if (!/^pid:\[\d+\]$/u.test(namespace)) {
        throw new Error("Process namespace identity is unavailable.");
      }
    } else if (process.platform === "darwin") {
      const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8",
        env: {},
        timeout: 1000,
        maxBuffer: 1024,
      });
      if (result.error || result.status !== 0) {
        throw new Error("Boot session identity is unavailable.");
      }
      boot = result.stdout.trim();
    } else {
      throw new Error("Process domain identity is unsupported.");
    }
    if (!z.uuid().safeParse(boot.toLowerCase()).success) {
      throw new Error("Boot session identity is invalid.");
    }
    cachedProcessDomain = createHash("sha256")
      .update(process.platform + ":" + boot.toLowerCase() + ":" + namespace)
      .digest("hex");
  } catch {
    cachedProcessDomain = null;
  }
  return cachedProcessDomain ?? undefined;
}

function identity(path: string): Identity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("staging directory was replaced: " + path);
  }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(left: Identity, right: Identity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertIdentity(path: string, expected: Identity) {
  if (!sameIdentity(identity(path), expected)) {
    throw new Error("staging directory identity changed: " + path);
  }
}

function safeRelative(path: string) {
  return (
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function readBounded(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) {
      throw new Error("staging metadata is not a bounded regular file");
    }
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) {
        throw new Error("staging metadata became shorter while reading");
      }
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("staging metadata changed while reading");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string) {
  // Windows does not expose a directory flush through this Node API. Such
  // receipts remain useful for inspection, but never authorize orphan removal.
  if (process.platform === "win32") {
    return false;
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    fsyncSync(fd);
    return true;
  } catch (error) {
    if (
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return false;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function syncFile(fd: number) {
  try {
    fsyncSync(fd);
    return true;
  } catch (error) {
    if (
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return false;
    }
    throw error;
  }
}

function writeAtomic(root: string, name: string, bytes: string, durable = true) {
  const temporary = join(root, "." + name + "." + randomUUID());
  try {
    let fileDurable = false;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fileDurable = durable && syncFile(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(root, name));
    return fileDurable && syncDirectory(root);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function blob(path: string, symbolic: boolean) {
  if (symbolic) {
    const bytes = readlinkSync(path, { encoding: "buffer" });
    return createHash("sha1")
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex");
  }
  return regularFileDigest(path, (size) => createHash("sha1").update("blob " + size + "\0"));
}

function regularFileDigest(path: string, initialize: (size: bigint) => Hash) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) {
      throw new Error("staging contains an unsupported file");
    }
    const hash = initialize(before.size);
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = readSync(fd, buffer);
      if (!count) {
        break;
      }
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("staging content changed while reading");
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function artifactPath(path: string) {
  return (
    path === "source/.crabbox" ||
    ["source/.crabbox/runs", "source/.crabbox/captures"].some(
      (root) => path === root || path.startsWith(root + "/"),
    )
  );
}

function inventory(
  payload: string,
  known = new Map<string, Entry>(),
  preservedArtifacts = false,
  observeEntry?: (path: string, stat: Stats) => void,
): Entry[] {
  const entries: Entry[] = [];
  const walk = (directory: string, parent: string) => {
    for (const name of readdirSync(directory)) {
      const path = parent ? parent + "/" + name : name;
      if (preservedArtifacts && artifactPath(path) && path !== "source/.crabbox") {
        continue;
      }
      if (!safeRelative(path)) {
        throw new Error("staging contains an unsupported path");
      }
      const absolute = join(payload, path);
      const stat = lstatSync(absolute);
      observeEntry?.(path, stat);
      if (stat.isDirectory()) {
        if (!preservedArtifacts || path !== "source/.crabbox") {
          entries.push({ path, kind: "directory" });
        }
        walk(absolute, path);
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        const symbolic = stat.isSymbolicLink();
        const mode = symbolic ? "120000" : stat.mode & 0o100 ? "100755" : "100644";
        const frozen = known.get(path);
        if (frozen && frozen.mode !== mode) {
          throw new Error("source mode changed before sealing: " + path);
        }
        entries.push({
          path,
          kind: symbolic ? "symlink" : "file",
          mode,
          blob: frozen?.blob ?? blob(absolute, symbolic),
        });
      } else {
        throw new Error("staging contains an unsupported file kind: " + path);
      }
    }
  };
  walk(payload, "");
  return entries.toSorted((a, b) => a.path.localeCompare(b.path));
}

function readReceipt(root: string) {
  identity(root);
  let receipt: Receipt;
  try {
    receipt = receiptSchema.parse(
      JSON.parse(readBounded(join(root, receiptName), headerLimit).toString("utf8")),
    );
  } catch {
    throw new Error("staging receipt has unknown or invalid metadata");
  }
  if (basename(root) !== prefix + receipt.id) {
    throw new Error("staging generation does not match its directory");
  }
  assertIdentity(root, receipt.rootIdentity);
  return receipt;
}

function ownerAbsent(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export type StagingHandle = {
  recorded: boolean;
  root: string;
  payload: string;
  prepared: (
    source: FrozenSource,
    witness?: SourceWitness,
    observeEntry?: (path: string, stat: Stats) => void,
  ) => void;
  admitted: (claims?: ClaimNamespace, leases?: string[]) => void;
  settled: (leases?: string[]) => void;
  preserved: (artifacts: CrabboxArtifactEvidence) => void;
  hold: (reason: NonNullable<Receipt["hold"]>) => void;
  dispose: () => void;
};

export function createStaging(
  syncRoot: string,
  repository: string,
  kind: Receipt["kind"] = "capsule",
): StagingHandle {
  const id = randomUUID();
  mkdirSync(syncRoot, { recursive: true });
  const root = join(realpathSync(syncRoot), prefix + id);
  mkdirSync(root, { mode: 0o700 });
  const recorded = canRecordStaging(root, repository);
  const payload = join(root, "payload");
  let receipt: Receipt;
  try {
    mkdirSync(payload, { mode: 0o700 });
    receipt = {
      version: 2,
      id,
      ownerPid: process.pid,
      ownerDomain: recorded ? processDomain() : undefined,
      repository: realpathSync(repository),
      repositoryIdentity: identity(realpathSync(repository)),
      kind,
      rootIdentity: identity(root),
      payloadIdentity: identity(payload),
      durable: recorded && syncDirectory(root) && syncDirectory(dirname(root)),
      users: "none",
      state: "preparing",
    };
    if (
      recorded &&
      !writeAtomic(root, receiptName, JSON.stringify(receipt) + "\n", receipt.durable) &&
      receipt.durable
    ) {
      receipt.durable = false;
      writeAtomic(root, receiptName, JSON.stringify(receipt) + "\n", false);
    }
  } catch (error) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Staging preparation failed; allocation retained at " + root,
        { cause: cleanupError },
      );
    }
    throw error;
  }
  return stagingHandle(root, receipt, recorded);
}

function stagingHandle(root: string, initialReceipt: Receipt, recorded: boolean): StagingHandle {
  let receipt = initialReceipt;
  const payload = join(root, "payload");
  const update = (fields: Partial<Receipt>) => {
    assertIdentity(root, receipt.rootIdentity);
    receipt = { ...receipt, ...fields };
    if (!recorded) {
      return;
    }
    // Unsupported durability is terminal for this generation, including later
    // metadata writes. The live producer still owns ordinary cleanup.
    if (
      !writeAtomic(root, receiptName, JSON.stringify(receipt) + "\n", receipt.durable) &&
      receipt.durable
    ) {
      receipt.durable = false;
      writeAtomic(root, receiptName, JSON.stringify(receipt) + "\n", false);
    }
  };
  let disposed = false;
  return {
    recorded,
    root,
    payload,
    prepared(source, witness, observeEntry) {
      if (!recorded) {
        return;
      }
      const known = new Map<string, Entry>(
        source.files.map((entry) => [
          "source/" + entry.path,
          {
            ...entry,
            path: "source/" + entry.path,
            kind: entry.mode === "120000" ? "symlink" : "file",
          },
        ]),
      );
      const manifest: Manifest = {
        source,
        entries: inventory(payload, known, false, observeEntry),
      };
      const bytes = JSON.stringify(manifest) + "\n";
      if (Buffer.byteLength(bytes) > manifestLimit) {
        throw new Error("staging manifest exceeds the recovery metadata limit");
      }
      const durable = writeAtomic(root, manifestName, bytes, receipt.durable);
      let claims: ClaimNamespace | undefined;
      try {
        claims = captureClaimNamespace(join(payload, "source"));
      } catch {
        // Missing claim-location evidence withholds orphan recovery, not ordinary use.
      }
      update({
        durable,
        claims,
        state: "prepared",
        manifest: createHash("sha256").update(bytes).digest("hex"),
        witness,
      });
    },
    admitted: (claims, leases) => update({ state: "admitted", users: "admitted", claims, leases }),
    settled: (leases) =>
      update({ state: "settled", users: "settled", leases: leases ?? receipt.leases }),
    preserved(artifacts) {
      if (!recorded) {
        return;
      }
      assertIdentity(root, receipt.rootIdentity);
      const saved = writeArtifactRecord(root, artifacts, receipt.durable);
      update({
        state: "preserved",
        durable: saved.durable && receipt.durable && artifacts.durable,
        artifactManifest: saved.digest,
      });
    },
    // A retryable cleanup failure cannot certify earlier preparation writers.
    hold: (hold) => update({ hold: receipt.hold === "writers" ? "writers" : hold }),
    dispose() {
      if (disposed) {
        return;
      }
      // The live producer may dispose its own dirty snapshot after normal
      // settlement. Independent-source proof applies only to a later owner.
      update({ state: "removing" });
      assertIdentity(payload, receipt.payloadIdentity);
      rmSync(payload, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      disposed = true;
    },
  };
}

const mirrorLimit = 32;
const mirrorDatabase = "mirror.sqlite";

function privateMirrorDirectory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("source mirror directory is not private: " + path);
  }
  return identity(path);
}

function mirrorLock(path: string, waitForAllocation = false) {
  const parent = dirname(path);
  const parentIdentity = privateMirrorDirectory(parent);
  try {
    closeSync(
      openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const captured = lstatSync(path, { bigint: true });
  if (
    !captured.isFile() ||
    captured.isSymbolicLink() ||
    captured.nlink !== 1n ||
    captured.size !== 0n ||
    (captured.mode & 0o077n) !== 0n ||
    (process.getuid && captured.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("source mirror lock is not a private empty regular database");
  }
  let released = false;
  const assertOwned = () => {
    assertIdentity(parent, parentIdentity);
    const current = lstatSync(path, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      current.dev !== captured.dev ||
      current.ino !== captured.ino ||
      current.mode !== captured.mode ||
      current.size !== 0n
    ) {
      throw new Error("source mirror lock ownership changed");
    }
  };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { timeout: 0 });
    // A lock-only transaction never commits data or writes a journal. SQLite
    // owns every open descriptor so closing a competing connection cannot drop
    // another connection's POSIX locks. Kernel locks disappear on producer exit.
    try {
      database.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
    } catch (error) {
      if (!waitForAllocation || !sqliteBusy(error)) {
        throw error;
      }
      console.error("[crabbox] waiting for source mirror allocation...");
      const deadline = performance.now() + 120_000;
      database.exec("PRAGMA busy_timeout=120000");
      database.exec("PRAGMA journal_mode=MEMORY");
      // SQLite resets its busy budget for each statement, and another allocator
      // can win between the journal-mode probe and BEGIN.
      const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
      database.exec(`PRAGMA busy_timeout=${remaining}`);
      database.exec("BEGIN EXCLUSIVE");
    }
    assertOwned();
  } catch (error) {
    database?.close();
    if (sqliteBusy(error)) {
      return undefined;
    }
    throw error;
  }
  const connection = database;
  const release = () => {
    if (released) {
      return;
    }
    assertOwned();
    connection.exec("ROLLBACK");
    connection.close();
    released = true;
  };
  const remove = () => {
    if (!released) {
      throw new Error("cannot remove an active source mirror lock");
    }
    assertOwned();
    rmSync(path);
  };
  return Object.assign(release, { assertOwned, remove });
}

function sqliteBusy(error: unknown) {
  return typeof error === "object" && error !== null && "errcode" in error && error.errcode === 5;
}

function mirrorSlot(syncRoot: string, key: string, expectedId?: string) {
  const slot = join(syncRoot, "mirrors", key);
  const slotIdentity = privateMirrorDirectory(slot);
  if (readdirSync(slot).some((name) => name !== "stage" && name !== "lock")) {
    throw new Error("source mirror slot has unknown metadata");
  }
  const id = lstatSync(join(slot, "stage"), { throwIfNoEntry: false })
    ? readBounded(join(slot, "stage"), 128).toString("utf8").trim()
    : expectedId;
  if (!id || !z.uuid().safeParse(id).success) {
    throw new Error("source mirror slot has an invalid staging identity");
  }
  const root = join(syncRoot, prefix + id);
  const { receipt, disposal } = readMirrorState(syncRoot, id);
  if (
    receipt &&
    (receipt.mirror?.key !== key || !sameIdentity(receipt.mirror.slotIdentity, slotIdentity))
  ) {
    throw new Error("source mirror staging ownership does not match its slot");
  }
  return { slot, slotIdentity, root, receipt, disposal, id };
}

function idleMirror(receipt: Receipt) {
  return Boolean(
    receipt.mirror?.idle &&
    receipt.durable &&
    receipt.manifest &&
    !receipt.hold &&
    ((receipt.users === "none" && receipt.state === "prepared") ||
      (receipt.users === "settled" && receipt.state === "preserved")),
  );
}

function saveMirrorReceipt(root: string, receipt: Receipt) {
  assertIdentity(root, receipt.rootIdentity);
  if (!writeAtomic(root, receiptName, JSON.stringify(receipt) + "\n")) {
    writeAtomic(
      root,
      receiptName,
      JSON.stringify({
        ...receipt,
        durable: false,
        mirror: receipt.mirror ? { ...receipt.mirror, idle: false } : undefined,
      }) + "\n",
      false,
    );
    throw new Error("source mirror ownership could not be recorded durably");
  }
}

function databaseDigest(root: string, witness?: SourceWitness) {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (lstatSync(join(root, mirrorDatabase + suffix), { throwIfNoEntry: false })) {
      throw new Error("source mirror database has unsettled journal state");
    }
  }
  return regularFileDigest(join(root, mirrorDatabase), () =>
    createHash("sha256").update(JSON.stringify(witness ?? null) + "\0"),
  );
}

function disposalPath(syncRoot: string, id: string) {
  return join(syncRoot, prefix + "disposal-" + id);
}

function readDisposal(syncRoot: string, id: string) {
  const path = disposalPath(syncRoot, id);
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("source mirror disposal record is not private");
  }
  const record = disposalSchema.parse(JSON.parse(readBounded(path, headerLimit).toString("utf8")));
  const receipt = record.receipt;
  if (
    record.id !== id ||
    (receipt &&
      (receipt.id !== id ||
        !receipt.mirror?.disposing ||
        !idleMirror(receipt) ||
        receipt.mirror.key !== record.key ||
        !sameIdentity(receipt.mirror.slotIdentity, record.slotIdentity)))
  ) {
    throw new Error("source mirror disposal record has invalid ownership");
  }
  return record;
}

function readMirrorState(syncRoot: string, id: string) {
  const root = join(syncRoot, prefix + id);
  const record = lstatSync(disposalPath(syncRoot, id), { throwIfNoEntry: false })
    ? readDisposal(syncRoot, id)
    : undefined;
  const present = lstatSync(root, { throwIfNoEntry: false });
  if (record && present) {
    if (!record.receipt) {
      throw new Error("source mirror root appeared after empty-slot disposal was recorded");
    }
    assertIdentity(root, record.receipt.rootIdentity);
  }
  if (lstatSync(join(root, receiptName), { throwIfNoEntry: false })) {
    const receipt = readReceipt(root);
    if (record && JSON.stringify(record.receipt) !== JSON.stringify(receipt)) {
      throw new Error("source mirror disposal record does not match its receipt");
    }
    return { receipt, disposal: record };
  }
  if (record) {
    if (present && readdirSync(root).length) {
      throw new Error("source mirror lost its receipt before payload disposal completed");
    }
    return { receipt: record.receipt, disposal: record };
  }
  return { receipt: present ? readReceipt(root) : undefined, disposal: undefined };
}

function saveDisposal(syncRoot: string, input: Disposal) {
  const record = disposalSchema.parse(input);
  const path = disposalPath(syncRoot, record.id);
  if (lstatSync(path, { throwIfNoEntry: false })) {
    if (JSON.stringify(readDisposal(syncRoot, record.id)) !== JSON.stringify(record)) {
      throw new Error("source mirror disposal record changed");
    }
    // Retry an interrupted durability flush without rewriting committed custody.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!syncFile(fd) || !syncDirectory(syncRoot)) {
        throw new Error("source mirror disposal record durability is unavailable");
      }
    } finally {
      closeSync(fd);
    }
  } else if (!writeAtomic(syncRoot, basename(path), JSON.stringify(record) + "\n")) {
    throw new Error("source mirror disposal record could not be recorded durably");
  }
  return record;
}

function removeDisposal(syncRoot: string, expected: Disposal) {
  if (JSON.stringify(readDisposal(syncRoot, expected.id)) !== JSON.stringify(expected)) {
    throw new Error("source mirror disposal record changed");
  }
  if (!syncDirectory(join(syncRoot, "mirrors")) || !syncDirectory(syncRoot)) {
    throw new Error("source mirror namespace removal could not be recorded durably");
  }
  rmSync(disposalPath(syncRoot, expected.id));
}

/** Claim under allocation; keep the slot reserved until its recorded disposal finishes. */
function claimIdleMirror(syncRoot: string, key: string, expectedId?: string) {
  const slot = join(syncRoot, "mirrors", key);
  privateMirrorDirectory(slot);
  // A missing stage/lock is valid only after recorded root removal. Check before
  // mirrorLock can recreate the empty lock database during terminal recovery.
  if (
    !lstatSync(join(slot, "stage"), { throwIfNoEntry: false }) ||
    !lstatSync(join(slot, "lock"), { throwIfNoEntry: false })
  ) {
    if (!expectedId) {
      return undefined;
    }
    const disposal = readDisposal(syncRoot, expectedId);
    assertIdentity(slot, disposal.slotIdentity);
    if (
      disposal.key !== key ||
      lstatSync(join(syncRoot, prefix + expectedId), { throwIfNoEntry: false }) ||
      readdirSync(slot).some((name) => name !== "lock")
    ) {
      throw new Error("source mirror terminal disposal ownership changed");
    }
  }
  const release = mirrorLock(join(slot, "lock"));
  if (!release) {
    return undefined;
  }
  try {
    const current = mirrorSlot(syncRoot, key, expectedId);
    if (
      (expectedId && current.id !== expectedId) ||
      (current.receipt && !idleMirror(current.receipt))
    ) {
      release();
      return undefined;
    }
    let disposal: Disposal | undefined;
    return {
      release,
      removePayload() {
        release.assertOwned();
        if (!current.receipt) {
          if (lstatSync(current.root, { throwIfNoEntry: false })) {
            throw new Error("source mirror root appeared before empty-slot disposal");
          }
          disposal = saveDisposal(syncRoot, {
            version: 1,
            id: current.id,
            key,
            slotIdentity: current.slotIdentity,
          });
          return;
        }
        let receipt = current.receipt;
        if (
          JSON.stringify(readMirrorState(syncRoot, current.id).receipt) !== JSON.stringify(receipt)
        ) {
          throw new Error("source mirror disposal ownership changed");
        }
        if (!lstatSync(join(current.root, receiptName), { throwIfNoEntry: false })) {
          // Only a durable record can admit an absent or identity-checked empty root.
          disposal = saveDisposal(syncRoot, readDisposal(syncRoot, current.id));
          return;
        }
        const generations = recoveryMetadata(current.root, join(current.root, "payload", "source"));
        const payload = join(current.root, "payload");
        if (!receipt.mirror?.disposing || lstatSync(payload, { throwIfNoEntry: false })) {
          assertIdentity(payload, receipt.payloadIdentity);
        }
        // Never downgrade an already committed disposal during a retry.
        if (!receipt.mirror?.disposing) {
          receipt = receiptSchema.parse({
            ...receipt,
            mirror: { ...receipt.mirror!, disposing: true },
          });
          saveMirrorReceipt(current.root, receipt);
        }
        disposal = saveDisposal(syncRoot, {
          version: 1,
          id: current.id,
          key,
          slotIdentity: current.slotIdentity,
          receipt,
        });
        release.assertOwned();
        assertIdentity(current.root, receipt.rootIdentity);
        for (const name of generations) {
          rmSync(join(current.root, name));
        }
        // Recovery must not resurrect artifact records after their source is gone.
        if (generations.length && !syncDirectory(current.root)) {
          throw new Error("source mirror metadata removal could not be recorded durably");
        }
        rmSync(payload, { recursive: true, force: true });
        for (const name of [
          manifestName,
          mirrorDatabase,
          `${mirrorDatabase}-journal`,
          `${mirrorDatabase}-wal`,
          `${mirrorDatabase}-shm`,
        ]) {
          rmSync(join(current.root, name), { force: true });
        }
      },
      // Allocation must be reacquired before unlinking the lock namespace.
      removeSlot() {
        release.assertOwned();
        if (
          !disposal ||
          JSON.stringify(readDisposal(syncRoot, current.id)) !== JSON.stringify(disposal)
        ) {
          throw new Error("source mirror disposal record changed before namespace removal");
        }
        const latest = mirrorSlot(syncRoot, key, current.id);
        if (latest.id !== current.id || !sameIdentity(latest.slotIdentity, current.slotIdentity)) {
          throw new Error("source mirror slot changed during disposal");
        }
        if (latest.receipt) {
          if (JSON.stringify(latest.receipt) !== JSON.stringify(disposal.receipt)) {
            throw new Error("source mirror disposal was not recorded");
          }
          if (lstatSync(current.root, { throwIfNoEntry: false })) {
            assertIdentity(current.root, latest.receipt.rootIdentity);
            if (readdirSync(current.root).some((name) => name !== receiptName)) {
              throw new Error("source mirror disposal has remaining metadata");
            }
            rmSync(join(current.root, receiptName), { force: true });
            rmdirSync(current.root);
          }
        } else if (lstatSync(current.root, { throwIfNoEntry: false })) {
          throw new Error("source mirror root appeared during empty-slot disposal");
        }
        // Root absence must persist before the slot can disappear or be reused.
        if (!syncDirectory(syncRoot)) {
          throw new Error("source mirror root removal could not be recorded durably");
        }
        assertIdentity(slot, current.slotIdentity);
        rmSync(join(slot, "stage"), { force: true });
        if (!syncDirectory(slot)) {
          throw new Error("source mirror slot handoff removal could not be recorded durably");
        }
        release();
        release.remove();
        rmdirSync(slot);
        removeDisposal(syncRoot, disposal);
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

function allocateMirrorSlot(syncRoot: string, key: string) {
  const mirrors = join(syncRoot, "mirrors");
  const slot = join(mirrors, key);
  let allocation: ReturnType<typeof mirrorLock>;
  const acquire = () => {
    allocation = mirrorLock(join(mirrors, ".allocation.lock"), true);
    if (!allocation) {
      console.error("[crabbox] source mirror allocation is busy; using a fresh capsule");
    }
    return allocation;
  };
  try {
    if (!acquire()) {
      return undefined;
    }
    const attempted = new Set<string>();
    for (;;) {
      let createdSlot = false;
      if (!lstatSync(slot, { throwIfNoEntry: false })) {
        const slots = readdirSync(mirrors).filter((name) => name !== ".allocation.lock");
        if (slots.length >= mirrorLimit) {
          const idle = slots
            .flatMap((name) => {
              try {
                if (!/^[a-f0-9]{64}$/u.test(name) || attempted.has(name)) {
                  return [];
                }
                const value = mirrorSlot(syncRoot, name);
                return !value.receipt || idleMirror(value.receipt)
                  ? [{ key: name, lastUsed: value.receipt?.mirror?.lastUsed ?? 0 }]
                  : [];
              } catch {
                return [];
              }
            })
            .toSorted((a, b) => a.lastUsed - b.lastUsed);
          let victim: ReturnType<typeof claimIdleMirror>;
          for (const entry of idle) {
            attempted.add(entry.key);
            try {
              victim = claimIdleMirror(syncRoot, entry.key);
              if (victim) {
                break;
              }
            } catch {
              // Unknown ownership stays protected and counts toward capacity.
            }
          }
          if (!victim) {
            console.error(
              "[crabbox] source mirror limit reached; protected copies retained, using a fresh capsule",
            );
            return undefined;
          }
          allocation!();
          allocation = undefined;
          try {
            victim.removePayload();
            if (!acquire()) {
              return undefined;
            }
            victim.removeSlot();
          } catch (error) {
            console.error(
              "[crabbox] source mirror eviction could not verify a candidate; retained it and checking later idle mirrors: " +
                (error instanceof Error ? error.message : String(error)),
            );
          } finally {
            victim.release();
          }
          if (!allocation && !acquire()) {
            return undefined;
          }
          // Other allocators may have created our slot or consumed capacity
          // while deletion ran. Re-read both before making a namespace change.
          continue;
        }
        mkdirSync(slot, { mode: 0o700 });
        createdSlot = true;
      }
      const slotIdentity = privateMirrorDirectory(slot);
      const release = mirrorLock(join(slot, "lock"));
      if (!release) {
        console.error(
          "[crabbox] source mirror is in use or has an unresolved owner; using a fresh capsule",
        );
        return undefined;
      }
      return { slot, slotIdentity, createdSlot, release };
    }
  } finally {
    allocation?.();
  }
}

type MirrorStagingHandle = {
  staging: StagingHandle;
  reused: boolean;
  finish: () => void;
  discard: () => void;
};

/** Own one immutable command view, with a bounded disposable cache between runs. */
export function createMirrorStaging(
  syncRootInput: string,
  repositoryInput: string,
): MirrorStagingHandle | undefined {
  let release: ReturnType<typeof mirrorLock>;
  try {
    if (!processDomain()) {
      console.error(
        "[crabbox] source mirror process ownership is unavailable; using a fresh capsule",
      );
      return undefined;
    }
    mkdirSync(syncRootInput, { recursive: true });
    const syncRoot = realpathSync(syncRootInput);
    const repository = realpathSync(repositoryInput);
    if (!canRecordStaging(join(syncRoot, prefix + "mirror"), repository)) {
      return undefined;
    }
    if (!syncDirectory(syncRoot)) {
      console.error(
        "[crabbox] durable source mirror ownership is unavailable; using a fresh capsule",
      );
      return undefined;
    }
    const mirrors = join(syncRoot, "mirrors");
    mkdirSync(mirrors, { recursive: true, mode: 0o700 });
    privateMirrorDirectory(mirrors);
    const key = createHash("sha256").update(repository).digest("hex");
    const allocated = allocateMirrorSlot(syncRoot, key);
    if (!allocated) {
      return undefined;
    }
    const { slot, slotIdentity, createdSlot } = allocated;
    release = allocated.release;
    let receipt: Receipt | undefined;
    let root: string | undefined;
    if (!createdSlot && !lstatSync(join(slot, "stage"), { throwIfNoEntry: false })) {
      throw new Error("source mirror slot has no recorded staging owner");
    }
    if (lstatSync(join(slot, "stage"), { throwIfNoEntry: false })) {
      const previous = mirrorSlot(syncRoot, key);
      receipt = previous.receipt;
      root = previous.root;
      if (previous.disposal || (receipt && (!idleMirror(receipt) || receipt.mirror?.disposing))) {
        console.error(
          "[crabbox] source mirror has no completed idle handoff; using a fresh capsule",
        );
        return undefined;
      }
      if (receipt) {
        recoveryMetadata(root, join(root, "payload", "source"));
        let intact = false;
        try {
          intact =
            Boolean(receipt.mirror?.database) &&
            databaseDigest(root, receipt.witness) === receipt.mirror?.database;
        } catch {
          // Known disposable idle data may be rebuilt; unknown ownership may not.
        }
        if (!intact) {
          assertIdentity(root, receipt.rootIdentity);
          rmSync(root, { recursive: true, force: true });
          receipt = undefined;
          console.error("[crabbox] source mirror metadata changed or disappeared; rebuilding cold");
        }
      }
    }
    const reused = Boolean(receipt);
    if (!receipt) {
      const fresh = createStaging(syncRoot, repository);
      if (!fresh.recorded) {
        fresh.dispose();
        return undefined;
      }
      root = fresh.root;
      receipt = readReceipt(root);
    }
    if (!root || !canRecordStaging(root, repository)) {
      return undefined;
    }
    assertIdentity(join(root, "payload"), receipt.payloadIdentity);
    const generations = recoveryMetadata(root, join(root, "payload", "source"));
    const adopted: Receipt = {
      ...receipt,
      ownerPid: process.pid,
      ownerDomain: processDomain(),
      repository,
      repositoryIdentity: identity(repository),
      state: "preparing",
      users: "none",
      claims: undefined,
      leases: undefined,
      witness: undefined,
      artifactManifest: undefined,
      mirror: { key, slotIdentity, idle: false, lastUsed: Date.now() },
    };
    saveMirrorReceipt(root, adopted);
    if (!writeAtomic(slot, "stage", adopted.id + "\n")) {
      throw new Error("source mirror slot could not be recorded durably");
    }
    for (const name of generations) {
      rmSync(join(root, name));
    }
    const staging = stagingHandle(root, adopted, true);
    const unlock = release;
    release = undefined;
    let finished = false;
    const abandon = () => {
      if (!finished) {
        unlock();
        finished = true;
      }
    };
    const ownedReceipt = () => {
      unlock.assertOwned();
      const current = mirrorSlot(syncRoot, key);
      if (
        current.root !== root ||
        current.receipt?.ownerPid !== process.pid ||
        current.receipt.mirror?.idle ||
        current.receipt.id !== adopted.id
      ) {
        throw new Error("source mirror ownership changed during its command");
      }
      return current.receipt;
    };
    return {
      staging,
      reused,
      finish() {
        if (finished) {
          return;
        }
        try {
          const current = ownedReceipt();
          const idle = {
            ...current,
            mirror: { ...current.mirror!, idle: true, lastUsed: Date.now() },
          };
          if (idleMirror(idle)) {
            const source = join(staging.payload, "source");
            const outputs = join(source, ".crabbox");
            if (lstatSync(outputs, { throwIfNoEntry: false })) {
              try {
                const outputIdentity = identity(outputs);
                if (!current.artifactManifest) {
                  throw new Error("source mirror output preservation was not recorded");
                }
                const artifacts = readArtifactRecord(staging.root, current.artifactManifest);
                verifyPreservedCrabboxArtifacts(source, artifacts);
                unlock.assertOwned();
                assertIdentity(outputs, outputIdentity);
                if (readdirSync(outputs).some((name) => name !== "runs" && name !== "captures")) {
                  // Native state outside the artifact roots is disposable only
                  // through the completed live producer's ordinary cleanup.
                  staging.dispose();
                  return;
                }
                idle.mirror.database = databaseDigest(staging.root, current.witness);
                for (const name of ["runs", "captures"]) {
                  rmSync(join(outputs, name), { recursive: true, force: true });
                }
                rmdirSync(outputs);
              } catch (error) {
                staging.hold("artifacts");
                throw error;
              }
            } else {
              idle.mirror.database = databaseDigest(staging.root, current.witness);
            }
            saveMirrorReceipt(staging.root, idle);
          }
        } finally {
          abandon();
        }
      },
      discard() {
        if (finished) {
          return;
        }
        try {
          const current = ownedReceipt();
          if (
            current.users !== "none" ||
            current.hold ||
            !["preparing", "prepared"].includes(current.state)
          ) {
            throw new Error(
              "source mirror has admitted or unverified users; retained for recovery",
            );
          }
          staging.dispose();
        } finally {
          abandon();
        }
      },
    };
  } catch (error) {
    console.error(
      "[crabbox] source mirror unavailable; retained for inspection, using a fresh capsule: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return undefined;
  } finally {
    release?.();
  }
}

function readManifest(root: string, receipt: Receipt): Manifest {
  const bytes = readBounded(join(root, manifestName), manifestLimit);
  if (createHash("sha256").update(bytes).digest("hex") !== receipt.manifest) {
    throw new Error("staging manifest does not match its receipt");
  }
  try {
    return manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error("staging manifest has unknown or invalid metadata");
  }
}

function writeArtifactRecord(root: string, artifacts: CrabboxArtifactEvidence, durable = true) {
  const bytes = JSON.stringify(artifacts) + "\n";
  if (Buffer.byteLength(bytes) > manifestLimit) {
    throw new Error("staging artifact evidence exceeds the recovery metadata limit");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  // Keep the previous committed generation readable until the receipt advances.
  return { digest, durable: writeAtomic(root, "artifacts-" + digest + ".json", bytes, durable) };
}

function readArtifactRecord(root: string, digest: string) {
  const bytes = readBounded(join(root, "artifacts-" + digest + ".json"), manifestLimit);
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("staging artifact evidence does not match its recorded identity");
  }
  try {
    return crabboxArtifactEvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error("staging artifact evidence has unknown or invalid metadata");
  }
}

function recoveryMetadata(root: string, source: string, artifacts?: CrabboxArtifactEvidence) {
  const names = readdirSync(root).toSorted();
  if (names.length > 68) {
    throw new Error("staging has too many metadata generations; inspect it before recovery");
  }
  const known = new Set([receiptName, manifestName, "payload", "recovery.lock"]);
  const sourceIdentity = lstatSync(source, { throwIfNoEntry: false })
    ? identity(source)
    : artifacts?.sourceIdentity;
  const generations: string[] = [];
  const mirror = readReceipt(root).mirror;
  for (const name of names) {
    if (known.has(name)) {
      continue;
    }
    if (
      mirror &&
      [
        mirrorDatabase,
        `${mirrorDatabase}-journal`,
        `${mirrorDatabase}-wal`,
        `${mirrorDatabase}-shm`,
      ].includes(name)
    ) {
      const stat = lstatSync(join(root, name));
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error("source mirror database metadata has an unsupported kind");
      }
      continue;
    }
    const match = /^artifacts-([a-f0-9]{64})\.json$/u.exec(name);
    if (
      !match ||
      !sourceIdentity ||
      !sameIdentity(readArtifactRecord(root, match[1]!).sourceIdentity, sourceIdentity)
    ) {
      throw new Error(
        "staging has an unknown or replaced metadata sibling; preserve it before recovery",
      );
    }
    generations.push(name);
  }
  return generations;
}

type StagingStatus = {
  id: string;
  directory: string;
  status: "active" | "protected" | "candidate";
  reason: string;
  ownerPid?: number;
  state?: Receipt["state"];
  users?: Receipt["users"];
  kind?: Receipt["kind"];
  hold?: Receipt["hold"];
  leases?: string[];
};

function metadataStatus(root: string, receipt: Receipt, explicit = false): StagingStatus {
  const base = {
    id: receipt.id,
    directory: root,
    ownerPid: receipt.ownerPid,
    state: receipt.state,
    users: receipt.users,
    kind: receipt.kind,
    hold: receipt.hold,
    leases: receipt.leases,
  };
  if (lstatSync(join(root, "recovery.lock"), { throwIfNoEntry: false })) {
    return {
      ...base,
      status: "protected",
      reason:
        "Another or interrupted recovery owns this copy; inspect that operation before manual disposition.",
    };
  }
  if (idleMirror(receipt)) {
    return {
      ...base,
      status: receipt.mirror?.disposing ? "candidate" : "protected",
      reason: receipt.mirror?.disposing
        ? "Interrupted idle source mirror disposal; its exclusive slot lock must be acquired before resuming."
        : "Idle source mirror retained for reuse; capacity eviction or explicit staging recover uses its exclusive mirror lock.",
    };
  }
  if (!receipt.ownerDomain || receipt.ownerDomain !== processDomain()) {
    return {
      ...base,
      status: "protected",
      reason:
        "The producer belongs to an unknown or different boot/process namespace; this process cannot establish its absence.",
    };
  }
  if (!ownerAbsent(receipt.ownerPid)) {
    return {
      ...base,
      status: "active",
      reason: "The producer PID is live or cannot be checked; wait for its cleanup.",
    };
  }
  if (receipt.kind === "worktree") {
    return {
      ...base,
      status: "protected",
      reason:
        "Full-worktree preparation can run hooks or filters. Preserve its raw source and outputs, then verify this exact Git registration before manual disposition; recovery does not adopt it.",
    };
  }
  if (!receipt.durable || !receipt.manifest) {
    return {
      ...base,
      status: "protected",
      reason:
        "Preparation or durable recovery metadata is incomplete; preserve this copy for inspection.",
    };
  }
  if (receipt.users === "admitted" || receipt.state === "preparing") {
    return {
      ...base,
      status: "protected",
      reason: "Writer settlement was not recorded; PID absence does not authorize removal.",
    };
  }
  if (receipt.hold === "writers" || receipt.hold === "registration") {
    return {
      ...base,
      status: "protected",
      reason:
        "Writer or registration settlement is unverified; inspect and preserve this copy before manual disposition.",
    };
  }
  if (!explicit && (receipt.hold || (receipt.users === "settled" && receipt.state === "settled"))) {
    return {
      ...base,
      status: "protected",
      reason:
        "Claim or diagnostic preservation is incomplete; repair the named destination or lease, then run staging recover with this ID to retry.",
    };
  }
  if (!["prepared", "settled", "preserved", "removing"].includes(receipt.state)) {
    return {
      ...base,
      status: "protected",
      reason: "Staging state is inconsistent with recorded ownership; preserve it for inspection.",
    };
  }
  if (!receipt.claims) {
    return {
      ...base,
      status: "protected",
      reason:
        "The original native claims namespace was not recorded; absence in another namespace cannot authorize removal.",
    };
  }
  if (!receipt.witness) {
    return {
      ...base,
      status: "protected",
      reason:
        "No independent retained Git ref is recorded; preserve the snapshot in a retained repository first.",
    };
  }
  return {
    ...base,
    status: "candidate",
    reason: "Source preservation and unchanged contents must still be verified before removal.",
  };
}

function inspectStaging(
  syncRoot: string,
  options: { limit?: number; budgetMs?: number; startAfter?: string } = {},
) {
  const started = performance.now();
  const entries: StagingStatus[] = [];
  let incomplete = false;
  let nextCursor = options.startAfter;
  let skipping = Boolean(options.startAfter);
  let directory;
  try {
    directory = opendirSync(syncRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries, incomplete, nextCursor: undefined, elapsedMs: performance.now() - started };
    }
    throw error;
  }
  try {
    for (;;) {
      if (
        entries.length >= (options.limit ?? 64) ||
        performance.now() - started >= (options.budgetMs ?? 250)
      ) {
        incomplete = true;
        break;
      }
      const entry = directory.readSync();
      if (!entry) {
        nextCursor = undefined;
        incomplete = skipping;
        break;
      }
      if (skipping) {
        skipping = entry.name !== options.startAfter;
        continue;
      }
      if (!entry.name.startsWith(prefix) || entry.name === cursorName) {
        continue;
      }
      nextCursor = entry.name;
      const root = join(syncRoot, entry.name);
      try {
        const disposalId = entry.name.startsWith(prefix + "disposal-")
          ? entry.name.slice((prefix + "disposal-").length)
          : undefined;
        const disposal = disposalId ? readDisposal(syncRoot, disposalId) : undefined;
        const receipt = disposal
          ? disposal.receipt
          : readMirrorState(syncRoot, entry.name.slice(prefix.length)).receipt;
        if (!receipt && !disposal) {
          throw new Error("staging has no recorded owner");
        }
        const id = disposal?.id ?? receipt!.id;
        if (!entries.some((value) => value.id === id)) {
          entries.push(
            receipt
              ? { ...metadataStatus(join(syncRoot, prefix + id), receipt), directory: root }
              : {
                  id,
                  directory: root,
                  status: "candidate",
                  reason:
                    "Recorded empty source mirror slot disposal; its allocation and slot locks must be acquired before resuming.",
                },
          );
        }
      } catch {
        entries.push({
          id: entry.name,
          directory: root,
          status: "protected",
          reason: "Unmarked, unknown, replaced or unreadable staging; no automatic adoption.",
        });
      }
    }
  } finally {
    directory.closeSync();
  }
  return { entries, incomplete, nextCursor, elapsedMs: performance.now() - started };
}

const cursorSchema = z.strictObject({
  version: z.literal(1),
  rootIdentity: identitySchema,
  cursorIdentity: identitySchema,
  after: z.string().startsWith(prefix).max(256).optional(),
});

function readCursor(syncRoot: string) {
  const physicalRoot = realpathSync(syncRoot);
  const root = join(physicalRoot, cursorName);
  const value = cursorSchema.parse(
    JSON.parse(readBounded(join(root, "position.json"), headerLimit).toString("utf8")),
  );
  assertIdentity(physicalRoot, value.rootIdentity);
  assertIdentity(root, value.cursorIdentity);
  if (value.after && basename(value.after) !== value.after) {
    throw new Error("staging discovery cursor is invalid");
  }
  return value;
}

/** Metadata-only discovery; its cursor is a fairness hint, never deletion authority. */
export function discoverStaging(syncRoot: string) {
  let startAfter: string | undefined;
  try {
    startAfter = readCursor(syncRoot).after;
  } catch {
    // Unknown cursor data grants no authority and is never overwritten below.
  }
  return inspectStaging(syncRoot, { startAfter });
}

/** Advance bounded discovery and attempt at most one old candidate after normal completion. */
export async function recoverDiscoveredStaging(
  syncRoot: string,
  discovery: ReturnType<typeof discoverStaging>,
  options: RecoveryOptions,
) {
  options.signal?.throwIfAborted();
  if (!discovery.entries.length && !discovery.incomplete) {
    return undefined;
  }
  const physicalRoot = realpathSync(syncRoot);
  const cursor = join(physicalRoot, cursorName);
  const candidate = discovery.entries.find((entry) => entry.status === "candidate");
  try {
    if (!canRecordStaging(cursor, options.cwd)) {
      throw new Error("This source location does not support recovery metadata.");
    }
    if (!lstatSync(cursor, { throwIfNoEntry: false })) {
      mkdirSync(cursor, { mode: 0o700 });
    } else {
      readCursor(physicalRoot);
    }
    writeAtomic(
      cursor,
      "position.json",
      JSON.stringify({
        version: 1,
        rootIdentity: identity(physicalRoot),
        cursorIdentity: identity(cursor),
        after: candidate ? basename(candidate.directory) : discovery.nextCursor,
      }) + "\n",
    );
  } catch {
    // A corrupt or interrupted hint is never adopted or allowed to veto the
    // independently validated candidate already found in this bounded page.
    options.signal?.throwIfAborted();
    console.error(
      "[crabbox] staging discovery cursor is unavailable; retained it for inspection. Use staging inspect --after to page past protected entries.",
    );
  }
  if (candidate) {
    return recoverStaging(physicalRoot, candidate.id, { ...options, automatic: true });
  }
  return undefined;
}

function validatePayload(root: string, receipt: Receipt, manifest: Manifest) {
  const payload = join(root, "payload");
  const present = lstatSync(payload, { throwIfNoEntry: false });
  if (!present && receipt.state === "removing") {
    return "[]";
  }
  assertIdentity(payload, receipt.payloadIdentity);
  const entries = manifest.artifacts
    ? manifest.entries.filter((entry) => !artifactPath(entry.path))
    : manifest.entries;
  const expected = new Map(entries.map((entry) => [entry.path, entry]));
  if (
    expected.size !== entries.length ||
    [...expected.keys()].some((path) => !safeRelative(path))
  ) {
    throw new Error("staging manifest contains duplicate or unsafe paths");
  }
  const actual = inventory(payload, new Map(), Boolean(manifest.artifacts));
  for (const entry of actual) {
    const frozen = expected.get(entry.path);
    if (
      !frozen ||
      frozen.kind !== entry.kind ||
      frozen.mode !== entry.mode ||
      frozen.blob !== entry.blob
    ) {
      throw new Error("staging contents changed or gained an entry: " + entry.path);
    }
    expected.delete(entry.path);
  }
  if (expected.size && receipt.state !== "removing") {
    throw new Error("staging contents are missing before disposal");
  }
  return JSON.stringify(actual);
}

type RecoveryOptions = {
  binary: string;
  cwd: string;
  automatic?: boolean;
  witness?: SourceWitness;
  signal?: AbortSignal;
};

async function recoverStaging(syncRoot: string, id: string, options: RecoveryOptions) {
  if (!z.uuid().safeParse(id).success) {
    return { id, recovered: false, reason: "Choose a recorded staging ID from staging inspect." };
  }
  const root = join(syncRoot, prefix + id);
  const source = join(root, "payload", "source");
  let locked = false;
  let unsettled = false;
  let releaseMirror: (() => void) | undefined;
  let lockedRoot: Identity | undefined;
  let lockedDirectory: Identity | undefined;
  const lockOwner = JSON.stringify({ pid: process.pid, generation: randomUUID() }) + "\n";
  const lock = join(root, "recovery.lock");
  try {
    options.signal?.throwIfAborted();
    const { receipt: before, disposal: recordedDisposal } = readMirrorState(syncRoot, id);
    if (recordedDisposal || (before && idleMirror(before))) {
      const key = recordedDisposal?.key ?? before!.mirror!.key;
      const slotIdentity = recordedDisposal?.slotIdentity ?? before!.mirror!.slotIdentity;
      if (options.automatic && !recordedDisposal && !before?.mirror?.disposing) {
        return {
          id,
          recovered: false,
          reason: "Idle source mirrors are retained until capacity eviction or explicit recovery.",
        };
      }
      let allocation = mirrorLock(join(syncRoot, "mirrors", ".allocation.lock"), true);
      if (!allocation) {
        return {
          id,
          recovered: false,
          reason: "Source mirror allocation is busy; retry after the active command finishes.",
        };
      }
      let victim: ReturnType<typeof claimIdleMirror>;
      try {
        const slot = join(syncRoot, "mirrors", key);
        if (recordedDisposal && !lstatSync(root, { throwIfNoEntry: false })) {
          const present = lstatSync(slot, { throwIfNoEntry: false });
          if (!present || !sameIdentity(identity(slot), slotIdentity)) {
            if (present) {
              // A later recorded owner may already have allocated this key.
              // Its slot is never modified while finishing the old tombstone.
              const newer = mirrorSlot(syncRoot, key);
              if (!newer.receipt || newer.id === id) {
                throw new Error("Source mirror disposal slot identity changed.");
              }
            }
            removeDisposal(syncRoot, recordedDisposal);
            return {
              id,
              recovered: true,
              reason: "Completed source mirror disposal record removed.",
            };
          }
        }
        victim = claimIdleMirror(syncRoot, key, id);
        allocation();
        allocation = undefined;
        if (victim) {
          victim.removePayload();
          allocation = mirrorLock(join(syncRoot, "mirrors", ".allocation.lock"), true);
          if (!allocation) {
            throw new Error(
              "Source mirror allocation is busy; recorded disposal retained for recovery.",
            );
          }
          victim.removeSlot();
        }
        const recovered = Boolean(victim);
        return {
          id,
          recovered,
          reason: recovered
            ? "Explicitly disposable idle source mirror removed."
            : "Source mirror is in use or its ownership changed; retained.",
        };
      } finally {
        victim?.release();
        allocation?.();
      }
    }
    if (!before) {
      throw new Error("Staging has no recorded owner.");
    }
    const selectedWitness = options.witness ?? before.witness;
    const status = metadataStatus(
      root,
      { ...before, witness: selectedWitness },
      !options.automatic,
    );
    if (status.status !== "candidate") {
      return { id, recovered: false, reason: status.reason };
    }
    if (before.mirror) {
      const allocation = mirrorLock(join(syncRoot, "mirrors", ".allocation.lock"), true);
      if (!allocation) {
        return {
          id,
          recovered: false,
          reason: "Source mirror allocation is busy; retry after the active command finishes.",
        };
      }
      try {
        const slot = mirrorSlot(syncRoot, before.mirror.key);
        if (slot.root !== root) {
          throw new Error("Source mirror staging ownership changed before recovery.");
        }
        releaseMirror = mirrorLock(join(slot.slot, "lock"));
        if (!releaseMirror) {
          return {
            id,
            recovered: false,
            reason: "Source mirror has an active lock owner; retained.",
          };
        }
      } finally {
        allocation();
      }
    }
    // Interrupted owners do not supply settlement evidence for their child tools.
    mkdirSync(lock, { mode: 0o700 });
    locked = true;
    lockedRoot = identity(root);
    lockedDirectory = identity(lock);
    writeFileSync(join(lock, "owner.json"), lockOwner, { mode: 0o600, flag: "wx" });
    let receipt = readReceipt(root);
    if (JSON.stringify(receipt) !== JSON.stringify(before) || !ownerAbsent(receipt.ownerPid)) {
      throw new Error("staging ownership changed while acquiring recovery");
    }
    const saveReceipt = (next: Receipt) => {
      assertIdentity(root, receipt.rootIdentity);
      receipt = next;
      if (!writeAtomic(root, receiptName, JSON.stringify(receipt) + "\n")) {
        receipt.durable = false;
        writeAtomic(root, receiptName, JSON.stringify(receipt) + "\n", false);
        throw new Error("Durable recovery updates are unavailable; staging remains protected.");
      }
    };
    const checkClaims = async () => {
      const claims = await verifyNoStagingClaims({
        binary: options.binary,
        cwd: options.cwd,
        namespace: receipt.claims!,
        sourceRoot: root,
        signal: options.signal,
      });
      if (!claims.ok) {
        unsettled ||= claims.unjoined === true;
        if (!unsettled) {
          saveReceipt({
            ...receipt,
            hold: "claims",
            leases: claims.matchingLeaseIds ?? receipt.leases,
          });
        }
        throw new Error(
          claims.reason +
            (claims.matchingLeaseIds?.length
              ? " Matching leases: " + JSON.stringify(claims.matchingLeaseIds)
              : ""),
          { cause: claims.error },
        );
      }
    };
    await checkClaims();
    let manifest = readManifest(root, receipt);
    if (receipt.artifactManifest) {
      manifest = { ...manifest, artifacts: readArtifactRecord(root, receipt.artifactManifest) };
    }
    recoveryMetadata(root, source, manifest.artifacts);
    if (receipt.users === "settled") {
      try {
        if (!manifest.artifacts) {
          throw new Error("Diagnostic preservation was not recorded.");
        }
        verifyPreservedCrabboxArtifacts(source, manifest.artifacts, receipt.state === "removing");
      } catch (error) {
        if (options.automatic || receipt.state === "removing") {
          throw error;
        }
        if (!receipt.repositoryIdentity) {
          throw new Error(
            "Original repository identity is unavailable; preserve diagnostics manually.",
            { cause: error },
          );
        }
        const artifacts = preserveCrabboxArtifacts(
          source,
          receipt.repository,
          receipt.repositoryIdentity,
        );
        if (!artifacts?.durable) {
          throw new Error("Durable diagnostic preservation could not be established.", {
            cause: error,
          });
        }
        manifest = { ...manifest, artifacts };
        const saved = writeArtifactRecord(root, artifacts);
        if (!saved.durable) {
          throw new Error("Durable artifact evidence could not be recorded.", { cause: error });
        }
        saveReceipt({
          ...receipt,
          artifactManifest: saved.digest,
          state: "preserved",
          hold: undefined,
        });
      }
    }
    const generations = recoveryMetadata(root, source, manifest.artifacts);
    const footprint = validatePayload(root, receipt, manifest);
    const witness = await verifySourceWitness({
      source: manifest.source,
      witness: selectedWitness!,
      payloadRoot: root,
      signal: options.signal,
    });
    if (!witness.ok) {
      unsettled ||= witness.unjoined === true;
      return { id, recovered: false, reason: witness.reason };
    }
    await checkClaims();
    options.signal?.throwIfAborted();
    // Both asynchronous readers have settled. Recheck all remaining bytes and
    // authority immediately before recording disposal and removing this payload.
    if (
      JSON.stringify(readReceipt(root)) !== JSON.stringify(receipt) ||
      !ownerAbsent(receipt.ownerPid)
    ) {
      throw new Error("staging ownership changed during preservation verification");
    }
    if (validatePayload(root, receipt, manifest) !== footprint) {
      throw new Error("staging changed during preservation verification");
    }
    if (manifest.artifacts) {
      verifyPreservedCrabboxArtifacts(source, manifest.artifacts, receipt.state === "removing");
    }
    assertIdentity(lock, lockedDirectory);
    if (
      readBounded(join(lock, "owner.json"), headerLimit).toString("utf8") !== lockOwner ||
      JSON.stringify(recoveryMetadata(root, source, manifest.artifacts)) !==
        JSON.stringify(generations)
    ) {
      throw new Error("staging metadata changed during preservation verification");
    }
    saveReceipt({ ...receipt, state: "removing", hold: undefined, witness: selectedWitness });
    witness.revalidate();
    rmSync(join(root, "payload"), { recursive: true, force: true });
    rmSync(join(root, manifestName));
    for (const name of generations) {
      rmSync(join(root, name));
    }
    if (receipt.mirror) {
      for (const name of [
        mirrorDatabase,
        `${mirrorDatabase}-journal`,
        `${mirrorDatabase}-wal`,
        `${mirrorDatabase}-shm`,
      ]) {
        rmSync(join(root, name), { force: true });
      }
    }
    rmSync(join(root, receiptName));
    rmSync(join(lock, "owner.json"));
    rmdirSync(lock);
    locked = false;
    rmdirSync(root);
    return {
      id,
      recovered: true,
      reason:
        "Independent retained source, diagnostics, and native claims verified; abandoned staging removed.",
    };
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "Another or interrupted recovery owns this copy; inspect its owner before manual disposition."
        : error instanceof Error
          ? error.message
          : "Staging recovery could not be verified.";
    return { id, recovered: false, reason };
  } finally {
    if (locked && !unsettled && lockedRoot && lockedDirectory) {
      try {
        assertIdentity(root, lockedRoot);
        assertIdentity(lock, lockedDirectory);
        if (readBounded(join(lock, "owner.json"), headerLimit).toString("utf8") === lockOwner) {
          rmSync(join(lock, "owner.json"));
          rmdirSync(lock);
        }
      } catch {
        // A replaced or incomplete recovery owner never grants cleanup authority.
      }
    }
    if (!unsettled) {
      releaseMirror?.();
    }
  }
}

export async function runStagingCommand(
  args: string[],
  syncRoot: string,
  options: RecoveryOptions,
) {
  if (
    args[0] === "inspect" &&
    (args.length === 1 ||
      (args.length === 3 &&
        args[1] === "--after" &&
        args[2]!.startsWith(prefix) &&
        basename(args[2]!) === args[2]))
  ) {
    console.log(JSON.stringify(inspectStaging(syncRoot, { startAfter: args[2] }), null, 2));
    return 0;
  }
  if (args[0] === "recover" && (args.length === 2 || args.length === 6)) {
    try {
      let witness: SourceWitness | undefined;
      if (args.length === 6) {
        const fields = new Map([
          [args[2], args[3]],
          [args[4], args[5]],
        ]);
        if (fields.size !== 2 || !fields.get("--witness-repo") || !fields.get("--witness-ref")) {
          throw new Error("Supply both --witness-repo and --witness-ref, with one value each.");
        }
        witness = selectSourceWitness(fields.get("--witness-repo")!, fields.get("--witness-ref")!);
      }
      const result = await recoverStaging(syncRoot, args[1]!, { ...options, witness });
      console.log(JSON.stringify(result, null, 2));
      return result.recovered ? 0 : 1;
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            id: args[1],
            recovered: false,
            reason:
              error instanceof Error ? error.message : "Recovery options could not be verified.",
          },
          null,
          2,
        ),
      );
      return 1;
    }
  }
  console.log(
    "Usage: node scripts/crabbox-wrapper.mjs staging inspect [--after <nextCursor>]\n       node scripts/crabbox-wrapper.mjs staging recover <id> [--witness-repo <path> --witness-ref <full-ref>]\n\nOnly positively settled, unchanged staging with independently retained source and preserved diagnostics can be removed. Existing native claims are inspected without provider calls or claim mutation.",
  );
  return args.length === 0 || args[0] === "--help" ? 0 : 2;
}
