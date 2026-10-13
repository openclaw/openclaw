import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { validateReviewArtifacts } from "./review-artifacts.mjs";
import { worktreeEntry } from "./review-transition-state.mjs";

const executable = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const bindingPath = ".local/prepare-baseline.json";
const oidPattern = /^[a-f0-9]{40}$/u;
const modes = new Set(["100644", "100755", "120000"]);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const present = (path) => Boolean(fs.lstatSync(path, { throwIfNoEntry: false }));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Invocation-local replay facts, never a persisted admission or recovery token.
let replayFiles;
let replayDirectories;

function git(args, options = {}) {
  return execFileSync(executable, args, { maxBuffer: Infinity, ...options });
}
const text = (...args) => decoder.decode(git(args)).trim();
const hash = (bytes, write = false) =>
  decoder
    .decode(
      git(["hash-object", "--no-filters", ...(write ? ["-w"] : []), "--stdin"], { input: bytes }),
    )
    .trim();

// Empty resolution files are valid blobs. Read the opened regular descriptor once;
// Git receives those bytes without filters, pathname rereads or text normalization.
function readRegular(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) {
      throw new Error(`Expected a regular file: ${path}`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (["size", "mtimeMs", "ctimeMs"].some((key) => before[key] !== after[key])) {
      throw new Error(`File changed while reading: ${path}`);
    }
    if (replayFiles) {
      const value = digest(bytes);
      if (Object.hasOwn(replayFiles, path) && replayFiles[path] !== value) {
        throw new Error("Preparation evidence changed during replay: " + path);
      }
      replayFiles[path] = value;
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function exactKeys(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error("Unexpected baseline refresh record fields.");
  }
}

function safePath(path) {
  if (typeof path !== "string" || !path) {
    throw new Error(`Unsupported product path: ${JSON.stringify(path)}`);
  }
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      throw new Error(`Unsupported product path: ${JSON.stringify(path)}`);
    }
  }
  if (
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
    path.split("/")[0].toLowerCase() === ".local"
  ) {
    throw new Error(`Unsupported product path: ${JSON.stringify(path)}`);
  }
  return path;
}

function paths(from, to, validate = true) {
  const changed = decoder
    .decode(
      git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        from,
        to,
        "--",
      ]),
    )
    .split("\0")
    .filter(Boolean);
  return validate ? changed.map(safePath) : changed;
}

function tree(commit) {
  return new Map(
    decoder
      .decode(git(["ls-tree", "-r", "-z", commit]))
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match = /^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(line);
        if (!match) {
          throw new Error("Invalid baseline tree entry.");
        }
        return [match[3], { mode: match[1], oid: match[2] }];
      }),
  );
}

const same = (left, right) => left?.mode === right?.mode && left?.oid === right?.oid;

function entry(value) {
  if (value === null) {
    return;
  }
  exactKeys(value, ["mode", "oid"]);
  if (
    !modes.has(value.mode) ||
    !oidPattern.test(value.oid) ||
    text("cat-file", "-t", value.oid) !== "blob"
  ) {
    throw new Error("Invalid baseline blob or mode.");
  }
}

function resolveConflict(conflict, supplied, manifestPath) {
  exactKeys(supplied, ["path", "base", "source", "baseline", "resolved"]);
  for (const name of ["base", "source", "baseline"]) {
    entry(supplied[name]);
    if (!same(supplied[name], conflict[name])) {
      throw new Error(`Stale ${name} resolution for ${conflict.path}.`);
    }
  }
  if (supplied.resolved === null) {
    return { ...conflict, resolved: null };
  }
  if (!manifestPath) {
    entry(supplied.resolved);
    return { ...conflict, resolved: supplied.resolved };
  }
  exactKeys(supplied.resolved, ["mode", "file", "sha256"]);
  const { mode, file, sha256 } = supplied.resolved;
  if (!modes.has(mode) || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Invalid resolution mode or digest.");
  }
  safePath(file);
  let parent = dirname(resolve(manifestPath));
  for (const part of file.split("/").slice(0, -1)) {
    parent = join(parent, part);
    if (!fs.lstatSync(parent).isDirectory()) {
      throw new Error("Resolution path traverses a non-directory.");
    }
  }
  const bytes = readRegular(resolve(dirname(manifestPath), file));
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error(`Resolution bytes changed for ${conflict.path}.`);
  }
  return { ...conflict, resolved: { mode, oid: hash(bytes, true) } };
}

