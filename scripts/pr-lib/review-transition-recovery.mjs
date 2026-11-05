import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { join, resolve } from "node:path";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { readRegular, requireOperationOwner } from "./baseline-refresh.mjs";
import { worktreeEntry } from "./review-transition-state.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const oid = /^[a-f0-9]{40}$/u;
const seal = /^[a-f0-9]{64}$/u;
const git = (...args) =>
  execFileSync(process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git", args, {
    maxBuffer: Infinity,
  });
const text = (...args) =>
  git(...args)
    .toString("utf8")
    .trim();

// Salvage one explicitly selected preimage; automatic transition admission is
// deliberately unchanged. The original bound workflow owns subsequent replay.
function recoverReviewTransitionFile(
  pr,
  planPath,
  planSha,
  root,
  lockRef,
  lockOid,
  workflow,
  binding,
) {
  const bytes = readRegular(planPath);
  if (!seal.test(planSha) || sha(bytes) !== planSha) {
    throw new Error("Recovery plan seal differs.");
  }
  const plan = JSON.parse(bytes);
  const keys = [
    "version",
    "pr",
    "binding",
    "head",
    "headRef",
    "journalSha256",
    "indexSha256",
    "path",
    "workingEntry",
    "reason",
  ];
  if (
    !plan ||
    Array.isArray(plan) ||
    Object.keys(plan).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(plan, key)) ||
    keys
      .filter((key) => key !== "version" && key !== "pr")
      .some((key) => typeof plan[key] !== "string") ||
    plan.version !== 1 ||
    !Number.isSafeInteger(plan.pr) ||
    String(plan.pr) !== pr ||
    !oid.test(plan.binding) ||
    !oid.test(plan.head) ||
    !seal.test(plan.journalSha256) ||
    !seal.test(plan.indexSha256) ||
    typeof plan.headRef !== "string" ||
    !/^100(?:644|755) [a-f0-9]{40}$/u.test(plan.workingEntry) ||
    typeof plan.reason !== "string" ||
    !plan.reason.trim() ||
    !oid.test(workflow) ||
    binding !== plan.binding
  ) {
    throw new Error("Invalid selected review recovery identity.");
  }
  if (
    typeof plan.path !== "string" ||
    plan.path.includes("\\") ||
    Array.from(plan.path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    plan.path
      .split("/")
      .some((part) => !part || [".", "..", ".git", ".local"].includes(part.toLowerCase()))
  ) {
    throw new Error("Recovery requires a normal tracked file path.");
  }
  const cwd = fs.realpathSync(".");
  const admin = text("rev-parse", "--absolute-git-dir");
  const indexPath = resolve(text("rev-parse", "--git-path", "index"));
  if (
    cwd !== fs.realpathSync(join(root, ".worktrees", "pr-" + pr)) ||
    cwd !== fs.realpathSync(text("rev-parse", "--show-toplevel")) ||
    indexPath !== join(admin, "index") ||
    fs.realpathSync(text("rev-parse", "--git-common-dir")) !== fs.realpathSync(join(root, ".git"))
  ) {
    throw new Error("Review recovery checkout identity differs.");
  }
  const journal = readRegular(".local/review-transition.json");
  const index = readRegular(indexPath);
  const transition = JSON.parse(journal);
  if (
    sha(journal) !== plan.journalSha256 ||
    sha(index) !== plan.indexSha256 ||
    transition.version !== 1 ||
    transition.pr !== Number(pr) ||
    transition.mode !== "detached" ||
    transition.branch !== null ||
    Object.keys(transition).toSorted().join(",") !== "branch,mode,pr,source,target,version" ||
    !oid.test(transition.source) ||
    !oid.test(transition.target) ||
    ![transition.source, transition.target].includes(plan.head)
  ) {
    throw new Error("Recovery journal or index differs from the selected review transition.");
  }
  const entry = (commit) => {
    const raw = git("--literal-pathspecs", "ls-tree", "-z", commit, "--", plan.path).toString(
      "utf8",
    );
    const [row, tail, ...extra] = raw.split("\0");
    const match = /^(100(?:644|755)) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
    if (tail !== "" || extra.length || !match || match[3] !== plan.path) {
      throw new Error("Both journal endpoints must contain the selected regular file.");
    }
    return match[1] + " " + match[2];
  };
  const sourceEntry = entry(transition.source);
  const targetEntry = entry(transition.target);
  if ([sourceEntry, targetEntry].includes(plan.workingEntry)) {
    throw new Error("Selected file is already owned by ordinary transition replay.");
  }
  const source = git("cat-file", "blob", sourceEntry.split(" ")[1]);
  const ref = "refs/openclaw/pr-workflow-bindings/" + pr;
  function assertCustody() {
    try {
      requireOperationOwner(pr, root, lockRef, lockOid);
    } catch {
      throw new Error("Review recovery no longer holds its native PR operation lock.");
    }
    const symbolic = spawnSync(
      process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git",
      ["symbolic-ref", "-q", "HEAD"],
      { encoding: "utf8" },
    );
    const symbolicBinding = spawnSync(
      process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git",
      ["symbolic-ref", "-q", ref],
      { encoding: "utf8" },
    );
    if (
      symbolicBinding.error ||
      symbolicBinding.signal ||
      symbolicBinding.status !== 1 ||
      symbolic.error ||
      symbolic.signal ||
      ![0, 1].includes(symbolic.status) ||
      symbolic.stdout.trim() !== plan.headRef ||
      text("rev-parse", "HEAD") !== plan.head ||
      text("rev-parse", "--verify", ref) !== binding ||
      sha(readRegular(".local/review-transition.json")) !== plan.journalSha256 ||
      sha(readRegular(indexPath)) !== plan.indexSha256 ||
      fs.realpathSync(".") !== cwd ||
      !fs.lstatSync(".local").isDirectory() ||
      fs.lstatSync(".local").isSymbolicLink()
    ) {
      throw new Error(
        "Review recovery custody changed; preserve the existing checkout and backup.",
      );
    }
  }
  assertCustody();
  const directory = join(".local", "review-transition-recovery." + planSha);
  const actual = worktreeEntry(plan.path);
  if (actual !== plan.workingEntry && !(actual === sourceEntry && fs.existsSync(directory))) {
    throw new Error("Selected working file differs; no replacement performed.");
  }
  const names = new Set([
    "plan.json",
    "worktree.before",
    "journal.before",
    "index.before",
    "provenance.json",
    "replacement",
  ]);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  if (
    !fs.lstatSync(directory).isDirectory() ||
    fs.lstatSync(directory).isSymbolicLink() ||
    fs.readdirSync(directory).some((name) => !names.has(name))
  ) {
    throw new Error("Recovery backup has unexpected entries.");
  }
  const preserve = (name, content, mode = 0o600) => {
    const path = join(directory, name);
    if (!fs.existsSync(path)) {
      fs.writeFileSync(path, content, { flag: "wx", mode });
    }
    if (!readRegular(path).equals(content)) {
      throw new Error("Recovery backup differs: " + name);
    }
  };
  preserve("plan.json", bytes);
  preserve("journal.before", journal);
  preserve("index.before", index);
  // A lost response can be reconciled only using this exact retained preimage,
  // not merely because the destination now happens to match a Git endpoint.
  const backup = join(directory, "worktree.before");
  const before = fs.existsSync(backup) ? readRegular(backup) : readRegular(plan.path);
  const blob = createHash("sha1")
    .update("blob " + before.length + "\0")
    .update(before)
    .digest("hex");
  if (blob !== plan.workingEntry.split(" ")[1]) {
    throw new Error("Selected recovery preimage differs.");
  }
  preserve("worktree.before", before);
  const provenance = join(directory, "provenance.json");
  if (!fs.existsSync(provenance)) {
    fs.writeFileSync(
      provenance,
      JSON.stringify({ binding, workflow, source: transition.source, target: transition.target }) +
        "\n",
      { flag: "wx", mode: 0o600 },
    );
  } else {
    const retained = JSON.parse(readRegular(provenance));
    if (
      retained.binding !== binding ||
      retained.source !== transition.source ||
      retained.target !== transition.target ||
      !oid.test(retained.workflow)
    ) {
      throw new Error("Recovery backup provenance differs.");
    }
  }
  if (actual === sourceEntry) {
    assertCustody();
    return {
      status: "already_repaired",
      path: plan.path,
      backup: directory,
      transition: "pending",
    };
  }
  if (actual !== plan.workingEntry) {
    throw new Error("Selected working file differs; no replacement performed.");
  }
  const replacement = join(directory, "replacement");
  preserve("replacement", source, sourceEntry.startsWith("100755") ? 0o755 : 0o644);
  assertCustody();
  if (
    worktreeEntry(plan.path) !== plan.workingEntry ||
    worktreeEntry(replacement) !== sourceEntry
  ) {
    throw new Error("Review recovery file changed before replacement.");
  }
  console.log(JSON.stringify({ status: "preserved", path: plan.path, backup: directory }));
  fs.renameSync(replacement, plan.path);
  if (worktreeEntry(plan.path) !== sourceEntry) {
    throw new Error("Recovery replacement requires reconciliation; preserve its backup.");
  }
  return { status: "repaired", path: plan.path, backup: directory, transition: "pending" };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    if (process.argv.length !== 10) {
      throw new Error("Review recovery requires the selected plan and native operation owner.");
    }
    console.log(JSON.stringify(recoverReviewTransitionFile(...process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
