import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "../lib/direct-run.mjs";

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

export function getPrWorktreePaths(root, pr) {
  if (!/^[1-9][0-9]*$/.test(pr)) {
    throw new Error("Invalid PR number");
  }
  const owner = fs.realpathSync(root);
  const legacyParent = path.join(owner, ".worktrees");
  const isolatedParent = `${owner}.pr-worktrees`;
  if (stat(isolatedParent) && !stat(isolatedParent).isDirectory()) {
    throw new Error("Native PR isolation parent must be a physical directory");
  }
  return {
    legacy: path.join(
      stat(legacyParent) ? fs.realpathSync(legacyParent) : legacyParent,
      `pr-${pr}`,
    ),
    isolated: path.join(isolatedParent, `pr-${pr}`),
  };
}

export function requireIsolatedPrWorktreeParent(root, { writableFor } = {}) {
  const parent = path.dirname(getPrWorktreePaths(root, "1").isolated);
  // A complete local installation still permits ancestor package probes.
  // Placement, not the declaration guard, must exclude those installations.
  for (let current = parent; ; current = path.dirname(current)) {
    if (stat(path.join(current, "node_modules"))) {
      throw new Error(`Native PR placement has an ancestor installation: ${current}`);
    }
    if (path.dirname(current) === current) {
      break;
    }
  }
  if (writableFor) {
    // Mode bits/access() do not prove sandbox admission. Probe only the selected
    // physical parent; legacy reuse and read-only placement never need this grant.
    let probe;
    try {
      fs.mkdirSync(parent, { recursive: true });
      if (!stat(parent)?.isDirectory() || fs.realpathSync(parent) !== parent) {
        throw new Error("Native PR isolation parent must be a physical directory");
      }
      probe = fs.mkdtempSync(path.join(parent, ".pr-write-probe-"));
      fs.rmdirSync(probe);
    } catch (error) {
      throw new Error(
        `Cannot admit ${writableFor} at native PR parent ${parent}: ${error.code ? `${error.code}: ` : ""}${error.message}. ` +
          "Provision and authorize this exact sibling directory in the approved maintainer environment; " +
          `retain sandbox/approval policy and Git metadata authorization.${probe ? ` Retain failed probe ${probe}.` : ""}`,
        { cause: error },
      );
    }
  }
  return parent;
}

function validatePrWorktreePath(root, requested) {
  const input = path.resolve(requested);
  const leaf = path.basename(input);
  if (!/^pr-[1-9][0-9]*$/.test(leaf)) {
    throw new Error("non-canonical PR-worktree path");
  }
  const paths = getPrWorktreePaths(root, leaf.slice(3));
  const inputParent = path.dirname(input);
  const parent = stat(inputParent) ? fs.realpathSync(inputParent) : inputParent;
  const target = path.join(parent, leaf);
  if (target !== paths.legacy && target !== paths.isolated) {
    throw new Error("non-canonical PR-worktree path");
  }
  return target;
}

function git(root, args, { statuses = [0], env = {} } = {}) {
  const result = spawnSync(process.env.OPENCLAW_PR_GIT || "git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", ...env },
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    result.error ||
    result.signal ||
    result.status === null ||
    !statuses.includes(result.status)
  ) {
    throw new Error(
      `Cannot inspect native PR placement: ${result.stderr || result.error || result.status}`,
    );
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result;
}

function readIsolationIntentOid(root, ref) {
  const symbolic = git(root, ["symbolic-ref", "--quiet", ref], { statuses: [0, 1] });
  if (symbolic.status === 0) {
    throw new Error("Native PR isolation intent must be a direct ref");
  }
  if (symbolic.stdout !== "") {
    throw new Error("Invalid native PR isolation ref observation");
  }
  // Iteration otherwise hides broken refs. Match the full name after show-ref's
  // suffix matching; status alone cannot prove this exact intent exists.
  const result = git(root, ["show-ref", "--", ref], {
    statuses: [0, 1],
    env: { GIT_REF_PARANOIA: "1" },
  });
  if (result.status === 1) {
    if (result.stdout !== "") {
      throw new Error("Invalid native PR isolation ref observation");
    }
    return undefined;
  }
  if (!result.stdout.endsWith("\n")) {
    throw new Error("Incomplete native PR isolation ref observation");
  }
  let intent;
  for (const row of result.stdout.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[!-~\u0080-\uFFFF]+)$/.exec(row);
    if (!match) {
      throw new Error("Invalid native PR isolation ref observation");
    }
    if (match[2] !== ref) {
      continue;
    }
    if (intent) {
      throw new Error("Duplicate native PR isolation intent");
    }
    intent = match[1];
  }
  return intent;
}

