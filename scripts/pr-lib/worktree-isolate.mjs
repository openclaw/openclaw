import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { getPrWorktreePaths, requireIsolatedPrWorktreeParent } from "./worktree-placement.mjs";

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const preservedArtifacts = [
  "pr-meta.json",
  "pr-meta.env",
  "review.json",
  "review.md",
  "review-mode.env",
  "prep-context.env",
  "correction-review.json",
  "correction-review.md",
  "correction-incoming-review.json",
];
const pathBoundStamps = ["gates.env", "prep.env"];

function stat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function read(file) {
  if (!stat(file)?.isFile()) {
    throw new Error(`Expected a regular owned file: ${file}`);
  }
  return fs.readFileSync(file);
}

function identity(file) {
  const value = stat(file);
  if (!value?.isDirectory()) {
    throw new Error(`Expected a physical owned directory: ${file}`);
  }
  return { dev: value.dev, ino: value.ino };
}

function same(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} changed`);
  }
}

function requireNoHolders(directory) {
  // The per-PR lock excludes native commands, not editors or unrelated shells.
  // Unknown visibility must not become permission to move their cwd or files.
  const result = spawnSync("lsof", ["-n", "-P", "-Fpcfn", "+D", directory], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    result.error ||
    result.signal ||
    result.stderr ||
    (result.status !== 0 && result.status !== 1)
  ) {
    throw new Error(
      "Cannot establish native PR checkout holder absence with lsof; preserve the checkout",
    );
  }
  if (result.stdout.trim() || result.status !== 1) {
    throw new Error("Native PR checkout or admin directory has live holders");
  }
}

function isolatePrWorktree({ root: requestedRoot, pr, expectedHead, lockRef, ownerOid }) {
  if (
    !/^[1-9][0-9]*$/.test(pr) ||
    !oidPattern.test(expectedHead) ||
    !oidPattern.test(ownerOid) ||
    lockRef !== `refs/openclaw/pr-operation-locks/${pr}`
  ) {
    throw new Error("Invalid native PR isolation identity");
  }
  const root = fs.realpathSync(requestedRoot);
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" };
  const binary = env.OPENCLAW_PR_GIT || "git";
  function git(args, { cwd = root, input } = {}) {
    const result = spawnSync(binary, ["-C", cwd, ...args], {
      env,
      input,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error(
        `Native PR isolation Git operation failed: ${result.stderr || result.error || result.status}`,
      );
    }
    return result.stdout.trimEnd();
  }
  function assertAuthority() {
    const result = spawnSync(
      process.platform === "win32" ? "bash" : "/bin/bash",
      [
        "-c",
        'source "$1"; pr_operation_lock_owner_is_current "$2" "$3" "$4"',
        "pr-isolation-authority",
        fileURLToPath(new URL("./operation-lock.sh", import.meta.url)),
        root,
        lockRef,
        ownerOid,
      ],
      { cwd: root, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0 || result.error || result.signal) {
      throw new Error("PR operation lock changed or is unreadable; preserve isolation state");
    }
  }
  const common = fs.realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (
    path.dirname(common) !== root ||
    fs.realpathSync(git(["rev-parse", "--show-toplevel"])) !== root
  ) {
    throw new Error("Native PR isolation requires the canonical repository owner");
  }
  const ref = `refs/openclaw/pr-worktree-isolations/${pr}`;
  function retainOperation() {
    if (env.OPENCLAW_PR_LOCK_NOTIFY_FD === "3") {
      fs.writeSync(3, "phase\tside-effects-started\n");
    }
  }
  let retained;
  try {
    retained = git(["for-each-ref", "--format=%(refname) %(objectname)", ref])
      .split("\n")
      .find((line) => line.startsWith(`${ref} `))
      ?.slice(ref.length + 1);
  } catch (error) {
    // A failed observation cannot establish absence of earlier move custody.
    retainOperation();
    throw error;
  }
  // A prior intent already owns uncertain effects. A recovery refusal must not
  // release its new operation lock as though it were a fresh admission failure.
  if (retained) {
    retainOperation();
  }
  const paths = getPrWorktreePaths(root, pr);
  let record = retained ? JSON.parse(git(["cat-file", "blob", retained])) : undefined;
  function assertIntent() {
    same(
      git(["for-each-ref", "--format=%(refname) %(objectname) %(symref)", ref]),
      `${ref} ${retained}`,
      "Retained native isolation intent",
    );
  }
  function writeRecord(next) {
    assertAuthority();
    const oid = git(["hash-object", "-w", "--stdin"], { input: JSON.stringify(next) + "\n" });
    git(["update-ref", "--no-deref", ref, oid, retained || "0".repeat(oid.length)]);
    retained = oid;
    record = next;
  }
  function privateRefs() {
    return git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/openclaw"])
      .split("\n")
      .filter((line) => {
        const name = line.split(" ", 1)[0];
        return name.endsWith(`/${pr}`) && name !== ref && name !== lockRef;
      });
  }
  function snapshot(directory) {
    const pointer = read(path.join(directory, ".git")).toString().trimEnd();
    if (!pointer.startsWith("gitdir: ")) {
      throw new Error("Invalid native worktree Git pointer");
    }
    const admin = path.resolve(directory, pointer.slice(8));
    if (path.dirname(admin) !== path.join(common, "worktrees")) {
      throw new Error("Foreign native worktree admin directory");
    }
    const adminIdentity = identity(admin);
    if (path.resolve(admin, read(path.join(admin, "commondir")).toString().trimEnd()) !== common) {
      throw new Error("Foreign native worktree common directory");
    }
    if (stat(path.join(admin, "locked")) || stat(path.join(admin, "index.lock"))) {
      throw new Error("Native worktree has a Git lock");
    }
    for (const pending of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ]) {
      if (stat(path.join(admin, pending))) {
        throw new Error("Native worktree has an unfinished Git operation");
      }
    }
    const head = git(["rev-parse", "HEAD"], { cwd: directory });
    if (head !== expectedHead) {
      throw new Error("Native PR head changed");
    }
    const branch = git(["symbolic-ref", "HEAD"], { cwd: directory });
    if (
      ![`refs/heads/pr-${pr}`, `refs/heads/pr-${pr}-prep`, `refs/heads/temp/pr-${pr}`].includes(
        branch,
      )
    ) {
      throw new Error("Native PR branch is not owned by this PR");
    }
    if (git(["status", "--porcelain=v1", "--untracked-files=no"], { cwd: directory })) {
      throw new Error("Native PR checkout has tracked changes");
    }
    if (
      fs.statSync(path.join(admin, "modules"), { throwIfNoEntry: false })?.isDirectory() ||
      git(["ls-files", "--stage"], { cwd: directory })
        .split("\n")
        .some((line) => line.startsWith("160000 "))
    ) {
      throw new Error("Native PR isolation does not move worktrees with submodules");
    }
    const local = stat(path.join(directory, ".local"));
    if (local && !local.isDirectory()) {
      throw new Error("Native PR artifacts must have a physical owner");
    }
    const artifacts = Object.fromEntries(
      preservedArtifacts.map((name) => {
        const file = path.join(directory, ".local", name);
        return [name, stat(file) ? sha(read(file)) : null];
      }),
    );
    return {
      directory: identity(directory),
      admin,
      adminIdentity,
      head,
      branch,
      tree: git(["rev-parse", "HEAD^{tree}"], { cwd: directory }),
      index: sha(read(path.join(admin, "index"))),
      artifacts,
      privateRefs: privateRefs(),
    };
  }
  function requireRegistration(directory, admin) {
    if (
      path.resolve(admin, read(path.join(admin, "gitdir")).toString().trimEnd()) !==
      path.join(directory, ".git")
    ) {
      throw new Error(
        "Original isolation has a stale Git backlink; retain intent and operation lock",
      );
    }
    const registered = git(["worktree", "list", "--porcelain", "-z"]).split("\0");
    if (
      registered.filter((field) => field === `worktree ${directory}`).length !== 1 ||
      registered.includes(`worktree ${directory === paths.legacy ? paths.isolated : paths.legacy}`)
    ) {
      throw new Error("Native PR registration is ambiguous");
    }
  }
  function originalStamps() {
    return Object.fromEntries(
      pathBoundStamps.map((name) => {
        const file = path.join(paths.legacy, ".local", name);
        if (stat(`${file}.before-isolation`)) {
          throw new Error("An earlier path-bound stamp is already retained");
        }
        return [name, stat(file) ? sha(read(file)) : null];
      }),
    );
  }
  assertAuthority();
  const parent = requireIsolatedPrWorktreeParent(root);
  if (record) {
    if (
      record.version !== 1 ||
      record.root !== root ||
      record.common !== common ||
      record.pr !== pr ||
      record.head !== expectedHead ||
      record.from !== paths.legacy ||
      record.to !== paths.isolated ||
      !["intent", "complete"].includes(record.phase)
    ) {
      throw new Error("Retained native isolation intent does not match this checkout");
    }
    const originalPresent = Boolean(stat(paths.legacy));
    const destinationPresent = Boolean(stat(paths.isolated));
    if (
      originalPresent === destinationPresent ||
      (record.phase === "complete" && originalPresent)
    ) {
      throw new Error("Retained isolation has ambiguous placement; preserve it for recovery");
    }
    // A crash after rename may leave stale backlinks. Do not sweep or repair
    // other worktrees, and never replay the directory move under a new owner.
    if (destinationPresent) {
      requireRegistration(paths.isolated, record.snapshot.admin);
      same(snapshot(paths.isolated), record.snapshot, "Original isolated worktree");
      assertIntent();
      if (record.phase === "complete") {
        return paths.isolated;
      }
    }
  }
  if (!record || stat(paths.legacy)) {
    if (!stat(paths.legacy) || stat(paths.isolated)) {
      throw new Error("Isolation requires one existing legacy checkout and an absent destination");
    }
    // Resumption consumes the original receipt, never a new snapshot accepted
    // after interruption. Fresh and retained-original moves share every guard.
    const before = record ? record.snapshot : snapshot(paths.legacy);
    same(snapshot(paths.legacy), before, "Original native worktree");
    requireRegistration(paths.legacy, before.admin);
    const stamps = record ? record.stamps : originalStamps();
    same(originalStamps(), stamps, "Original path-bound preparation stamps");
    requireNoHolders(paths.legacy);
    requireNoHolders(before.admin);
    const parentIdentity = identity(path.dirname(parent));
    requireIsolatedPrWorktreeParent(root, { writableFor: "native PR isolation" });
    same(identity(path.dirname(parent)), parentIdentity, "Isolation parent");
    const destinationParent = identity(parent);
    if (destinationParent.dev !== before.directory.dev) {
      throw new Error("Native PR isolation requires a same-filesystem move");
    }
    requireIsolatedPrWorktreeParent(root);
    same(snapshot(paths.legacy), before, "Original native worktree");
    same(originalStamps(), stamps, "Original path-bound preparation stamps");
    if (!record) {
      retainOperation();
      writeRecord({
        version: 1,
        phase: "intent",
        root,
        common,
        pr,
        head: expectedHead,
        from: paths.legacy,
        to: paths.isolated,
        snapshot: before,
        stamps,
      });
    }
    same(identity(parent), destinationParent, "Isolation destination parent");
    if (stat(paths.isolated)) {
      throw new Error("Isolation destination appeared before the move");
    }
    requireRegistration(paths.legacy, before.admin);
    assertAuthority();
    assertIntent();
    git(["worktree", "move", "--", paths.legacy, paths.isolated]);
    requireRegistration(paths.isolated, before.admin);
    same(snapshot(paths.isolated), before, "Moved native worktree");
  }
  requireNoHolders(paths.isolated);
  requireNoHolders(record.snapshot.admin);
  assertAuthority();
  assertIntent();
  // Preserve old bytes as evidence without letting a path-bound stamp qualify
  // the new location. Review and incoming-review authority remain untouched.
  for (const name of pathBoundStamps) {
    const original = path.join(paths.isolated, ".local", name);
    const archived = `${original}.before-isolation`;
    const expected = record.stamps[name];
    if (stat(original)) {
      if (expected === null || sha(read(original)) !== expected || stat(archived)) {
        throw new Error("Path-bound preparation stamp changed during isolation");
      }
      fs.renameSync(original, archived);
    } else if (expected !== null && (!stat(archived) || sha(read(archived)) !== expected)) {
      throw new Error("Original path-bound preparation stamp is unavailable");
    }
  }
  same(snapshot(paths.isolated), record.snapshot, "Completed native worktree");
  writeRecord({ ...record, phase: "complete" });
  return paths.isolated;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [root, pr, expectedHead, lockRef, ownerOid] = process.argv.slice(2);
    console.log(isolatePrWorktree({ root, pr, expectedHead, lockRef, ownerOid }));
    console.log(
      "Placement isolated. Dependency and path-bound build proof must be qualified here.",
    );
  } catch (error) {
    console.error(`Native PR isolation stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
