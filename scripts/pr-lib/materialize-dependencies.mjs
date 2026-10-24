import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Recovery runs from the current trusted wrapper, under its actual PR lock.
// The retained anchor is data; its own materializer still owns package selection.
if (process.argv[2] === "--recover") {
  try {
    await recover();
  } catch (error) {
    console.error(`Tooling recovery refused: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const manifestPath = join(dirname(process.argv[3]), "package.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : undefined;
const markdownManifestPath = join(dirname(manifestPath), "packages/markdown-core/package.json");
const markdownManifest = existsSync(markdownManifestPath)
  ? JSON.parse(readFileSync(markdownManifestPath, "utf8"))
  : undefined;
const markdownDependencies = markdownManifest
  ? ["mdast-util-from-markdown", "mdast-util-gfm-table", "micromark-extension-gfm-table"]
  : [];
// Pre-#149585 anchors contain no package manifest and need only these tooling pins.
const dependencies = [
  "tsx",
  "zod",
  "minimatch",
  "yaml",
  ...(manifest
    ? [
        "@openclaw/fs-safe",
        "@openclaw/proc-safe",
        "@openclaw/proxyline",
        "acorn",
        "chalk",
        "commander",
        "dotenv",
        "execa",
        "hosted-git-info",
        "import-meta-resolve",
        "ipaddr.js",
        "jiti",
        "json5",
        "kysely",
        ...markdownDependencies,
        "p-map",
        "partial-json",
        "semver",
        "string-width",
        "tsdown",
        "tslog",
        "typebox",
        "typescript",
        "undici",
      ]
    : []),
].map((dependency) => {
  const link = join(process.argv[3], dependency);
  // An older parent or the current supervisor may already have pinned this package.
  // Preserve that installation even if canonical aliases change during the run.
  const present = lstatSync(link, { throwIfNoEntry: false });
  const workspace = markdownDependencies.includes(dependency)
    ? "packages/markdown-core"
    : undefined;
  const installedPath = present
    ? link
    : join(
        workspace ? join(dirname(process.argv[2]), workspace, "node_modules") : process.argv[2],
        dependency,
      );
  try {
    const target = realpathSync(installedPath);
    if (!statSync(target).isDirectory()) {
      throw new Error("not a package directory");
    }
    const dependencyManifest = workspace ? markdownManifest : manifest;
    const expectedVersion =
      dependencyManifest?.dependencies?.[dependency] ??
      dependencyManifest?.devDependencies?.[dependency];
    const installedVersion = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;
    if (manifest && (!expectedVersion || installedVersion !== expectedVersion)) {
      console.error(
        `Installed scripts/pr dependency '${dependency}' has version ${installedVersion}; the trust anchor requires ${expectedVersion}.`,
      );
      throw new Error("dependency version mismatch");
    }
    return { dependency, target, present };
  } catch {
    console.error(
      `Cannot resolve installed scripts/pr dependency '${dependency}' at ${installedPath}.`,
    );
    console.error(
      "Restore frozen dependencies in a clean trusted-main checkout or set OPENCLAW_PR_TOOLING_ROOT before retrying; no dependencies were installed.",
    );
    // Distinguish dependency drift from a destination write failure. Only the
    // former may trigger a refresh of an explicitly selected tooling checkout.
    return process.exit(78);
  }
});
mkdirSync(process.argv[3], { recursive: true });
for (const { dependency, target, present } of dependencies) {
  if (present) {
    continue;
  }
  // Native junctions avoid Git Bash copying package directories on Windows.
  const link = join(process.argv[3], dependency);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

async function recover() {
  const [pr, planPath, planSha, repo, lockRef, lockOid] = process.argv.slice(3);
  const fail = (message) => {
    throw new Error(message);
  };
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const equal = isDeepStrictEqual;
  const identity = (path) => {
    const s = lstatSync(path, { bigint: true });
    return Object.fromEntries(
      ["dev", "ino", "uid", "gid", "mode"].map((key) => [key, String(s[key])]),
    );
  };
  const within = (root, path) => path.startsWith(`${root}${sep}`);
  const physical = (path) => {
    if (
      typeof path !== "string" ||
      resolve(path) !== path ||
      realpathSync(path) !== path ||
      !lstatSync(path).isDirectory()
    ) {
      fail("Expected a physical directory");
    }
    return path;
  };
  const run = (binary, args, options = {}) => {
    const result = spawnSync(binary, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    if (result.error || result.signal || result.status !== 0) {
      fail("Recovery prerequisite command failed");
    }
    return result.stdout;
  };
  const git = (root, args) => run(process.env.OPENCLAW_PR_GIT, ["-C", root, ...args]).trimEnd();
  const assertLock = () => {
    if (
      lockRef !== `refs/openclaw/pr-operation-locks/${pr}` ||
      !/^[a-f0-9]{40}$/.test(lockOid ?? "") ||
      git(repo, ["rev-parse", "--verify", lockRef]) !== lockOid
    ) {
      fail("Recovery does not hold the PR lock");
    }
    const owner = git(repo, ["cat-file", "blob", lockOid]);
    const supervisor = process.env.OPENCLAW_PR_LOCK_SUPERVISOR_PID;
    if (!/^[1-9][0-9]*$/.test(supervisor ?? "")) {
      fail("Recovery supervisor is absent");
    }
    const birth = run("bash", [
      "-c",
      'source "$1"; pr_operation_lock_process_birth "$2"',
      "recovery-owner",
      fileURLToPath(new URL("./operation-lock.sh", import.meta.url)),
      supervisor,
    ]).trim();
    if (
      !owner.split("\n").includes(`pgid=${process.ppid}`) ||
      !owner.split("\n").includes(`supervisor_pid=${supervisor}`) ||
      !owner.split("\n").includes(`supervisor_birth=${birth}`)
    ) {
      fail("Recovery lock belongs to another operation");
    }
  };
  const bytes = readFileSync(planPath);
  if (!/^[a-f0-9]{64}$/.test(planSha ?? "") || sha(bytes) !== planSha) {
    fail("Recovery plan seal differs");
  }
  const plan = JSON.parse(bytes);
  if (plan.version !== 1 || String(plan.pr) !== pr || !/^[a-f0-9]{40}$/.test(plan.revision ?? "")) {
    fail("Invalid recovery identity");
  }
  if (
    process.platform !== "linux" ||
    !equal(plan.runtime, {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    })
  ) {
    fail("Recovery runtime differs from qualified runtime");
  }
  assertLock();
  const anchor = physical(plan.anchor.path);
  const donor = physical(plan.donor.path);
  const live = physical(join(anchor, "node_modules"));
  if (
    !basename(anchor).startsWith("openclaw-pr-anchor.") ||
    anchor === dirname(dirname(dirname(fileURLToPath(import.meta.url)))) ||
    anchor === donor ||
    within(anchor, donor) ||
    within(donor, anchor) ||
    !equal(identity(anchor), plan.anchor.identity) ||
    !equal(identity(donor), plan.donor.identity) ||
    !equal(identity(dirname(anchor)), plan.anchor.parentIdentity) ||
    !equal(identity(dirname(donor)), plan.donor.parentIdentity)
  ) {
    fail("Recovery directory identity differs");
  }
  const owned = (path) => {
    const s = lstatSync(path);
    if (s.uid !== process.getuid() || s.gid !== process.getgid()) {
      fail("Recovery directory ownership differs");
    }
  };
  owned(anchor);
  owned(live);
  if (
    git(donor, ["rev-parse", "--show-toplevel"]) !== donor ||
    git(donor, ["rev-parse", "HEAD"]) !== plan.revision ||
    git(donor, ["rev-parse", "--is-shallow-repository"]) !== "false" ||
    git(donor, ["config", "--bool", "--default=false", "--get", "core.sparseCheckout"]) !==
      "false" ||
    git(donor, ["config", "--bool", "--default=false", "--get", "remote.origin.promisor"]) !==
      "false" ||
    git(donor, ["status", "--porcelain", "--untracked-files=all"]) !== "" ||
    git(donor, ["remote", "get-url", "origin"]) !== git(repo, ["remote", "get-url", "origin"])
  ) {
    fail("Donor is not the clean frozen repository checkout");
  }
  git(repo, ["merge-base", "--is-ancestor", plan.revision, "refs/remotes/origin/main"]);
  const modules = physical(join(donor, "node_modules"));
  const store = physical(join(modules, ".pnpm"));
  owned(modules);
  owned(store);
  const installMetadata = [
    [join(modules, ".modules.yaml"), plan.donor.modulesSha256],
    [join(store, "lock.yaml"), plan.donor.installLockSha256],
  ];
  for (const [path, expected] of installMetadata) {
    if (!lstatSync(path).isFile() || sha(readFileSync(path)) !== expected) {
      fail("Donor install metadata differs");
    }
  }
  const donorManifest = JSON.parse(readFileSync(join(donor, "package.json")));
  const packageManager = donorManifest.packageManager?.split("+")[0];
  const { parse } = await import("yaml");
  const installed = parse(readFileSync(join(modules, ".modules.yaml"), "utf8"));
  if (
    !packageManager ||
    installed.packageManager !== packageManager ||
    installed.nodeLinker !== "isolated" ||
    installed.virtualStoreDir !== ".pnpm"
  ) {
    fail("Donor package manager or layout differs");
  }

  // Verify the frozen source closure against Git, including its own inventory.
  // No helper from the target is executed before all these bytes are admitted.
  const inventory = git(repo, [
    "show",
    `${plan.revision}:scripts/pr-lib/wrapper-components.txt`,
  ]).split("\n");
  const components = ["scripts/pr", "scripts/pr-lib", ...inventory];
  if (
    components.some(
      (path) =>
        !path || path.startsWith("/") || path.split("/").some((p) => p === ".." || p === "."),
    )
  ) {
    fail("Invalid frozen inventory");
  }
  const listing = git(repo, ["ls-tree", "-r", "-z", plan.revision, "--", ...components])
    .split("\0")
    .filter(Boolean);
  const frozen = [];
  for (const row of listing) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match) {
      fail("Unsupported frozen source entry");
    }
    const [, mode, oid, name] = match;
    const path = join(anchor, name);
    if (
      realpathSync(path) !== path ||
      !lstatSync(path).isFile() ||
      (lstatSync(path).mode & 0o100) !== (mode === "100755" ? 0o100 : 0)
    ) {
      fail("Frozen source path or mode differs");
    }
    const data = readFileSync(path);
    if (createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") !== oid) {
      fail("Frozen source bytes differ");
    }
    frozen.push([path, sha(data), identity(path)]);
  }
  for (const required of ["scripts/pr-lib/materialize-dependencies.mjs", "package.json"]) {
    if (!frozen.some(([path]) => path === join(anchor, required))) {
      fail("Frozen materializer or manifest is absent");
    }
  }
  const projection = (directory) => {
    const entries = {};
    const visit = (path, name) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        entries[name] = { ...identity(path), target: readlinkSync(path) };
      } else if (stat.isDirectory() && (name === "" || /^@[^/]+$/.test(name))) {
        owned(path);
        entries[name] = identity(path);
        for (const child of readdirSync(path).toSorted()) {
          visit(join(path, child), name ? `${name}/${child}` : child);
        }
      } else {
        fail("Projection contains package contents or unrelated entries");
      }
    };
    visit(directory, "");
    return entries;
  };
  const original = projection(live);
  if (!equal(original, plan.anchor.projection)) {
    fail("Projection preimage differs");
  }

  const stage = mkdtempSync(join(anchor, ".pr-dependency-recovery-"));
  // Keep both directories on every outcome. The calling owner retains this
  // stdout before dispatch and reconciles identities after an interrupted call.
  const record = (state, extra = {}) =>
    writeSync(
      1,
      `${JSON.stringify({
        state,
        pr,
        planSha256: planSha,
        anchor,
        live,
        stage,
        ...extra,
      })}\n`,
    );
  record("staging", { original: original[""], staged: identity(stage) });
  const frozenHelper = join(anchor, "scripts/pr-lib/materialize-dependencies.mjs");
  run(process.execPath, [frozenHelper, modules, stage]);
  const staged = projection(stage);
  const names = Object.keys(staged).filter((name) => staged[name].target !== undefined);
  if (
    !equal(names.toSorted(), Object.keys(plan.donor.packages).toSorted()) ||
    Object.keys(original).some((name) => !(name in staged))
  ) {
    fail("Projection is not the frozen selective dependency set");
  }
  const visited = new Set();
  const dependenciesIn = (directory) => {
    const resolved = realpathSync(directory);
    if (!within(store, resolved) || !lstatSync(resolved).isDirectory()) {
      fail("Dependency escapes the isolated installation");
    }
    for (const entry of readdirSync(resolved)) {
      if (entry === ".bin") {
        continue;
      }
      const path = join(resolved, entry);
      for (const packagePath of entry.startsWith("@")
        ? readdirSync(path).map((name) => join(path, name))
        : [path]) {
        closure(realpathSync(packagePath));
      }
    }
  };
  const closure = (target) => {
    if (
      !within(store, target) ||
      realpathSync(target) !== target ||
      !lstatSync(target).isDirectory()
    ) {
      fail("Dependency escapes the isolated installation");
    }
    if (visited.has(target)) {
      return;
    }
    visited.add(target);
    const packageModules = target.slice(
      0,
      target.indexOf(`${sep}node_modules${sep}`, store.length) + 13,
    );
    if (!packageModules.endsWith(`${sep}node_modules`)) {
      fail("Dependency is outside the isolated package layout");
    }
    dependenciesIn(packageModules);
    const nested = join(target, "node_modules");
    if (lstatSync(nested, { throwIfNoEntry: false })) {
      dependenciesIn(nested);
    }
  };
  for (const name of names) {
    if (staged[name].target !== plan.donor.packages[name]) {
      fail("Qualified package path differs");
    }
    closure(staged[name].target);
  }
  for (const [name, entry] of Object.entries(staged)) {
    if (entry.target === undefined) {
      chmodSync(join(stage, name), Number(original[name]?.mode ?? entry.mode) & 0o7777);
    }
  }
  const replacement = projection(stage);
  const assertFrozen = () => {
    for (const [path, expected, before] of frozen) {
      if (!equal(identity(path), before) || sha(readFileSync(path)) !== expected) {
        fail("Frozen source changed during recovery");
      }
    }
  };
  const unchanged = () => {
    assertLock();
    if (
      !equal(identity(anchor), plan.anchor.identity) ||
      !equal(identity(dirname(anchor)), plan.anchor.parentIdentity) ||
      !equal(projection(live), original) ||
      !equal(projection(stage), replacement)
    ) {
      fail("Recovery identities changed before exchange");
    }
    assertFrozen();
    if (
      !equal(identity(donor), plan.donor.identity) ||
      git(donor, ["rev-parse", "HEAD"]) !== plan.revision
    ) {
      fail("Donor identity changed during recovery");
    }
    for (const [path, expected] of installMetadata) {
      if (sha(readFileSync(path)) !== expected) {
        fail("Donor install changed during recovery");
      }
    }
  };
  unchanged();
  record("exchange-ready", { original: original[""], replacement: replacement[""] });
  const exchange = spawnSync("mv", ["--exchange", "--no-copy", "-T", "--", stage, live], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let state = "unknown";
  try {
    if (equal(identity(live), replacement[""]) && equal(identity(stage), original[""])) {
      state = "exchanged";
    } else if (equal(identity(live), original[""]) && equal(identity(stage), replacement[""])) {
      state = "unchanged";
    }
  } catch {
    /* Preserve both paths and let the native owner reconcile. */
  }
  record(state, { exitCode: exchange.status, signal: exchange.signal });
  if (state !== "exchanged") {
    fail("Exchange not confirmed; retain both paths and reconcile before any resume; do not retry");
  }
  assertLock();
  if (!equal(projection(live), replacement) || !equal(projection(stage), original)) {
    fail("Exchanged projection differs; resume remains blocked");
  }
  assertFrozen();
  run(process.execPath, [frozenHelper, modules, live]);
  record("complete", {
    original: original[""],
    installed: replacement[""],
    packages: names.length,
  });
}