function resolvePrWorktreePath(root, pr) {
  const paths = getPrWorktreePaths(root, pr);
  const registrations = new Set(
    git(root, ["worktree", "list", "--porcelain", "-z"])
      .stdout.split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice(9)),
  );
  const selected = [...new Set(Object.values(paths))].filter(
    (file) => stat(file) || registrations.has(file),
  );
  if (selected.length > 1) {
    throw new Error("Ambiguous legacy and isolated PR worktrees");
  }
  const ref = `refs/openclaw/pr-worktree-isolations/${pr}`;
  const intent = readIsolationIntentOid(root, ref);
  if (intent) {
    const record = JSON.parse(git(root, ["cat-file", "blob", intent]).stdout);
    if (
      record.version !== 1 ||
      record.root !== fs.realpathSync(root) ||
      record.pr !== pr ||
      record.from !== paths.legacy ||
      record.to !== paths.isolated ||
      record.phase !== "complete"
    ) {
      throw new Error(
        `PR worktree isolation is incomplete; preserve ${intent} and recover its original move`,
      );
    }
  }
  return selected[0] ?? paths.isolated;
}

function listPrWorktreePaths(root) {
  const parents = new Set(
    Object.values(getPrWorktreePaths(root, "1")).map((file) => path.dirname(file)),
  );
  const paths = [];
  for (const parent of parents) {
    if (!stat(parent)) {
      continue;
    }
    for (const leaf of fs.readdirSync(parent).toSorted()) {
      if (!leaf.startsWith("pr-")) {
        continue;
      }
      const file = path.join(parent, leaf);
      if (stat(file)?.isDirectory()) {
        paths.push(file);
      }
    }
  }
  return paths;
}

function printPrWorktreeState(root, common, requested, previousAdmin, purpose) {
  function read(file) {
    if (!stat(file)?.isFile()) {
      throw new Error("damaged worktree metadata");
    }
    return fs.readFileSync(file, "utf8").trimEnd();
  }
  try {
    const target = validatePrWorktreePath(root, requested);
    const targetStat = stat(target);
    if (targetStat && !targetStat.isDirectory()) {
      throw new Error("non-canonical PR-worktree path");
    }
    const commonDir = fs.realpathSync(common);
    const adminRoot = path.join(commonDir, "worktrees");
    const adminStat = stat(adminRoot);
    if (adminStat && !adminStat.isDirectory()) {
      throw new Error("damaged worktree metadata");
    }
    const matches = [];
    let ids;
    // Reusing a healthy worktree needs its own identity, not proof that unrelated
    // admin entries are readable. Destruction still requires the complete scan.
    if (purpose === "entry" && targetStat) {
      const gitfile = path.join(target, ".git");
      if (!stat(gitfile)?.isFile()) {
        throw new Error(
          "unregistered or ambiguous PR worktree; scripts/pr refuses to mutate the shared canonical checkout",
        );
      }
      const pointer = read(gitfile);
      if (!pointer.startsWith("gitdir: ")) {
        throw new Error("damaged worktree metadata");
      }
      const admin = path.resolve(target, pointer.slice(8));
      if (path.dirname(admin) !== adminRoot) {
        throw new Error("damaged worktree metadata");
      }
      ids = [path.basename(admin)];
    } else {
      ids = adminStat ? fs.readdirSync(adminRoot) : [];
    }
    // Git preserves admin IDs across moves. Only readable, valid backlinks can
    // attribute entries; an unknown backlink cannot establish target absence.
    for (const id of ids) {
      const admin = path.join(adminRoot, id);
      if (!stat(admin)?.isDirectory()) {
        throw new Error("damaged worktree metadata");
      }
      const backlink = read(path.join(admin, "gitdir"));
      if (!backlink.endsWith("/.git")) {
        throw new Error("damaged worktree metadata");
      }
      if (path.resolve(admin, backlink) !== path.join(target, ".git")) {
        continue;
      }
      if (path.resolve(admin, read(path.join(admin, "commondir"))) !== commonDir) {
        throw new Error("damaged worktree metadata");
      }
      matches.push(admin);
    }
    if (matches.length > 1 || (purpose === "entry" && targetStat && matches.length !== 1)) {
      throw new Error("ambiguous worktree metadata");
    }
    process.stdout.write(
      JSON.stringify({
        path: target,
        present: Boolean(targetStat),
        admin: matches[0] ?? "",
        common: commonDir,
        previousAdminPresent: previousAdmin ? Boolean(stat(previousAdmin)) : false,
      }) + "\n",
    );
  } catch (error) {
    console.error(`Refusing PR worktree cleanup: ${error.code ?? error.message}`);
    process.exitCode = 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [operation, root, value, requested, previousAdmin, purpose] = process.argv.slice(2);
    if (operation === "resolve") {
      console.log(resolvePrWorktreePath(root, value));
    } else if (operation === "list") {
      process.stdout.write(JSON.stringify(listPrWorktreePaths(root)) + "\n");
    } else if (operation === "state") {
      printPrWorktreeState(root, value, requested, previousAdmin, purpose);
    } else if (operation === "admit") {
      if (!value) {
        throw new Error("Native PR parent admission requires the operation name");
      }
      requireIsolatedPrWorktreeParent(root, { writableFor: value });
    } else {
      throw new Error(
        "Usage: worktree-placement.mjs <resolve|list|state|admit> <root> [arguments]",
      );
    }
  } catch (error) {
    console.error(`Refusing native PR placement: ${error.message}`);
    process.exitCode = 1;
  }
}
