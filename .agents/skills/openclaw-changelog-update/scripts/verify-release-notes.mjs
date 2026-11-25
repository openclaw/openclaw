#!/usr/bin/env -S node --import tsx

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  authorsMatch,
  backportPullRequestOrigins,
  canonicalMainCommitMatches,
  cherryPickOrigins,
  normalizedCommitSubject,
  pathsOverlap,
  loadChangelogShippedBaseline,
} from "../../../../scripts/lib/release-changelog-baseline.mts";
import {
  findReleaseChangelog,
  loadChangelogCollection,
  loadReleaseChangelog,
  writeReleaseChangelog,
} from "../../../../scripts/lib/release-changelog.mjs";
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "../../../../scripts/lib/release-version.mjs";
import {
  extractChangelogReleaseSections,
  formatContributionRecordProvenance,
  formatShippedBaselineExclusions,
  parseContributionRecordProvenance,
  parseShippedBaselineExclusions,
  verifyGithubReleaseNotes,
} from "../../../../scripts/render-github-release-notes.mts";

export {
  canonicalMainCommitMatches,
  cumulativeShippedPullRequests,
} from "../../../../scripts/lib/release-changelog-baseline.mts";

const repo = "openclaw/openclaw";
const githubSnapshotSchemaVersion = 1;
const githubSnapshotCheckpointInterval = 25;
const commitAssociationQueryBatchSize = 20;
const excludedHandles = new Set([
  "openclaw",
  "clawsweeper",
  "claude",
  "codex",
  "copilot",
  "hugin-bot",
  "roboclaw-bot",
  "tideclaw-bot",
  "steipete-oai",
]);
const nonEditorialTypes = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "qa",
  "refactor",
  "style",
  "test",
]);
const nonEditorialTitlePattern =
  /(?:^|[\s:([{-])(docs?|documentation|tests?|testing|qa|quality assurance|refactor(?:ing)?|ci|continuous integration|build|chore|style|lint|format)(?:$|[\s:)\]}-])/i;
const editorialTitlePattern =
  /^\s*(?:\[[^\]]+\]\s*)?(?:#\d+:\s*)?(?:add|allow|block|enable|expose|fail|fix|harden|honor|improve|keep|migrate|move|persist|polish|preserve|prevent|propagate|rate[- ]?limit|restore|revert|ship|support|treat|validate)\b|^\s*#\d+:/i;
const genericDirectCommitTerms = new Set([
  "add",
  "allow",
  "avoid",
  "build",
  "change",
  "fix",
  "improve",
  "keep",
  "make",
  "missing",
  "move",
  "omit",
  "omitted",
  "prevent",
  "repair",
  "required",
  "restore",
  "update",
]);
const ansiEscapePattern = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");
let githubSnapshotState;

function fail(message) {
  throw new Error(message);
}

function printUsage() {
  console.log(`Usage:
  node --import tsx .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \\
    [--base <tag-or-sha|npm-beta|npm-stable>] --target <tag-or-sha> --version <version> [options]

Required:
  --base <ref>          Previous release; defaults to npm-stable (npm-beta for beta).
                       Capture npm beta before publication; reuse the resolved tag on retries.
  --target <ref>        Release range end.
  --version <version>   Release changelog version heading to verify.

Options:
  --manifest <path>     Read or write the complete contribution record ledger.
  --github-snapshot <path>
                        Override the exact-range GitHub GraphQL snapshot path.
  --historical-issue-snapshot <path>
                        Immutable historical issue evidence (not a live cache).
  --historical-issue-snapshot-sha256 <digest>
                        Required SHA-256 of the historical evidence bytes.
  --no-github-snapshot  Disable GitHub GraphQL snapshot reuse.
  --refresh-github-snapshot
                        Ignore an existing exact-range snapshot and rebuild it.
  --main-ref <ref>      Canonical mainline used to replace backport PRs.
  --release-branch <ref>
                        Ref whose history must contain the generation target.
  --source-ref <ref>    Read initial notes from an immutable Git commit; read-only.
  --seed-ref <ref>      Use an existing release section as editorial input.
  --shipped-ref <tag>   Exclude PRs already recorded by this shipped tag; repeatable.
  --release-provenance <sha -> #PR[, #PR]>
                        Supply an exact provenance marker; repeatable.
  --regular-stable-version <version>
                        Regular stable version linked by extended-stable release notes.
  --write-ledger        Write the verified split release entry and contribution record.
  --release-tag <tag>   GitHub release tag to compare; repeatable with --check-github.
  --check-github        Require each supplied GitHub release body to match.
  --json                Emit machine-readable verification output.
  --help                Show this help text.`);
}

export function parseArgs(argv) {
  const options = {
    releaseTags: [],
    releaseProvenance: [],
    checkGithub: false,
    help: false,
    json: false,
    manifestPath: undefined,
    githubSnapshotPath: undefined,
    mainRef: undefined,
    historicalIssueSnapshotPath: undefined,
    historicalIssueSnapshotSha256: undefined,
    releaseBranch: /** @type {string | undefined} */ (undefined),
    noGithubSnapshot: false,
    regularStableVersion: undefined,
    refreshGithubSnapshot: false,
    sourceRef: /** @type {string | undefined} */ (undefined),
    seedRef: /** @type {string | undefined} */ (undefined),
    shippedRefs: [],
    writeLedger: false,
  };
  const booleanOptions = new Map([
    ["--help", "help"],
    ["--check-github", "checkGithub"],
    ["--json", "json"],
    ["--no-github-snapshot", "noGithubSnapshot"],
    ["--refresh-github-snapshot", "refreshGithubSnapshot"],
    ["--write-ledger", "writeLedger"],
  ]);
  const valueOptions = new Map([
    ["--base", "base"],
    ["--target", "target"],
    ["--version", "version"],
    ["--release-tag", "releaseTags"],
    ["--release-provenance", "releaseProvenance"],
    ["--shipped-ref", "shippedRefs"],
    ["--github-snapshot", "githubSnapshotPath"],
    ["--main-ref", "mainRef"],
    ["--historical-issue-snapshot", "historicalIssueSnapshotPath"],
    ["--historical-issue-snapshot-sha256", "historicalIssueSnapshotSha256"],
    ["--release-branch", "releaseBranch"],
    ["--manifest", "manifestPath"],
    ["--regular-stable-version", "regularStableVersion"],
    ["--source-ref", "sourceRef"],
    ["--seed-ref", "seedRef"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const booleanKey = booleanOptions.get(arg);
    if (booleanKey) {
      options[booleanKey] = true;
      continue;
    }
    const valueKey = valueOptions.get(arg);
    if (valueKey) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`missing value for ${arg}`);
      }
      if (Array.isArray(options[valueKey])) {
        options[valueKey].push(value);
      } else {
        options[valueKey] = value;
      }
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }

  if (!options.help) {
    if (!options.base) {
      const version = parseReleaseVersion(options.version ?? "");
      if (version?.channel === "beta") {
        options.base = "npm-beta";
      } else if (version?.channel === "stable" && version.patch < 33) {
        options.base = "npm-stable";
      }
    }
    for (const name of ["base", "target", "version"]) {
      if (!options[name]) {
        fail(`--${name} is required`);
      }
    }
  } else if (options.checkGithub || options.releaseTags.length > 0) {
    fail("--help cannot be combined with verification options");
  }
  if (!options.help && options.checkGithub && options.releaseTags.length === 0) {
    fail("--check-github requires at least one --release-tag");
  }
  if (options.noGithubSnapshot && options.githubSnapshotPath) {
    fail("--no-github-snapshot cannot be combined with --github-snapshot");
  }
  if (options.noGithubSnapshot && options.refreshGithubSnapshot) {
    fail("--no-github-snapshot cannot be combined with --refresh-github-snapshot");
  }
  if (
    Boolean(options.historicalIssueSnapshotPath) !== Boolean(options.historicalIssueSnapshotSha256)
  ) {
    fail("historical issue snapshot requires both path and sha256");
  }
  if (options.sourceRef && options.writeLedger) {
    fail("--source-ref cannot be combined with --write-ledger");
  }
  const uniqueShippedRefs = new Set(options.shippedRefs);
  if (uniqueShippedRefs.size !== options.shippedRefs.length) {
    fail("--shipped-ref values must be unique");
  }
  options.shippedRefs = options.shippedRefs.toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  return options;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...options.env },
    // Canonical main history exceeded 16 MiB during final-tag accounting (PR #199961).
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(args) {
  return run("git", args).trimEnd();
}

function* gitLogRecords(args) {
  // Release histories exceed the command buffer. Spool once, then decode complete
  // records so UTF-8 characters spanning read boundaries remain intact.
  const directory = mkdtempSync(path.join(tmpdir(), "openclaw-release-log-"));
  const output = path.join(directory, "log");
  let descriptor;
  try {
    git(["log", `--output=${output}`, ...args]);
    descriptor = openSync(output, "r");
    let parts = [];
    for (;;) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!length) {
        break;
      }
      const chunk = buffer.subarray(0, length);
      let start = 0;
      for (let end = chunk.indexOf(0x1e); end !== -1; end = chunk.indexOf(0x1e, start)) {
        parts.push(chunk.subarray(start, end));
        yield Buffer.concat(parts).toString("utf8");
        parts = [];
        start = end + 1;
      }
      parts.push(chunk.subarray(start));
    }
    const tail = Buffer.concat(parts).toString("utf8").trimEnd();
    if (tail) {
      yield tail;
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function gitIsAncestor(base, target) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${base}^{commit}`, `${target}^{commit}`],
    {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  return fail(
    `could not validate release range ancestry for ${base}..${target}: ${
      result.stderr?.trim() || result.signal || result.status
    }`,
  );
}

function gitMergeBase(base, target) {
  const result = spawnSync("git", ["merge-base", base, target], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (shallow.status === 0 && shallow.stdout.trim() === "true") {
    return fail(
      `could not resolve release range merge base for ${base}..${target}: this checkout is shallow; fetch complete history (for example, git fetch --unshallow origin) and retry`,
    );
  }

  return fail(
    `could not resolve release range merge base for ${base}..${target}: ${
      result.stderr?.trim() || result.signal || result.status
    }`,
  );
}

function gitCommit(ref, required = false) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  if (!required) {
    return undefined;
  }
  return fail(
    `could not resolve canonical main ref ${ref}: ${result.stderr?.trim() || result.status}`,
  );
}

function fetchGithubApi(args) {
  try {
    return JSON.parse(run("gh", ["api", ...args]).replace(ansiEscapePattern, ""));
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.trim() !== "") {
      const response = JSON.parse(error.stdout.replace(ansiEscapePattern, ""));
      // gh exits 1 for GraphQL NOT_FOUND as well as real command failures.
      // Only a structured GraphQL error response may reach call-specific admission.
      if (
        error.status === 1 &&
        !error.signal &&
        Array.isArray(response.errors) &&
        response.errors.length > 0 &&
        (error.stderr ?? "")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .every(
            (line) =>
              line === "octopool: graphql delegated to personal token" ||
              response.errors.some(
                (entry) =>
                  line === "error: GraphQL request failed" ||
                  (typeof entry.message === "string" && line === "gh: " + entry.message),
              ),
          )
      ) {
        return response;
      }
    }
    throw error;
  }
}

export function createGithubSnapshotState({
  base,
  checkpointEvery = githubSnapshotCheckpointInterval,
  filePath,
  refresh = false,
  repository = repo,
  target,
}) {
  if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 1) {
    fail("GitHub snapshot checkpoint interval must be a positive integer");
  }
  let responses = {};
  if (!refresh && existsSync(filePath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      fail(
        `could not read GitHub snapshot ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      parsed.schemaVersion !== githubSnapshotSchemaVersion ||
      parsed.repository !== repository ||
      parsed.base !== base ||
      parsed.target !== target ||
      !parsed.responses ||
      typeof parsed.responses !== "object" ||
      Array.isArray(parsed.responses)
    ) {
      fail(
        `GitHub snapshot ${filePath} does not match ${repository} ${base}..${target}; use --refresh-github-snapshot`,
      );
    }
    responses = parsed.responses;
  }
  return {
    base,
    checkpointEvery,
    dirty: refresh && existsSync(filePath),
    filePath,
    hits: 0,
    misses: 0,
    repository,
    responses,
    target,
    writesSincePersist: 0,
  };
}

export function githubApiWithSnapshot(args, fetchApi, snapshotState) {
  if (!snapshotState || args[0] !== "graphql") {
    return fetchApi(args);
  }
  const key = JSON.stringify(args);
  const cached = snapshotState.responses[key];
  if (cached !== undefined) {
    snapshotState.hits += 1;
    return structuredClone(cached);
  }
  snapshotState.misses += 1;
  const response = fetchApi(args);
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    response.data === undefined ||
    (Array.isArray(response.errors) && response.errors.length > 0)
  ) {
    return response;
  }
  snapshotState.responses[key] = structuredClone(response);
  snapshotState.dirty = true;
  snapshotState.writesSincePersist += 1;
  if (snapshotState.writesSincePersist >= snapshotState.checkpointEvery) {
    persistGithubSnapshot(snapshotState);
  }
  return response;
}