function materialize(source, baseline, resolutions, manifestPath) {
  const bases = text("merge-base", "--all", source, baseline).split("\n");
  if (bases.length !== 1 || !oidPattern.test(bases[0])) {
    throw new Error("Baseline refresh requires one source/baseline fork base.");
  }
  const forkBase = bases[0];
  const changed = paths(forkBase, source);
  if (!changed.length) {
    throw new Error("Baseline refresh has no product delta.");
  }
  const [baseTree, sourceTree, baselineTree] = [forkBase, source, baseline].map(tree);
  const allPaths = new Set([...baseTree.keys(), ...sourceTree.keys(), ...baselineTree.keys()]);
  for (const path of changed) {
    for (const entries of [baseTree, sourceTree, baselineTree]) {
      const value = entries.get(path);
      if (value && !modes.has(value.mode)) {
        throw new Error(`Unsupported product mode at ${path}.`);
      }
    }
    if (
      [...allPaths].some((other) => other.startsWith(`${path}/`) || path.startsWith(`${other}/`))
    ) {
      throw new Error(`Directory/file overlap requires a separate source repair: ${path}.`);
    }
  }
  if (
    !Array.isArray(resolutions) ||
    new Set(resolutions.map((item) => item?.path)).size !== resolutions.length
  ) {
    throw new Error("Duplicate or invalid conflict resolutions.");
  }
  const supplied = new Map(resolutions.map((item) => [item.path, item]));
  const retained = [];
  const directory = fs.mkdtempSync(join(tmpdir(), "openclaw-pr-baseline-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
  const indexGit = (args, options = {}) => git(args, { env, ...options });
  const setEntry = (path, value) => {
    const line = value ? `${value.mode} ${value.oid}\t${path}\0` : `0 ${"0".repeat(40)}\t${path}\0`;
    indexGit(["update-index", "-z", "--index-info"], { input: line });
  };
  try {
    indexGit(["read-tree", baseline]);
    const conflicts = [];
    for (const path of changed) {
      const base = baseTree.get(path) ?? null;
      const candidate = sourceTree.get(path) ?? null;
      const main = baselineTree.get(path) ?? null;
      if (same(main, base) || same(main, candidate)) {
        setEntry(path, candidate);
        continue;
      }
      // Absence and type changes are tree conflicts; no worktree content can
      // decide them. Executable bits follow the same three-way equality rule.
      let conflict =
        !base ||
        !candidate ||
        !main ||
        [base, candidate, main].some((value) => value?.mode === "120000");
      if (!conflict) {
        const mode =
          candidate.mode === base.mode
            ? main.mode
            : main.mode === base.mode || main.mode === candidate.mode
              ? candidate.mode
              : null;
        conflict = mode === null;
        let oid;
        if (candidate.oid === base.oid) {
          oid = main.oid;
        } else if (main.oid === base.oid || main.oid === candidate.oid) {
          oid = candidate.oid;
        } else if (!conflict) {
          const inputs = [main, base, candidate].map((value) =>
            git(["cat-file", "blob", value.oid]),
          );
          // NUL-containing competing edits require an explicit blob resolution.
          conflict = inputs.some((bytes) => bytes.includes(0));
          if (!conflict) {
            const files = ["baseline", "base", "source"].map((name, index) => {
              const file = join(directory, name);
              fs.writeFileSync(file, inputs[index], { mode: 0o600 });
              return file;
            });
            // merge-file uses built-in Myers, without attributes/custom drivers.
            // Explicit style also makes reconstruction independent of config.
            const result = spawnSync(executable, ["merge-file", "--stdout", "--diff3", ...files], {
              env,
              maxBuffer: Infinity,
            });
            if (result.error) {
              throw result.error;
            }
            conflict = result.status >= 1 && result.status <= 127;
            if (result.status !== 0 && !conflict) {
              throw new Error(
                `Cannot replay ${path}: ${result.signal ?? decoder.decode(result.stderr)}`,
              );
            }
            if (!conflict) {
              oid = hash(result.stdout, true);
            }
          }
        }
        if (!conflict) {
          setEntry(path, { mode, oid });
        }
      }
      if (!conflict) {
        continue;
      }
      const input = { path, base, source: candidate, baseline: main };
      conflicts.push(input);
      const resolution = supplied.get(path);
      if (resolution) {
        const bound = resolveConflict(input, resolution, manifestPath);
        retained.push(bound);
        setEntry(path, null);
        if (bound.resolved) {
          setEntry(path, bound.resolved);
        }
        supplied.delete(path);
      } else {
        // Report every native conflict while leaving the baseline entry intact.
        setEntry(path, null);
        if (main) {
          setEntry(path, main);
        }
      }
    }
    if (retained.length !== conflicts.length || supplied.size) {
      throw new Error(
        `Expected exactly the computed conflict resolutions: ${JSON.stringify(conflicts)}`,
      );
    }
    const resultTree = decoder.decode(indexGit(["write-tree"])).trim();
    if (paths(baseline, resultTree).some((path) => !changed.includes(path))) {
      throw new Error(
        "Baseline materialization changed an entry outside the complete product delta.",
      );
    }
    return { forkBase, paths: changed, resolutions: retained, tree: resultTree };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function bindingAt(anchor, suppliedBytes) {
  const markers = text("show", "-s", "--format=%B", anchor).match(
    /^Baseline-Refresh: ([a-f0-9]{40})$/gmu,
  );
  if (markers?.length !== 1) {
    throw new Error("Missing signed baseline refresh binding.");
  }
  const oid = markers[0].slice("Baseline-Refresh: ".length);
  const bytes = suppliedBytes ?? readRegular(bindingPath);
  if (hash(bytes) !== oid) {
    throw new Error("Retained baseline binding differs from the signed candidate.");
  }
  const record = JSON.parse(decoder.decode(bytes));
  exactKeys(record, [
    "version",
    "pr",
    "sourceHead",
    "baselineHead",
    "capturedMain",
    "forkBase",
    "tree",
    "incomingHead",
    "incomingReviewOid",
    "archive",
    "authority",
    "resolutions",
    ...(Object.hasOwn(record, "sourceAdmission") ? ["sourceAdmission"] : []),
  ]);
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.pr) ||
    record.pr < 1 ||
    ![
      record.sourceHead,
      record.baselineHead,
      record.capturedMain,
      record.forkBase,
      record.tree,
      record.incomingHead,
      record.incomingReviewOid,
    ].every((value) => oidPattern.test(value)) ||
    !/^\.local\/prep-evidence\.[A-Za-z0-9]+$/u.test(record.archive)
  ) {
    throw new Error("Invalid baseline refresh binding.");
  }
  if (text("show", "-s", "--format=%P", anchor) !== `${record.sourceHead} ${record.baselineHead}`) {
    throw new Error("Refreshed candidate lost its ordered source and baseline parents.");
  }
  git(["verify-commit", anchor]);
  git(["verify-commit", record.sourceHead]);
  git(["merge-base", "--is-ancestor", record.incomingHead, record.sourceHead]);
  git(["merge-base", "--is-ancestor", record.baselineHead, record.capturedMain]);
  const replay = materialize(record.sourceHead, record.baselineHead, record.resolutions);
  if (
    replay.forkBase !== record.forkBase ||
    replay.tree !== record.tree ||
    text("rev-parse", `${anchor}^{tree}`) !== replay.tree
  ) {
    throw new Error("Baseline refresh tree does not reproduce the complete product delta.");
  }
  paths(record.sourceHead, anchor);
  return { record, oid, bytes, paths: replay.paths };
}

const authorityPaths = [
  ".local/prep-context.env",
  ".local/pr-meta.json",
  ".local/pr-meta.env",
  ".local/review.json",
  ".local/correction-review.json",
  ".local/correction-incoming-review.json",
  ".local/prep.env",
  ".local/prepare-push-result.env",
  ".local/prepare-sync-result.env",
  bindingPath,
];
const retiredNames = [
  "gates.env",
  "prep.env",
  "correction-review.json",
  "correction-review.md",
  "correction-incoming-review.json",
  "correction-incoming-review.md",
  "prepare-push-result.env",
  "prepare-sync-result.env",
];

function proofInventory(archives) {
  return Object.fromEntries(
    archives.map((archive) => {
      if (
        !/^\.local\/prep-evidence\.[A-Za-z0-9]+$/u.test(archive) ||
        !fs.lstatSync(archive).isDirectory()
      ) {
        throw new Error("Invalid retained proof directory.");
      }
      const names = fs.readdirSync(archive).toSorted();
      if (replayDirectories) {
        replayDirectories[archive] = names;
      }
      return [
        archive,
        Object.fromEntries(names.map((name) => [name, hash(readRegular(join(archive, name)))])),
      ];
    }),
  );
}

function retainedAuthority(binding) {
  const { record, oid } = binding;
  exactKeys(record.authority, authorityPaths);
  if (!fs.lstatSync(record.archive).isDirectory()) {
    throw new Error("Invalid retained preparation directory.");
  }
  const retained = (path) => readRegular(join(record.archive, path.slice(".local/".length)));
  const context = retained(".local/prep-context.env");
  const admission = record.sourceAdmission;
  let predecessor;
  let prior;
  if (Object.hasOwn(record, "sourceAdmission")) {
    exactKeys(admission, [
      "predecessorHead",
      "predecessorBinding",
      "sourceReviewOid",
      "sourceTree",
      "evidence",
    ]);
    if (
      ![
        admission.predecessorHead,
        admission.predecessorBinding,
        admission.sourceReviewOid,
        admission.sourceTree,
      ].every((value) => oidPattern.test(value)) ||
      admission.predecessorBinding !== record.authority[bindingPath] ||
      admission.sourceReviewOid !== record.authority[".local/correction-review.json"] ||
      admission.sourceTree !== text("rev-parse", `${record.sourceHead}^{tree}`)
    ) {
      throw new Error("Successor source admission identity changed.");
    }
    git(["merge-base", "--is-ancestor", admission.predecessorHead, record.sourceHead]);
    predecessor = {
      ...bindingAt(admission.predecessorHead, retained(bindingPath)),
      anchor: admission.predecessorHead,
    };
    if (
      predecessor.oid !== admission.predecessorBinding ||
      predecessor.record.pr !== record.pr ||
      predecessor.record.incomingHead !== record.incomingHead ||
      predecessor.record.incomingReviewOid !== record.incomingReviewOid
    ) {
      throw new Error("Successor predecessor authority changed.");
    }
    prior = retainedAuthority(predecessor);
    if (!context.equals(prior.boundContext)) {
      throw new Error("Successor source context does not retain its predecessor binding.");
    }
    const inventory = proofInventory([...prior.archives, record.archive]);
    if (JSON.stringify(inventory) !== JSON.stringify(admission.evidence)) {
      throw new Error("Retained successor proof changed.");
    }
  }
  for (const path of authorityPaths) {
    const expected = record.authority[path];
    if (path === bindingPath) {
      if (expected !== "absent" && !admission) {
        throw new Error("Nested baseline refresh requires separate source admission.");
      }
      continue;
    }
    if (!["absent"].includes(expected) && !oidPattern.test(expected)) {
      throw new Error("Invalid retained authority object ID.");
    }
    if ([".local/pr-meta.json", ".local/pr-meta.env", ".local/review.json"].includes(path)) {
      if (hash(readRegular(path)) !== expected) {
        throw new Error(`Incoming authority changed: ${path}`);
      }
    } else if (expected !== "absent" && hash(retained(path)) !== expected) {
      throw new Error(`Retained preparation authority changed: ${path}`);
    }
  }
  const meta = JSON.parse(readRegular(".local/pr-meta.json"));
  const review = JSON.parse(retained(".local/correction-review.json"));
  const incoming = JSON.parse(readRegular(".local/review.json"));
  const required = incoming.findings.filter((finding) =>
    ["BLOCKER", "IMPORTANT"].includes(finding.severity),
  );
  const scope = new Set([
    ...meta.files.map((file) => file.path),
    ...(predecessor
      ? [...prior.scope, ...paths(predecessor.anchor, record.sourceHead)]
      : paths(record.incomingHead, record.sourceHead)),
  ]);
  const violations = validateReviewArtifacts({
    review,
    prMeta: { ...meta, headRefOid: record.sourceHead, files: [...scope].map((path) => ({ path })) },
  });
  if (
    violations.length ||
    review.recommendation !== "READY FOR /prepare-pr" ||
    meta.number !== record.pr ||
    meta.headRefOid !== record.incomingHead ||
    record.authority[".local/review.json"] !== record.incomingReviewOid ||
    incoming.recommendation !== "NEEDS WORK" ||
    !required.length ||
    review.correction?.incomingHeadSha !== record.incomingHead ||
    review.correction?.incomingReviewJsonOid !== record.incomingReviewOid ||
    record.authority[".local/correction-incoming-review.json"] !== record.incomingReviewOid ||
    review.correction.resolvedFindings?.length !== required.length ||
    !required.every(({ id }) =>
      review.correction.resolvedFindings.some((item) => item.id === id && item.resolution?.trim()),
    )
  ) {
    throw new Error(
      `Retained correction review does not authorize its source. ${violations.join("; ")}`,
    );
  }
  if (!admission && /^PREP_BASELINE_REFRESH_(?:HEAD|OID)=/mu.test(decoder.decode(context))) {
    throw new Error("Source context is already baseline-bound.");
  }
  return {
    context,
    scope: [
      ...new Set([
        ...binding.paths,
        ...(prior ? [...prior.scope, ...paths(predecessor.anchor, record.sourceHead)] : []),
      ]),
    ],
    archives: [...(prior?.archives ?? []), record.archive],
    boundContext: Buffer.concat([
      admission
        ? Buffer.from(
            decoder
              .decode(context)
              .replace(/^PREP_BASELINE_REFRESH_(?:HEAD|OID)=[a-f0-9]{40}\n/gmu, ""),
          )
        : context,
      Buffer.from(
        `\nPREP_BASELINE_REFRESH_OID=${oid}\nPREP_BASELINE_REFRESH_HEAD=${binding.anchor}\n`,
      ),
    ]),
  };
}

function atomicWrite(path, bytes) {
  const pending = `${path}.${process.pid}.pending`;
  fs.writeFileSync(pending, bytes, { flag: "wx", mode: 0o600 });
  fs.renameSync(pending, path);
}

function requireOperationOwner(pr, root, lockRef, lockOid) {
  if (lockRef !== `refs/openclaw/pr-operation-locks/${pr}` || !oidPattern.test(lockOid)) {
    throw new Error("Missing baseline transition operation owner.");
  }
  execFileSync("bash", [
    "-c",
    'source "$1"; pr_git() { "${OPENCLAW_PR_GIT:-${GIT_EXEC:-git}}" "$@"; }; pr_operation_lock_owner_is_current "$2" "$3" "$4"',
    "baseline-operation-owner",
    fileURLToPath(new URL("./operation-lock.sh", import.meta.url)),
    root,
    lockRef,
    lockOid,
  ]);
}

function requireCheckout(source, anchor, branch, cwd, gitDir) {
  if (
    fs.realpathSync(".") !== cwd ||
    text("rev-parse", "--absolute-git-dir") !== gitDir ||
    text("symbolic-ref", "--short", "HEAD") !== branch ||
    ![source, anchor].includes(text("rev-parse", `refs/heads/${branch}`))
  ) {
    throw new Error("Baseline transition source or preparation branch changed.");
  }
}

function workspace(source, ownedPaths) {
  const foreign = (names) =>
    names
      .split("\0")
      .filter(
        (path) =>
          path && path !== ".local" && !path.startsWith(".local/") && !ownedPaths.includes(path),
      );
  return {
    index: digest(git(["ls-files", "--stage", "-v", "-z"])),
    // Source-index reconstruction must not change the identity of a target-only
    // file. The transition-state owner reads exact bytes/modes without Git filters.
    work: digest(JSON.stringify(ownedPaths.map((path) => [path, worktreeEntry(path) ?? null]))),
    foreign: JSON.stringify([
      foreign(
        decoder.decode(
          git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", source, "--"]),
        ),
      ),
      foreign(decoder.decode(git(["ls-files", "--others", "--exclude-standard", "-z"]))),
    ]),
  };
}

function checkPrepared(facts, pr, source, anchor, branch, root, lockRef, lockOid, restoring) {
  if (
    JSON.stringify(facts.identity) !==
    JSON.stringify([pr, source, anchor, branch, root, lockRef, lockOid])
  ) {
    throw new Error("Prepared transition identity changed.");
  }
  for (const [path, expected] of Object.entries(facts.files)) {
    const actual = present(path) ? digest(readRegular(path)) : null;
    if (actual !== expected) {
      throw new Error("Preparation evidence changed after replay: " + path);
    }
  }
  for (const [path, names] of Object.entries(facts.directories)) {
    if (
      !fs.lstatSync(path).isDirectory() ||
      JSON.stringify(fs.readdirSync(path).toSorted()) !== JSON.stringify(names)
    ) {
      throw new Error("Retained proof inventory changed after replay.");
    }
  }
  const current = workspace(source, facts.paths);
  if (
    (current.index !== facts.workspace.index &&
      (!restoring || current.index !== facts.sourceIndex)) ||
    current.work !== facts.workspace.work ||
    current.foreign !== facts.workspace.foreign
  ) {
    throw new Error("Preparation worktree changed after replay.");
  }
  // No signature verification, tree materialization or review recursion follows
  // this local check. It is consumed immediately by the owning side effect.
  requireOperationOwner(pr, root, lockRef, lockOid);
  requireCheckout(source, anchor, branch, facts.cwd, facts.gitDir);
}

function transition(command, pr, source, anchor, branch, root, lockRef, lockOid) {
  const identity = [pr, source, anchor, branch, root, lockRef, lockOid];
  if (command !== "validate-transition") {
    const facts = JSON.parse(fs.readFileSync(0, "utf8"));
    const check = () => checkPrepared(facts, ...identity, command === "restore-transition");
    check();
    if (command === "install-transition") {
      for (const [path, encoded] of [
        [bindingPath, facts.binding],
        [".local/prep-context.env", facts.context],
      ]) {
        const bytes = Buffer.from(encoded, "base64");
        if (facts.files[path] !== digest(bytes)) {
          check();
          atomicWrite(path, bytes);
          facts.files[path] = digest(bytes);
        }
      }
      for (const name of retiredNames) {
        const path = `.local/${name}`;
        check();
        fs.rmSync(path, { force: true });
        facts.files[path] = null;
      }
      check();
      process.stdout.write(JSON.stringify(facts));
    }
    return;
  }

  const cwd = fs.realpathSync(".");
  const gitDir = text("rev-parse", "--absolute-git-dir");
  const ownedPaths = paths(source, anchor);
  const work = workspace(source, ownedPaths);
  replayFiles = {};
  replayDirectories = {};
  const journal = JSON.parse(readRegular(".local/review-transition.json"));
  exactKeys(journal, ["version", "pr", "source", "target", "mode", "branch", "binding"]);
  if (
    journal.version !== 1 ||
    journal.pr !== pr ||
    journal.source !== source ||
    journal.target !== anchor ||
    journal.mode !== "prep" ||
    journal.branch !== branch ||
    typeof journal.binding !== "string"
  ) {
    throw new Error("Baseline transition journal changed.");
  }
  const bytes = Buffer.from(journal.binding, "base64");
  if (bytes.toString("base64") !== journal.binding) {
    throw new Error("Invalid retained baseline binding bytes.");
  }
  const binding = { ...bindingAt(anchor, bytes), anchor };
  const { record } = binding;
  if (record.pr !== pr || record.sourceHead !== source || branch !== `pr-${pr}-prep`) {
    throw new Error("Baseline transition source or preparation branch changed.");
  }
  const { context, boundContext } = retainedAuthority(binding);
  const currentContext = readRegular(".local/prep-context.env");
  if (!currentContext.equals(context) && !currentContext.equals(boundContext)) {
    throw new Error("Preparation context changed during baseline transition.");
  }
  if (record.sourceAdmission && !present(bindingPath)) {
    throw new Error("Successor transition lost its predecessor binding.");
  }
  if (
    present(bindingPath) &&
    !readRegular(bindingPath).equals(binding.bytes) &&
    (!record.sourceAdmission ||
      hash(readRegular(bindingPath)) !== record.sourceAdmission.predecessorBinding)
  ) {
    throw new Error("Baseline transition binding changed.");
  }
  for (const name of retiredNames) {
    const path = `.local/${name}`;
    if (
      fs.lstatSync(path, { throwIfNoEntry: false }) &&
      !readRegular(path).equals(readRegular(join(record.archive, name)))
    ) {
      throw new Error(`Active evidence changed during baseline transition: ${path}`);
    }
  }

  const files = replayFiles;
  const directories = replayDirectories;
  replayFiles = undefined;
  replayDirectories = undefined;
  for (const path of [...authorityPaths, ...retiredNames.map((name) => `.local/${name}`)]) {
    const value = present(path) ? digest(readRegular(path)) : null;
    if (Object.hasOwn(files, path) && files[path] !== value) {
      throw new Error("Preparation evidence changed during replay: " + path);
    }
    files[path] = value;
  }
  const sourceIndex = digest(
    Buffer.from(
      [...tree(source)]
        .map(([path, value]) => `H ${value.mode} ${value.oid} 0\t${path}\0`)
        .join(""),
    ),
  );
  const facts = {
    identity,
    cwd,
    gitDir,
    files,
    directories,
    workspace: work,
    sourceIndex,
    paths: ownedPaths,
    binding: bytes.toString("base64"),
    context: boundContext.toString("base64"),
  };
  checkPrepared(facts, ...identity, false);
  process.stdout.write(JSON.stringify(facts));
}

function checkSource(pr, source, cwd, root, lockRef, lockOid) {
  const snapshot = fs.readFileSync(0, "utf8").trim().split("\n");
  for (const line of snapshot) {
    const [path, expected] = line.split(" ");
    if (
      !authorityPaths.includes(path) ||
      (present(path) ? hash(readRegular(path)) : "absent") !== expected
    ) {
      throw new Error("Correction review authority changed during admission.");
    }
  }
  git(["diff", "--quiet"]);
  git(["diff", "--cached", "--quiet"]);
  if (text("ls-files", "--others", "--exclude-standard", "-z")) {
    throw new Error("Untracked source blocks baseline admission.");
  }
  requireOperationOwner(pr, root, lockRef, lockOid);
  requireCheckout(source, source, `pr-${pr}-prep`, cwd, text("rev-parse", "--absolute-git-dir"));
}

export function baselineRefreshScope({
  pr,
  incoming,
  incomingReviewOid,
  head,
  anchor,
  bindingOid,
}) {
  if (!anchor && !bindingOid) {
    if (present(bindingPath)) {
      throw new Error("Unbound baseline refresh evidence; retain and reconcile preparation.");
    }
    return paths(incoming, head, false);
  }
  const binding = bindingAt(anchor);
  if (
    binding.oid !== bindingOid ||
    hash(readRegular(bindingPath)) !== bindingOid ||
    binding.record.pr !== pr ||
    binding.record.incomingHead !== incoming ||
    binding.record.incomingReviewOid !== incomingReviewOid
  ) {
    throw new Error("Baseline refresh authority changed.");
  }
  const retained = retainedAuthority({ ...binding, anchor });
  git(["merge-base", "--is-ancestor", anchor, head]);
  return [...retained.scope, ...paths(anchor, head)];
}

function create(pr, source, baseline, main, archive, snapshot, manifestPath, successor) {
  if (
    ![source, baseline, main].every((value) => oidPattern.test(value)) ||
    (!successor && present(bindingPath))
  ) {
    throw new Error("Invalid or already bound baseline refresh source.");
  }
  git(["verify-commit", source]);
  git(["merge-base", "--is-ancestor", baseline, main]);
  const authority = Object.fromEntries(
    snapshot
      .trim()
      .split("\n")
      .map((line) => line.split(" ")),
  );
  let sourceAdmission;
  if (successor) {
    const [predecessorHead, predecessorBinding, sourceReviewOid, sourceTree] = successor;
    const predecessor = { ...bindingAt(predecessorHead), anchor: predecessorHead };
    const prior = retainedAuthority(predecessor);
    if (
      predecessor.oid !== predecessorBinding ||
      authority[bindingPath] !== predecessorBinding ||
      authority[".local/correction-review.json"] !== sourceReviewOid ||
      text("rev-parse", `${source}^{tree}`) !== sourceTree ||
      !readRegular(".local/prep-context.env").equals(prior.boundContext)
    ) {
      throw new Error("Successor admission does not match its exact source authority.");
    }
    git(["merge-base", "--is-ancestor", predecessorHead, source]);
    sourceAdmission = {
      predecessorHead,
      predecessorBinding,
      sourceReviewOid,
      sourceTree,
      evidence: proofInventory([...prior.archives, archive]),
    };
  }
  const prMeta = JSON.parse(readRegular(".local/pr-meta.json"));
  const manifest = manifestPath ? JSON.parse(readRegular(manifestPath)) : undefined;
  if (manifestPath) {
    exactKeys(manifest, ["version", "pr", "sourceHead", "baselineHead", "forkBase", "resolutions"]);
    if (
      manifest.version !== 1 ||
      manifest.pr !== pr ||
      manifest.sourceHead !== source ||
      manifest.baselineHead !== baseline ||
      manifest.forkBase !== text("merge-base", "--all", source, baseline)
    ) {
      throw new Error("Conflict manifest does not bind this refresh.");
    }
  }
  const replay = materialize(source, baseline, manifest?.resolutions ?? [], manifestPath);
  const record = {
    version: 1,
    pr,
    sourceHead: source,
    baselineHead: baseline,
    capturedMain: main,
    forkBase: replay.forkBase,
    tree: replay.tree,
    incomingHead: prMeta.headRefOid,
    incomingReviewOid: authority[".local/review.json"],
    archive,
    authority,
    resolutions: replay.resolutions,
    ...(sourceAdmission ? { sourceAdmission } : {}),
  };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const oid = hash(bytes);
  const anchor = decoder
    .decode(
      git(["commit-tree", "-S", replay.tree, "-p", source, "-p", baseline], {
        input: `fix: refresh the reviewed correction baseline\n\nBaseline-Refresh: ${oid}\n`,
      }),
    )
    .trim();
  retainedAuthority({ ...bindingAt(anchor, bytes), anchor });
  process.stdout.write(
    `${JSON.stringify({ target: anchor, binding: bytes.toString("base64"), resolutions: replay.resolutions })}\n`,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "create" && args.length === 7) {
      create(Number(args[0]), ...args.slice(1));
    } else if (command === "create-successor" && args.length === 11) {
      create(Number(args[0]), ...args.slice(1, 7), args.slice(7));
    } else if (command === "check-source" && args.length === 6) {
      checkSource(Number(args[0]), ...args.slice(1));
    } else if (
      [
        "validate-transition",
        "install-transition",
        "check-transition",
        "restore-transition",
      ].includes(command) &&
      args.length === 7
    ) {
      transition(command, Number(args[0]), ...args.slice(1));
    } else {
      throw new Error("Invalid baseline refresh operation.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
