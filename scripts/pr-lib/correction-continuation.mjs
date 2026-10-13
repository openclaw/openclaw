import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { readRegular, requireCheckout, requireOperationOwner } from "./baseline-refresh.mjs";
import { incomingReview } from "./correction-review.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const executable = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const git = (...args) => execFileSync(executable, args, { encoding: "utf8" }).trim();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const oid = (bytes) =>
  execFileSync(executable, ["hash-object", "--no-filters", "--stdin"], {
    input: bytes,
    encoding: "utf8",
  }).trim();
const present = (path) => Boolean(fs.lstatSync(path, { throwIfNoEntry: false }));
const journalPath = ".local/review-transition.json";
const freshNames = ["pr-meta.json", "pr-meta.env", "review.json"];
const retiredNames = [
  "prep.env",
  "gates.env",
  "correction-review.json",
  "correction-review.md",
  "correction-incoming-review.json",
  "correction-incoming-review.md",
  "prepare-push-result.env",
  "prepare-sync-result.env",
  "prepare-baseline.json",
];
const sha = /^[a-f0-9]{40}$/u;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function inventory(archive) {
  if (!/^\.local\/prep-evidence\.[A-Za-z0-9]+$/u.test(archive)) {
    throw new Error("Invalid retained continuation evidence directory.");
  }
  if (!fs.lstatSync(archive).isDirectory()) {
    throw new Error("Missing retained preparation evidence.");
  }
  return Object.fromEntries(
    fs
      .readdirSync(archive)
      .toSorted()
      .map((name) => [name, digest(readRegular(join(archive, name)))]),
  );
}

function same(left, right, message) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(message);
  }
}