export function persistGithubSnapshot(snapshotState) {
  if (!snapshotState?.dirty) {
    return;
  }
  const output = `${JSON.stringify(
    {
      schemaVersion: githubSnapshotSchemaVersion,
      repository: snapshotState.repository,
      base: snapshotState.base,
      target: snapshotState.target,
      responses: snapshotState.responses,
    },
    null,
    2,
  )}\n`;
  mkdirSync(path.dirname(snapshotState.filePath), { recursive: true });
  const tempPath = `${snapshotState.filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, output);
    renameSync(tempPath, snapshotState.filePath);
    snapshotState.dirty = false;
    snapshotState.writesSincePersist = 0;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function githubApi(args) {
  return githubApiWithSnapshot(args, fetchGithubApi, githubSnapshotState);
}

export function defaultGithubSnapshotPath(base, target, gitCommonDir) {
  const defaultName = `verify-release-notes-${base}-${target}.json`;
  return path.resolve(gitCommonDir, "openclaw-release-cache", defaultName);
}

function initializeGithubSnapshot(options) {
  if (options.noGithubSnapshot) {
    return undefined;
  }
  const base = git(["rev-parse", `${options.base}^{commit}`]);
  const target = git(["rev-parse", `${options.target}^{commit}`]);
  const filePath = path.resolve(
    options.githubSnapshotPath ??
      defaultGithubSnapshotPath(base, target, git(["rev-parse", "--git-common-dir"])),
  );
  const state = createGithubSnapshotState({
    base,
    filePath,
    refresh: options.refreshGithubSnapshot,
    target,
  });
  process.once("exit", () => persistGithubSnapshot(state));
  return state;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isEligibleHandle(handle) {
  return (
    typeof handle === "string" &&
    handle.toLowerCase() !== "undefined" &&
    !handle.endsWith("[bot]") &&
    !excludedHandles.has(handle.toLowerCase())
  );
}

function githubHandleFromNoreply(email) {
  return email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i)?.[1];
}

function editorialClassification(subject) {
  const conventional = subject.match(/^\s*([a-z]+)(?:\(([^)]*)\))?(!)?:/i);
  const type = conventional?.[1]?.toLowerCase();
  return {
    // Declared type/scope outrank ambiguous prose such as "doc" or "build".
    // Breaking changes still need migration notes even for internal scopes.
    editorialEligible:
      Boolean(conventional?.[3]) ||
      ((Boolean(type) || editorialTitlePattern.test(subject)) &&
        !nonEditorialTypes.has(type) &&
        !nonEditorialTitlePattern.test(conventional ? (conventional[2] ?? "") : subject)),
    type: type ?? "other",
  };
}

function mergedByTarget(mergedAt, targetTimestamp) {
  const mergedTimestamp = Date.parse(mergedAt);
  return Number.isFinite(mergedTimestamp) && mergedTimestamp <= targetTimestamp;
}

function optionalSectionFor(changelog, version) {
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\r?$`, "m").exec(changelog);
  if (!heading || heading.index === undefined) {
    return undefined;
  }
  const start = heading.index;
  const bodyStart = changelog.indexOf("\n", start) + 1;
  const next = /^## /gm;
  next.lastIndex = bodyStart;
  const nextHeading = next.exec(changelog);
  const end = nextHeading?.index ?? changelog.length;
  return {
    start,
    end,
    source: changelog.slice(start, end).trimEnd(),
    body: changelog.slice(bodyStart, end).trim(),
  };
}

function sectionFor(changelog, version) {
  const section = optionalSectionFor(changelog, version);
  if (!section) {
    fail(`CHANGELOG.md does not contain ## ${version}`);
  }
  return section;
}

function referencesIn(text) {
  return referenceLabelsIn(text)
    .filter((reference) => reference.startsWith("#"))
    .map((reference) => Number(reference.slice(1)));
}

function referenceLabelsIn(text) {
  const hexColor = String.raw`#(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{4}|[A-Fa-f0-9]{3})(?![A-Za-z0-9_])`;
  // Mask only custom-property color values/transitions, never the rest of a line:
  // a following issue ref must still participate in release attribution.
  const source = text.replace(
    new RegExp(
      String.raw`--[\w-]+(?:[ \t]*:[ \t]*|[ \t]+)${hexColor}(?:[ \t]*(?:->|→)[ \t]*${hexColor})*`,
      "g",
    ),
    " ",
  );
  const labels = [];
  // Issue ids are complete positive decimal tokens, not hex prefixes or zero-padded colors.
  for (const match of source.matchAll(
    /(?<![A-Za-z0-9_.&-])(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(?<number>[1-9]\d*)(?![A-Za-z0-9_])/g,
  )) {
    const qualifiedRepository = match.groups?.repository;
    labels.push(
      !qualifiedRepository || qualifiedRepository.toLowerCase() === repo
        ? `#${match.groups?.number}`
        : `${qualifiedRepository}#${match.groups?.number}`,
    );
  }
  return labels;
}

export function renderContributionRecordEntry(entry) {
  const references = [];
  const linkedIssueNumbers = new Set(entry.linkedIssues.map((issue) => issue.number));
  appendUnique(
    references,
    referenceLabelsIn(entry.title).filter(
      (reference) =>
        !reference.startsWith("#") || linkedIssueNumbers.has(Number(reference.slice(1))),
    ),
  );
  appendUnique(
    references,
    (entry.priorReferences ?? [])
      .filter((number) => linkedIssueNumbers.has(number))
      .map((number) => `#${number}`),
  );
  appendUnique(references, entry.externalReferences ?? []);
  for (const issue of entry.linkedIssues) {
    appendUnique(references, [`#${issue.number}`]);
  }
  const related = references.length > 0 ? ` Related ${references.join(", ")}.` : "";
  const credits = formatInitialCredits(entry.thanks);
  const attribution = credits ? ` ${credits}` : "";
  return `- **PR #${entry.number}**${related}${attribution}`;
}

export function releaseNoteReferences(sectionSource, shippedBaselines) {
  const shippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  // The baseline inventory proves subtraction; its PR ids are not release-note references.
  const referenceSource = shippedBaselineLine
    ? sectionSource.replace(shippedBaselineLine, "")
    : sectionSource;
  return referencesIn(referenceSource);
}

function closingReferencesIn(text) {
  const references = [];
  for (const match of text.matchAll(
    /\b(?:fix(?:es|ed)?|closes?|closed|resolves?|resolved)\s+(?:(?:openclaw\/openclaw)?#\d+)(?:\s*(?:,|and)\s*(?:(?:openclaw\/openclaw)?#\d+))*/gi,
  )) {
    appendReferences(references, referencesIn(match[0]));
  }
  return references;
}

export function standardRevertedHash(message) {
  const paragraphs = message
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim());
  const messageIsRevert = /^(?:[a-z][a-z0-9-]*(?:\([^)]+\))?!?:\s*)?revert\b/i.test(
    paragraphs[0] ?? "",
  );
  for (const [index, paragraph] of paragraphs.entries()) {
    const revertedHash = paragraph.match(/^This reverts commit ([0-9a-f]{7,40})\.$/i)?.[1];
    if (!revertedHash) {
      continue;
    }
    // GitHub squash messages can embed a reverted intermediate commit. Its
    // marker follows the corresponding bullet and does not revert the squash.
    if (!messageIsRevert && /^\*\s+Revert\b/i.test(paragraphs[index - 1] ?? "")) {
      continue;
    }
    return revertedHash;
  }
  return undefined;
}

function verifiedMultiRevertedHashes(hash, subject, body) {
  if (!/^(?:[a-z][a-z0-9-]*(?:\([^)]+\))?!?:\s*)?revert\b/i.test(subject)) {
    return [];
  }
  const declarations = body
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .map((paragraph) =>
      paragraph.match(
        /^Reverts ([0-9a-f]{40}(?:, [0-9a-f]{40})*(?:,? and [0-9a-f]{40}))(?:\.| to restore the previous behavior\.)$/i,
      ),
    )
    .filter(Boolean);
  if (declarations.length !== 1) {
    return [];
  }
  const targets = declarations[0][1].toLowerCase().match(/[0-9a-f]{40}/g);
  if (new Set(targets).size !== targets.length) {
    return [];
  }

  let temporaryDirectory;
  try {
    const parents = git(["rev-list", "--parents", "-n", "1", hash]).split(/\s+/);
    if (parents.length !== 2) {
      throw new Error("the revert must have exactly one parent");
    }
    const parent = parents[1];
    for (const target of targets) {
      if (gitCommit(target) !== target || !gitIsAncestor(target, parent)) {
        throw new Error(`target ${target} must be an existing ancestor of the revert parent`);
      }
      if (git(["rev-list", "--parents", "-n", "1", target]).split(/\s+/).length !== 2) {
        throw new Error(`target ${target} must have exactly one parent`);
      }
    }
    const orderedTargets = git(["rev-list", "--topo-order", parent])
      .split("\n")
      .filter((candidate) => targets.includes(candidate));
    const originalObjects = git(["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), "openclaw-release-revert-"));
    const objects = path.join(temporaryDirectory, "objects");
    mkdirSync(objects);
    const env = {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
      GIT_INDEX_FILE: path.join(temporaryDirectory, "index"),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        JSON.stringify(originalObjects),
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      ]
        .filter(Boolean)
        .join(path.delimiter),
    };
    const privateGit = (args, input) =>
      execFileSync(
        "git",
        ["-c", `core.hooksPath=${path.join(temporaryDirectory, "hooks")}`, ...args],
        { env, input, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
      );
    privateGit(["read-tree", parent]);
    for (const target of orderedTargets) {
      // Keep patch bytes intact; text decoding corrupts binary/non-UTF-8 reversals.
      const patch = privateGit([
        "diff-tree",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "-p",
        `${target}^`,
        target,
      ]);
      privateGit(["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"], patch);
    }
    const reversedTree = privateGit(["write-tree"]).toString("utf8").trim();
    if (reversedTree !== git(["rev-parse", `${hash}^{tree}`])) {
      throw new Error("declared inverse patches do not reproduce the complete revert tree");
    }
    return targets;
  } catch (error) {
    throw new Error(`could not verify explicit multi-commit revert ${hash}: ${error.message}`, {
      cause: error,
    });
  } finally {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function handlesIn(text) {
  const creditStarts = [text.lastIndexOf(" Authored by "), text.lastIndexOf(" Thanks ")].filter(
    (index) => index >= 0,
  );
  if (creditStarts.length === 0) {
    return [];
  }
  return [...text.slice(Math.min(...creditStarts)).matchAll(/@([A-Za-z0-9-]+)/g)]
    .map((match) => match[1])
    .filter(isEligibleHandle);
}

function externalReferencesIn(text) {
  return referenceLabelsIn(text).filter((reference) => !reference.startsWith("#"));
}

function appendUnique(values, additions) {
  const seen = new Set(values.map((value) => value.toLowerCase()));
  for (const value of additions) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      values.push(value);
      seen.add(key);
    }
  }
}

function addContributionRecordEntry(entries, key, entry) {
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, {
      ...entry,
      externalReferences: [...(entry.externalReferences ?? [])],
      references: [...entry.references],
      thanks: [...entry.thanks],
    });
    return;
  }
  appendUnique(existing.externalReferences, entry.externalReferences ?? []);
  appendReferences(existing.references, entry.references);
  addHandles(existing.thanks, entry.thanks);
}