function validateRequest(request) {
  const { pr, head, tree, incoming, review, receipt, receiptOid, archive } = request;
  if (
    request.version !== 1 ||
    !Number.isSafeInteger(pr) ||
    pr < 1 ||
    ![head, tree, incoming, review, receiptOid].every((value) => sha.test(value)) ||
    !["prepare-push-result.env", "prepare-sync-result.env"].includes(receipt) ||
    head === incoming
  ) {
    throw new Error("Invalid correction continuation identity.");
  }
  same(inventory(archive), request.archiveFiles, "Retained continuation evidence changed.");
  for (const name of freshNames) {
    if (digest(readRegular(`.local/${name}`)) !== request.fresh[name]) {
      throw new Error(`Incoming continuation authority changed: ${name}`);
    }
  }
  const { prMeta } = incomingReview(pr, incoming, review);
  if (oid(readRegular(join(archive, receipt))) !== receiptOid) {
    throw new Error("Selected publication receipt changed.");
  }
  // Reuse the publication owner's complete receipt-chain and identical-tree checks.
  // The native env format already belongs to its shell reader; never reinterpret it.
  const fields = execFileSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
source "$1/prepare-core.sh"
source "$1/push.sh"
pr_git() { "\${OPENCLAW_PR_GIT:-\${GIT_EXEC:-git}}" "$@"; }
source .local/pr-meta.env
[ "$PR_NUMBER" = "$3" ] && [ "$PR_HEAD_SHA" = "$5" ] && [ "$PR_HEAD" = "$7" ]
source "$2/prep-context.env"
[ "$PR_NUMBER" = "$3" ] && [ "$PREP_BRANCH" = "pr-$3-prep" ] && [ "$PREP_REVIEW_MODE" = correction ]
resolve_prep_publication_target "$3" "$4" "$2"
[ "$PREP_PUBLICATION_LEASE_SHA" = "$5" ]
read_prep_publication_result "$2/$6"
[ "$PUSH_PREP_HEAD_SHA" = "$5" ] && [ "$PUSH_REPLACED_HOSTED_ANCESTRY" = false ]
printf '%s\\0' "$PR_HEAD" "$PR_HEAD_SHA_BEFORE" "$PREP_INCOMING_JSON_OID" "\${PR_AUTHOR_ACCESS_AT_PREP:-unknown}"
`,
      "correction-publication",
      scripts,
      archive,
      String(pr),
      head,
      incoming,
      receipt,
      prMeta.headRefName,
    ],
    { encoding: "utf8" },
  ).split("\0");
  const [headRef, oldIncoming, oldReview, access] = fields;
  if (
    headRef !== prMeta.headRefName ||
    oldIncoming === incoming ||
    !sha.test(oldIncoming) ||
    !sha.test(oldReview) ||
    oid(readRegular(join(archive, "correction-incoming-review.json"))) !== oldReview
  ) {
    throw new Error("Publication does not continue the retained incoming correction.");
  }
  const previous = JSON.parse(readRegular(join(archive, "correction-incoming-review.json")));
  if (previous.pr?.number !== pr || previous.pr?.headSha !== oldIncoming) {
    throw new Error("Retained incoming review belongs to another correction.");
  }
  git("merge-base", "--is-ancestor", incoming, head);
  if (git("rev-parse", `${head}^{tree}`) !== tree) {
    throw new Error("Retained correction tree changed.");
  }
  for (const commit of git("rev-list", `${incoming}..${head}`).split("\n")) {
    git("verify-commit", commit);
  }
  return Buffer.from(
    Object.entries({
      PR_NUMBER: pr,
      PR_HEAD: headRef,
      PR_HEAD_SHA_BEFORE: incoming,
      PREP_BRANCH: `pr-${pr}-prep`,
      PREP_REVIEW_MODE: "correction",
      PREP_INCOMING_JSON_OID: review,
      PR_AUTHOR_ACCESS_AT_PREP: access,
    })
      .map(([key, value]) => `${key}=${quote(value)}\n`)
      .join(""),
  );
}

function prepared(request, journal) {
  const context = validateRequest(request);
  const before = {};
  for (const name of ["prep-context.env", ...retiredNames]) {
    const path = `.local/${name}`;
    const bytes = present(path) ? readRegular(path) : null;
    const original = request.archiveFiles[name] ?? null;
    const actual = bytes ? digest(bytes) : null;
    if (
      actual !== original &&
      !(name === "prep-context.env" ? actual === digest(context) : actual === null)
    ) {
      throw new Error(`Unowned continuation state: ${name}`);
    }
    before[path] = actual;
  }
  return {
    request,
    journal: journal.toString("base64"),
    context: context.toString("base64"),
    before,
    cwd: fs.realpathSync("."),
    gitDir: git("rev-parse", "--absolute-git-dir"),
  };
}

function check(facts, pr, root, lockRef, lockOid) {
  const request = facts.request;
  if (request.pr !== pr) {
    throw new Error("Continuation operation identity changed.");
  }
  same(inventory(request.archive), request.archiveFiles, "Retained continuation evidence changed.");
  for (const name of freshNames) {
    if (digest(readRegular(`.local/${name}`)) !== request.fresh[name]) {
      throw new Error(`Incoming continuation authority changed: ${name}`);
    }
  }
  for (const [path, expected] of Object.entries(facts.before)) {
    const actual = present(path) ? digest(readRegular(path)) : null;
    if (actual !== expected) {
      throw new Error(`Continuation authority changed: ${path}`);
    }
  }
  git("--no-optional-locks", "diff", "--quiet");
  git("--no-optional-locks", "diff", "--cached", "--quiet");
  if (git("ls-files", "--others", "--exclude-standard")) {
    throw new Error("Untracked source blocks correction continuation.");
  }
  requireCheckout(request.head, request.head, `pr-${pr}-prep`, facts.cwd, facts.gitDir);
  requireOperationOwner(pr, root, lockRef, lockOid);
}

function writeOwned(path, bytes, checkCurrent) {
  const temporary = `${path}.${process.pid}`;
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    checkCurrent();
    fs.renameSync(temporary, path);
  } finally {
    if (present(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

function run(command, pr, root, lockRef, lockOid, args) {
  if (command === "prepare") {
    const [head, tree, incoming, review, receipt, receiptOid, archive] = args;
    const request = {
      version: 1,
      pr,
      head,
      tree,
      incoming,
      review,
      receipt,
      receiptOid,
      archive,
      archiveFiles: inventory(archive),
      fresh: Object.fromEntries(
        freshNames.map((name) => [name, digest(readRegular(`.local/${name}`))]),
      ),
    };
    const journal = Buffer.from(
      `${JSON.stringify({
        version: 1,
        mode: "correction",
        pr,
        source: head,
        target: head,
        branch: `pr-${pr}-prep`,
        continuation: request,
      })}\n`,
    );
    const facts = prepared(request, journal);
    if (present(journalPath)) {
      throw new Error("Retained transition blocks new continuation.");
    }
    // Initial admission requires every archived authority file still installed.
    for (const [path, actual] of Object.entries(facts.before)) {
      if (actual !== (request.archiveFiles[path.slice(7)] ?? null)) {
        throw new Error("Preparation authority changed during archive retention.");
      }
    }
    facts.before[journalPath] = null;
    check(facts, pr, root, lockRef, lockOid);
    process.stdout.write(JSON.stringify(facts));
  } else if (command === "replay") {
    const bytes = readRegular(journalPath);
    const journal = JSON.parse(bytes);
    const request = journal.continuation;
    if (
      journal.version !== 1 ||
      journal.mode !== "correction" ||
      journal.pr !== pr ||
      journal.source !== request?.head ||
      journal.target !== request.head ||
      journal.branch !== `pr-${pr}-prep`
    ) {
      throw new Error("Invalid correction continuation journal.");
    }
    same(
      Object.keys(journal).toSorted(),
      ["branch", "continuation", "mode", "pr", "source", "target", "version"],
      "Invalid correction continuation journal fields.",
    );
    if (args.length) {
      same(
        args,
        [
          request.head,
          request.tree,
          request.incoming,
          request.review,
          request.receipt,
          request.receiptOid,
        ],
        "Selected continuation differs from the retained transition.",
      );
    }
    const facts = prepared(request, bytes);
    facts.before[journalPath] = digest(bytes);
    check(facts, pr, root, lockRef, lockOid);
    process.stdout.write(JSON.stringify(facts));
  } else if (command === "apply") {
    // These facts exist only in the supervised invocation. Recovery always replays
    // the retained publication before the shell rechecks the live PR identity.
    const facts = JSON.parse(fs.readFileSync(0, "utf8"));
    const guard = () => check(facts, pr, root, lockRef, lockOid);
    guard();
    if (facts.before[journalPath] === null) {
      const bytes = Buffer.from(facts.journal, "base64");
      writeOwned(journalPath, bytes, guard);
      facts.before[journalPath] = digest(bytes);
    }
    for (const name of retiredNames) {
      const path = `.local/${name}`;
      if (facts.before[path] === null) {
        continue;
      }
      guard();
      fs.unlinkSync(path);
      facts.before[path] = null;
    }
    const context = Buffer.from(facts.context, "base64");
    writeOwned(".local/prep-context.env", context, guard);
    facts.before[".local/prep-context.env"] = digest(context);
    guard();
    fs.unlinkSync(journalPath);
  } else {
    throw new Error("Unknown correction continuation operation.");
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [command, pr, root, lockRef, lockOid, ...args] = process.argv.slice(2);
    run(command, Number(pr), root, lockRef, lockOid, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