export function contributionRecordFor(section) {
  const result = { legacyIssues: new Map(), pullRequests: new Map() };
  const recordStart = section.source.search(/\n### Complete contribution (?:ledger|record)\r?$/m);
  if (recordStart < 0) {
    return result;
  }
  const record = section.source.slice(recordStart);
  let subsection = "";
  for (const line of record.split("\n")) {
    if (line === "#### Pull requests") {
      subsection = "pull-requests";
      continue;
    }
    if (line === "#### Linked issues") {
      subsection = "linked-issues";
      continue;
    }
    if (line.startsWith("#### ")) {
      subsection = "";
      continue;
    }
    if (subsection === "pull-requests") {
      const explicitRecord = line.match(/^- \*\*PR #(\d+)\*\*/);
      const legacyRecord = line.match(/\(#(\d+)\)\.(?: Thanks.*)?$/);
      const number = explicitRecord?.[1] ?? legacyRecord?.[1];
      if (number) {
        const value = Number(number);
        const metadata = explicitRecord ? line.slice(explicitRecord[0].length) : line;
        addContributionRecordEntry(result.pullRequests, value, {
          externalReferences: externalReferencesIn(metadata),
          references: referencesIn(metadata).filter((reference) => reference !== value),
          thanks: handlesIn(line),
        });
      }
      continue;
    }
    if (subsection === "linked-issues") {
      const number = referencesIn(line)[0];
      if (number) {
        addContributionRecordEntry(result.legacyIssues, number, {
          references: [],
          thanks: handlesIn(line),
        });
      }
    }
  }
  return result;
}

export function contributionRecordTarget(section) {
  const recordStart = section.source.search(/\n### Complete contribution (?:ledger|record)\r?$/m);
  if (recordStart < 0) {
    return undefined;
  }
  const target = parseContributionRecordProvenance(section.source.slice(recordStart))?.target;
  return target && /^[0-9a-f]{40}$/u.test(target) ? target : undefined;
}

export function pullRequestTitleFromCommitSubject(subject, number) {
  const match = subject.match(/^(?<title>\S(?:.*\S)?)(?<! \(#\d+\)) \(#(?<number>[1-9]\d*)\)$/u);
  return match?.groups?.number === String(number) ? match.groups.title : undefined;
}

export function subtractShippedPullRequests(source, baselines) {
  const excluded = new Set();
  const metadata = [];
  for (const baseline of baselines.toSorted((a, b) =>
    a.ref === b.ref ? 0 : a.ref < b.ref ? -1 : 1,
  )) {
    const pullRequests = [];
    for (const number of baseline.pullRequests) {
      if (
        !excluded.has(number) &&
        (source.pullRequests.has(number) || source.references.includes(number))
      ) {
        excluded.add(number);
        pullRequests.push(number);
      }
      source.pullRequests.delete(number);
    }
    source.references = source.references.filter((number) => !baseline.pullRequests.has(number));
    const sortedPullRequests = pullRequests.toSorted((a, b) => a - b);
    metadata.push({
      ref: baseline.ref,
      count: sortedPullRequests.length,
      pullRequests: sortedPullRequests,
    });
  }
  // References belonging only to already-shipped PRs are outside this release.
  // Keep shared references and references from direct commits in the inventory.
  const shippedReferences = new Set();
  const retainedReferences = new Set();
  for (const commit of source.activeCommits) {
    const references =
      commit.pullRequests.length > 0 && commit.pullRequests.every((number) => excluded.has(number))
        ? shippedReferences
        : retainedReferences;
    for (const number of commit.references) {
      references.add(number);
    }
  }
  source.references = source.references.filter(
    (number) => !shippedReferences.has(number) || retainedReferences.has(number),
  );
  return { baselines: metadata, pullRequests: excluded };
}

export function withoutExcludedContributionRecords(record, excludedReferences) {
  if (excludedReferences.size === 0) {
    return record;
  }
  const filtered = { legacyIssues: new Map(), pullRequests: new Map() };
  for (const [number, entry] of record.pullRequests) {
    if (excludedReferences.has(number)) {
      continue;
    }
    addContributionRecordEntry(filtered.pullRequests, number, {
      ...entry,
      externalReferences: entry.externalReferences,
      references: entry.references.filter((reference) => !excludedReferences.has(reference)),
    });
  }
  for (const [number, entry] of record.legacyIssues) {
    if (!excludedReferences.has(number)) {
      addContributionRecordEntry(filtered.legacyIssues, number, entry);
    }
  }
  return filtered;
}

function contributionRecordMetadataReferences(record) {
  const references = [...record.pullRequests.keys()];
  for (const entry of record.pullRequests.values()) {
    appendReferences(references, entry.references);
  }
  appendReferences(references, record.legacyIssues.keys());
  return references;
}

export function renderedContributionRecordReferences(record, writeLedger) {
  // Write mode replaces the existing generated record. Validating stale record
  // references here would make the verifier unable to repair its own output.
  return writeLedger ? [] : contributionRecordMetadataReferences(record);
}

export function contaminatingPullRequestReferences({
  noteReferences,
  recordedReferences,
  excludedRecordedReferences = new Set(),
  sourcePullRequests,
  sourceReferences,
  seededPullRequests,
  nodes,
}) {
  const allowed = new Set([...sourcePullRequests, ...seededPullRequests]);
  const allowedEditorial = new Set(allowed);
  for (const number of sourceReferences) {
    if (nodes.get(number)?.__typename === "PullRequest") {
      allowedEditorial.add(number);
    }
  }
  const effectiveRecordedReferences = recordedReferences.filter(
    (number) => !excludedRecordedReferences.has(number),
  );
  return [
    ...new Set([
      ...noteReferences.filter(
        (number) =>
          nodes.get(number)?.__typename === "PullRequest" && !allowedEditorial.has(number),
      ),
      ...effectiveRecordedReferences.filter(
        (number) => nodes.get(number)?.__typename === "PullRequest" && !allowed.has(number),
      ),
    ]),
  ];
}

function appendReferences(references, additions) {
  const seen = new Set(references);
  for (const number of additions) {
    if (!seen.has(number)) {
      references.push(number);
      seen.add(number);
    }
  }
}

function releaseProvenanceMarker(line) {
  const match = line.match(/^Release provenance: ([0-9a-f]{40}) -> (#\d+(?:,\s*#\d+)*)\.?\s*$/i);
  if (!match) {
    fail(`invalid release provenance marker: ${line}`);
  }
  return {
    commit: match[1].toLowerCase(),
    pullRequests: [...match[2].matchAll(/#(\d+)/g)].map((reference) => Number(reference[1])),
  };
}

export function releaseProvenanceMarkers(message) {
  return message
    .split("\n")
    .filter((line) => /^Release provenance:/i.test(line))
    .map(releaseProvenanceMarker);
}

export function collectReleaseProvenanceOverrides(activeCommits, releaseProvenance = []) {
  const activeCommitHashes = new Set(activeCommits.map((commit) => commit.hash));
  const overrides = new Map();
  const addMarker = (marker) => {
    if (!activeCommitHashes.has(marker.commit)) {
      fail(`release provenance marker targets commit outside the active range: ${marker.commit}`);
    }
    const existing = overrides.get(marker.commit);
    if (existing && existing.join(",") !== marker.pullRequests.join(",")) {
      fail(`conflicting release provenance markers for ${marker.commit}`);
    }
    overrides.set(marker.commit, marker.pullRequests);
  };
  for (const commit of activeCommits) {
    for (const marker of releaseProvenanceMarkers(commit.body)) {
      addMarker(marker);
    }
  }
  for (const value of releaseProvenance) {
    if (/[\r\n]/u.test(value)) {
      fail(`invalid release provenance marker: Release provenance: ${value}`);
    }
    addMarker(releaseProvenanceMarker(`Release provenance: ${value}`));
  }
  return overrides;
}

export function resolvedReleasePullRequests(
  currentPullRequests,
  mainPullRequests,
  hasCanonicalMainCommit,
  provenanceOverride,
) {
  return (
    provenanceOverride ??
    canonicalPullRequests(currentPullRequests, mainPullRequests, hasCanonicalMainCommit)
  );
}

export function releasePullRequestReferencesToSuppress(
  currentPullRequests,
  subject,
  associatedPullRequests,
  hasProvenanceOverride,
) {
  const candidates = new Set(currentPullRequests);
  if (hasProvenanceOverride) {
    for (const match of subject.matchAll(/\(#(\d+)\)\s*$/g)) {
      candidates.add(Number(match[1]));
    }
  }
  return [...candidates].filter((number) => !associatedPullRequests.includes(number));
}

function changedPathsForCommit(hash) {
  return new Set(
    git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", hash, "--"])
      .split("\n")
      .filter(Boolean),
  );
}

export function canonicalPullRequests(
  currentPullRequests,
  mainPullRequests,
  hasCanonicalMainCommit = mainPullRequests.length > 0,
) {
  const pullRequests = hasCanonicalMainCommit ? mainPullRequests : currentPullRequests;
  return [...new Set(pullRequests)].toSorted((left, right) => left - right);
}

function canonicalMainCommits(base, mainRef, filters = []) {
  if (!mainRef) {
    return [];
  }
  const mainCommit = /** @type {string} */ (gitCommit(mainRef, true));
  const mainBase = gitMergeBase(base, mainCommit);
  const records = gitLogRecords([
    "--reverse",
    "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%B%x1e",
    ...filters,
    `${mainBase}..${mainCommit}`,
  ]);
  const commits = [];
  for (const record of records) {
    if (!record) {
      continue;
    }
    const [rawHash, subject, authorName, authorEmail, ...bodyParts] = record.split("\x1f");
    const hash = rawHash.trim();
    commits.push({
      authorEmail,
      authorName,
      body: bodyParts.join("\x1f"),
      hash,
      subject,
    });
  }
  return commits;
}

function sourceCommits(base, target, mainRef, releaseProvenance = []) {
  const targetCommit = git(["rev-parse", `${target}^{commit}`]);
  const targetHistory = new Set(git(["rev-list", targetCommit]).split("\n"));
  const mainCommit = mainRef ? gitCommit(mainRef, true) : undefined;
  const mainHistory = mainCommit ? new Set(git(["rev-list", mainCommit]).split("\n")) : new Set();
  if (!/^v[0-9]/u.test(base) && !gitIsAncestor(base, targetCommit)) {
    fail(`release range base ${base} must be an ancestor of target ${target}`);
  }
  const mergeBase = gitMergeBase(base, targetCommit);
  const targetTimestamp = Date.parse(git(["show", "-s", "--format=%cI", targetCommit]));
  if (!Number.isFinite(targetTimestamp)) {
    fail(`could not resolve timestamp for release target ${target}`);
  }
  const records = gitLogRecords([
    // Merged side branches carry source PRs too; first-parent hides their credit.
    "--topo-order",
    "--reverse",
    "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%cI%x1f%B%x1e",
    `${base}..${targetCommit}`,
  ]);
  const revertedTargetsByCommit = new Map();
  const revertedHashesFor = (hash, subject, body) => {
    if (!revertedTargetsByCommit.has(hash)) {
      const standard = standardRevertedHash(body);
      revertedTargetsByCommit.set(
        hash,
        standard ? [standard] : verifiedMultiRevertedHashes(hash, subject, body),
      );
    }
    return revertedTargetsByCommit.get(hash);
  };
  const commits = new Map();
  const revertsByTarget = new Map();
  for (const record of records) {
    if (!record) {
      continue;
    }
    const [rawHash, subject, authorName, authorEmail, committedAt, ...bodyParts] =
      record.split("\x1f");
    const hash = rawHash.trim();
    const body = bodyParts.join("\x1f");
    const revertedHashes = revertedHashesFor(hash, subject, body);
    const isRevert = revertedHashes.length > 0 || subject.startsWith('Revert "');
    commits.set(hash, {
      authorEmail,
      authorName,
      body,
      committedAt,
      hash,
      isRevert,
      revertedHashes,
      subject,
    });
  }
  for (const commit of commits.values()) {
    for (const revertedHash of commit.revertedHashes) {
      const targetHash = [...commits.keys()].find((candidate) =>
        candidate.startsWith(revertedHash),
      );
      if (targetHash) {
        const reverts = revertsByTarget.get(targetHash) ?? [];
        reverts.push(commit.hash);
        revertsByTarget.set(targetHash, reverts);
      }
    }
  }
  const active = new Map();
  function isActive(hash) {
    if (active.has(hash)) {
      return active.get(hash);
    }
    const cancellingReverts = revertsByTarget.get(hash) ?? [];
    const value = !cancellingReverts.some((revertHash) => isActive(revertHash));
    active.set(hash, value);
    return value;
  }
  const revertedCommitStates = new Map();
  function revertedCommitStatesFor(ref, seen = new Set()) {
    let hash;
    try {
      hash = git(["rev-parse", `${ref}^{commit}`]);
    } catch {
      return undefined;
    }
    const cached = revertedCommitStates.get(hash);
    if (cached) {
      return cached;
    }
    if (seen.has(hash)) {
      fail(`cyclic revert history at ${hash}`);
    }
    seen.add(hash);
    const commitOutput = git(["show", "-s", "--format=%s%x1f%B", hash]);
    const [subject, ...bodyParts] = commitOutput.split("\x1f");
    const body = bodyParts.join("\x1f");
    const message = `${subject}\n${body}`;
    const targets = revertedHashesFor(hash, subject, body);
    const targetStates = targets.flatMap(
      (revertedTarget) => revertedCommitStatesFor(revertedTarget, new Set(seen)) ?? [],
    );
    const states =
      targetStates.length > 0
        ? targetStates.map((state) => Object.assign({}, state, { depth: state.depth + 1 }))
        : [{ depth: 0, hash, references: referencesIn(message) }];
    revertedCommitStates.set(hash, states);
    return states;
  }

  const references = [];
  const revertedReferences = new Set();
  const revertedCommitHashes = new Set();
  const activeCommits = [];
  for (const commit of commits.values()) {
    const uniqueReferences = commit.isRevert
      ? []
      : [...new Set(referencesIn(`${commit.subject}\n${commit.body}`))];
    if (!isActive(commit.hash)) {
      if (!commit.isRevert) {
        revertedCommitHashes.add(commit.hash);
        for (const number of uniqueReferences) {
          revertedReferences.add(number);
        }
      }
      continue;
    }
    const coauthorEmails = coauthorEmailsIn(commit.body);
    const coauthors = coauthorEmails.map(githubHandleFromNoreply).filter(isEligibleHandle);
    activeCommits.push({
      authorEmail: commit.authorEmail,
      authorHandle: githubHandleFromNoreply(commit.authorEmail),
      authorName: commit.authorName,
      body: commit.body,
      closingReferences: commit.isRevert
        ? []
        : closingReferencesIn(`${commit.subject}\n${commit.body}`),
      committedAt: commit.committedAt,
      coauthors,
      coauthorEmails,
      hash: commit.hash,
      isRevert: commit.isRevert,
      pullRequests: [],
      references: uniqueReferences,
      subject: commit.subject,
    });
  }
  for (const commit of commits.values()) {
    if (!commit.isRevert || !isActive(commit.hash)) {
      continue;
    }
    for (const revertedHash of commit.revertedHashes) {
      if ([...commits.keys()].some((candidate) => candidate.startsWith(revertedHash))) {
        continue;
      }
      for (const state of revertedCommitStatesFor(revertedHash) ?? []) {
        if (state.depth % 2 !== 0) {
          continue;
        }
        revertedCommitHashes.add(state.hash);
        for (const number of state.references) {
          revertedReferences.add(number);
        }
      }
    }
  }
  const activePullRequests = resolveAssociatedPullRequests(
    activeCommits.map((commit) => commit.hash),
    targetTimestamp,
    targetHistory,
  );
  const provenanceOverrides = collectReleaseProvenanceOverrides(activeCommits, releaseProvenance);
  const mainCommits = canonicalMainCommits(base, mainCommit);
  const mainCommitsByHash = new Map(mainCommits.map((commit) => [commit.hash, commit]));
  const mainCommitsBySubject = new Map();
  const mainCommitsByOrigin = new Map();
  for (const commit of mainCommits) {
    for (const origin of cherryPickOrigins(commit.body)) {
      const carriers = mainCommitsByOrigin.get(origin) ?? [];
      carriers.push(commit);
      mainCommitsByOrigin.set(origin, carriers);
    }
    const subject = normalizedCommitSubject(commit.subject);
    const matches = mainCommitsBySubject.get(subject) ?? [];
    matches.push(commit);
    mainCommitsBySubject.set(subject, matches);
  }
  const canonicalMainCommitsByReleaseCommit = new Map();
  const namedMainPullRequestsByReleaseCommit = new Map();
  const canonicalMainHashes = new Set();
  const mainAssociationCandidateHashes = new Set();
  const pendingCanonicalMatches = [];
  const changedPathsByCommit = new Map();
  const withChangedPaths = (commit) => {
    if (!changedPathsByCommit.has(commit.hash)) {
      changedPathsByCommit.set(commit.hash, changedPathsForCommit(commit.hash));
    }
    return { ...commit, changedPaths: changedPathsByCommit.get(commit.hash) };
  };
  for (const commit of activeCommits) {
    const exact = mainCommitsByHash.get(commit.hash);
    if (exact) {
      canonicalMainCommitsByReleaseCommit.set(commit.hash, []);
      continue;
    }
    const explicit = [
      ...cherryPickOrigins(commit.body)
        .map((origin) => mainCommitsByHash.get(origin))
        .filter(Boolean),
      ...(mainCommitsByOrigin.get(commit.hash) ?? []),
    ];
    if (explicit.length > 0) {
      const matches = [...new Set(explicit.map((candidate) => candidate.hash))];
      canonicalMainCommitsByReleaseCommit.set(commit.hash, matches);
      for (const hash of matches) {
        canonicalMainHashes.add(hash);
      }
      continue;
    }
    const releaseCommit = withChangedPaths(commit);
    const pullRequestOrigins = backportPullRequestOrigins(commit.body);
    const candidates = new Map(
      (mainCommitsBySubject.get(normalizedCommitSubject(commit.subject)) ?? []).map((candidate) => [
        candidate.hash,
        candidate,
      ]),
    );
    if (pullRequestOrigins.length > 0) {
      for (const candidate of mainCommits) {
        if (!authorsMatch(releaseCommit, candidate)) {
          continue;
        }
        const mainCandidate = withChangedPaths(candidate);
        if (!pathsOverlap(releaseCommit.changedPaths, mainCandidate.changedPaths)) {
          continue;
        }
        candidates.set(candidate.hash, candidate);
        mainAssociationCandidateHashes.add(candidate.hash);
      }
    }
    pendingCanonicalMatches.push({ candidates, commit: releaseCommit, pullRequestOrigins });
  }
  const candidateMainPullRequests = resolveAssociatedPullRequests(
    [...mainAssociationCandidateHashes],
    Number.POSITIVE_INFINITY,
    mainHistory,
  );
  for (const { candidates, commit, pullRequestOrigins } of pendingCanonicalMatches) {
    const matches = canonicalMainCommitMatches(
      commit,
      [...candidates.values()].map((candidate) =>
        Object.assign({}, withChangedPaths(candidate), {
          pullRequests: candidateMainPullRequests.get(candidate.hash) ?? [],
        }),
      ),
    );
    canonicalMainCommitsByReleaseCommit.set(commit.hash, matches);
    if (pullRequestOrigins.length > 0 && matches.length === 1) {
      const associatedPullRequests = candidateMainPullRequests.get(matches[0]) ?? [];
      const namedPullRequests = pullRequestOrigins.filter((number) =>
        associatedPullRequests.includes(number),
      );
      if (namedPullRequests.length > 0) {
        namedMainPullRequestsByReleaseCommit.set(commit.hash, namedPullRequests);
      }
    }
    for (const hash of matches) {
      canonicalMainHashes.add(hash);
    }
  }
  const canonicalMainPullRequests = resolveAssociatedPullRequests(
    [...canonicalMainHashes],
    Number.POSITIVE_INFINITY,
    mainHistory,
  );
  const pullRequests = new Set();
  const nonRevertPullRequests = new Set();
  for (const commit of activeCommits) {
    const currentPullRequests = activePullRequests.get(commit.hash) ?? [];
    const namedMainPullRequests = namedMainPullRequestsByReleaseCommit.get(commit.hash);
    const mainPullRequests =
      namedMainPullRequests ??
      (canonicalMainCommitsByReleaseCommit.get(commit.hash) ?? []).flatMap(
        (hash) => canonicalMainPullRequests.get(hash) ?? [],
      );
    const matchedMainCommits = canonicalMainCommitsByReleaseCommit.get(commit.hash) ?? [];
    const provenanceOverride = provenanceOverrides.get(commit.hash);
    const associatedPullRequests = resolvedReleasePullRequests(
      currentPullRequests,
      mainPullRequests,
      matchedMainCommits.length > 0,
      provenanceOverride,
    );
    commit.pullRequests = associatedPullRequests;
    const suppressedBackportPullRequests = new Set(
      releasePullRequestReferencesToSuppress(
        currentPullRequests,
        commit.subject,
        associatedPullRequests,
        provenanceOverride !== undefined,
      ),
    );
    commit.references = commit.references.filter(
      (number) => !suppressedBackportPullRequests.has(number),
    );
    appendReferences(commit.references, associatedPullRequests);
    for (const number of associatedPullRequests) {
      pullRequests.add(number);
      if (!commit.isRevert) {
        nonRevertPullRequests.add(number);
      }
    }
    appendReferences(references, commit.references);
  }
  const directCommits = activeCommits.filter((commit) => commit.pullRequests.length === 0);
  const resolvedCoauthors = resolveCommitCoauthors(directCommits);
  for (const commit of directCommits) {
    addHandles(commit.coauthors, resolvedCoauthors.get(commit.hash) ?? []);
  }
  const revertedPullRequests = new Set();
  for (const revertedPullRequestNumbers of resolveAssociatedPullRequests(
    [...revertedCommitHashes],
    targetTimestamp,
    new Set([...targetHistory, ...mainHistory]),
  ).values()) {
    for (const number of revertedPullRequestNumbers) {
      revertedPullRequests.add(number);
    }
  }
  // A later active implementation supersedes an earlier reverted fix, including
  // direct commits that cite the same issue without having a recoverable PR.
  for (const commit of activeCommits) {
    if (commit.isRevert) {
      continue;
    }
    for (const number of commit.references) {
      revertedReferences.delete(number);
    }
  }
  // A PR can span several commits. A reverted commit does not erase the PR while
  // another non-revert commit from it remains active in this release range.
  for (const number of revertedPullRequests) {
    if (!nonRevertPullRequests.has(number)) {
      pullRequests.delete(number);
      revertedReferences.add(number);
    }
  }
  for (const number of pullRequests) {
    revertedReferences.delete(number);
  }

  return {
    activeCommits,
    mainCommit,
    mergeBase,
    pullRequests,
    provenanceOverrides,
    references,
    revertedReferences,
    target: targetCommit,
    targetTimestamp,
    targetHistory,
  };
}

function graphql(query, notFoundNumbers = [], optionalUserAliases = []) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = githubApi(["graphql", "-f", `query=${query}`]);
      const errors = response?.errors ?? [];
      const allowed = githubNotFoundReferences(response ?? {}, notFoundNumbers);
      if (
        !Array.isArray(errors) ||
        errors.some(
          (error) =>
            error.type !== "NOT_FOUND" ||
            (!optionalUserAliases.some(
              (alias) =>
                error.path?.length === 1 &&
                error.path[0] === alias &&
                response.data?.[alias] === null,
            ) &&
              !allowed.some(
                (number) =>
                  error.path?.[0] === "n" + number &&
                  error.path?.[1] === "issueOrPullRequest" &&
                  error.path.length === 2 &&
                  response.data?.["n" + number]?.issueOrPullRequest === null,
              )),
        )
      ) {
        const failure = new Error("GitHub GraphQL errors: " + JSON.stringify(errors));
        failure.cause = "graphql-errors";
        throw failure;
      }
      if (response?.data && typeof response.data === "object") {
        return response;
      }
      const messages = Array.isArray(response?.errors)
        ? response.errors.map((error) => error?.message).filter(Boolean)
        : [];
      const detail = [...messages, response?.message].filter(Boolean).join("\n");
      throw new Error(
        detail
          ? `GitHub GraphQL response did not include data:\n${detail}`
          : "GitHub GraphQL response did not include data.",
      );
    } catch (error) {
      lastError = error;
      const message = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
      // Historical ranges batch hundreds of objects; only retry transient transport failures.
      if (
        error.cause === "graphql-errors" ||
        !/(?:operation timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS handshake timeout|stream error: .*CANCEL|unexpected end of JSON input|unexpected EOF|upstream connect error|connection termination|connection reset by peer|error connecting to api\.github\.com|Unexpected token '<'|something went wrong|temporarily unavailable|internal server error|rate limit)/i.test(
          message,
        )
      ) {
        throw error;
      }
      if (attempt < 4) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

function resolveAssociatedPullRequests(commitHashes, targetTimestamp, history) {
  const pullRequestsByCommit = new Map();
  const pending = [];
  function appendPullRequests(commitHash, connection) {
    const pullRequests = pullRequestsByCommit.get(commitHash) ?? [];
    const seen = new Set(pullRequests);
    for (const pullRequest of connection?.nodes ?? []) {
      // GitHub's mergedAt can trail the merge commit timestamp by a second.
      // Keep an exact merge-commit association so a release ending there does not drop its PR.
      const isExactMergeCommit = pullRequest.mergeCommit?.oid === commitHash;
      if (
        pullRequest.mergedAt &&
        history.has(pullRequest.mergeCommit?.oid) &&
        (isExactMergeCommit || mergedByTarget(pullRequest.mergedAt, targetTimestamp)) &&
        !seen.has(pullRequest.number)
      ) {
        pullRequests.push(pullRequest.number);
        seen.add(pullRequest.number);
      }
    }
    pullRequestsByCommit.set(commitHash, pullRequests);
    if (connection?.pageInfo?.hasNextPage) {
      pending.push({ commitHash, cursor: connection.pageInfo.endCursor });
    }
  }
  for (let index = 0; index < commitHashes.length; index += commitAssociationQueryBatchSize) {
    const chunk = commitHashes.slice(index, index + commitAssociationQueryBatchSize);
    const fields = chunk
      .map(
        (hash, offset) =>
          `c${index + offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(hash)}) {
              ... on Commit {
                associatedPullRequests(first: 100) {
                  nodes {
                    number
                    mergedAt
                    mergeCommit { oid }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
      )
      .join("\n");
    const { data } = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      appendPullRequests(chunk[offset], data[`c${index + offset}`]?.object?.associatedPullRequests);
    }
  }
  while (pending.length > 0) {
    const chunk = pending.splice(0, 20);
    const fields = chunk
      .map(
        (item, offset) =>
          `c${offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(item.commitHash)}) {
              ... on Commit {
                associatedPullRequests(first: 100, after: ${JSON.stringify(item.cursor)}) {
                  nodes {
                    number
                    mergedAt
                    mergeCommit { oid }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
      )
      .join("\n");
    const { data } = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      appendPullRequests(
        chunk[offset].commitHash,
        data[`c${offset}`]?.object?.associatedPullRequests,
      );
    }
  }
  return pullRequestsByCommit;
}

function issueConnectionName(node) {
  if (node.__typename === "Issue") {
    return "closedByPullRequestsReferences";
  }
  if (node.__typename === "PullRequest") {
    return "closingIssuesReferences";
  }
  return undefined;
}

function resolveIssueRelationshipPages(nodes) {
  const pending = [];
  for (const [number, node] of nodes) {
    const connectionName = issueConnectionName(node);
    const pageInfo = connectionName ? node[connectionName]?.pageInfo : undefined;
    if (pageInfo?.hasNextPage) {
      pending.push({ connectionName, cursor: pageInfo.endCursor, number, type: node.__typename });
    }
  }
  while (pending.length > 0) {
    const chunk = pending.splice(0, 20);
    const fields = chunk
      .map((item, offset) => {
        const connection = `${item.connectionName}(first: 100, after: ${JSON.stringify(item.cursor)}) {
          nodes { number }
          pageInfo { hasNextPage endCursor }
        }`;
        return `n${offset}: repository(owner: "openclaw", name: "openclaw") {
          issueOrPullRequest(number: ${item.number}) {
            ... on ${item.type} {
              ${connection}
            }
          }
        }`;
      })
      .join("\n");
    const { data } = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const item = chunk[offset];
      const node = nodes.get(item.number);
      const connection = data[`n${offset}`]?.issueOrPullRequest?.[item.connectionName];
      if (!node || !connection) {
        continue;
      }
      node[item.connectionName] = {
        nodes: [...(node[item.connectionName]?.nodes ?? []), ...connection.nodes],
        pageInfo: connection.pageInfo,
      };
      if (connection.pageInfo.hasNextPage) {
        pending.push({
          connectionName: item.connectionName,
          cursor: connection.pageInfo.endCursor,
          number: item.number,
          type: item.type,
        });
      }
    }
  }
  return nodes;
}

function resolveSourceWorkflowRuns(source, nodes, requiredReferences) {
  const candidates = new Set();
  const required = new Set([...requiredReferences, ...source.pullRequests]);
  for (const commit of source.activeCommits) {
    if (commit.isRevert) {
      continue;
    }
    const message = `${commit.subject}\n${commit.body}`;
    // Mask only explicitly labelled, unqualified occurrences. The same number
    // anywhere else remains an issue/PR requirement, even in a different commit.
    const remaining = message.replace(
      /(?<![A-Za-z0-9_])(?:CI(?:[ \t]+run)?|Actions[ \t]+run|workflow[ \t]+run)[ \t]+#([1-9]\d*)(?![A-Za-z0-9_])/gi,
      (_match, number) => {
        candidates.add(Number(number));
        return " ";
      },
    );
    for (const number of referencesIn(remaining)) {
      required.add(number);
    }
  }
  const runs = [];
  for (const number of candidates) {
    if (!source.references.includes(number) || nodes.has(number) || required.has(number)) {
      continue;
    }
    const workflowRun = githubApi([`repos/${repo}/actions/runs/${number}`]);
    if (workflowRun?.id === number && workflowRun.repository?.full_name === repo) {
      runs.push({ id: number, repository: repo });
    }
  }
  const runIds = new Set(runs.map((workflowRun) => workflowRun.id));
  source.references = source.references.filter((number) => !runIds.has(number));
  for (const commit of source.activeCommits) {
    commit.references = commit.references.filter((number) => !runIds.has(number));
  }
  return runs;
}

export function githubNotFoundReferences(response, numbers) {
  const errors = Array.isArray(response.errors) ? response.errors : [];
  return numbers.filter((number) =>
    errors.some(
      (error) =>
        error?.type === "NOT_FOUND" &&
        Array.isArray(error.path) &&
        error.path.length === 2 &&
        error.path[0] === `n${number}` &&
        error.path[1] === "issueOrPullRequest",
    ),
  );
}

export function classifyUnavailableContextualReferences({
  unresolved,
  notFound,
  activeCommits,
  protectedReferences,
  highestResolved,
}) {
  const required = new Set(protectedReferences);
  const bodyCommits = new Map();
  for (const commit of activeCommits) {
    for (const number of [
      ...referencesIn(commit.subject),
      ...closingReferencesIn(`${commit.subject}\n${commit.body}`),
    ]) {
      required.add(number);
    }
    for (const number of referencesIn(commit.body)) {
      const commits = bodyCommits.get(number) ?? new Set();
      commits.add(commit.hash.slice(0, 12));
      bodyCommits.set(number, commits);
    }
  }
  const unavailable = [];
  const stillUnresolved = [];
  for (const number of unresolved) {
    if (
      notFound.has(number) &&
      !required.has(number) &&
      number < highestResolved &&
      bodyCommits.has(number)
    ) {
      unavailable.push({
        number,
        commits: [...bodyCommits.get(number)].toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1)),
      });
    } else {
      stillUnresolved.push(number);
    }
  }
  unavailable.sort((a, b) => a.number - b.number);
  return { unavailable, stillUnresolved };
}

function resolveReferences(numbers) {
  const nodes = new Map();
  const notFound = new Set();
  // GitHub's issue-number argument is GraphQL Int; Actions run IDs can exceed it.
  const issueNumbers = numbers.filter((number) => number <= 2147483647);
  for (let index = 0; index < issueNumbers.length; index += 40) {
    const chunk = issueNumbers.slice(index, index + 40);
    const fields = chunk
      .map(
        (number) => `n${number}: repository(owner: "openclaw", name: "openclaw") {
          issueOrPullRequest(number: ${number}) {
            __typename
            ... on Issue {
              number
              title
              author { __typename login }
              closedByPullRequestsReferences(first: 100) {
                nodes { number }
                pageInfo { hasNextPage endCursor }
              }
            }
            ... on PullRequest {
              number
              title
              baseRefName
              mergedAt
              mergeCommit { oid message }
              author { __typename login }
              closingIssuesReferences(first: 100) {
                nodes { number }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
      )
      .join("\n");
    const response = graphql(`query { ${fields} }`, chunk);
    for (const number of githubNotFoundReferences(response, chunk)) {
      notFound.add(number);
    }
    for (const number of chunk) {
      const node = response.data[`n${number}`]?.issueOrPullRequest;
      if (node) {
        nodes.set(number, node);
      }
    }
  }
  return { nodes: resolveIssueRelationshipPages(nodes), notFound };
}

// Historical snapshots are evidence, never a cache for a different endpoint.
export function loadHistoricalIssueSnapshot({
  filePath,
  sha256,
  base,
  target,
  isAncestor = gitIsAncestor,
}) {
  const bytes = readFileSync(filePath);
  if (
    !/^[0-9a-f]{64}$/.test(sha256 ?? "") ||
    createHash("sha256").update(bytes).digest("hex") !== sha256
  ) {
    fail("historical issue snapshot digest mismatch");
  }
  const snapshot = JSON.parse(bytes.toString("utf8"));
  if (
    snapshot.schemaVersion !== githubSnapshotSchemaVersion ||
    snapshot.repository !== repo ||
    !/^[0-9a-f]{40}$/.test(snapshot.base ?? "") ||
    !isAncestor(base, snapshot.base) ||
    !/^[0-9a-f]{40}$/.test(snapshot.target ?? "") ||
    !snapshot.responses ||
    typeof snapshot.responses !== "object" ||
    Array.isArray(snapshot.responses) ||
    !isAncestor(snapshot.base, snapshot.target) ||
    !isAncestor(snapshot.target, target)
  ) {
    fail("historical issue snapshot repository/range mismatch");
  }
  const nodes = new Map();
  for (const [key, response] of Object.entries(snapshot.responses)) {
    const args = JSON.parse(key);
    if (!Array.isArray(args) || args[0] !== "graphql" || response.errors?.length) {
      continue;
    }
    const query = args.find((arg) => typeof arg === "string" && arg.startsWith("query=")) ?? "";
    // Only the collector's exact repository/number lookup establishes identity.
    for (const match of query.matchAll(
      /n([1-9]\d*): repository\(owner: "openclaw", name: "openclaw"\)\s*\{\s*issueOrPullRequest\(number: ([1-9]\d*)\)/g,
    )) {
      const number = Number(match[1]);
      const node = response.data?.["n" + number]?.issueOrPullRequest;
      if (
        match[1] !== match[2] ||
        !node ||
        node.number !== number ||
        !["Issue", "PullRequest"].includes(node.__typename)
      ) {
        fail("invalid historical reference identity #" + number);
      }
      if (nodes.has(number) && JSON.stringify(nodes.get(number)) !== JSON.stringify(node)) {
        fail("conflicting historical reference #" + number);
      }
      nodes.set(number, node);
    }
  }
  return {
    nodes,
    snapshot: { repository: repo, base: snapshot.base, target: snapshot.target, sha256 },
  };
}

function completeRelationship(node, name) {
  const connection = node?.[name];
  return connection?.pageInfo?.hasNextPage === false &&
    Array.isArray(connection.nodes) &&
    connection.nodes.every((entry) => Number.isSafeInteger(entry.number) && entry.number > 0) &&
    new Set(connection.nodes.map((entry) => entry.number)).size === connection.nodes.length
    ? connection.nodes.map((entry) => entry.number)
    : undefined;
}

export function recoverUnavailableIssues({
  numbers,
  nodes,
  notFound,
  evidence,
  record,
  recordTarget,
  recordBase,
  source,
  isAncestor = gitIsAncestor,
}) {
  const recovered = [];
  if (!evidence) {
    return recovered;
  }
  for (const number of numbers) {
    const historical = evidence.nodes.get(number);
    if (historical?.__typename !== "Issue") {
      continue;
    }
    const live = nodes.get(number);
    if (live) {
      if (
        live.__typename !== "Issue" ||
        live.number !== number ||
        live.author?.__typename !== historical.author?.__typename ||
        live.author?.login?.toLowerCase() !== historical.author?.login?.toLowerCase()
      ) {
        fail("conflicting live historical issue identity #" + number);
      }
      continue;
    }
    if (!notFound.has(number)) {
      continue;
    }
    const closing = completeRelationship(historical, "closedByPullRequestsReferences");
    const prNumber = closing?.length === 1 ? closing[0] : undefined;
    const priorPr = evidence.nodes.get(prNumber);
    const pr = nodes.get(prNumber);
    const row = record.pullRequests.get(prNumber);
    const merge = pr?.mergeCommit?.oid;
    const priorIssues = completeRelationship(priorPr, "closingIssuesReferences");
    const currentIssues = completeRelationship(pr, "closingIssuesReferences");
    const coveredCommits = source.activeCommits.filter((commit) => {
      if (!commit.pullRequests.includes(prNumber)) {
        return false;
      }
      if (commit.hash === merge) {
        return true;
      }
      const origins = [...commit.body.matchAll(/^Source commit: ([0-9a-f]{40})$/gm)];
      const cherryPicks = [
        ...commit.body.matchAll(/^\(cherry picked from commit ([0-9a-f]{40})\)$/gm),
      ];
      const pullRequests = [...commit.body.matchAll(/^Source PR: (\S+)$/gm)];
      return (
        pullRequestTitleFromCommitSubject(commit.subject, prNumber) === priorPr?.title &&
        ((origins.length === 1 &&
          origins[0][1] === merge &&
          pullRequests.length === 1 &&
          pullRequests[0][1] === "https://github.com/" + repo + "/pull/" + prNumber &&
          cherryPicks.every((entry) => entry[1] === merge)) ||
          (origins.length === 0 &&
            pullRequests.length === 0 &&
            cherryPicks.length === 1 &&
            cherryPicks[0][1] === merge))
      );
    });
    const coveredCommit = coveredCommits.length === 1 ? coveredCommits[0].hash : undefined;
    const conflictingPr = [...evidence.nodes.values(), ...nodes.values()].some(
      (node) =>
        node.__typename === "PullRequest" &&
        node.number !== prNumber &&
        node.closingIssuesReferences?.nodes?.some((issue) => issue.number === number),
    );
    if (
      conflictingPr ||
      typeof historical.title !== "string" ||
      !historical.title ||
      historical.author?.__typename !== "User" ||
      !isEligibleHandle(historical.author.login) ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(historical.author.login) ||
      priorPr?.__typename !== "PullRequest" ||
      pr?.__typename !== "PullRequest" ||
      pr.number !== prNumber ||
      priorPr.number !== prNumber ||
      priorPr.baseRefName !== "main" ||
      pr.baseRefName !== "main" ||
      !pr.mergedAt ||
      pr.mergedAt !== priorPr.mergedAt ||
      merge !== priorPr.mergeCommit?.oid ||
      priorPr.author?.__typename !== "User" ||
      pr.author?.__typename !== "User" ||
      pr.author.login?.toLowerCase() !== priorPr.author?.login?.toLowerCase() ||
      !priorIssues?.includes(number) ||
      !currentIssues ||
      !row?.references.includes(number) ||
      !row.thanks.some(
        (handle) => handle.toLowerCase() === historical.author.login.toLowerCase(),
      ) ||
      !source.pullRequests.has(prNumber) ||
      !coveredCommit ||
      !source.targetHistory.has(coveredCommit) ||
      !mergedByTarget(pr.mergedAt, source.targetTimestamp) ||
      !recordTarget ||
      recordBase !== evidence.snapshot.base ||
      !isAncestor(recordTarget, evidence.snapshot.target) ||
      !isAncestor(recordTarget, source.target) ||
      !isAncestor(coveredCommit, recordTarget) ||
      !isAncestor(coveredCommit, evidence.snapshot.target) ||
      isAncestor(coveredCommit, evidence.snapshot.base)
    ) {
      fail("insufficient historical issue provenance #" + number);
    }
    const provenance = {
      number,
      historicalIdentity: historical.author,
      snapshot: evidence.snapshot,
      recordTarget,
      pullRequest: prNumber,
      mergeCommit: merge,
      coveredCommit,
    };
    // Preserve historical reporter credit, without presenting it as a live identity.
    nodes.set(number, {
      __typename: "Issue",
      number,
      title: historical.title,
      recordedThanks: [historical.author.login],
      closedByPullRequestsReferences: historical.closedByPullRequestsReferences,
      historicalProvenance: provenance,
    });
    recovered.push(provenance);
  }
  return recovered;
}

// A vanished GitHub PR is recoverable only when a prior exact-SHA ledger
// covered its exact merge-title commit.
export function recoverUnavailablePullRequests({
  numbers,
  nodes,
  record,
  recordTarget,
  source,
  isAncestor = gitIsAncestor,
}) {
  const recovered = new Map();
  if (!recordTarget || !isAncestor(recordTarget, source.target)) {
    return recovered;
  }
  for (const number of numbers) {
    if (nodes.has(number)) {
      continue;
    }
    const recorded = record.pullRequests.get(number);
    if (!recorded) {
      continue;
    }
    const commits = source.activeCommits
      .map((commit) => ({
        commit,
        title: pullRequestTitleFromCommitSubject(commit.subject, number),
      }))
      .filter(
        ({ commit, title }) =>
          title &&
          commit.references.includes(number) &&
          Number.isFinite(Date.parse(commit.committedAt)),
      );
    if (commits.length !== 1) {
      continue;
    }
    const { commit, title } = commits[0];
    if (!isAncestor(commit.hash, recordTarget)) {
      continue;
    }
    const node = {
      __typename: "PullRequest",
      number,
      title,
      baseRefName: "main",
      mergedAt: commit.committedAt,
      mergeCommit: { oid: commit.hash },
      // Historical credit is not evidence of PR authorship.
      recordedThanks: recorded.thanks,
      closingIssuesReferences: {
        nodes: commit.closingReferences.map((reference) => ({ number: reference })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    nodes.set(number, node);
    recovered.set(number, node);
    commit.pullRequests = [...new Set([...commit.pullRequests, number])];
    source.pullRequests.add(number);
  }
  return recovered;
}

function canonicalSourceCommit(hash) {
  const [subject, authorName, authorEmail, ...body] = git([
    "show",
    "-s",
    "--format=%s%x1f%an%x1f%ae%x1f%B",
    hash,
  ]).split("\x1f");
  return {
    hash,
    subject: subject.replace(/^\[[^\]]+\]\s*/, ""),
    authorName,
    authorEmail,
    body: body.join("\x1f"),
    changedPaths: changedPathsForCommit(hash),
  };
}

function hasCanonicalMainSource(node, mainCommit, resolveNodes) {
  const source = canonicalSourceCommit(node.mergeCommit.oid);
  const subjectPattern = normalizedCommitSubject(source.subject)
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "[[:space:]]+");
  const candidates = new Map(
    canonicalMainCommits(source.hash, mainCommit, [
      "--extended-regexp",
      "--regexp-ignore-case",
      "--grep=" + source.hash,
      "--grep=" + subjectPattern,
    ]).map((candidate) => [
      candidate.hash,
      {
        ...candidate,
        subject: candidate.subject.replace(/^\[[^\]]+\]\s*/, ""),
        changedPaths: changedPathsForCommit(candidate.hash),
      },
    ]),
  );
  for (const hash of cherryPickOrigins(source.body)) {
    if (gitIsAncestor(hash, mainCommit)) {
      const candidate = canonicalSourceCommit(hash);
      // Squash bodies can retain unrelated constituent cherry-pick trailers.
      if (pathsOverlap(source.changedPaths, candidate.changedPaths)) {
        candidates.set(hash, candidate);
      }
    }
  }
  const origins = backportPullRequestOrigins(source.body);
  const namedSources = origins.length > 0 ? resolveNodes(origins) : new Map();
  for (const [number, origin] of namedSources) {
    if (
      origin?.baseRefName === "main" &&
      origin.mergedAt &&
      origin.mergeCommit?.oid &&
      gitIsAncestor(origin.mergeCommit.oid, mainCommit)
    ) {
      const candidate = canonicalSourceCommit(origin.mergeCommit.oid);
      candidates.set(candidate.hash, { ...candidate, pullRequests: [number] });
    }
  }
  const mainCandidates = [...candidates.values()];
  return (
    mainCandidates.some((candidate) => cherryPickOrigins(candidate.body).includes(source.hash)) ||
    canonicalMainCommitMatches(source, mainCandidates).length > 0
  );
}

export function validateReleaseProvenanceOverrides(
  provenanceOverrides,
  nodes,
  mainCommit,
  isMainAncestor = gitIsAncestor,
  resolveNodes = (numbers) => resolveReferences(numbers).nodes,
) {
  // Subtraction does not excuse source validation. A merged release-only
  // original is valid only until the corresponding main forward-port exists.
  const missing = [...new Set([...provenanceOverrides.values()].flat())].filter(
    (number) => !nodes.has(number),
  );
  const markerNodes = missing.length > 0 ? resolveNodes(missing) : new Map();
  for (const [commit, pullRequests] of provenanceOverrides) {
    for (const number of pullRequests) {
      const node = nodes.get(number) ?? markerNodes.get(number);
      const merged = node?.__typename === "PullRequest" && node.mergedAt && node.mergeCommit?.oid;
      const onMain =
        merged && node.baseRefName === "main" && isMainAncestor(node.mergeCommit.oid, mainCommit);
      const releaseOnly =
        merged &&
        node.baseRefName?.startsWith("release/") &&
        !isMainAncestor(node.mergeCommit.oid, mainCommit) &&
        !hasCanonicalMainSource(node, mainCommit, resolveNodes);
      if (!onMain && !releaseOnly) {
        fail(
          "release provenance marker for " + commit + " references invalid source PR #" + number,
        );
      }
    }
  }
}

function resolveGitHubHandles(handles) {
  const resolved = new Map();
  const uniqueHandles = [...new Set(handles)];
  for (let index = 0; index < uniqueHandles.length; index += 80) {
    const chunk = uniqueHandles.slice(index, index + 80);
    const fields = chunk
      .map(
        (handle, offset) =>
          `u${index + offset}: user(login: ${JSON.stringify(handle)}) { __typename login }`,
      )
      .join("\n");
    // Missing users are optional credit, unlike required issue/PR references.
    const { data } = graphql(
      `query { ${fields} }`,
      [],
      chunk.map((_, offset) => `u${index + offset}`),
    );
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const user = data[`u${index + offset}`];
      if (user?.__typename === "User" && isEligibleHandle(user.login)) {
        resolved.set(chunk[offset].toLowerCase(), user.login);
      }
    }
  }
  return resolved;
}

function resolveDirectCommitAuthors(commits) {
  const resolved = new Map();
  const commitsWithoutGitHubHandle = commits.filter((commit) => !commit.author?.handle);
  for (let index = 0; index < commitsWithoutGitHubHandle.length; index += 40) {
    const chunk = commitsWithoutGitHubHandle.slice(index, index + 40);
    const fields = chunk
      .map(
        (commit, offset) =>
          `c${index + offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(commit.hash)}) {
              ... on Commit {
                author {
                  user {
                    login
                  }
                }
              }
            }
          }`,
      )
      .join("\n");
    const { data } = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const author = data[`c${index + offset}`]?.object?.author?.user;
      if (author?.login && isEligibleHandle(author.login)) {
        resolved.set(chunk[offset].hash, author.login);
      }
    }
  }
  return resolved;
}

function coauthorEmailsIn(message) {
  return [...message.matchAll(/^Co-authored-by:\s*.+?<([^>\s]+)>$/gim)].map((match) => match[1]);
}

function resolvePullRequestCoauthors(nodes) {
  // PR credit belongs to its original merge, never the release carrier or
  // another commit that merely mentions the PR in contextual prose.
  const pullRequests = [...nodes.values()].filter(
    (node) => node.__typename === "PullRequest" && node.mergeCommit?.message,
  );
  const commits = pullRequests.map((node) => ({
    hash: node.mergeCommit.oid,
    coauthorEmails: coauthorEmailsIn(node.mergeCommit.message),
  }));
  const resolved = resolveCommitCoauthors(commits);
  return new Map(
    pullRequests.map((node) => [node.number, resolved.get(node.mergeCommit.oid) ?? []]),
  );
}

function resolveCommitCoauthors(commits) {
  const resolved = new Map();
  const pending = commits
    .filter((commit) => commit.coauthorEmails.length > 0)
    .map((commit) => ({ commit, cursor: null }));
  while (pending.length > 0) {
    const chunk = pending.splice(0, 40);
    const fields = chunk
      .map(
        ({ commit, cursor }, offset) =>
          `c${offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(commit.hash)}) {
              ... on Commit {
                authors(first: 20, after: ${JSON.stringify(cursor)}) {
                  nodes {
                    email
                    user { login }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
      )
      .join("\n");
    const { data } = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const { commit, cursor } = chunk[offset];
      const coauthorEmails = new Set(commit.coauthorEmails.map((email) => email.toLowerCase()));
      const connection = data[`c${offset}`]?.object?.authors;
      const handles = (connection?.nodes ?? [])
        .filter((author) => coauthorEmails.has(author.email?.toLowerCase()))
        .map((author) => author.user?.login);
      resolved.set(commit.hash, addHandles(resolved.get(commit.hash) ?? [], handles));
      if (connection?.pageInfo?.hasNextPage) {
        const nextCursor = connection.pageInfo.endCursor;
        if (typeof nextCursor !== "string" || !nextCursor || nextCursor === cursor) {
          fail(`GitHub returned an invalid authors cursor for commit ${commit.hash}`);
        }
        pending.push({ commit, cursor: nextCursor });
      }
    }
  }
  return resolved;
}

function withDirectCommitAuthors(commits, resolvedAuthors) {
  return commits.map((commit) => {
    const authorHandle = resolvedAuthors.get(commit.hash) ?? commit.author?.handle;
    const contributors = [];
    if (authorHandle) {
      contributors.push(authorHandle);
    }
    addHandles(contributors, commit.contributors);
    return {
      ...commit,
      author: {
        handle: authorHandle,
        name: commit.author?.name ?? commit.authorName,
      },
      contributors,
    };
  });
}

function thanksFor(node, coauthorHandles) {
  const handles = [];
  if (node.author?.__typename === "User" && isEligibleHandle(node.author.login)) {
    handles.push(node.author.login);
  }
  addHandles(handles, node.recordedThanks ?? []);
  addHandles(handles, coauthorHandles);
  return handles;
}

function addHandles(handles, additions) {
  appendUnique(handles, [...additions].filter(isEligibleHandle));
  return handles;
}

function titleReferences(entries) {
  return [...new Set(entries.flatMap((entry) => referencesIn(entry.title)))];
}

function withSentenceEnding(value) {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function formatThanks(handles) {
  const mentions = handles.map((handle) => `@${handle}`);
  if (mentions.length <= 1) {
    return mentions[0] ?? "";
  }
  if (mentions.length === 2) {
    return mentions.join(" and ");
  }
  return `${mentions.slice(0, -1).join(", ")}, and ${mentions.at(-1)}`;
}

function formatInitialCredits(handles) {
  const authors = handles.filter((handle) => handle.toLowerCase() === "steipete");
  const thanked = handles.filter((handle) => handle.toLowerCase() !== "steipete");
  const parts = [];
  if (authors.length > 0) {
    parts.push(`Authored by ${formatThanks(authors)}.`);
  }
  if (thanked.length > 0) {
    parts.push(`Thanks ${formatThanks(thanked)}.`);
  }
  return parts.join(" ");
}

function directCommitTitleTokens(subject) {
  const title = subject.replace(/^\s*[a-z]+(?:\([^)]*\))?!?:\s*/i, "");
  return [...new Set(title.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])].filter(
    (token) => !genericDirectCommitTerms.has(token),
  );
}

function lineHasTerm(line, term) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(line);
}

function directCommitMatchesLine(commit, line) {
  if (!line.startsWith("- ")) {
    return false;
  }
  if (commit.closingReferences.some((number) => referencesIn(line).includes(number))) {
    return true;
  }
  const matchingTerms = directCommitTitleTokens(commit.subject).filter((token) =>
    lineHasTerm(line, token),
  );
  return matchingTerms.length >= 2;
}

function directCommitCreditsForLine(line, directCommits) {
  const contributors = [];
  for (const commit of directCommits) {
    if (
      !editorialClassification(commit.subject).editorialEligible ||
      !directCommitMatchesLine(commit, line)
    ) {
      continue;
    }
    addHandles(contributors, commit.contributors);
  }
  return contributors;
}

function editorialCreditsForLine(line, pullRequestsByNumber, directCommits, nodes) {
  const contributors = directCommitCreditsForLine(line, directCommits);
  let known = contributors.length > 0;
  for (const number of referencesIn(line)) {
    const entry = pullRequestsByNumber.get(number);
    const node = nodes.get(number);
    if (entry) {
      known = true;
      addHandles(contributors, entry.thanks);
    } else if (node?.__typename === "Issue") {
      known = true;
      if (
        !node.historicalProvenance ||
        !referencesIn(line).some((reference) => pullRequestsByNumber.has(reference)) ||
        referencesIn(line).includes(node.historicalProvenance.pullRequest)
      ) {
        addHandles(contributors, thanksFor(node, []));
      }
    }
  }
  return known ? contributors : undefined;
}

function completeEditorialCredits(prose, pullRequests, directCommits, nodes) {
  const pullRequestsByNumber = new Map(
    pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  return prose
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- ")) {
        return line;
      }
      const contributors = editorialCreditsForLine(
        line,
        pullRequestsByNumber,
        directCommits,
        nodes,
      );
      if (contributors === undefined) {
        return line;
      }
      const creditStarts = [line.lastIndexOf(" Authored by "), line.lastIndexOf(" Thanks ")].filter(
        (index) => index >= 0,
      );
      const creditStart = creditStarts.length > 0 ? Math.min(...creditStarts) : -1;
      const rawContent = creditStart >= 0 ? line.slice(0, creditStart) : line;
      const content =
        referencesIn(rawContent).length === 0
          ? withSentenceEnding(rawContent)
          : rawContent.replace(/[.!?]$/, "");
      const credits = formatInitialCredits(contributors);
      return credits ? `${content} ${credits}` : withSentenceEnding(content);
    })
    .join("\n");
}

function issueEntries(numbers, nodes) {
  return [...new Set(numbers)]
    .map((number) => {
      const node = nodes.get(number);
      if (node?.__typename !== "Issue") {
        return undefined;
      }
      const thanks = thanksFor(node, []);
      return {
        number,
        thanks,
        historicalProvenance: node.historicalProvenance,
        title: node.title.replace(/\s+/g, " ").trim(),
      };
    })
    .filter(Boolean);
}

function legacyIssuesByPullRequest(priorRecord, nodes) {
  const result = new Map();
  for (const number of priorRecord.legacyIssues.keys()) {
    const issue = nodes.get(number);
    if (issue?.__typename !== "Issue") {
      continue;
    }
    const pullRequests =
      issue.closedByPullRequestsReferences?.nodes.map((pullRequest) => pullRequest.number) ?? [];
    for (const pullRequest of new Set(pullRequests)) {
      const issues = result.get(pullRequest) ?? [];
      issues.push(number);
      result.set(pullRequest, issues);
    }
  }
  return result;
}

function contributionRelationships(source, nodes, resolvedContributors) {
  const issuesByPullRequest = new Map();
  const directCommits = [];
  for (const [number, node] of nodes) {
    if (node.historicalProvenance) {
      const pr = node.historicalProvenance.pullRequest;
      issuesByPullRequest.set(pr, [
        ...(issuesByPullRequest.get(pr) ?? []),
        ...issueEntries([number], nodes),
      ]);
    }
  }
  for (const commit of source.activeCommits) {
    const pullRequests = commit.pullRequests;
    const issues = issueEntries(commit.closingReferences, nodes).filter(
      (issue) =>
        !issue.historicalProvenance ||
        commit.pullRequests.includes(issue.historicalProvenance.pullRequest),
    );
    if (pullRequests.length === 0) {
      const authorHandle = commit.authorHandle
        ? resolvedContributors.get(commit.authorHandle.toLowerCase())
        : undefined;
      const contributors = [];
      if (authorHandle) {
        contributors.push(authorHandle);
      }
      addHandles(
        contributors,
        commit.coauthors
          .map((handle) => resolvedContributors.get(handle.toLowerCase()))
          .filter(Boolean),
      );
      directCommits.push({
        ...commit,
        author: { handle: authorHandle, name: commit.authorName },
        contributors,
        issues,
      });
      continue;
    }
    if (issues.length === 0) {
      continue;
    }
    for (const number of pullRequests) {
      const existing = issuesByPullRequest.get(number) ?? [];
      issuesByPullRequest.set(number, [...existing, ...issues]);
    }
  }
  return { directCommits, issuesByPullRequest };
}

function mergeIssues(...groups) {
  const entries = new Map();
  for (const group of groups) {
    for (const issue of group) {
      const existing = entries.get(issue.number);
      if (existing) {
        addHandles(existing.thanks, issue.thanks);
      } else {
        entries.set(issue.number, { ...issue, thanks: [...issue.thanks] });
      }
    }
  }
  return [...entries.values()];
}

export function ledgerFor(
  base,
  target,
  references,
  nodes,
  coauthorsByPullRequest,
  relationships,
  priorRecord,
  sourcePullRequests,
  sourceReferences,
  legacyIssuePullRequests,
  revertedReferences,
  shippedBaselines,
  targetTimestamp,
  targetHistory,
  canonicalMain,
) {
  const entries = references.map((number) => {
    const node = nodes.get(number);
    const coauthors = coauthorsByPullRequest.get(number) ?? [];
    return {
      number,
      title: node.title.replace(/\s+/g, " ").trim(),
      type: node.__typename,
      mergedAt: node.mergedAt,
      closingIssuesReferences: node.closingIssuesReferences,
      thanks: thanksFor(node, coauthors),
    };
  });

  // A resolved reference supplies context; only shipped graph evidence supplies membership.
  const inRangePullRequestNumbers = new Set([
    ...sourcePullRequests,
    ...[...sourceReferences].filter((number) => {
      const node = nodes.get(number);
      return (
        node?.__typename === "PullRequest" &&
        targetHistory.has(node.mergeCommit?.oid) &&
        mergedByTarget(node.mergedAt, targetTimestamp)
      );
    }),
  ]);
  const recordedPullRequests = new Set([
    ...inRangePullRequestNumbers,
    ...legacyIssuePullRequests,
    ...priorRecord.pullRequests.keys(),
  ]);
  const pullRequests = entries.filter(
    (entry) =>
      entry.type === "PullRequest" &&
      entry.mergedAt &&
      (sourcePullRequests.has(entry.number) || mergedByTarget(entry.mergedAt, targetTimestamp)) &&
      recordedPullRequests.has(entry.number) &&
      !revertedReferences.has(entry.number),
  );
  const issues = entries.filter((entry) => entry.type === "Issue");
  const legacyIssues = legacyIssuesByPullRequest(priorRecord, nodes);
  const records = pullRequests.map((entry) => {
    const priorEntry = priorRecord.pullRequests.get(entry.number);
    const priorReferences = priorEntry?.references ?? [];
    const titleIssues = issueEntries(referencesIn(entry.title), nodes);
    const closingIssues = issueEntries(
      entry.closingIssuesReferences?.nodes.map((issue) => issue.number) ?? [],
      nodes,
    );
    const linkedIssues = mergeIssues(
      titleIssues,
      closingIssues,
      relationships.issuesByPullRequest.get(entry.number) ?? [],
      issueEntries(priorReferences, nodes),
      issueEntries(legacyIssues.get(entry.number) ?? [], nodes),
    ).filter(
      (issue) =>
        !issue.historicalProvenance || issue.historicalProvenance.pullRequest === entry.number,
    );
    const thanks = [...entry.thanks];
    for (const issue of linkedIssues) {
      addHandles(thanks, issue.thanks);
    }
    return Object.assign({}, entry, editorialClassification(entry.title), {
      externalReferences: priorEntry?.externalReferences ?? [],
      linkedIssues,
      priorReferences,
      thanks,
    });
  });
  const inRangePullRequests = records.filter((entry) =>
    inRangePullRequestNumbers.has(entry.number),
  ).length;
  const retainedSeedOnlyPullRequests = records.length - inRangePullRequests;
  const provenance = {
    inRangePullRequests,
    retainedSeedOnlyPullRequests,
    uniquePullRequests: records.length,
  };
  const shippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  const ledger = [
    "### Complete contribution record",
    "",
    `${formatContributionRecordProvenance({ base, target, ...provenance })} The generation manifest also supplies direct commits as editorial input; the grouped notes above prioritize user impact.`,
    ...(shippedBaselineLine ? ["", shippedBaselineLine] : []),
    ...(canonicalMain ? ["", "Canonical main history: " + canonicalMain + "."] : []),
    "",
    "#### Pull requests",
    "",
    ...records.map((entry) => renderContributionRecordEntry(entry)),
  ].join("\n");
  return {
    entries,
    issues,
    ledger,
    pullRequests: records,
    provenance,
    titleReferences: titleReferences(records),
  };
}

function replaceLedger(changelog, section, ledger, pullRequests, directCommits, nodes) {
  const beforeLedger = completeEditorialCredits(
    section.source.replace(/\n+### Complete contribution (?:ledger|record)[\s\S]*$/m, "").trimEnd(),
    pullRequests,
    directCommits,
    nodes,
  );
  const replacement = `${beforeLedger}\n\n${ledger}\n`;
  return `${changelog.slice(0, section.start)}${replacement}${changelog.slice(section.end)}`;
}

export function countTopLevelSectionBullets(sectionSource, heading) {
  const headingMatch = new RegExp(`^### ${escapeRegExp(heading)}\\r?$`, "mu").exec(sectionSource);
  if (!headingMatch || headingMatch.index === undefined) {
    return 0;
  }
  const headingEnd = sectionSource.indexOf("\n", headingMatch.index);
  const bodyStart = headingEnd < 0 ? sectionSource.length : headingEnd + 1;
  const nextHeading = /^### /gmu;
  nextHeading.lastIndex = bodyStart;
  const end = nextHeading.exec(sectionSource)?.index ?? sectionSource.length;
  return sectionSource
    .slice(bodyStart, end)
    .split("\n")
    .filter((line) => line.startsWith("- ")).length;
}

export function highlightCountError(sectionSource) {
  const count = countTopLevelSectionBullets(sectionSource, "Highlights");
  const minimum = /^## [^\n]+-beta\.[1-9][0-9]*\r?(?:\n|$)/u.test(sectionSource) ? 0 : 5;
  return count >= minimum && count <= 8
    ? undefined
    : `### Highlights must contain ${minimum}-8 top-level bullets; found ${count}`;
}

export function ledgerChecks(section, pullRequests, nodes, directCommits, shippedBaselines = []) {
  const errors = [];
  let sectionReferences = referencesIn(section.source);
  if (/@undefined\b/i.test(section.source)) {
    errors.push("release section contains invalid @undefined contributor credit");
  }
  if (!section.source.includes("### Highlights")) {
    errors.push("missing ### Highlights");
  } else {
    const error = highlightCountError(section.source);
    if (error) {
      errors.push(error);
    }
  }
  if (!section.source.includes("### Changes")) {
    errors.push("missing ### Changes");
  }
  if (!section.source.includes("### Fixes")) {
    errors.push("missing ### Fixes");
  }
  const ledgerStart = section.source.indexOf("### Complete contribution record");
  if (ledgerStart < 0) {
    errors.push("missing ### Complete contribution record");
    return errors;
  }
  const ledger = section.source.slice(ledgerStart);
  try {
    const provenance = parseContributionRecordProvenance(ledger);
    if (!provenance) {
      errors.push("missing exact complete contribution record provenance");
    } else if (
      section.expectedProvenance &&
      provenance.inRangePullRequests !== undefined &&
      (provenance.inRangePullRequests !== section.expectedProvenance.inRangePullRequests ||
        provenance.retainedSeedOnlyPullRequests !==
          section.expectedProvenance.retainedSeedOnlyPullRequests)
    ) {
      errors.push("contribution record provenance partition does not match generated inventory");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const expectedShippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  try {
    const sectionShippedBaselineLine = formatShippedBaselineExclusions(
      parseShippedBaselineExclusions(section.source),
    );
    const actualShippedBaselineLine = formatShippedBaselineExclusions(
      parseShippedBaselineExclusions(ledger),
    );
    if (sectionShippedBaselineLine !== actualShippedBaselineLine) {
      errors.push(
        "shipped baseline exclusions must appear inside the complete contribution record",
      );
    } else if (actualShippedBaselineLine !== expectedShippedBaselineLine) {
      errors.push(
        `shipped baseline exclusions mismatch: expected ${
          expectedShippedBaselineLine || "none"
        }, found ${actualShippedBaselineLine || "none"}`,
      );
    } else {
      sectionReferences = releaseNoteReferences(section.source, shippedBaselines);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (ledger.includes("#### Linked issues")) {
    errors.push("complete contribution record must not have a linked-issues inventory");
  }
  if (ledger.includes("#### Direct commits")) {
    errors.push("complete contribution record must not list direct commits");
  }
  for (const number of new Set(sectionReferences)) {
    if (!nodes.has(number)) {
      errors.push(`unresolved release-note reference #${number}`);
    }
  }
  for (const entry of pullRequests) {
    const line = ledger
      .split("\n")
      .find((candidate) => candidate.startsWith(`- **PR #${entry.number}**`));
    if (!line) {
      errors.push(`missing contribution record for PR #${entry.number}`);
      continue;
    }
    const actualThanks = new Set(handlesIn(line).map((handle) => handle.toLowerCase()));
    for (const handle of entry.thanks) {
      if (!actualThanks.has(handle.toLowerCase())) {
        errors.push(`missing Thanks @${handle} for #${entry.number}`);
      }
    }
    const expectedThanks = new Set(entry.thanks.map((handle) => handle.toLowerCase()));
    for (const handle of handlesIn(line)) {
      if (!expectedThanks.has(handle.toLowerCase())) {
        errors.push(`unexpected Thanks @${handle} for #${entry.number}`);
      }
    }
    const expectedReferences = [];
    appendUnique(expectedReferences, externalReferencesIn(entry.title));
    appendUnique(expectedReferences, entry.externalReferences);
    appendUnique(
      expectedReferences,
      entry.linkedIssues.map((issue) => `#${issue.number}`),
    );
    const actualReferences = new Set(
      referenceLabelsIn(line).map((reference) => reference.toLowerCase()),
    );
    for (const reference of expectedReferences) {
      if (!actualReferences.has(reference.toLowerCase())) {
        errors.push(`missing ${reference} on contribution record for PR #${entry.number}`);
      }
    }
  }
  const editorialProse = section.source.slice(0, ledgerStart);
  const editorialReferences = new Set(referencesIn(editorialProse));
  for (const entry of pullRequests) {
    if (!entry.editorialEligible && editorialReferences.has(entry.number)) {
      errors.push(
        `editorial release prose references non-editorial ${entry.type} PR #${entry.number} (${entry.type})`,
      );
    }
  }
  const pullRequestsByNumber = new Map(pullRequests.map((entry) => [entry.number, entry]));
  const editorialLines = editorialProse.split("\n");
  for (const line of editorialLines) {
    if (!line.startsWith("- ")) {
      continue;
    }
    const expectedCredits = editorialCreditsForLine(
      line,
      pullRequestsByNumber,
      directCommits,
      nodes,
    );
    const actualThanks = new Set(handlesIn(line).map((handle) => handle.toLowerCase()));
    if (expectedCredits !== undefined) {
      const expectedThanks = new Set(expectedCredits.map((handle) => handle.toLowerCase()));
      for (const handle of handlesIn(line)) {
        if (!expectedThanks.has(handle.toLowerCase())) {
          errors.push(`unexpected editorial Thanks @${handle}`);
        }
      }
    }
    const lineReferences = new Set(referencesIn(line));
    for (const entry of pullRequests) {
      if (!lineReferences.has(entry.number)) {
        continue;
      }
      for (const handle of entry.thanks) {
        if (!actualThanks.has(handle.toLowerCase())) {
          errors.push(`missing editorial Thanks @${handle} for PR #${entry.number}`);
        }
      }
    }
    for (const handle of directCommitCreditsForLine(line, directCommits)) {
      if (!actualThanks.has(handle.toLowerCase())) {
        errors.push(`missing editorial Thanks @${handle} for directly landed work`);
      }
    }
  }
  const lines = section.source.split("\n");
  for (const number of new Set(referencesIn(section.source))) {
    const node = nodes.get(number);
    if (node?.__typename !== "Issue") {
      continue;
    }
    for (const handle of thanksFor(node, [])) {
      const credited = lines.some(
        (line) =>
          line.includes(`#${number}`) && line.toLowerCase().includes(`@${handle.toLowerCase()}`),
      );
      if (!credited) {
        errors.push(`missing Thanks @${handle} for issue #${number}`);
      }
    }
  }
  return errors;
}

function manifestFor(options, source, ledger, directCommitRecords) {
  const directCommits = directCommitRecords.map((commit) => ({
    ...editorialClassification(commit.subject),
    commit: commit.hash.slice(0, 12),
    subject: commit.subject,
    references: commit.references,
    author: commit.author,
    contributors: commit.contributors,
    issues: commit.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      reporter: issue.thanks,
    })),
  }));
  const unlinkedCommits = directCommits.filter((commit) => commit.references.length === 0);
  return {
    schemaVersion: 3,
    diagnostics: source.diagnostics,
    canonicalMain: source.mainCommit,
    changelogSource: options.changelogSource,
    base: options.base,
    target: options.target,
    mergeBase: source.mergeBase,
    version: options.version,
    shippedBaselines: source.shippedBaselines,
    workflowRuns: source.workflowRuns,
    unavailableReferences: source.unavailableReferences,
    recoveredIssues: source.recoveredIssues,
    source: {
      references: ledger.entries.length,
      ...ledger.provenance,
      issues: ledger.issues.length,
      directCommits: directCommits.length,
      unlinkedCommits: unlinkedCommits.length,
    },
    pullRequests: ledger.pullRequests.map((entry) => ({
      number: entry.number,
      title: entry.title,
      type: entry.type,
      editorialEligible: entry.editorialEligible,
      thanks: entry.thanks,
      externalReferences: entry.externalReferences,
      relatedReferences: [...new Set(entry.linkedIssues.map((issue) => issue.number))],
      linkedIssues: entry.linkedIssues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        reporter: issue.thanks,
      })),
    })),
    directCommits,
    unlinkedCommits,
  };
}

function releaseChecks(
  changelog,
  version,
  releaseTags,
  contributionRecordPath,
  regularStableVersion,
) {
  const checks = [];
  for (const tag of releaseTags) {
    const release = githubApi([`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
    const verification = verifyGithubReleaseNotes({
      body: release.body ?? "",
      changelog,
      version,
      tag,
      repository: repo,
      regularStableVersion,
      contributionRecordPath,
    });
    checks.push({
      tag,
      releaseId: release.id,
      matches: verification.matches,
      mode: verification.mode,
      bodyLength: verification.actualSize.characters,
      bodyBytes: verification.actualSize.bytes,
    });
  }
  return checks;
}

function writeFileAtomic(filePath, contents) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const tempDirectory = mkdtempSync(path.join(directory, `.${path.basename(filePath)}.tmp-`));
  const tempPath = path.join(tempDirectory, path.basename(filePath));
  try {
    writeFileSync(tempPath, contents);
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
}

function canonicalArtifactPath(file) {
  let ancestor = path.resolve(file);
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(realpathSync(ancestor), ...missing);
}

function assertSeparateOutput(input, output, message) {
  if (canonicalArtifactPath(input) === canonicalArtifactPath(output)) {
    fail(message);
  }
  if (existsSync(input) && existsSync(output)) {
    const original = statSync(input);
    const destination = statSync(output);
    if (original.dev === destination.dev && original.ino === destination.ino) {
      fail(message);
    }
  }
}

function loadOrInitializeReleaseChangelog(rootDir, version, writeLedger) {
  const existing = findReleaseChangelog({ rootDir, version });
  if (existing || !writeLedger) {
    return existing ?? loadReleaseChangelog({ rootDir, version });
  }
  writeReleaseChangelog({
    rootDir,
    version,
    section: `## ${version}\n\n### Highlights\n\n### Changes\n\n### Fixes\n`,
  });
  return loadReleaseChangelog({ rootDir, version });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (options.base === "npm-beta" || options.base === "npm-stable") {
    const candidate = parseReleaseVersion(options.version);
    const channel = options.base === "npm-beta" ? "beta" : "latest";
    if (
      !candidate ||
      (channel === "beta"
        ? candidate.channel !== "beta"
        : candidate.channel !== "stable" || candidate.patch >= 33)
    ) {
      fail(
        "registry baseline requires a matching regular release channel; extended-stable requires its captured --base tag",
      );
    }
    const previous = JSON.parse(
      run("npm", [
        "view",
        "openclaw@" + channel,
        "version",
        "--json",
        "--registry=https://registry.npmjs.org",
      ]),
    );
    const baseline = typeof previous === "string" ? parseReleaseVersion(previous) : null;
    if (
      !baseline ||
      baseline.channel === "alpha" ||
      baseline.patch >= 33 ||
      (channel === "latest" && baseline.channel !== "stable")
    ) {
      fail("npm " + channel + " did not resolve to a supported regular release version");
    }
    if ((compareReleaseVersions(baseline.version, candidate.version) ?? 0) >= 0) {
      fail(
        "npm " +
          channel +
          " already points to this candidate or a newer version; reuse the previously captured --base tag for verification or recovery",
      );
    }
    // Resolve once before discovery. The manifest and contribution provenance
    // retain this tag; publication/verification never consult a moving selector.
    options.base = `v${baseline.version}`;
  }
  // Keep the shipped identity in provenance, including divergent release branches.
  if (/^v[0-9]/u.test(options.base) && !options.shippedRefs.includes(options.base)) {
    options.shippedRefs.push(options.base);
  }
  // Preserve early recovery guidance for divergent/shallow shipped tags.
  if (/^v[0-9]/u.test(options.base)) {
    gitMergeBase(options.base, options.target);
  }
  const rootDir = process.cwd();
  if (options.releaseBranch && !gitIsAncestor(options.target, options.releaseBranch)) {
    fail(
      `release notes target ${options.target} is not reachable from canonical release branch ${options.releaseBranch}; generate notes from that branch's frozen tip`,
    );
  }
  if (options.historicalIssueSnapshotPath) {
    const input = realpathSync(options.historicalIssueSnapshotPath);
    const base = git(["rev-parse", options.base + "^{commit}"]);
    const target = git(["rev-parse", options.target + "^{commit}"]);
    const outputs = [
      options.manifestPath,
      options.githubSnapshotPath ??
        defaultGithubSnapshotPath(base, target, git(["rev-parse", "--git-common-dir"])),
      ...(options.writeLedger
        ? [
            "CHANGELOG.md",
            "CHANGELOG/" + options.version + ".md",
            "CHANGELOG/records/" + options.version + ".md",
          ]
        : []),
    ];
    for (const output of outputs.filter(Boolean)) {
      assertSeparateOutput(input, output, "historical issue snapshot must not be an output path");
    }
  }
  const historicalEvidence = options.historicalIssueSnapshotPath
    ? loadHistoricalIssueSnapshot({
        filePath: options.historicalIssueSnapshotPath,
        sha256: options.historicalIssueSnapshotSha256,
        base: git(["rev-parse", options.base + "^{commit}"]),
        target: git(["rev-parse", options.target + "^{commit}"]),
      })
    : undefined;
  const releaseSource = options.sourceRef
    ? loadReleaseChangelog({ rootDir, version: options.version, ref: options.sourceRef })
    : loadOrInitializeReleaseChangelog(rootDir, options.version, options.writeLedger);
  if (options.sourceRef) {
    options.changelogSource = {
      ref: releaseSource.ref,
      sourcePath: releaseSource.sourcePath,
      recordPath: releaseSource.recordPath,
      format: releaseSource.format,
    };
    for (const output of [options.manifestPath, options.githubSnapshotPath].filter(Boolean)) {
      for (const input of [
        "CHANGELOG.md",
        "CHANGELOG/" + releaseSource.version + ".md",
        "CHANGELOG/records/" + releaseSource.version + ".md",
      ]) {
        assertSeparateOutput(input, output, "source artifact must not be an output path");
      }
    }
  }
  if (releaseSource.format !== "initial") {
    fail("docs-mirrored release notes must be verified by the docs-publication workflow");
  }
  if (options.writeLedger && releaseSource.layout !== "split") {
    fail("split the changelog before writing a release contribution record");
  }
  githubSnapshotState = initializeGithubSnapshot(options);
  const changelog = releaseSource.section;
  const section = sectionFor(changelog, options.version);
  const source = sourceCommits(
    options.base,
    options.target,
    options.mainRef ?? "origin/main",
    options.releaseProvenance,
  );
  const committedSource = findReleaseChangelog({
    rootDir,
    ref: source.target,
    version: options.version,
  });
  const committedSection = committedSource
    ? sectionFor(committedSource.record ?? committedSource.section, options.version)
    : undefined;
  const committedRecord = committedSection
    ? contributionRecordFor(committedSection)
    : { legacyIssues: new Map(), pullRequests: new Map() };
  const committedRecordTarget = committedSection
    ? contributionRecordTarget(committedSection)
    : undefined;
  const committedRecordBase = committedSection
    ? parseContributionRecordProvenance(committedSection.source)?.base
    : undefined;
  const recordBase = committedRecordBase ? gitCommit(committedRecordBase) : undefined;
  // Cumulative stable accounting can include a prior beta's audited range.
  // Read its committed record without retargeting the original snapshot.
  let historicalRecord = committedRecord;
  let historicalRecordTarget = committedRecordTarget;
  let historicalRecordBase = recordBase;
  if (historicalEvidence) {
    const matches = extractChangelogReleaseSections(
      loadChangelogCollection({ rootDir, ref: source.target, recordsOnly: true }),
    ).filter((entry) => {
      // Only the matching audited range is evidence for this recovery. Unrelated
      // historical records can predate the current ledger format or invariants.
      const auditLine = entry.source.match(/^This audited record covers the complete .+$/mu)?.[0];
      if (!auditLine?.includes(`..${historicalEvidence.snapshot.target} history:`)) {
        return false;
      }
      const provenance = parseContributionRecordProvenance(entry.source);
      return (
        provenance &&
        provenance.target === historicalEvidence.snapshot.target &&
        gitCommit(provenance.base) === historicalEvidence.snapshot.base
      );
    });
    if (matches.length > 1) {
      fail("ambiguous committed historical contribution record");
    }
    if (matches.length === 1) {
      historicalRecord = contributionRecordFor(matches[0]);
      historicalRecordTarget = contributionRecordTarget(matches[0]);
      historicalRecordBase = historicalEvidence.snapshot.base;
    }
  }
  const shippedBaselineRecords = options.shippedRefs.map((ref) =>
    loadChangelogShippedBaseline(ref, rootDir, source.mainCommit ?? source.target),
  );
  source.diagnostics = shippedBaselineRecords.flatMap((baseline) => baseline.diagnostics);
  if (!/^v[0-9]/u.test(options.base)) {
    source.diagnostics.push(
      "Explicit non-release base retained for historical replay; use the previous shipped tag for new release notes, not a main closeout SHA.",
    );
  }
  const shippedExclusions = subtractShippedPullRequests(source, shippedBaselineRecords);
  source.shippedBaselines = shippedExclusions.baselines;
  const preexistingNotes = section.source.replace(
    /\n+### Complete contribution (?:ledger|record)[\s\S]*$/m,
    "",
  );
  const noteReferences = referencesIn(preexistingNotes);
  const revertedNoteReferences = noteReferences.filter((number) =>
    source.revertedReferences.has(number),
  );
  if (revertedNoteReferences.length > 0) {
    fail(
      `release notes reference reverted work: ${[...new Set(revertedNoteReferences)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const renderedRecord = contributionRecordFor(section);
  const renderedRecordReferences = contributionRecordMetadataReferences(renderedRecord);
  const revertedRenderedReferences = renderedRecordReferences.filter((number) =>
    source.revertedReferences.has(number),
  );
  if (!options.writeLedger && revertedRenderedReferences.length > 0) {
    fail(
      `contribution record references reverted work: ${[...new Set(revertedRenderedReferences)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const excludedRecordedReferences = new Set([
    ...source.revertedReferences,
    ...shippedExclusions.pullRequests,
  ]);
  const effectiveRenderedRecordReferences = renderedContributionRecordReferences(
    renderedRecord,
    options.writeLedger,
  );
  let priorRecord = { legacyIssues: new Map(), pullRequests: new Map() };
  if (options.seedRef) {
    const seedSource = loadReleaseChangelog({
      rootDir,
      ref: options.seedRef,
      version: options.version,
    });
    const seedSection = sectionFor(seedSource.record ?? seedSource.section, options.version);
    priorRecord = contributionRecordFor(seedSection);
  }
  const priorRecordReferences = contributionRecordMetadataReferences(priorRecord);
  priorRecord = withoutExcludedContributionRecords(priorRecord, excludedRecordedReferences);
  const recordedReferences = contributionRecordMetadataReferences(priorRecord);
  const revertedRecordedReferences = recordedReferences.filter((number) =>
    source.revertedReferences.has(number),
  );
  if (revertedRecordedReferences.length > 0) {
    fail(
      `contribution record references reverted work: ${[...new Set(revertedRecordedReferences)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  let references = [...source.references];
  appendReferences(references, noteReferences);
  appendReferences(references, effectiveRenderedRecordReferences);
  appendReferences(references, recordedReferences);
  // Hidden issues also disappear from live PR edges. The committed row names
  // the bounded historical candidates; it does not by itself establish recovery.
  if (historicalEvidence) {
    appendReferences(
      references,
      [...historicalRecord.pullRequests].flatMap(([number, row]) =>
        source.pullRequests.has(number)
          ? row.references.filter(
              (reference) => historicalEvidence.nodes.get(reference)?.__typename === "Issue",
            )
          : [],
      ),
    );
  }
  const resolveWithRecovery = (numbers) => {
    const resolution = resolveReferences(numbers);
    recoverUnavailablePullRequests({
      numbers,
      nodes: resolution.nodes,
      record: committedRecord,
      recordTarget: committedRecordTarget,
      source,
    });
    source.recoveredIssues = recoverUnavailableIssues({
      numbers,
      ...resolution,
      evidence: historicalEvidence,
      record: historicalRecord,
      recordTarget: historicalRecordTarget,
      recordBase: historicalRecordBase,
      source,
    });
    return resolution;
  };
  let { nodes } = resolveWithRecovery(references);
  let highestResolved = Math.max(0, ...nodes.keys());
  const legacyIssuePullRequests = [...legacyIssuesByPullRequest(priorRecord, nodes).keys()].filter(
    (number) => !shippedExclusions.pullRequests.has(number),
  );
  appendReferences(references, legacyIssuePullRequests);
  const resolution = resolveWithRecovery(references);
  nodes = resolution.nodes;
  highestResolved = Math.max(highestResolved, ...nodes.keys());
  const workflowRuns = resolveSourceWorkflowRuns(source, nodes, [
    ...noteReferences,
    ...effectiveRenderedRecordReferences,
    ...recordedReferences,
    ...legacyIssuePullRequests,
  ]);
  source.workflowRuns = workflowRuns;
  const workflowRunIds = new Set(workflowRuns.map((workflowRun) => workflowRun.id));
  references = references.filter((number) => !workflowRunIds.has(number));
  const { unavailable } = classifyUnavailableContextualReferences({
    unresolved: references.filter((number) => !nodes.has(number)),
    notFound: resolution.notFound,
    activeCommits: source.activeCommits,
    protectedReferences: new Set([
      ...noteReferences,
      ...renderedRecordReferences,
      ...priorRecordReferences,
      ...contributionRecordMetadataReferences(committedRecord),
      ...legacyIssuePullRequests,
      ...source.pullRequests,
      ...[...source.provenanceOverrides.values()].flat(),
    ]),
    highestResolved,
  });
  source.unavailableReferences = unavailable;
  const unavailableNumbers = new Set(unavailable.map((reference) => reference.number));
  references = references.filter((number) => !unavailableNumbers.has(number));
  source.references = source.references.filter((number) => !unavailableNumbers.has(number));
  for (const commit of source.activeCommits) {
    commit.references = commit.references.filter((number) => !unavailableNumbers.has(number));
  }
  if (unavailable.length > 0) {
    process.stderr.write(
      `unavailable contextual references (GitHub NOT_FOUND): ${unavailable.map(({ number }) => `#${number}`).join(", ")}\n`,
    );
  }
  const unresolvedSourceReferences = references.filter((number) => !nodes.has(number));
  if (unresolvedSourceReferences.length > 0) {
    fail(
      `GitHub could not resolve source references: ${unresolvedSourceReferences
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  validateReleaseProvenanceOverrides(source.provenanceOverrides, nodes, source.mainCommit);
  const provisionalEntries = references
    .map((number) => nodes.get(number))
    .filter((node) => node?.__typename === "PullRequest");
  const titleReferenceNumbers = titleReferences(provisionalEntries);
  const closingIssueNumbers = provisionalEntries.flatMap(
    (entry) => entry.closingIssuesReferences?.nodes.map((issue) => issue.number) ?? [],
  );
  const resolvedReferences = [...references];
  appendReferences(resolvedReferences, titleReferenceNumbers);
  appendReferences(resolvedReferences, closingIssueNumbers);
  ({ nodes } = resolveWithRecovery(resolvedReferences));
  references = resolvedReferences;
  const unresolvedFinal = references.filter((number) => !nodes.has(number));
  if (unresolvedFinal.length > 0) {
    fail("GitHub could not resolve final references: " + unresolvedFinal.join(", "));
  }
  const invalidRecordedPullRequests = [...priorRecord.pullRequests.keys()].filter((number) => {
    const node = nodes.get(number);
    return (
      node?.__typename !== "PullRequest" ||
      !node.mergedAt ||
      (!source.pullRequests.has(number) && !mergedByTarget(node.mergedAt, source.targetTimestamp))
    );
  });
  if (!options.writeLedger && invalidRecordedPullRequests.length > 0) {
    fail(
      `contribution record contains unresolved or unmerged PRs: ${invalidRecordedPullRequests
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const contributorHandles = [
    ...source.activeCommits.flatMap((commit) => commit.coauthors),
    ...source.activeCommits.map((commit) => commit.authorHandle).filter(Boolean),
  ];
  const resolvedHandles = resolveGitHubHandles(contributorHandles);
  const relationships = contributionRelationships(source, nodes, resolvedHandles);
  const resolvedCommitAuthors = resolveDirectCommitAuthors(relationships.directCommits);
  relationships.directCommits = withDirectCommitAuthors(
    relationships.directCommits,
    resolvedCommitAuthors,
  );
  const ledger = ledgerFor(
    options.base,
    source.target,
    references,
    nodes,
    resolvePullRequestCoauthors(nodes),
    relationships,
    priorRecord,
    source.pullRequests,
    source.references,
    legacyIssuePullRequests,
    source.revertedReferences,
    source.shippedBaselines,
    source.targetTimestamp,
    source.targetHistory,
    source.mainCommit,
  );
  const contamination = contaminatingPullRequestReferences({
    noteReferences,
    recordedReferences: options.writeLedger ? [] : [...renderedRecord.pullRequests.keys()],
    excludedRecordedReferences,
    sourcePullRequests: new Set(ledger.pullRequests.map((entry) => entry.number)),
    sourceReferences: source.references,
    seededPullRequests: new Set(priorRecord.pullRequests.keys()),
    nodes,
  });
  if (contamination.length > 0) {
    fail(
      `release section contains PRs outside ${options.base}..${options.target}: ${contamination
        .map((number) => `#${number}`)
        .join(", ")}; use --seed-ref only for an intentional historical backfill`,
    );
  }
  const manifest = manifestFor(
    { ...options, target: source.target },
    source,
    ledger,
    relationships.directCommits,
  );
  if (options.manifestPath) {
    writeFileAtomic(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  let candidateChangelog = changelog;
  let candidateSection = section;
  if (options.writeLedger) {
    candidateChangelog = replaceLedger(
      changelog,
      section,
      ledger.ledger,
      ledger.pullRequests,
      relationships.directCommits,
      nodes,
    );
    candidateSection = sectionFor(candidateChangelog, options.version);
  }

  const errors = ledgerChecks(
    { ...candidateSection, expectedProvenance: ledger.provenance },
    ledger.pullRequests,
    nodes,
    relationships.directCommits,
    source.shippedBaselines,
  );
  const github = options.checkGithub
    ? releaseChecks(
        candidateChangelog,
        options.version,
        options.releaseTags,
        releaseSource.recordPath ?? undefined,
        options.regularStableVersion,
      )
    : [];
  for (const check of github) {
    if (!check.matches) {
      errors.push(
        `GitHub release ${check.tag} does not match the ${options.version} CHANGELOG section`,
      );
    }
  }
  if (errors.length === 0 && options.writeLedger) {
    // Discovery can take minutes; do not replace notes edited while it was running.
    if (loadReleaseChangelog({ rootDir, version: options.version }).section !== changelog) {
      fail("Changelog changed during release-note generation; preserve the edits and rerun.");
    }
    writeReleaseChangelog({ rootDir, version: options.version, section: candidateChangelog });
  }

  const result = {
    diagnostics: source.diagnostics,
    canonicalMain: source.mainCommit,
    changelogSource: options.changelogSource,
    workflowRuns,
    recoveredIssues: source.recoveredIssues,
    base: options.base,
    target: source.target,
    mergeBase: source.mergeBase,
    version: options.version,
    shippedBaselines: source.shippedBaselines,
    source: {
      references: references.length,
      ...ledger.provenance,
      issues: ledger.issues.length,
      directCommits: manifest.directCommits.length,
      unlinkedCommits: manifest.unlinkedCommits.length,
    },
    github,
    githubSnapshot: githubSnapshotState
      ? {
          path: githubSnapshotState.filePath,
          hits: githubSnapshotState.hits,
          misses: githubSnapshotState.misses,
        }
      : null,
    errors,
  };
  persistGithubSnapshot(githubSnapshotState);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const diagnostic of source.diagnostics) {
      console.error("Warning: " + diagnostic);
    }
    const snapshotSummary = githubSnapshotState
      ? `, GitHub snapshot ${githubSnapshotState.hits} hits/${githubSnapshotState.misses} misses`
      : "";
    process.stdout.write(
      `${options.version}: ${ledger.provenance.uniquePullRequests} unique PRs (${ledger.provenance.inRangePullRequests} in-range + ${ledger.provenance.retainedSeedOnlyPullRequests} retained seed-only), ${ledger.issues.length} issues, ${errors.length === 0 ? "verified" : `${errors.length} errors`}${snapshotSummary}\n`,
    );
    if (errors.length > 0) {
      process.stdout.write(
        `${errors.map((error) => `- ${error.replaceAll("\n", "\n  ")}`).join("\n")}\n`,
      );
    }
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
