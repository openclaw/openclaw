#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatShippedBaselineExclusions,
  parseShippedBaselineExclusions,
  verifyGithubReleaseNotes,
} from "../../../../scripts/render-github-release-notes.mjs";
import {
  createTeamUniverseResolver,
  isoSecond,
  teamUniverseWindowQuery,
} from "./lib/github-team-inventory.mjs";
import {
  assertCompleteReleaseSourceInventory,
  buildReleaseSourceInventory,
  canonicalGitEnvironment,
  standardRevertedHash,
} from "./lib/release-source-inventory.mjs";

const repo = "openclaw/openclaw";
const commitAssociationQueryBatchSize = 20;
const githubApiRetryDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const githubGitObjectLimit = 2_048;
const githubGitBlobByteLimit = 8 * 1024 * 1024;
const githubGitTreeEntryLimit = 50_000;
const exactGitObjectPattern = /^[0-9a-f]{40}$/;
const gitTreeEntryTypes = new Map([
  ["040000", "tree"],
  ["100644", "blob"],
  ["100755", "blob"],
  ["120000", "blob"],
  ["160000", "commit"],
]);
const excludedHandles = new Set(["openclaw", "clawsweeper", "claude", "codex", "steipete"]);
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
  /(?:^|[\s:([{\-])(docs?|documentation|tests?|testing|qa|quality assurance|refactor(?:ing)?|ci|continuous integration|build|chore|style|lint|format)(?:$|[\s:)\]}\-])/i;
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
const toolingModuleFiles = [
  {
    path: ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
    url: new URL(import.meta.url),
  },
  {
    path: ".agents/skills/openclaw-changelog-update/scripts/lib/github-team-inventory.mjs",
    url: new URL("./lib/github-team-inventory.mjs", import.meta.url),
  },
  {
    path: ".agents/skills/openclaw-changelog-update/scripts/lib/release-source-inventory.mjs",
    url: new URL("./lib/release-source-inventory.mjs", import.meta.url),
  },
  {
    path: "scripts/render-github-release-notes.mjs",
    url: new URL("../../../../scripts/render-github-release-notes.mjs", import.meta.url),
  },
];

function fail(message) {
  throw new Error(message);
}

function fileSnapshot(path) {
  try {
    return { bytes: readFileSync(path), exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { bytes: Buffer.alloc(0), exists: false };
    }
    throw error;
  }
}

function snapshotsMatch(actual, expected) {
  return actual.exists === expected.exists && actual.bytes.equals(expected.bytes);
}

function snapshotSha256(snapshot) {
  return snapshot.exists ? createHash("sha256").update(snapshot.bytes).digest("hex") : "absent";
}

function snapshotDescription(snapshot) {
  return snapshot.exists
    ? `sha256=${snapshotSha256(snapshot)},bytes=${snapshot.bytes.length}`
    : "absent";
}

function contentSnapshot(content) {
  return {
    bytes: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content),
    exists: true,
  };
}

function canonicalFilesystemPath(path) {
  const absolutePath = resolvePath(path);
  try {
    return realpathSync.native(absolutePath).toLowerCase();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    if (lstatSync(absolutePath).isSymbolicLink()) {
      return canonicalFilesystemPath(
        resolvePath(dirname(absolutePath), readlinkSync(absolutePath)),
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return join(realpathSync.native(dirname(absolutePath)), basename(absolutePath)).toLowerCase();
}

function restoreSnapshot(path, snapshot, expectedCurrent) {
  if (!snapshot.exists) {
    const actual = fileSnapshot(path);
    if (!snapshotsMatch(actual, expectedCurrent)) {
      fail(
        `release output changed during rollback: ${path} ` +
          `(expected ${snapshotDescription(expectedCurrent)}; actual ${snapshotDescription(actual)})`,
      );
    }
    rmSync(path, { force: true });
    return;
  }
  const restorePath = `${path}.restore-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(restorePath, snapshot.bytes, { flag: "wx" });
    const actual = fileSnapshot(path);
    if (!snapshotsMatch(actual, expectedCurrent)) {
      fail(
        `release output changed during rollback: ${path} ` +
          `(expected ${snapshotDescription(expectedCurrent)}; actual ${snapshotDescription(actual)})`,
      );
    }
    renameSync(restorePath, path);
  } finally {
    rmSync(restorePath, { force: true });
  }
}

export function commitOutputTransaction(
  outputs,
  { afterRename, afterSnapshotCheck, beforeCommit, beforeRename, guards = [] } = {},
) {
  const pathStates = new Map();
  const normalized = outputs.map((output) => {
    const canonicalPath = canonicalFilesystemPath(output.path);
    const prior = pathStates.get(canonicalPath);
    if (prior && (!output.replacesPrevious || output.path !== prior.path)) {
      fail("release output transaction paths must be unique");
    }
    if (!prior && output.replacesPrevious) {
      fail(`release output transaction has no prior output for ${output.path}`);
    }
    const expectedBefore = prior?.current ?? output.expected;
    if (!expectedBefore) {
      fail(`release output transaction is missing an expected snapshot for ${output.path}`);
    }
    if (
      prior &&
      output.expected &&
      (output.expected.exists !== expectedBefore.exists ||
        !output.expected.bytes.equals(expectedBefore.bytes))
    ) {
      fail(`release output transaction chain does not match the prior output for ${output.path}`);
    }
    const written = contentSnapshot(output.content);
    if (prior && output.failureSentinel) {
      fail(`release output failure sentinel must be the first output for ${output.path}`);
    }
    pathStates.set(canonicalPath, {
      current: written,
      failureSentinel: prior?.failureSentinel ?? Boolean(output.failureSentinel),
      original: prior?.original ?? expectedBefore,
      path: output.path,
      rollback: prior?.rollback ?? (output.failureSentinel ? written : expectedBefore),
    });
    return { ...output, canonicalPath, expectedBefore, written };
  });
  const guardStates = new Map();
  for (const guard of guards) {
    if (!guard?.expected || typeof guard.path !== "string") {
      fail("release output transaction guard is invalid");
    }
    const canonicalPath = canonicalFilesystemPath(guard.path);
    if (pathStates.has(canonicalPath) || guardStates.has(canonicalPath)) {
      fail("release output transaction guards must be unique and read-only");
    }
    guardStates.set(canonicalPath, {
      path: guard.path,
      snapshot: guard.expected,
    });
  }

  const liveStates = new Map([
    ...[...pathStates].map(([canonicalPath, state]) => [
      canonicalPath,
      { path: state.path, snapshot: state.original },
    ]),
    ...guardStates,
  ]);
  const staged = [];
  const committed = [];
  try {
    for (const output of normalized) {
      const temporaryPath = `${output.path}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(temporaryPath, output.written.bytes, { flag: "wx" });
      staged.push({ ...output, temporaryPath });
    }
    beforeCommit?.();
    for (const state of liveStates.values()) {
      const actual = fileSnapshot(state.path);
      if (!snapshotsMatch(actual, state.snapshot)) {
        fail(
          `release output changed during verification: ${state.path} ` +
            `(expected ${snapshotDescription(state.snapshot)}; actual ${snapshotDescription(actual)})`,
        );
      }
    }
    for (const [index, output] of staged.entries()) {
      beforeRename?.({ index, output });
      const currentState = liveStates.get(output.canonicalPath);
      const otherStates = [...liveStates.entries()]
        .filter(([canonicalPath]) => canonicalPath !== output.canonicalPath)
        .map(([, state]) => state);
      for (const state of otherStates) {
        const actual = fileSnapshot(state.path);
        if (!snapshotsMatch(actual, state.snapshot)) {
          fail(
            `release output changed during commit: ${state.path} ` +
              `(expected ${snapshotDescription(state.snapshot)}; actual ${snapshotDescription(actual)})`,
          );
        }
        afterSnapshotCheck?.({ index, output, state });
      }
      const currentActual = fileSnapshot(currentState.path);
      if (!snapshotsMatch(currentActual, currentState.snapshot)) {
        fail(
          `release output changed during commit: ${currentState.path} ` +
            `(expected ${snapshotDescription(currentState.snapshot)}; ` +
            `actual ${snapshotDescription(currentActual)})`,
        );
      }
      renameSync(output.temporaryPath, output.path);
      committed.push(output);
      liveStates.set(output.canonicalPath, {
        path: output.path,
        snapshot: output.written,
      });
      afterRename?.({ index, output });
    }
  } catch (error) {
    const rollbackFailures = [];
    const lastCommittedByPath = new Map();
    for (const output of committed) {
      lastCommittedByPath.set(output.canonicalPath, output);
    }
    const rollbackEntries = [...lastCommittedByPath.entries()]
      .map(([canonicalPath, output]) => ({
        output,
        state: pathStates.get(canonicalPath),
      }))
      .toSorted(
        (left, right) => Number(right.state.failureSentinel) - Number(left.state.failureSentinel),
      );
    for (const { output, state } of rollbackEntries) {
      const actual = fileSnapshot(output.path);
      // Restore only bytes this transaction still owns; a concurrent writer's
      // replacement must survive even when rollback cannot fully complete.
      if (actual.exists !== output.written.exists || !actual.bytes.equals(output.written.bytes)) {
        rollbackFailures.push(
          `${output.path} no longer matches transaction output ` +
            `(expected ${snapshotDescription(output.written)}; actual ${snapshotDescription(actual)})`,
        );
        continue;
      }
      if (snapshotsMatch(actual, state.rollback)) {
        continue;
      }
      try {
        restoreSnapshot(output.path, state.rollback, output.written);
      } catch (rollbackError) {
        rollbackFailures.push(`${output.path}: ${rollbackError.message}`);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `${error.message}; release output rollback incomplete: ${rollbackFailures.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    for (const output of staged) {
      rmSync(output.temporaryPath, { force: true });
    }
  }
}

function manifestContent(manifest, status) {
  const { schemaVersion, ...fields } = manifest;
  return `${JSON.stringify({ schemaVersion, status, ...fields }, null, 2)}\n`;
}

function printUsage() {
  console.log(`Usage:
  node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \\
    --base <tag-or-sha> --target <tag-or-sha> --version <version> [options]

Required:
  --base <ref>          Release range start.
  --target <ref>        Release range end.
  --version <version>   CHANGELOG.md version heading to verify.

Options:
  --manifest <path>     Read or write the complete contribution record ledger.
  --seed-ref <ref>      Use an existing release section as editorial input.
  --tooling-commit <full-SHA>
                        Commit containing the exact trusted verifier modules.
  --tooling-tree <full-SHA>
                        Tree for --tooling-commit; both options are required together.
  --shipped-ref <tag>   Exclude PRs proven present in this shipped tag; repeatable.
  --source-target <ref> Inventory cutoff; --target may be one final CHANGELOG-only child.
  --max-changelog-tail <count>
                        Maximum linear CHANGELOG-only commits after --source-target (default: 1).
  --comparison-base main
                        Reconcile the exact merged-main PR universe against the source inventory.
  --provenance-ref <ref>
                        Search this trusted ref for unique cherry-pick provenance; repeatable.
  --provenance-pr <PR>:<full-SHA>
                        Trust one exact trailer-linked patch as merged PR provenance; repeatable.
  --comparison-pr-member-overlap <PR>:<member-SHA>:<target-SHA>:<main-witness-SHA>
                        Review one exact PR-member/direct-commit overlap against the sole
                        independent match in the merge parent's full ancestry; the selected
                        witness must lie on its first-parent path, without attributing the PR.
  --comparison-pr-member-subset-overlap <PR>:<member-SHA>:<target-SHA>:<main-witness-SHA>
                        Review one strict PR-member subset already supplied by an independent
                        broader main/release commit pair, without attributing the PR.
  --provenance-pr-adapted <PR>:<origin-SHA>:<target-SHA>
                        Trust one reviewed same-path member or squash-aggregate adaptation.
  --provenance-pr-integrated <PR>:<source-SHA>:<target-SHA>
                        Bind one source in a reviewed adapted multi-source PR backport; repeatable.
  --provenance-pr-partial <PR>:<source-SHA>:<target-SHA>
                        Trust one reviewed strict-path-subset PR backport; repeatable.
  --write-ledger        Write the verified ledger back into CHANGELOG.md.
  --release-tag <tag>   GitHub release tag to compare; repeatable with --check-github.
  --check-github        Require each supplied GitHub release body to match.
  --json                Emit machine-readable verification output.
  --help                Show this help text.`);
}

function parseArgs(argv) {
  const options = {
    releaseTags: [],
    checkGithub: false,
    comparisonBaseBranch: undefined,
    help: false,
    json: false,
    manifestPath: undefined,
    maxSourceTailCommits: 1,
    provenanceAdaptedPullRequests: [],
    comparisonPullRequestMemberOverlaps: [],
    comparisonPullRequestMemberSubsetOverlaps: [],
    provenanceIntegratedPullRequests: [],
    provenancePartialPullRequests: [],
    provenancePullRequests: [],
    provenanceRefs: [],
    seedRef: undefined,
    shippedRefs: [],
    toolingCommit: undefined,
    toolingTree: undefined,
    writeLedger: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--check-github" || arg === "--json" || arg === "--write-ledger") {
      options[
        arg === "--check-github" ? "checkGithub" : arg === "--write-ledger" ? "writeLedger" : "json"
      ] = true;
      continue;
    }
    if (
      arg === "--base" ||
      arg === "--target" ||
      arg === "--version" ||
      arg === "--release-tag" ||
      arg === "--shipped-ref" ||
      arg === "--source-target" ||
      arg === "--max-changelog-tail" ||
      arg === "--comparison-base" ||
      arg === "--provenance-ref" ||
      arg === "--provenance-pr" ||
      arg === "--comparison-pr-member-overlap" ||
      arg === "--comparison-pr-member-subset-overlap" ||
      arg === "--provenance-pr-adapted" ||
      arg === "--provenance-pr-integrated" ||
      arg === "--provenance-pr-partial" ||
      arg === "--manifest" ||
      arg === "--seed-ref" ||
      arg === "--tooling-commit" ||
      arg === "--tooling-tree"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`missing value for ${arg}`);
      }
      if (arg === "--release-tag") {
        options.releaseTags.push(value);
      } else if (arg === "--shipped-ref") {
        options.shippedRefs.push(value);
      } else if (arg === "--source-target") {
        options.sourceTarget = value;
      } else if (arg === "--max-changelog-tail") {
        if (!/^\d+$/.test(value)) {
          fail(`invalid --max-changelog-tail value: ${value}`);
        }
        options.maxSourceTailCommits = Number(value);
        if (!Number.isSafeInteger(options.maxSourceTailCommits)) {
          fail(`invalid --max-changelog-tail value: ${value}`);
        }
      } else if (arg === "--comparison-base") {
        if (value !== "main") {
          fail("--comparison-base must be main");
        }
        options.comparisonBaseBranch = value;
      } else if (arg === "--provenance-ref") {
        options.provenanceRefs.push(value);
      } else if (arg === "--provenance-pr") {
        const match = value.match(/^#?(?<number>\d+):(?<commit>[0-9a-f]{40})$/i);
        if (!match?.groups || Number(match.groups.number) <= 0) {
          fail(`invalid --provenance-pr value: ${value}`);
        }
        options.provenancePullRequests.push({
          commitRef: match.groups.commit.toLowerCase(),
          number: Number(match.groups.number),
        });
      } else if (arg === "--comparison-pr-member-overlap") {
        const match = value.match(
          /^#?(?<number>\d+):(?<source>[0-9a-f]{40}):(?<target>[0-9a-f]{40}):(?<witness>[0-9a-f]{40})$/i,
        );
        if (!match?.groups || Number(match.groups.number) <= 0) {
          fail(`invalid --comparison-pr-member-overlap value: ${value}`);
        }
        options.comparisonPullRequestMemberOverlaps.push({
          number: Number(match.groups.number),
          sourceCommitRef: match.groups.source.toLowerCase(),
          targetCommitRef: match.groups.target.toLowerCase(),
          witnessCommitRef: match.groups.witness.toLowerCase(),
        });
      } else if (arg === "--comparison-pr-member-subset-overlap") {
        const match = value.match(
          /^#?(?<number>\d+):(?<source>[0-9a-f]{40}):(?<target>[0-9a-f]{40}):(?<witness>[0-9a-f]{40})$/i,
        );
        if (!match?.groups || Number(match.groups.number) <= 0) {
          fail(`invalid --comparison-pr-member-subset-overlap value: ${value}`);
        }
        options.comparisonPullRequestMemberSubsetOverlaps.push({
          number: Number(match.groups.number),
          sourceCommitRef: match.groups.source.toLowerCase(),
          targetCommitRef: match.groups.target.toLowerCase(),
          witnessCommitRef: match.groups.witness.toLowerCase(),
        });
      } else if (arg === "--provenance-pr-adapted") {
        const match = value.match(
          /^#?(?<number>\d+):(?<origin>[0-9a-f]{40}):(?<target>[0-9a-f]{40})$/i,
        );
        if (!match?.groups || Number(match.groups.number) <= 0) {
          fail(`invalid --provenance-pr-adapted value: ${value}`);
        }
        options.provenanceAdaptedPullRequests.push({
          number: Number(match.groups.number),
          originCommitRef: match.groups.origin.toLowerCase(),
          targetCommitRef: match.groups.target.toLowerCase(),
        });
      } else if (arg === "--provenance-pr-integrated") {
        const match = value.match(
          /^#?(?<number>\d+):(?<source>[0-9a-f]{40}):(?<target>[0-9a-f]{40})$/i,
        );
        if (!match?.groups || Number(match.groups.number) <= 0) {
          fail(`invalid --provenance-pr-integrated value: ${value}`);
        }
        options.provenanceIntegratedPullRequests.push({
          number: Number(match.groups.number),
          sourceCommitRef: match.groups.source.toLowerCase(),
          targetCommitRef: match.groups.target.toLowerCase(),
        });
      } else if (arg === "--provenance-pr-partial") {
        const match = value.match(
          /^#?(?<number>\d+):(?<source>[0-9a-f]{40}):(?<target>[0-9a-f]{40})$/i,
        );
        if (!match?.groups || Number(match.groups.number) <= 0) {
          fail(`invalid --provenance-pr-partial value: ${value}`);
        }
        options.provenancePartialPullRequests.push({
          number: Number(match.groups.number),
          sourceCommitRef: match.groups.source.toLowerCase(),
          targetCommitRef: match.groups.target.toLowerCase(),
        });
      } else if (arg === "--manifest") {
        options.manifestPath = value;
      } else if (arg === "--seed-ref") {
        options.seedRef = value;
      } else if (arg === "--tooling-commit") {
        if (!/^[0-9a-f]{40}$/i.test(value)) {
          fail(`invalid --tooling-commit value: ${value}`);
        }
        options.toolingCommit = value.toLowerCase();
      } else if (arg === "--tooling-tree") {
        if (!/^[0-9a-f]{40}$/i.test(value)) {
          fail(`invalid --tooling-tree value: ${value}`);
        }
        options.toolingTree = value.toLowerCase();
      } else {
        options[arg.slice(2)] = value;
      }
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }

  if (!options.help) {
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
  if (Boolean(options.toolingCommit) !== Boolean(options.toolingTree)) {
    fail("--tooling-commit and --tooling-tree must be supplied together");
  }
  if (options.comparisonBaseBranch && !options.toolingCommit) {
    fail("--comparison-base main requires --tooling-commit and --tooling-tree");
  }
  const uniqueShippedRefs = new Set(options.shippedRefs);
  if (uniqueShippedRefs.size !== options.shippedRefs.length) {
    fail("--shipped-ref values must be unique");
  }
  options.shippedRefs = options.shippedRefs.toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const uniqueProvenanceRefs = new Set(options.provenanceRefs);
  if (uniqueProvenanceRefs.size !== options.provenanceRefs.length) {
    fail("--provenance-ref values must be unique");
  }
  options.provenanceRefs = options.provenanceRefs.toSorted((a, b) =>
    a === b ? 0 : a < b ? -1 : 1,
  );
  const provenancePullRequestKeys = new Set(
    options.provenancePullRequests.map((entry) => `${entry.number}:${entry.commitRef}`),
  );
  if (provenancePullRequestKeys.size !== options.provenancePullRequests.length) {
    fail("--provenance-pr values must be unique");
  }
  options.provenancePullRequests = options.provenancePullRequests.toSorted(
    (left, right) => left.number - right.number || left.commitRef.localeCompare(right.commitRef),
  );
  const comparisonMemberOverlapKeys = new Set(
    options.comparisonPullRequestMemberOverlaps.map(
      (entry) =>
        `${entry.number}:${entry.sourceCommitRef}:${entry.targetCommitRef}:${entry.witnessCommitRef}`,
    ),
  );
  if (comparisonMemberOverlapKeys.size !== options.comparisonPullRequestMemberOverlaps.length) {
    fail("--comparison-pr-member-overlap values must be unique");
  }
  if (
    new Set(options.comparisonPullRequestMemberOverlaps.map((entry) => entry.number)).size !==
    options.comparisonPullRequestMemberOverlaps.length
  ) {
    fail("--comparison-pr-member-overlap PR numbers must be unique");
  }
  if (
    new Set(options.comparisonPullRequestMemberOverlaps.map((entry) => entry.sourceCommitRef))
      .size !== options.comparisonPullRequestMemberOverlaps.length
  ) {
    fail("--comparison-pr-member-overlap source SHAs must be unique");
  }
  if (
    new Set(options.comparisonPullRequestMemberOverlaps.map((entry) => entry.targetCommitRef))
      .size !== options.comparisonPullRequestMemberOverlaps.length
  ) {
    fail("--comparison-pr-member-overlap target SHAs must be unique");
  }
  if (
    new Set(options.comparisonPullRequestMemberOverlaps.map((entry) => entry.witnessCommitRef))
      .size !== options.comparisonPullRequestMemberOverlaps.length
  ) {
    fail("--comparison-pr-member-overlap witness SHAs must be unique");
  }
  const comparisonMemberOverlapCommits = options.comparisonPullRequestMemberOverlaps.flatMap(
    (entry) => [entry.sourceCommitRef, entry.targetCommitRef, entry.witnessCommitRef],
  );
  if (
    new Set(comparisonMemberOverlapCommits).size !==
    options.comparisonPullRequestMemberOverlaps.length * 3
  ) {
    fail("--comparison-pr-member-overlap source, target, and witness SHAs must be disjoint");
  }
  options.comparisonPullRequestMemberOverlaps =
    options.comparisonPullRequestMemberOverlaps.toSorted(
      (left, right) =>
        left.number - right.number ||
        left.sourceCommitRef.localeCompare(right.sourceCommitRef) ||
        left.targetCommitRef.localeCompare(right.targetCommitRef) ||
        left.witnessCommitRef.localeCompare(right.witnessCommitRef),
    );
  if (options.comparisonPullRequestMemberOverlaps.length > 0 && !options.comparisonBaseBranch) {
    fail("--comparison-pr-member-overlap requires --comparison-base main");
  }
  const comparisonMemberSubsetOverlapKeys = new Set(
    options.comparisonPullRequestMemberSubsetOverlaps.map(
      (entry) =>
        `${entry.number}:${entry.sourceCommitRef}:${entry.targetCommitRef}:${entry.witnessCommitRef}`,
    ),
  );
  if (
    comparisonMemberSubsetOverlapKeys.size !==
    options.comparisonPullRequestMemberSubsetOverlaps.length
  ) {
    fail("--comparison-pr-member-subset-overlap values must be unique");
  }
  if (
    new Set(options.comparisonPullRequestMemberSubsetOverlaps.map((entry) => entry.number)).size !==
    options.comparisonPullRequestMemberSubsetOverlaps.length
  ) {
    fail("--comparison-pr-member-subset-overlap PR numbers must be unique");
  }
  const comparisonMemberSubsetOverlapCommits =
    options.comparisonPullRequestMemberSubsetOverlaps.flatMap((entry) => [
      entry.sourceCommitRef,
      entry.targetCommitRef,
      entry.witnessCommitRef,
    ]);
  if (
    new Set(comparisonMemberSubsetOverlapCommits).size !==
    options.comparisonPullRequestMemberSubsetOverlaps.length * 3
  ) {
    fail("--comparison-pr-member-subset-overlap source, target, and witness SHAs must be disjoint");
  }
  options.comparisonPullRequestMemberSubsetOverlaps =
    options.comparisonPullRequestMemberSubsetOverlaps.toSorted(
      (left, right) =>
        left.number - right.number ||
        left.sourceCommitRef.localeCompare(right.sourceCommitRef) ||
        left.targetCommitRef.localeCompare(right.targetCommitRef) ||
        left.witnessCommitRef.localeCompare(right.witnessCommitRef),
    );
  if (
    options.comparisonPullRequestMemberSubsetOverlaps.length > 0 &&
    !options.comparisonBaseBranch
  ) {
    fail("--comparison-pr-member-subset-overlap requires --comparison-base main");
  }
  const comparisonOverlapNumbers = [
    ...options.comparisonPullRequestMemberOverlaps.map((entry) => entry.number),
    ...options.comparisonPullRequestMemberSubsetOverlaps.map((entry) => entry.number),
  ];
  if (new Set(comparisonOverlapNumbers).size !== comparisonOverlapNumbers.length) {
    fail("comparison-overlap PR numbers must be disjoint");
  }
  const comparisonOverlapCommits = [
    ...comparisonMemberOverlapCommits,
    ...comparisonMemberSubsetOverlapCommits,
  ];
  if (new Set(comparisonOverlapCommits).size !== comparisonOverlapCommits.length) {
    fail("comparison-overlap commit roles must be disjoint");
  }
  const adaptedKeys = new Set(
    options.provenanceAdaptedPullRequests.map(
      (entry) => `${entry.number}:${entry.originCommitRef}:${entry.targetCommitRef}`,
    ),
  );
  if (adaptedKeys.size !== options.provenanceAdaptedPullRequests.length) {
    fail("--provenance-pr-adapted values must be unique");
  }
  if (
    new Set(options.provenanceAdaptedPullRequests.map((entry) => entry.targetCommitRef)).size !==
    options.provenanceAdaptedPullRequests.length
  ) {
    fail("--provenance-pr-adapted target SHAs must be unique");
  }
  options.provenanceAdaptedPullRequests = options.provenanceAdaptedPullRequests.toSorted(
    (left, right) =>
      left.number - right.number ||
      left.originCommitRef.localeCompare(right.originCommitRef) ||
      left.targetCommitRef.localeCompare(right.targetCommitRef),
  );
  const integratedKeys = new Set(
    options.provenanceIntegratedPullRequests.map(
      (entry) => `${entry.number}:${entry.sourceCommitRef}:${entry.targetCommitRef}`,
    ),
  );
  if (integratedKeys.size !== options.provenanceIntegratedPullRequests.length) {
    fail("--provenance-pr-integrated values must be unique");
  }
  const integratedTargets = new Map();
  for (const entry of options.provenanceIntegratedPullRequests) {
    const number = integratedTargets.get(entry.targetCommitRef);
    if (number !== undefined && number !== entry.number) {
      fail("--provenance-pr-integrated target SHAs must map to one pull request");
    }
    integratedTargets.set(entry.targetCommitRef, entry.number);
  }
  options.provenanceIntegratedPullRequests = options.provenanceIntegratedPullRequests.toSorted(
    (left, right) =>
      left.number - right.number ||
      left.targetCommitRef.localeCompare(right.targetCommitRef) ||
      left.sourceCommitRef.localeCompare(right.sourceCommitRef),
  );
  const partialKeys = new Set(
    options.provenancePartialPullRequests.map(
      (entry) => `${entry.number}:${entry.sourceCommitRef}:${entry.targetCommitRef}`,
    ),
  );
  if (partialKeys.size !== options.provenancePartialPullRequests.length) {
    fail("--provenance-pr-partial values must be unique");
  }
  if (
    new Set(options.provenancePartialPullRequests.map((entry) => entry.targetCommitRef)).size !==
    options.provenancePartialPullRequests.length
  ) {
    fail("--provenance-pr-partial target SHAs must be unique");
  }
  options.provenancePartialPullRequests = options.provenancePartialPullRequests.toSorted(
    (left, right) =>
      left.number - right.number ||
      left.sourceCommitRef.localeCompare(right.sourceCommitRef) ||
      left.targetCommitRef.localeCompare(right.targetCommitRef),
  );
  const explicitTargetCommits = [
    ...options.provenanceAdaptedPullRequests.map((entry) => entry.targetCommitRef),
    ...integratedTargets.keys(),
    ...options.provenancePartialPullRequests.map((entry) => entry.targetCommitRef),
  ];
  if (new Set(explicitTargetCommits).size !== explicitTargetCommits.length) {
    fail("adapted, integrated, and partial provenance target SHAs must be disjoint");
  }
  if (comparisonOverlapCommits.some((commit) => explicitTargetCommits.includes(commit))) {
    fail("comparison-overlap commits and provenance target SHAs must be disjoint");
  }
  const ownershipPullRequestNumbers = new Set([
    ...options.provenancePullRequests.map((entry) => entry.number),
    ...options.provenanceAdaptedPullRequests.map((entry) => entry.number),
    ...options.provenanceIntegratedPullRequests.map((entry) => entry.number),
    ...options.provenancePartialPullRequests.map((entry) => entry.number),
  ]);
  if (
    options.comparisonPullRequestMemberOverlaps.some((entry) =>
      ownershipPullRequestNumbers.has(entry.number),
    ) ||
    options.comparisonPullRequestMemberSubsetOverlaps.some((entry) =>
      ownershipPullRequestNumbers.has(entry.number),
    )
  ) {
    fail("comparison-overlap PR numbers and provenance PR numbers must be disjoint");
  }
  const ownershipProvenanceCommits = new Set([
    ...options.provenancePullRequests.map((entry) => entry.commitRef),
    ...options.provenanceAdaptedPullRequests.flatMap((entry) => [
      entry.originCommitRef,
      entry.targetCommitRef,
    ]),
    ...options.provenanceIntegratedPullRequests.flatMap((entry) => [
      entry.sourceCommitRef,
      entry.targetCommitRef,
    ]),
    ...options.provenancePartialPullRequests.flatMap((entry) => [
      entry.sourceCommitRef,
      entry.targetCommitRef,
    ]),
  ]);
  if (comparisonOverlapCommits.some((commit) => ownershipProvenanceCommits.has(commit))) {
    fail("comparison-overlap commits and provenance commits must be disjoint");
  }
  if (options.writeLedger && !options.manifestPath) {
    fail("--write-ledger requires --manifest");
  }
  return options;
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: command === "git" ? canonicalGitEnvironment() : { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(args) {
  return run("git", args).trimEnd();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function gitAt(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

export function toolingIdentity(options, { cwd = process.cwd() } = {}) {
  const files = toolingModuleFiles
    .map((entry) => {
      const bytes = readFileSync(entry.url);
      return {
        bytes: bytes.length,
        path: entry.path,
        sha256: sha256(bytes),
      };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const aggregateSha256 = sha256(
    files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""),
  );
  if (!options.toolingCommit) {
    return { aggregateSha256, files, trustedSource: null };
  }

  const commit = gitAt(cwd, ["rev-parse", "--verify", `${options.toolingCommit}^{commit}`]);
  if (commit !== options.toolingCommit) {
    fail(`--tooling-commit did not resolve exactly: ${options.toolingCommit}`);
  }
  const tree = gitAt(cwd, ["show", "-s", "--format=%T", commit]);
  if (tree !== options.toolingTree) {
    fail(
      `--tooling-tree does not match ${commit}: expected ${tree}, received ${options.toolingTree}`,
    );
  }
  for (const file of files) {
    const committedBytes = execFileSync("git", ["show", `${commit}:${file.path}`], {
      cwd,
      env: canonicalGitEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const committedSha256 = sha256(committedBytes);
    if (committedSha256 !== file.sha256) {
      fail(
        `executed tooling file ${file.path} does not match ${commit}: ` +
          `expected ${committedSha256}, received ${file.sha256}`,
      );
    }
  }
  return {
    aggregateSha256,
    files,
    trustedSource: {
      commit,
      tree,
      verifiedFiles: files.length,
    },
  };
}

function normalizedInvocation(options) {
  const invocation = {
    base: options.base,
    checkGithub: options.checkGithub,
    comparisonBase: options.comparisonBaseBranch ?? null,
    maxChangelogTail: options.maxSourceTailCommits,
    provenanceAdaptedPullRequests: options.provenanceAdaptedPullRequests,
    comparisonPullRequestMemberOverlaps: options.comparisonPullRequestMemberOverlaps,
    comparisonPullRequestMemberSubsetOverlaps: options.comparisonPullRequestMemberSubsetOverlaps,
    provenanceIntegratedPullRequests: options.provenanceIntegratedPullRequests,
    provenancePartialPullRequests: options.provenancePartialPullRequests,
    provenancePullRequests: options.provenancePullRequests,
    provenanceRefs: options.provenanceRefs,
    releaseTags: [...options.releaseTags].toSorted(),
    seedRef: options.seedRef ?? null,
    shippedRefs: options.shippedRefs,
    sourceTarget: options.sourceTarget ?? options.target,
    target: options.target,
    toolingCommit: options.toolingCommit ?? null,
    toolingTree: options.toolingTree ?? null,
    version: options.version,
    writeLedger: options.writeLedger,
  };
  return {
    ...invocation,
    sha256: sha256(`${JSON.stringify(invocation)}\n`),
  };
}

function isCommitAncestor(ancestor, descendant) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${ancestor}^{commit}`, `${descendant}^{commit}`],
    {
      encoding: "utf8",
      env: canonicalGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  fail(
    `could not validate contribution record ancestry ${ancestor}..${descendant}: ${
      result.stderr?.trim() || result.signal || result.status
    }`,
  );
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function githubApiContext(args) {
  const operation = args[0] ?? "unknown";
  if (operation !== "graphql") {
    return `REST ${operation}`;
  }
  const query = args.find((value) => value.startsWith("query="))?.slice("query=".length) ?? "";
  const digest = createHash("sha256").update(query).digest("hex");
  return `graphql query sha256=${digest}`;
}

function sanitizedGithubResponsePrefix(value) {
  return stripAnsi(value)
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[redacted-token]")
    .replace(/\b(authorization|cookie|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function stringOutput(value) {
  if (typeof value === "string") {
    return value;
  }
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function sleepSync(delayMs) {
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}

function githubApiFailure({ args, attempt, attempts, error, raw }) {
  const context = githubApiContext(args);
  const prefix = sanitizedGithubResponsePrefix(raw);
  let responseKind = "non-JSON body";
  if (raw.trim() !== "") {
    try {
      JSON.parse(stripAnsi(raw));
      responseKind = "error response";
    } catch {
      responseKind = "non-JSON body";
    }
  }
  const execution = [
    error?.code === undefined ? undefined : `code=${error.code}`,
    error?.status === undefined ? undefined : `status=${error.status}`,
    error?.signal === undefined ? undefined : `signal=${error.signal}`,
    sanitizedGithubResponsePrefix(stringOutput(error?.stderr)),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const detail = prefix
    ? `${responseKind} prefix=${JSON.stringify(prefix)}`
    : `execution error=${JSON.stringify(execution || "unknown failure")}`;
  const failure = new Error(
    `GitHub API ${context} failed after ${attempt}/${attempts} attempts: ${detail}`,
  );
  failure.githubApiRetriesExhausted = true;
  return failure;
}

function isRetryableGithubApiFailure(error, raw) {
  const prefix = sanitizedGithubResponsePrefix(raw);
  if (/^\s*</.test(raw)) {
    return !/(?:access denied|authentication required|captcha|forbidden|sign in to github|single sign-on|sso required)/i.test(
      prefix,
    );
  }
  if (error instanceof SyntaxError && raw.trim() !== "") {
    return true;
  }
  if (error) {
    const detail = [
      error?.code,
      error?.status,
      error?.signal,
      error?.message,
      stringOutput(error?.stderr),
      raw,
    ]
      .filter((value) => value !== undefined && value !== null)
      .join(" ");
    return /(?:operation timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS handshake timeout|stream error: .*CANCEL|upstream connect error|connection termination|connection reset by peer|error connecting to api\.github\.com|something went wrong|temporarily unavailable|internal server error|rate limit|HTTP\s+(?:429|5\d\d)\b|unexpected end of JSON input|unterminated string|unterminated fractional number)/i.test(
      detail,
    );
  }
  return raw.trim() === "";
}

export function githubApi(
  args,
  { execute = run, retryDelaysMs = githubApiRetryDelaysMs, sleep = sleepSync } = {},
) {
  const attempts = retryDelaysMs.length + 1;
  let lastError;
  let lastRaw = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let raw = "";
    let executionError;
    try {
      raw = execute("ghx", ["api", ...args]);
    } catch (error) {
      executionError = error;
      raw = stringOutput(error?.stdout);
    }
    lastError = executionError;
    lastRaw = raw;
    if (!executionError && raw.trim() !== "") {
      try {
        return JSON.parse(stripAnsi(raw));
      } catch (error) {
        lastError = error;
      }
    }
    if (!isRetryableGithubApiFailure(executionError ?? lastError, raw) || attempt === attempts) {
      throw githubApiFailure({
        args,
        attempt,
        attempts,
        error: lastError,
        raw: lastRaw,
      });
    }
    sleep(retryDelaysMs[attempt - 1]);
  }
  throw githubApiFailure({ args, attempt: attempts, attempts, error: lastError, raw: lastRaw });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactHeadingMatches(sectionSource, heading) {
  return [...sectionSource.matchAll(new RegExp(`^${escapeRegExp(heading)}\\r?$`, "gmu"))];
}

function sourceBeforeContributionRecord(sectionSource, label) {
  const headings = [
    ...sectionSource.matchAll(/^### Complete contribution (?:ledger|record)\r?$/gmu),
  ];
  if (headings.length > 1) {
    fail(`${label} contains multiple complete contribution headings`);
  }
  return headings.length === 0
    ? sectionSource.trimEnd()
    : sectionSource.slice(0, headings[0].index).trimEnd();
}

function isEligibleHandle(handle) {
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
  const type = subject.match(/^\s*([a-z]+)(?:\([^)]*\))?!?:/i)?.[1]?.toLowerCase();
  return {
    editorialEligible:
      (Boolean(type) || editorialTitlePattern.test(subject)) &&
      !nonEditorialTypes.has(type) &&
      !nonEditorialTitlePattern.test(subject),
    type: type ?? "other",
  };
}

function mergedByTarget(mergedAt, targetTimestamp) {
  const mergedTimestamp = Date.parse(mergedAt);
  return Number.isFinite(mergedTimestamp) && mergedTimestamp <= targetTimestamp;
}

export function pullRequestMergedByTarget(node, targetCommit, targetTimestamp) {
  const mergedTimestamp = Date.parse(node?.mergedAt);
  const exactMerge = node?.mergeCommit?.oid === targetCommit;
  return (
    Number.isFinite(mergedTimestamp) &&
    (mergedTimestamp <= targetTimestamp ||
      (exactMerge && mergedTimestamp <= targetTimestamp + 1_000))
  );
}

function sectionFor(changelog, version) {
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\r?$`, "m").exec(changelog);
  if (!heading || heading.index === undefined) {
    fail(`CHANGELOG.md does not contain ## ${version}`);
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

function referencesIn(text) {
  const references = [];
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_.&-])(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g,
  )) {
    const qualifiedRepository = match.groups?.owner
      ? `${match.groups.owner}/${match.groups.name}`.toLowerCase()
      : undefined;
    if (!qualifiedRepository || qualifiedRepository === repo) {
      references.push(Number(match.groups?.number));
    }
  }
  return references;
}

function referenceLabelsIn(text) {
  const labels = [];
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9_.&-])(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g,
  )) {
    const qualifiedRepository = match.groups?.owner
      ? `${match.groups.owner}/${match.groups.name}`
      : undefined;
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
  appendUnique(references, referenceLabelsIn(entry.title));
  appendUnique(
    references,
    (entry.priorReferences ?? []).map((number) => `#${number}`),
  );
  appendUnique(references, entry.externalReferences ?? []);
  for (const issue of entry.linkedIssues) {
    appendUnique(references, [`#${issue.number}`]);
  }
  const related = references.length > 0 ? ` Related ${references.join(", ")}.` : "";
  const attribution =
    entry.thanks.length > 0
      ? ` Thanks ${entry.thanks.map((handle) => `@${handle}`).join(" and ")}.`
      : "";
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

export { standardRevertedHash };

function handlesIn(text) {
  const thanksStart = text.lastIndexOf(" Thanks ");
  if (thanksStart < 0) {
    return [];
  }
  const content = text.slice(0, thanksStart);
  return thanksHandlesIn(text).filter(
    (handle) =>
      isEligibleHandle(handle) &&
      !new RegExp(`(?<![A-Za-z0-9-])@${escapeRegExp(handle)}\\b`, "i").test(content),
  );
}

function thanksHandlesIn(text) {
  const thanksStart = text.lastIndexOf(" Thanks ");
  if (thanksStart < 0) {
    return [];
  }
  return [...text.slice(thanksStart).matchAll(/@([A-Za-z0-9-]+)/g)]
    .map((match) => match[1])
    .filter(isEligibleHandle);
}

function creditsHandle(text, handle) {
  const expected = handle.toLowerCase();
  return thanksHandlesIn(text).some((candidate) => candidate.toLowerCase() === expected);
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

function completeContributionRecordPullRequests(section, label) {
  const recordHeadings = exactHeadingMatches(section.source, "### Complete contribution record");
  if (recordHeadings.length !== 1) {
    fail(
      `${label} must contain exactly one ### Complete contribution record heading; found ${recordHeadings.length}`,
    );
  }
  const recordStart = recordHeadings[0].index;
  const recordSource = section.source.slice(recordStart);
  const provenancePattern =
    /^This audited record covers the complete (?<base>\S+)\.\.(?<target>[0-9a-f]{40}) history: (?<count>[0-9]+) merged PRs?\./gmu;
  const provenanceLines = [...recordSource.matchAll(provenancePattern)];
  if (provenanceLines.length !== 1) {
    fail(
      `${label} must contain exactly one complete contribution record provenance line; found ${provenanceLines.length}`,
    );
  }
  const provenance = provenanceLines[0];
  const rows = new Map();
  let inPullRequests = false;
  let pullRequestHeadings = 0;
  let shippedBaselineLines = 0;
  for (const line of recordSource.split("\n")) {
    if (line === "### Complete contribution record" || line.trim() === "") {
      continue;
    }
    if (line === "#### Pull requests") {
      pullRequestHeadings += 1;
      inPullRequests = true;
      continue;
    }
    if (line.startsWith("#### ")) {
      fail(`${label} contains unsupported contribution record subsection: ${line}`);
    }
    const row = line.match(/^- \*\*PR #(?<number>[0-9]+)\*\*(?:\s.*)?$/u);
    if (row) {
      const number = Number(row.groups.number);
      if (!inPullRequests) {
        fail(`${label} contains contribution record PR row outside #### Pull requests: #${number}`);
      }
      if (rows.has(number)) {
        fail(`${label} contains duplicate contribution record PR rows: #${number}`);
      }
      rows.set(number, line);
      continue;
    }
    if (inPullRequests) {
      fail(`${label} contains invalid #### Pull requests row: ${line}`);
    }
    if (provenancePattern.test(line)) {
      provenancePattern.lastIndex = 0;
      continue;
    }
    provenancePattern.lastIndex = 0;
    if (line.startsWith("Shipped baseline exclusions:")) {
      shippedBaselineLines += 1;
      if (shippedBaselineLines > 1) {
        fail(`${label} contains multiple shipped baseline exclusion lines`);
      }
      continue;
    }
    fail(`${label} contains unexpected contribution record preamble: ${line}`);
  }
  if (pullRequestHeadings !== 1) {
    fail(
      `${label} must contain exactly one #### Pull requests subsection; found ${pullRequestHeadings}`,
    );
  }
  if (!provenance?.groups?.base || !provenance.groups.target || !provenance.groups.count) {
    fail(`${label} is missing exact complete contribution record provenance`);
  }
  const declaredCount = Number(provenance.groups.count);
  if (rows.size !== declaredCount) {
    fail(`${label} contribution record declares ${declaredCount} PRs but contains ${rows.size}`);
  }
  return {
    base: provenance.groups.base,
    declaredCount,
    rows,
    target: provenance.groups.target,
  };
}

function completeContributionRecord(section, label, expectedRange) {
  const exact = completeContributionRecordPullRequests(section, label);
  if (
    expectedRange &&
    (exact.base !== expectedRange.base || exact.target !== expectedRange.target)
  ) {
    fail(
      `${label} contribution record provenance mismatch: expected ${expectedRange.base}..${expectedRange.target}, found ${exact.base}..${exact.target}`,
    );
  }
  const record = contributionRecordFor(section);
  if (record.pullRequests.size !== exact.rows.size) {
    fail(
      `${label} contribution record parser resolved ${record.pullRequests.size} of ${exact.rows.size} exact rows`,
    );
  }
  return { ...exact, record };
}

function shippedBaselineFor(ref) {
  const tagRef = `refs/tags/${ref}`;
  git(["rev-parse", `${tagRef}^{commit}`]);
  return { ref };
}

export function exactShippedPullRequestExclusions(source, baselines) {
  const included = new Set(source.inventory.partitions.pullRequests.included.members);
  // Exact tag content is publication truth. Historical credit rows may be incomplete,
  // so they cannot veto a patch-equivalence exclusion proven by the inventory.
  const excluded = new Set(
    source.inventory.partitions.pullRequests.shipped.members.filter(
      (number) => !included.has(number),
    ),
  );
  const claimed = new Set();
  const metadata = baselines
    .toSorted((left, right) => left.ref.localeCompare(right.ref))
    .map((baseline) => {
      const pullRequests = source.inventory.commits
        .filter(
          (commit) =>
            commit.disposition === "shipped" &&
            commit.shippedEvidence.some((evidence) => evidence.ref === baseline.ref),
        )
        .flatMap((commit) => commit.pullRequests)
        .filter((number) => excluded.has(number) && !claimed.has(number));
      const members = [...new Set(pullRequests)].toSorted((left, right) => left - right);
      for (const number of members) {
        claimed.add(number);
      }
      return { count: members.length, pullRequests: members, ref: baseline.ref };
    });
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

function contributionRecordReferences(record) {
  return [...record.pullRequests.keys()];
}

function contributionRecordMetadataReferences(record) {
  const references = contributionRecordReferences(record);
  for (const entry of record.pullRequests.values()) {
    appendReferences(references, entry.references);
  }
  appendReferences(references, record.legacyIssues.keys());
  return references;
}

export function contaminatingPullRequestReferences({
  noteReferences,
  recordedReferences,
  sourcePullRequests,
  seededPullRequests,
  nodes,
}) {
  const allowed = new Set([...sourcePullRequests, ...seededPullRequests]);
  return [...new Set([...noteReferences, ...recordedReferences])].filter(
    (number) => nodes.get(number)?.__typename === "PullRequest" && !allowed.has(number),
  );
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

function sourceCommits(options) {
  const provenanceNumbers = [
    ...new Set([
      ...options.provenanceAdaptedPullRequests.map((entry) => entry.number),
      ...options.comparisonPullRequestMemberOverlaps.map((entry) => entry.number),
      ...options.comparisonPullRequestMemberSubsetOverlaps.map((entry) => entry.number),
      ...options.provenanceIntegratedPullRequests.map((entry) => entry.number),
      ...options.provenancePartialPullRequests.map((entry) => entry.number),
      ...options.provenancePullRequests.map((entry) => entry.number),
    ]),
  ].toSorted((left, right) => left - right);
  const pullRequestCommitCache =
    provenanceNumbers.length === 0 ? new Map() : resolvePullRequestCommitLists(provenanceNumbers);
  hydrateExactGitCommits([
    ...options.provenancePullRequests.map((entry) => entry.commitRef),
    ...options.provenanceAdaptedPullRequests.flatMap((entry) => [
      entry.originCommitRef,
      entry.targetCommitRef,
    ]),
    ...options.comparisonPullRequestMemberOverlaps.flatMap((entry) => [
      entry.sourceCommitRef,
      entry.targetCommitRef,
      entry.witnessCommitRef,
    ]),
    ...options.comparisonPullRequestMemberSubsetOverlaps.flatMap((entry) => [
      entry.sourceCommitRef,
      entry.targetCommitRef,
      entry.witnessCommitRef,
    ]),
    ...options.provenanceIntegratedPullRequests.flatMap((entry) => [
      entry.sourceCommitRef,
      entry.targetCommitRef,
    ]),
    ...options.provenancePartialPullRequests.flatMap((entry) => [
      entry.sourceCommitRef,
      entry.targetCommitRef,
    ]),
    ...[...pullRequestCommitCache.values()].flat(),
  ]);
  const resolveCachedPullRequestCommits = (numbers) => {
    const missing = numbers.filter((number) => !pullRequestCommitCache.has(number));
    if (missing.length > 0) {
      const resolved = resolvePullRequestCommitLists(missing);
      hydrateExactGitCommits([...resolved.values()].flat());
      for (const [number, commits] of resolved) {
        pullRequestCommitCache.set(number, commits);
      }
    }
    return new Map(numbers.map((number) => [number, pullRequestCommitCache.get(number)]));
  };
  const resolveHydratedPullRequestMetadata = (numbers) => {
    const metadata = resolvePullRequestMetadata(numbers);
    hydrateExactGitCommits(
      [...metadata.values()].flatMap((entry) => [
        entry.baseCommit,
        entry.headCommit,
        entry.mergeCommit,
      ]),
    );
    return metadata;
  };
  const resolveHydratedComparison = (options) => {
    const comparison = resolveMergedPullRequestComparison(options);
    hydrateExactGitCommits(
      comparison.records.flatMap((entry) => [
        entry.baseCommit,
        entry.headCommit,
        entry.mergeCommit,
      ]),
    );
    return comparison;
  };
  const inventory = assertCompleteReleaseSourceInventory(
    buildReleaseSourceInventory(
      {
        baseRef: options.base,
        comparisonBaseBranch: options.comparisonBaseBranch,
        finalTargetRef: options.target,
        maxSourceTailCommits: options.maxSourceTailCommits,
        provenanceAdaptedPullRequests: options.provenanceAdaptedPullRequests,
        comparisonPullRequestMemberOverlaps: options.comparisonPullRequestMemberOverlaps,
        comparisonPullRequestMemberSubsetOverlaps:
          options.comparisonPullRequestMemberSubsetOverlaps,
        provenanceIntegratedPullRequests: options.provenanceIntegratedPullRequests,
        provenancePartialPullRequests: options.provenancePartialPullRequests,
        provenancePullRequests: options.provenancePullRequests,
        provenanceRefs: options.provenanceRefs,
        shippedRefs: options.shippedRefs,
        sourceTargetRef: options.sourceTarget ?? options.target,
      },
      {
        resolveAssociations: (commits, targetTimestamp) =>
          resolveAssociatedPullRequests(commits, targetTimestamp),
        resolveComparisonPullRequests: resolveHydratedComparison,
        resolvePullRequestCommits: resolveCachedPullRequestCommits,
        resolvePullRequestMetadata: resolveHydratedPullRequestMetadata,
        resolvePullRequests: (numbers) => {
          const nodes = resolveReferences(numbers);
          return new Map(numbers.map((number) => [number, nodes.get(number) ?? null]));
        },
      },
    ),
  );
  const source = sourceContributionsFromInventory(inventory);
  return sourceContributionsFromInventory(inventory, resolveCommitCoauthors(source.activeCommits));
}

export function sourceContributionsFromInventory(inventory, resolvedCommitCoauthors = new Map()) {
  const activeCommits = [];
  const coauthorsByReference = new Map();
  const manifestDirectCommits = new Set(inventory.partitions.commits.manifestDirect.members);
  const references = [];
  const pullRequests = new Set(inventory.partitions.pullRequests.included.members);
  const revertedReferences = new Set();
  for (const commit of inventory.commits) {
    if (commit.disposition === "reverted") {
      for (const number of [...commit.references, ...commit.pullRequests]) {
        revertedReferences.add(number);
      }
      continue;
    }
    if (commit.disposition !== "pull-request" && commit.disposition !== "direct") {
      continue;
    }
    for (const number of [
      ...commit.revertedExternalReferences,
      ...commit.revertedExternalPullRequests,
    ]) {
      revertedReferences.add(number);
    }
    const coauthorEmails = [...commit.body.matchAll(/^Co-authored-by:\s*.+?<([^>\s]+)>$/gim)].map(
      (match) => match[1],
    );
    const coauthors = coauthorEmails.map(githubHandleFromNoreply).filter(isEligibleHandle);
    addHandles(coauthors, resolvedCommitCoauthors.get(commit.commit) ?? []);
    const isRevert = Boolean(standardRevertedHash(`${commit.subject}\n\n${commit.body}`));
    const commitReferences = isRevert ? [] : [...commit.references];
    appendReferences(commitReferences, commit.pullRequests);
    appendReferences(references, commitReferences);
    activeCommits.push({
      authorEmail: commit.authorEmail,
      authorHandle: githubHandleFromNoreply(commit.authorEmail),
      authorName: commit.authorName,
      body: commit.body,
      closingReferences: closingReferencesIn(`${commit.subject}\n${commit.body}`),
      coauthors,
      coauthorEmails,
      hash: commit.commit,
      isRevert,
      manifestDirect: manifestDirectCommits.has(commit.commit),
      pullRequests: commit.pullRequests,
      references: commitReferences,
      subject: commit.subject,
    });
    for (const number of commitReferences) {
      const handles = coauthorsByReference.get(number) ?? new Set();
      for (const handle of coauthors) {
        handles.add(handle);
      }
      coauthorsByReference.set(number, handles);
    }
  }
  for (const number of pullRequests) {
    revertedReferences.delete(number);
  }
  for (const commit of activeCommits) {
    for (const number of commit.closingReferences) {
      revertedReferences.delete(number);
    }
  }
  return {
    activeCommits,
    coauthorsByReference,
    finalTarget: inventory.range.finalTarget,
    inventory,
    mergeBase: inventory.range.mergeBase,
    manifestDirectCommits,
    pullRequests,
    references,
    revertedReferences,
    sourceTail: inventory.range.sourceTail,
    target: inventory.range.sourceTarget,
    targetTimestamp: inventory.range.targetTimestamp,
  };
}

export function graphqlDataForResponse(response) {
  const errors = Array.isArray(response?.errors) ? response.errors : [];
  if (errors.length > 0) {
    fail(
      `GitHub GraphQL response contained errors:\n${errors
        .map((error) => error?.message || "unknown GraphQL error")
        .join("\n")}`,
    );
  }
  if (response?.data && typeof response.data === "object") {
    return response.data;
  }
  const detail = response?.message ? `\n${response.message}` : "";
  fail(`GitHub GraphQL response did not include data.${detail}`);
}

function graphql(query) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = githubApi(["graphql", "-f", `query=${query}`]);
      return graphqlDataForResponse(response);
    } catch (error) {
      lastError = error;
      if (error?.githubApiRetriesExhausted) {
        throw error;
      }
      const message = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
      // Historical ranges batch hundreds of objects; only retry transient transport failures.
      if (
        !/(?:operation timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS handshake timeout|stream error: .*CANCEL|unexpected end of JSON input|upstream connect error|connection termination|connection reset by peer|error connecting to api\.github\.com|Unexpected token '<'|something went wrong|temporarily unavailable|internal server error|rate limit)/i.test(
          message,
        )
      ) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function teamUniverseSearchPage(query, after) {
  const data = graphql(`query {
    search(
      type: ISSUE
      query: ${JSON.stringify(query)}
      first: 100
      after: ${after ? JSON.stringify(after) : "null"}
    ) {
      issueCount
      nodes {
        ... on PullRequest {
          number
          mergedAt
          baseRefName
          baseRefOid
          headRefOid
          mergeCommit { oid }
        }
      }
      pageInfo { endCursor hasNextPage }
    }
  }`);
  return data.search;
}

export function resolveMergedPullRequestComparison({
  baseBranch,
  endTimestamp,
  repository,
  startTimestamp,
}) {
  const query = teamUniverseWindowQuery({
    base: baseBranch,
    end: isoSecond(endTimestamp),
    repository,
    start: isoSecond(startTimestamp),
  });
  return createTeamUniverseResolver({
    base: baseBranch,
    fetchPage: teamUniverseSearchPage,
    repository,
  })(query);
}

export function resolvePullRequestCommitLists(numbers, { fetchPage = graphql } = {}) {
  const uniqueNumbers = [...new Set(numbers)].toSorted((left, right) => left - right);
  const states = new Map(
    uniqueNumbers.map((number) => [
      number,
      {
        commits: [],
        expectedCount: undefined,
        seenCommits: new Set(),
        seenCursors: new Set(),
      },
    ]),
  );
  const pending = [];

  function appendPage(number, connection) {
    const state = states.get(number);
    if (
      !connection ||
      !Number.isInteger(connection.totalCount) ||
      connection.totalCount <= 0 ||
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean" ||
      (connection.pageInfo.hasNextPage &&
        (typeof connection.pageInfo.endCursor !== "string" ||
          connection.pageInfo.endCursor.length === 0))
    ) {
      fail(`GitHub did not return a complete commits connection for PR #${number}`);
    }
    if (state.expectedCount !== undefined && state.expectedCount !== connection.totalCount) {
      fail(`GitHub commits totalCount changed for PR #${number}`);
    }
    state.expectedCount = connection.totalCount;
    for (const node of connection.nodes) {
      const commit = node?.commit?.oid;
      if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
        fail(`GitHub returned an invalid commit for PR #${number}`);
      }
      if (state.seenCommits.has(commit)) {
        fail(`GitHub commits returned a duplicate member for PR #${number}`);
      }
      state.seenCommits.add(commit);
      state.commits.push(commit);
    }
    if (connection.pageInfo.hasNextPage) {
      const cursor = connection.pageInfo.endCursor;
      if (state.seenCursors.has(cursor)) {
        fail(`GitHub commits repeated cursor ${cursor} for PR #${number}`);
      }
      state.seenCursors.add(cursor);
      pending.push({ cursor, number });
    }
  }

  function queryFor(items) {
    return `query { ${items
      .map(
        (item, offset) =>
          `p${offset}: repository(owner: "openclaw", name: "openclaw") {
            pullRequest(number: ${item.number}) {
              number
              commits(first: 100${item.cursor ? `, after: ${JSON.stringify(item.cursor)}` : ""}) {
                totalCount
                nodes { commit { oid } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
      )
      .join("\n")} }`;
  }

  for (let index = 0; index < uniqueNumbers.length; index += 20) {
    const items = uniqueNumbers.slice(index, index + 20).map((number) => ({ number }));
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      const item = items[offset];
      const pullRequest = data?.[`p${offset}`]?.pullRequest;
      if (pullRequest?.number !== item.number) {
        fail(`GitHub did not return PR #${item.number} while resolving commits`);
      }
      appendPage(item.number, pullRequest.commits);
    }
  }
  while (pending.length > 0) {
    const items = pending.splice(0, 20);
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      const item = items[offset];
      const pullRequest = data?.[`p${offset}`]?.pullRequest;
      if (pullRequest?.number !== item.number) {
        fail(`GitHub did not return PR #${item.number} while paginating commits`);
      }
      appendPage(item.number, pullRequest.commits);
    }
  }
  for (const [number, state] of states) {
    if (state.commits.length !== state.expectedCount) {
      fail(
        `GitHub commits did not return ${state.expectedCount} complete unique members for PR #${number}`,
      );
    }
  }
  return new Map([...states].map(([number, state]) => [number, [...state.commits]]));
}

export function resolvePullRequestMetadata(numbers, { fetchPage = graphql } = {}) {
  const uniqueNumbers = [...new Set(numbers)].toSorted((left, right) => left - right);
  const result = new Map();
  for (let index = 0; index < uniqueNumbers.length; index += 40) {
    const chunk = uniqueNumbers.slice(index, index + 40);
    const fields = chunk
      .map(
        (number, offset) =>
          `p${offset}: repository(owner: "openclaw", name: "openclaw") {
            pullRequest(number: ${number}) {
              baseRefName
              baseRefOid
              headRefOid
              mergeCommit { oid }
              mergedAt
              number
            }
          }`,
      )
      .join("\n");
    const data = fetchPage(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const number = chunk[offset];
      const pullRequest = data?.[`p${offset}`]?.pullRequest;
      const mergedAt = Date.parse(pullRequest?.mergedAt);
      if (
        pullRequest?.number !== number ||
        typeof pullRequest.baseRefName !== "string" ||
        pullRequest.baseRefName.length === 0 ||
        typeof pullRequest.baseRefOid !== "string" ||
        !/^[0-9a-f]{40}$/.test(pullRequest.baseRefOid) ||
        typeof pullRequest.headRefOid !== "string" ||
        !/^[0-9a-f]{40}$/.test(pullRequest.headRefOid) ||
        typeof pullRequest.mergeCommit?.oid !== "string" ||
        !/^[0-9a-f]{40}$/.test(pullRequest.mergeCommit.oid) ||
        !Number.isFinite(mergedAt)
      ) {
        fail(`GitHub did not return exact merged PR metadata for #${number}`);
      }
      result.set(number, {
        baseBranch: pullRequest.baseRefName,
        baseCommit: pullRequest.baseRefOid,
        headCommit: pullRequest.headRefOid,
        mergeCommit: pullRequest.mergeCommit.oid,
        mergedAt: new Date(mergedAt).toISOString(),
        number,
      });
    }
  }
  return result;
}

function exactGitObjectId(value, label) {
  if (typeof value !== "string" || !exactGitObjectPattern.test(value)) {
    fail(`${label} must be an exact lowercase 40-character Git object ID`);
  }
  return value;
}

function gitObjectType(objectId, cwd) {
  const result = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(),
    input: `${objectId}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      `could not inspect Git object ${objectId}: ${
        result.stderr?.trim() || result.error?.message || result.signal || result.status
      }`,
    );
  }
  const output = result.stdout.trim();
  if (output === `${objectId} missing`) {
    return null;
  }
  const [resolvedObjectId, type, ...extra] = output.split(" ");
  if (
    resolvedObjectId !== objectId ||
    extra.length > 0 ||
    !["blob", "commit", "tag", "tree"].includes(type)
  ) {
    fail(`Git returned malformed object metadata for ${objectId}: ${output || "empty"}`);
  }
  return type;
}

function gitObjectAvailable(objectId, expectedType, cwd) {
  const actualType = gitObjectType(objectId, cwd);
  if (actualType && actualType !== expectedType) {
    fail(`Git object ${objectId} is ${actualType}, expected ${expectedType}`);
  }
  return actualType !== null;
}

function gitObjectId(type, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1")
    .update(Buffer.from(`${type} ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

function assertGitObjectBytes(type, content, expectedObjectId) {
  const actualObjectId = gitObjectId(type, content);
  if (actualObjectId !== expectedObjectId) {
    fail(`Git ${type} ${expectedObjectId} hash mismatch: reconstructed ${actualObjectId}`);
  }
}

function writeExactGitObject(type, content, expectedObjectId, cwd) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  assertGitObjectBytes(type, bytes, expectedObjectId);
  const result = spawnSync("git", ["hash-object", "-w", "-t", type, "--stdin"], {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(),
    input: bytes,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      `could not write exact Git ${type} ${expectedObjectId}: ${
        result.stderr?.trim() || result.signal || result.status
      }`,
    );
  }
  const writtenObjectId = result.stdout.trim();
  if (writtenObjectId !== expectedObjectId) {
    fail(
      `Git wrote unexpected ${type} object ${writtenObjectId || "empty"}; expected ${expectedObjectId}`,
    );
  }
}

function exactGithubGitResponse(response, expectedObjectId, type) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    fail(`GitHub did not return a ${type} object for ${expectedObjectId}`);
  }
  if (response.sha !== expectedObjectId) {
    fail(
      `GitHub returned the wrong ${type} object for ${expectedObjectId}: ${response.sha ?? "missing"}`,
    );
  }
  return response;
}

function decodeGithubBlob(response, objectId, context) {
  if (
    response.encoding !== "base64" ||
    typeof response.content !== "string" ||
    !Number.isSafeInteger(response.size) ||
    response.size < 0
  ) {
    fail(`GitHub returned malformed blob metadata for ${objectId}`);
  }
  const encoded = response.content.replace(/\s/g, "");
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    fail(`GitHub returned malformed base64 for blob ${objectId}`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length !== response.size) {
    fail(`GitHub returned inconsistent blob bytes for ${objectId}`);
  }
  context.blobBytes += bytes.length;
  if (context.blobBytes > githubGitBlobByteLimit) {
    fail(`GitHub Git object hydration exceeded ${githubGitBlobByteLimit} blob bytes`);
  }
  return bytes;
}

function githubTreeEntry(entry, treeObjectId) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`GitHub returned a malformed entry for tree ${treeObjectId}`);
  }
  const expectedType = gitTreeEntryTypes.get(entry.mode);
  if (!expectedType || entry.type !== expectedType) {
    fail(
      `GitHub returned an invalid mode/type pair in tree ${treeObjectId}: ${entry.mode ?? "missing"}/${entry.type ?? "missing"}`,
    );
  }
  const objectId = exactGitObjectId(entry.sha, `tree ${treeObjectId} entry SHA`);
  if (
    typeof entry.path !== "string" ||
    entry.path.length === 0 ||
    entry.path === "." ||
    entry.path === ".." ||
    entry.path.includes("/") ||
    entry.path.includes("\0")
  ) {
    fail(`GitHub returned an invalid direct entry path in tree ${treeObjectId}`);
  }
  const pathBytes = Buffer.from(entry.path, "utf8");
  if (pathBytes.toString("utf8") !== entry.path) {
    fail(`GitHub returned a non-round-trippable path in tree ${treeObjectId}`);
  }
  return {
    mode: entry.mode,
    objectId,
    path: entry.path,
    pathBytes,
    sortKey: Buffer.concat([pathBytes, Buffer.from([entry.type === "tree" ? 47 : 0])]),
    type: entry.type,
  };
}

function githubTreeBytes(response, objectId, context) {
  if (response.truncated !== false || !Array.isArray(response.tree)) {
    fail(`GitHub returned an incomplete tree for ${objectId}`);
  }
  context.treeEntries += response.tree.length;
  if (context.treeEntries > githubGitTreeEntryLimit) {
    fail(`GitHub Git object hydration exceeded ${githubGitTreeEntryLimit} tree entries`);
  }
  const entries = response.tree.map((entry) => githubTreeEntry(entry, objectId));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    fail(`GitHub returned duplicate paths in tree ${objectId}`);
  }
  entries.sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
  const bytes = Buffer.concat(
    entries.flatMap((entry) => [
      Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} `),
      entry.pathBytes,
      Buffer.from([0]),
      Buffer.from(entry.objectId, "hex"),
    ]),
  );
  assertGitObjectBytes("tree", bytes, objectId);
  return { bytes, entries };
}

function githubSignedCommitBytes(response, objectId) {
  const treeObjectId = exactGitObjectId(response.tree?.sha, `commit ${objectId} tree SHA`);
  if (!Array.isArray(response.parents)) {
    fail(`GitHub returned malformed parents for commit ${objectId}`);
  }
  const parentObjectIds = response.parents.map((parent) =>
    exactGitObjectId(parent?.sha, `commit ${objectId} parent SHA`),
  );
  const verification = response.verification;
  if (
    !verification ||
    typeof verification.payload !== "string" ||
    typeof verification.signature !== "string" ||
    verification.payload.includes("\0") ||
    verification.signature.length === 0 ||
    verification.signature.includes("\0") ||
    verification.signature.startsWith("\n")
  ) {
    fail(`GitHub cannot reconstruct signed commit ${objectId}`);
  }
  const signature = verification.signature.endsWith("\r\n")
    ? verification.signature.slice(0, -2)
    : verification.signature.endsWith("\n")
      ? verification.signature.slice(0, -1)
      : verification.signature;
  if (signature.length === 0 || signature.endsWith("\n")) {
    fail(`GitHub cannot reconstruct signed commit ${objectId}`);
  }
  const headerBoundary = verification.payload.indexOf("\n\n");
  if (headerBoundary <= 0) {
    fail(`GitHub returned malformed signed payload for commit ${objectId}`);
  }
  const headers = verification.payload.slice(0, headerBoundary);
  const message = verification.payload.slice(headerBoundary + 2);
  const headerLines = headers.split("\n");
  const treeHeaders = headerLines.filter((line) => line.startsWith("tree "));
  const parentHeaders = headerLines.filter((line) => line.startsWith("parent "));
  if (
    headerLines.some((line) => line === "gpgsig" || line.startsWith("gpgsig ")) ||
    treeHeaders.length !== 1 ||
    treeHeaders[0] !== `tree ${treeObjectId}` ||
    parentHeaders.length !== parentObjectIds.length ||
    parentHeaders.some((line, index) => line !== `parent ${parentObjectIds[index]}`)
  ) {
    fail(`GitHub returned inconsistent signed payload headers for commit ${objectId}`);
  }
  const signedHeaders = `${headers}\ngpgsig ${signature.replaceAll("\n", "\n ")}`;
  const bytes = Buffer.from(`${signedHeaders}\n\n${message}`);
  assertGitObjectBytes("commit", bytes, objectId);
  return { bytes, parentObjectIds, treeObjectId };
}

function hydrateExactGithubGitObject(objectId, expectedType, context) {
  exactGitObjectId(objectId, `${expectedType} object ID`);
  const previousType = context.expectedTypes.get(objectId);
  if (previousType && previousType !== expectedType) {
    fail(`Git object ${objectId} was requested as both ${previousType} and ${expectedType}`);
  }
  context.expectedTypes.set(objectId, expectedType);
  if (gitObjectAvailable(objectId, expectedType, context.cwd)) {
    return;
  }
  if (context.visiting.has(objectId)) {
    fail(`GitHub Git object graph contains a cycle at ${objectId}`);
  }
  context.objectCount += 1;
  if (context.objectCount > context.maxObjects) {
    fail(`GitHub Git object hydration exceeded ${context.maxObjects} objects`);
  }
  context.visiting.add(objectId);
  try {
    if (expectedType === "blob") {
      const response = exactGithubGitResponse(
        context.fetchJson(`repos/${repo}/git/blobs/${objectId}`),
        objectId,
        "blob",
      );
      const bytes = decodeGithubBlob(response, objectId, context);
      writeExactGitObject("blob", bytes, objectId, context.cwd);
    } else if (expectedType === "tree") {
      const response = exactGithubGitResponse(
        context.fetchJson(`repos/${repo}/git/trees/${objectId}`),
        objectId,
        "tree",
      );
      const { bytes, entries } = githubTreeBytes(response, objectId, context);
      for (const entry of entries) {
        if (entry.type === "commit") {
          gitObjectAvailable(entry.objectId, "commit", context.cwd);
        } else {
          hydrateExactGithubGitObject(entry.objectId, entry.type, context);
        }
      }
      writeExactGitObject("tree", bytes, objectId, context.cwd);
    } else if (expectedType === "commit") {
      const response = exactGithubGitResponse(
        context.fetchJson(`repos/${repo}/git/commits/${objectId}`),
        objectId,
        "commit",
      );
      const { bytes, parentObjectIds, treeObjectId } = githubSignedCommitBytes(response, objectId);
      for (const parentObjectId of parentObjectIds) {
        hydrateExactGithubGitObject(parentObjectId, "commit", context);
      }
      hydrateExactGithubGitObject(treeObjectId, "tree", context);
      writeExactGitObject("commit", bytes, objectId, context.cwd);
    } else {
      fail(`unsupported GitHub Git object type: ${expectedType}`);
    }
  } finally {
    context.visiting.delete(objectId);
  }
  if (!gitObjectAvailable(objectId, expectedType, context.cwd)) {
    fail(`could not hydrate exact Git ${expectedType} ${objectId}`);
  }
}

function gitCommitAvailable(commit, cwd) {
  return gitObjectAvailable(exactGitObjectId(commit, "commit"), "commit", cwd);
}

export function hydrateExactGitCommits(
  commits,
  {
    cwd = process.cwd(),
    fetchJson = (path) => githubApi([path]),
    maxObjects = githubGitObjectLimit,
  } = {},
) {
  if (
    !Array.isArray(commits) ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects <= 0 ||
    maxObjects > githubGitObjectLimit
  ) {
    fail(
      `Git commit hydration requires a commit list and an object limit of 1-${githubGitObjectLimit}`,
    );
  }
  const missing = [...new Set(commits)]
    .map((commit) => exactGitObjectId(commit, "commit"))
    .filter((commit) => !gitCommitAvailable(commit, cwd))
    .toSorted();
  const context = {
    blobBytes: 0,
    cwd,
    expectedTypes: new Map(),
    fetchJson,
    maxObjects,
    objectCount: 0,
    treeEntries: 0,
    visiting: new Set(),
  };
  for (let index = 0; index < missing.length; index += 50) {
    const chunk = missing.slice(index, index + 50);
    const result = spawnSync("git", ["fetch", "--quiet", "--no-tags", "origin", ...chunk], {
      cwd,
      encoding: "utf8",
      env: canonicalGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const unavailable = chunk.filter((commit) => !gitCommitAvailable(commit, cwd));
    // GitHub retains authenticated Git database objects after refs stop advertising them.
    // Rebuild only exact hash-verified objects so historical signed provenance remains replayable.
    for (const commit of unavailable) {
      hydrateExactGithubGitObject(commit, "commit", context);
    }
    const stillUnavailable = chunk.filter((commit) => !gitCommitAvailable(commit, cwd));
    if (stillUnavailable.length > 0) {
      fail(
        `could not hydrate immutable Git commits ${stillUnavailable.join(", ")}: ${
          result.stderr?.trim() || result.signal || result.status
        }`,
      );
    }
  }
}

export function resolveAssociatedPullRequests(
  commitHashes,
  targetTimestamp,
  allowExactMergeCommit = true,
  { fetchPage = graphql } = {},
) {
  const states = new Map(
    commitHashes.map((commit) => [
      commit,
      {
        all: [],
        expectedCount: undefined,
        included: [],
        seenCursors: new Set(),
        seenNumbers: new Set(),
      },
    ]),
  );
  const pending = [];
  function appendPage(commit, connection) {
    const state = states.get(commit);
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !Number.isInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      typeof connection.pageInfo?.hasNextPage !== "boolean" ||
      (connection.pageInfo.hasNextPage &&
        (typeof connection.pageInfo.endCursor !== "string" ||
          connection.pageInfo.endCursor.length === 0))
    ) {
      fail(`GitHub did not return a complete associatedPullRequests connection for ${commit}`);
    }
    if (state.expectedCount !== undefined && state.expectedCount !== connection.totalCount) {
      fail(`GitHub associatedPullRequests totalCount changed for commit ${commit}`);
    }
    state.expectedCount = connection.totalCount;
    for (const pullRequest of connection.nodes) {
      const hasMergedAt = Object.hasOwn(pullRequest ?? {}, "mergedAt");
      const hasMergeCommit = Object.hasOwn(pullRequest ?? {}, "mergeCommit");
      const mergedAt =
        typeof pullRequest?.mergedAt === "string"
          ? Date.parse(pullRequest.mergedAt)
          : pullRequest?.mergedAt === null
            ? undefined
            : Number.NaN;
      const mergeCommit = pullRequest?.mergeCommit;
      if (
        !Number.isInteger(pullRequest?.number) ||
        pullRequest.number <= 0 ||
        !hasMergedAt ||
        !hasMergeCommit ||
        (pullRequest.mergedAt !== null && !Number.isFinite(mergedAt)) ||
        (mergeCommit !== null &&
          (typeof mergeCommit !== "object" ||
            typeof mergeCommit.oid !== "string" ||
            !/^[0-9a-f]{40}$/.test(mergeCommit.oid)))
      ) {
        fail(`GitHub returned an invalid associated pull request for commit ${commit}`);
      }
      if (state.seenNumbers.has(pullRequest.number)) {
        fail(`GitHub associatedPullRequests returned a duplicate member for commit ${commit}`);
      }
      state.seenNumbers.add(pullRequest.number);
      state.all.push(pullRequest.number);
      const exactMerge = allowExactMergeCommit && pullRequest.mergeCommit?.oid === commit;
      if (exactMerge && mergedAt > targetTimestamp + 1_000) {
        fail(`exact merge association for commit ${commit} was merged after the release target`);
      }
      if (
        Number.isFinite(mergedAt) &&
        (mergedAt <= targetTimestamp || (exactMerge && mergedAt <= targetTimestamp + 1_000))
      ) {
        state.included.push(pullRequest.number);
      }
    }
    if (connection.pageInfo.hasNextPage) {
      const cursor = connection.pageInfo.endCursor;
      if (state.seenCursors.has(cursor)) {
        fail(`GitHub associatedPullRequests repeated cursor ${cursor} for commit ${commit}`);
      }
      state.seenCursors.add(cursor);
      pending.push({ commit, cursor });
    }
  }
  function queryFor(items) {
    return `query { ${items
      .map(
        (item, index) =>
          `c${index}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(item.commit)}) {
              ... on Commit {
                associatedPullRequests(first: 100${
                  item.cursor ? `, after: ${JSON.stringify(item.cursor)}` : ""
                }) {
                  totalCount
                  nodes { number mergedAt mergeCommit { oid } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
      )
      .join("\n")} }`;
  }
  for (let index = 0; index < commitHashes.length; index += commitAssociationQueryBatchSize) {
    const items = commitHashes
      .slice(index, index + commitAssociationQueryBatchSize)
      .map((commit) => ({ commit }));
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      appendPage(items[offset].commit, data?.[`c${offset}`]?.object?.associatedPullRequests);
    }
  }
  while (pending.length > 0) {
    const items = pending.splice(0, 20);
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      appendPage(items[offset].commit, data?.[`c${offset}`]?.object?.associatedPullRequests);
    }
  }
  for (const [commit, state] of states) {
    if (state.seenNumbers.size !== state.expectedCount) {
      fail(
        `GitHub associatedPullRequests did not return ${state.expectedCount} complete unique members for commit ${commit}`,
      );
    }
  }
  return {
    allPullRequests: new Map(
      [...states].map(([commit, state]) => [
        commit,
        state.all.toSorted((left, right) => left - right),
      ]),
    ),
    pullRequests: new Map(
      [...states].map(([commit, state]) => [
        commit,
        state.included.toSorted((left, right) => left - right),
      ]),
    ),
    unresolved: [],
  };
}

function issueConnectionName(node) {
  if (node?.__typename === "Issue") {
    return "closedByPullRequestsReferences";
  }
  if (node?.__typename === "PullRequest") {
    return "closingIssuesReferences";
  }
  return undefined;
}

export function resolveIssueRelationshipPages(nodes, { fetchPage = graphql } = {}) {
  const states = new Map();
  const pending = [];

  function appendPage(number, connection) {
    const state = states.get(number);
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !Number.isInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      typeof connection.pageInfo?.hasNextPage !== "boolean" ||
      (connection.pageInfo.hasNextPage &&
        (typeof connection.pageInfo.endCursor !== "string" ||
          connection.pageInfo.endCursor.length === 0))
    ) {
      fail(`GitHub did not return a complete ${state.connectionName} connection for #${number}`);
    }
    if (state.expectedCount !== undefined && state.expectedCount !== connection.totalCount) {
      fail(`GitHub ${state.connectionName} totalCount changed for #${number}`);
    }
    state.expectedCount = connection.totalCount;
    for (const member of connection.nodes) {
      if (!Number.isInteger(member?.number) || member.number <= 0) {
        fail(`GitHub returned an invalid ${state.connectionName} member for #${number}`);
      }
      if (state.seenNumbers.has(member.number)) {
        fail(`GitHub ${state.connectionName} returned a duplicate member for #${number}`);
      }
      state.seenNumbers.add(member.number);
      state.members.push(member);
    }
    if (state.seenNumbers.size > state.expectedCount) {
      fail(`GitHub ${state.connectionName} returned more members than totalCount for #${number}`);
    }
    if (connection.pageInfo.hasNextPage) {
      const cursor = connection.pageInfo.endCursor;
      if (state.seenCursors.has(cursor)) {
        fail(`GitHub ${state.connectionName} repeated cursor ${cursor} for #${number}`);
      }
      state.seenCursors.add(cursor);
      pending.push({
        connectionName: state.connectionName,
        cursor,
        number,
        type: state.type,
      });
    }
  }

  for (const [number, node] of nodes) {
    const connectionName = issueConnectionName(node);
    if (!connectionName || node.number !== number) {
      fail(`GitHub returned an invalid issue or pull request for #${number}`);
    }
    states.set(number, {
      connectionName,
      expectedCount: undefined,
      members: [],
      seenCursors: new Set(),
      seenNumbers: new Set(),
      type: node.__typename,
    });
    appendPage(number, node[connectionName]);
  }

  while (pending.length > 0) {
    const chunk = pending.splice(0, 20);
    const fields = chunk
      .map((item, offset) => {
        const connection = `${item.connectionName}(first: 100, after: ${JSON.stringify(item.cursor)}) {
          totalCount
          nodes { number }
          pageInfo { hasNextPage endCursor }
        }`;
        return `n${offset}: repository(owner: "openclaw", name: "openclaw") {
          issueOrPullRequest(number: ${item.number}) {
            ... on ${item.type} {
              number
              ${connection}
            }
          }
        }`;
      })
      .join("\n");
    const data = fetchPage(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const item = chunk[offset];
      const alias = data?.[`n${offset}`];
      const pageNode = alias?.issueOrPullRequest;
      if (
        !alias ||
        !Object.hasOwn(alias, "issueOrPullRequest") ||
        !pageNode ||
        pageNode.number !== item.number
      ) {
        fail(`GitHub did not return issue or pull request #${item.number} while paginating`);
      }
      appendPage(item.number, pageNode[item.connectionName]);
    }
  }

  for (const [number, state] of states) {
    if (state.seenNumbers.size !== state.expectedCount) {
      fail(
        `GitHub ${state.connectionName} did not return ${state.expectedCount} complete unique members for #${number}`,
      );
    }
    nodes.get(number)[state.connectionName] = {
      nodes: state.members,
      pageInfo: { endCursor: null, hasNextPage: false },
      totalCount: state.expectedCount,
    };
  }
  return nodes;
}

function resolveReferences(numbers) {
  const nodes = new Map();
  for (let index = 0; index < numbers.length; index += 40) {
    const chunk = numbers.slice(index, index + 40);
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
                totalCount
                nodes { number }
                pageInfo { hasNextPage endCursor }
              }
            }
            ... on PullRequest {
              number
              title
              mergedAt
              mergeCommit { oid }
              author { __typename login }
              closingIssuesReferences(first: 100) {
                totalCount
                nodes { number }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
      )
      .join("\n");
    const data = graphql(`query { ${fields} }`);
    for (const number of chunk) {
      const alias = data?.[`n${number}`];
      if (!alias || !Object.hasOwn(alias, "issueOrPullRequest")) {
        fail(`GitHub did not return an issueOrPullRequest result for #${number}`);
      }
      const node = alias.issueOrPullRequest;
      if (node) {
        nodes.set(number, node);
      }
    }
  }
  return resolveIssueRelationshipPages(nodes);
}

function unresolvedRelationshipMembers(nodes, sourceNumbers, connectionName) {
  const unresolved = [];
  for (const sourceNumber of sourceNumbers) {
    const node = nodes.get(sourceNumber);
    for (const member of node?.[connectionName]?.nodes ?? []) {
      if (!nodes.has(member.number)) {
        unresolved.push({
          connectionName,
          member: member.number,
          source: sourceNumber,
        });
      }
    }
  }
  return unresolved;
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
    const data = graphql(`query { ${fields} }`);
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
    const data = graphql(`query { ${fields} }`);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const author = data[`c${index + offset}`]?.object?.author?.user;
      if (author?.login && isEligibleHandle(author.login)) {
        resolved.set(chunk[offset].hash, author.login);
      }
    }
  }
  return resolved;
}

export function resolveCommitCoauthors(commits, { fetchPage = graphql } = {}) {
  const commitsWithCoauthors = commits.filter((commit) => commit.coauthorEmails.length > 0);
  const states = new Map(
    commitsWithCoauthors.map((commit) => [
      commit.hash,
      {
        coauthorEmails: new Set(commit.coauthorEmails.map((email) => email.toLowerCase())),
        expectedCount: undefined,
        handles: [],
        seenCursors: new Set(),
        seenMembers: new Set(),
      },
    ]),
  );
  const pending = [];

  function appendPage(commit, connection) {
    const state = states.get(commit);
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !Number.isInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      typeof connection.pageInfo?.hasNextPage !== "boolean" ||
      (connection.pageInfo.hasNextPage &&
        (typeof connection.pageInfo.endCursor !== "string" ||
          connection.pageInfo.endCursor.length === 0))
    ) {
      fail(`GitHub did not return a complete authors connection for commit ${commit}`);
    }
    if (state.expectedCount !== undefined && state.expectedCount !== connection.totalCount) {
      fail(`GitHub authors totalCount changed for commit ${commit}`);
    }
    state.expectedCount = connection.totalCount;
    for (const author of connection.nodes) {
      if (
        typeof author?.email !== "string" ||
        (author.user !== null &&
          (typeof author.user !== "object" || typeof author.user.login !== "string"))
      ) {
        fail(`GitHub returned an invalid author for commit ${commit}`);
      }
      const memberKey = JSON.stringify({
        email: author.email.toLowerCase(),
        login: author.user?.login?.toLowerCase() ?? null,
      });
      if (state.seenMembers.has(memberKey)) {
        fail(`GitHub authors returned a duplicate member for commit ${commit}`);
      }
      state.seenMembers.add(memberKey);
      if (
        state.coauthorEmails.has(author.email.toLowerCase()) &&
        isEligibleHandle(author.user?.login)
      ) {
        addHandles(state.handles, [author.user.login]);
      }
    }
    if (state.seenMembers.size > state.expectedCount) {
      fail(`GitHub authors returned more members than totalCount for commit ${commit}`);
    }
    if (connection.pageInfo.hasNextPage) {
      const cursor = connection.pageInfo.endCursor;
      if (state.seenCursors.has(cursor)) {
        fail(`GitHub authors repeated cursor ${cursor} for commit ${commit}`);
      }
      state.seenCursors.add(cursor);
      pending.push({ commit, cursor });
    }
  }

  function queryFor(items) {
    return `query { ${items
      .map(
        (item, offset) =>
          `c${offset}: repository(owner: "openclaw", name: "openclaw") {
            object(expression: ${JSON.stringify(item.commit)}) {
              ... on Commit {
                authors(first: 100${item.cursor ? `, after: ${JSON.stringify(item.cursor)}` : ""}) {
                  totalCount
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
      .join("\n")} }`;
  }

  for (let index = 0; index < commitsWithCoauthors.length; index += 40) {
    const items = commitsWithCoauthors.slice(index, index + 40).map((commit) => ({
      commit: commit.hash,
    }));
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      appendPage(items[offset].commit, data?.[`c${offset}`]?.object?.authors);
    }
  }
  while (pending.length > 0) {
    const items = pending.splice(0, 20);
    const data = fetchPage(queryFor(items));
    for (let offset = 0; offset < items.length; offset += 1) {
      appendPage(items[offset].commit, data?.[`c${offset}`]?.object?.authors);
    }
  }
  for (const [commit, state] of states) {
    if (state.seenMembers.size !== state.expectedCount) {
      fail(
        `GitHub authors did not return ${state.expectedCount} complete unique members for commit ${commit}`,
      );
    }
  }
  return new Map([...states].map(([commit, state]) => [commit, state.handles]));
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
  for (const handle of coauthorHandles) {
    if (!handles.some((candidate) => candidate.toLowerCase() === handle.toLowerCase())) {
      handles.push(handle);
    }
  }
  return handles;
}

function addHandles(handles, additions) {
  for (const handle of additions) {
    if (!isEligibleHandle(handle)) {
      continue;
    }
    if (!handles.some((candidate) => candidate.toLowerCase() === handle.toLowerCase())) {
      handles.push(handle);
    }
  }
  return handles;
}

function titleReferences(entries) {
  return [...new Set(entries.flatMap((entry) => referencesIn(entry.title)))];
}

function releaseTitle(title) {
  return title;
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

function completeEditorialCredits(prose, pullRequests, directCommits) {
  const pullRequestsByNumber = new Map(
    pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  return prose
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- ")) {
        return line;
      }
      const contributors = [];
      for (const number of referencesIn(line)) {
        addHandles(contributors, pullRequestsByNumber.get(number)?.thanks ?? []);
      }
      addHandles(contributors, directCommitCreditsForLine(line, directCommits));
      if (contributors.length === 0) {
        return line;
      }
      const existingContributors = handlesIn(line);
      addHandles(existingContributors, contributors);
      const thanksStart = line.lastIndexOf(" Thanks ");
      const rawContent = thanksStart >= 0 ? line.slice(0, thanksStart) : line;
      const content =
        referencesIn(rawContent).length === 0
          ? withSentenceEnding(rawContent)
          : rawContent.replace(/[.!?]$/, "");
      return `${content} Thanks ${formatThanks(existingContributors)}.`;
    })
    .join("\n");
}

function issueEntries(numbers, nodes, priorIssues = new Map()) {
  return [...new Set(numbers)]
    .map((number) => {
      const node = nodes.get(number);
      if (node?.__typename !== "Issue") {
        return undefined;
      }
      const thanks = thanksFor(node, []);
      addHandles(thanks, priorIssues.get(number)?.thanks ?? []);
      return {
        number,
        thanks,
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
  for (const commit of source.activeCommits) {
    const pullRequests = commit.pullRequests;
    const issues = issueEntries(commit.closingReferences, nodes);
    if (commit.manifestDirect) {
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
    }
    if (pullRequests.length === 0 || issues.length === 0) {
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
  coauthorsByReference,
  resolvedHandles,
  relationships,
  priorRecord,
  sourcePullRequests,
  revertedReferences,
  shippedBaselines,
  targetTimestamp,
) {
  const entries = references.map((number) => {
    const node = nodes.get(number);
    const rawCoauthors = coauthorsByReference.get(number) ?? new Set();
    const coauthors = [...rawCoauthors]
      .map((handle) => resolvedHandles.get(handle.toLowerCase()))
      .filter(Boolean);
    return {
      number,
      title: releaseTitle(node.title.replace(/\s+/g, " ").trim()),
      type: node.__typename,
      mergedAt: node.mergedAt,
      closingIssuesReferences: node.closingIssuesReferences,
      thanks: thanksFor(node, coauthors),
    };
  });

  const recordedPullRequests = new Set([...sourcePullRequests, ...priorRecord.pullRequests.keys()]);
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
      issueEntries(legacyIssues.get(entry.number) ?? [], nodes, priorRecord.legacyIssues),
    );
    const thanks = [...entry.thanks];
    addHandles(thanks, priorEntry?.thanks ?? []);
    for (const issue of linkedIssues) {
      addHandles(thanks, issue.thanks);
    }
    return {
      ...entry,
      ...editorialClassification(entry.title),
      externalReferences: priorEntry?.externalReferences ?? [],
      linkedIssues,
      priorReferences,
      thanks,
    };
  });
  const shippedBaselineLine = formatShippedBaselineExclusions(shippedBaselines);
  const ledger = [
    "### Complete contribution record",
    "",
    `This audited record covers the complete ${base}..${target} history: ${records.length} merged PRs. The generation manifest also supplies direct commits as editorial input; the grouped notes above prioritize user impact.`,
    ...(shippedBaselineLine ? ["", shippedBaselineLine] : []),
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
    titleReferences: titleReferences(records),
  };
}

function replaceLedger(changelog, section, ledger, pullRequests, directCommits) {
  const beforeLedger = completeEditorialCredits(
    sourceBeforeContributionRecord(section.source, "release section"),
    pullRequests,
    directCommits,
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
  return count >= 5 && count <= 8
    ? undefined
    : `### Highlights must contain 5-8 top-level bullets; found ${count}`;
}

export function ledgerChecks(
  section,
  pullRequests,
  nodes,
  directCommits,
  shippedBaselines = [],
  expectedRange,
) {
  const errors = [];
  let sectionReferences = referencesIn(section.source);
  if (/@undefined\b/i.test(section.source)) {
    errors.push("release section contains invalid @undefined contributor credit");
  }
  const highlightsHeadings = exactHeadingMatches(section.source, "### Highlights");
  if (highlightsHeadings.length === 0) {
    errors.push("missing ### Highlights");
  } else if (highlightsHeadings.length !== 1) {
    errors.push(`### Highlights must appear exactly once; found ${highlightsHeadings.length}`);
  } else {
    const error = highlightCountError(section.source);
    if (error) {
      errors.push(error);
    }
  }
  const changesHeadings = exactHeadingMatches(section.source, "### Changes");
  if (changesHeadings.length === 0) {
    errors.push("missing ### Changes");
  } else if (changesHeadings.length !== 1) {
    errors.push(`### Changes must appear exactly once; found ${changesHeadings.length}`);
  }
  const fixesHeadings = exactHeadingMatches(section.source, "### Fixes");
  if (fixesHeadings.length === 0) {
    errors.push("missing ### Fixes");
  } else if (fixesHeadings.length !== 1) {
    errors.push(`### Fixes must appear exactly once; found ${fixesHeadings.length}`);
  }
  const recordHeadings = exactHeadingMatches(section.source, "### Complete contribution record");
  if (recordHeadings.length === 0) {
    errors.push("missing ### Complete contribution record");
    return errors;
  }
  const ledgerStart = recordHeadings[0].index;
  const ledger = section.source.slice(ledgerStart);
  let exactRecord;
  if (!expectedRange) {
    errors.push("release section expected contribution record range is missing");
  }
  try {
    exactRecord = completeContributionRecord(section, "release section", expectedRange);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (exactRecord && exactRecord.rows.size !== pullRequests.length) {
    errors.push(
      `release section contribution record contains ${exactRecord.rows.size} PR rows but expected ${pullRequests.length}`,
    );
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
    const line =
      exactRecord?.rows.get(entry.number) ??
      ledger.split("\n").find((candidate) => candidate.startsWith(`- **PR #${entry.number}**`));
    if (!line) {
      errors.push(`missing contribution record for PR #${entry.number}`);
      continue;
    }
    for (const handle of entry.thanks) {
      if (!creditsHandle(line, handle)) {
        errors.push(`missing Thanks @${handle} for #${entry.number}`);
      }
    }
    const expectedReferences = [];
    appendUnique(expectedReferences, referenceLabelsIn(entry.title));
    appendUnique(
      expectedReferences,
      entry.priorReferences.map((number) => `#${number}`),
    );
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
  for (const entry of pullRequests) {
    if (
      !entry.editorialEligible &&
      new RegExp(`(?<![A-Za-z0-9_./-])#${entry.number}\\b`).test(editorialProse)
    ) {
      errors.push(
        `editorial release prose references non-editorial ${entry.type} PR #${entry.number} (${entry.type})`,
      );
    }
  }
  const editorialLines = editorialProse.split("\n");
  for (const entry of pullRequests) {
    for (const line of editorialLines) {
      if (
        !new RegExp(`(?<![A-Za-z0-9_./-])#${entry.number}\\b`).test(line) ||
        !line.startsWith("- ")
      ) {
        continue;
      }
      for (const handle of entry.thanks) {
        if (!creditsHandle(line, handle)) {
          errors.push(`missing editorial Thanks @${handle} for PR #${entry.number}`);
        }
      }
    }
  }
  for (const line of editorialLines) {
    if (!line.startsWith("- ")) {
      continue;
    }
    for (const handle of directCommitCreditsForLine(line, directCommits)) {
      if (!creditsHandle(line, handle)) {
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
        (line) => referencesIn(line).includes(number) && creditsHandle(line, handle),
      );
      if (!credited) {
        errors.push(`missing Thanks @${handle} for issue #${number}`);
      }
    }
  }
  return errors;
}

function summarizedNumbers(numbers) {
  const members = [...new Set(numbers)].toSorted((left, right) => left - right);
  return {
    count: members.length,
    members,
    sha256: createHash("sha256")
      .update(members.map((number) => `${number}\n`).join(""))
      .digest("hex"),
  };
}

function summarizedRecords(records) {
  const serialized = records.map((record) => JSON.stringify(record)).toSorted();
  if (new Set(serialized).size !== serialized.length) {
    fail("release reconciliation evidence records contain duplicates");
  }
  return {
    count: serialized.length,
    records: serialized.map((record) => JSON.parse(record)),
    sha256: createHash("sha256")
      .update(serialized.map((record) => `${record}\n`).join(""))
      .digest("hex"),
  };
}

function summarizedReferenceEntries(entries) {
  const records = entries
    .map(({ number, type }) => ({ number, type }))
    .toSorted((left, right) => left.number - right.number);
  const serialized = records.map((record) => JSON.stringify(record));
  if (
    new Set(serialized).size !== serialized.length ||
    records.some(
      (record) =>
        !Number.isInteger(record.number) ||
        record.number <= 0 ||
        (record.type !== "Issue" && record.type !== "PullRequest"),
    )
  ) {
    fail("release reference entries contain invalid or duplicate records");
  }
  return {
    count: records.length,
    records,
    sha256: createHash("sha256")
      .update(serialized.map((record) => `${record}\n`).join(""))
      .digest("hex"),
  };
}

function targetCommitsForPullRequest(source, number) {
  return source.inventory.commits
    .filter((commit) => commit.pullRequests.includes(number))
    .map((commit) => commit.commit)
    .toSorted();
}

export function ledgerReconciliationFor(
  source,
  renderedRecord,
  generatedPullRequests = [],
  allowedHistoricalPullRequests = [],
  nodes = new Map(),
) {
  const canonical = new Set(source.inventory.partitions.pullRequests.included.members);
  const current = new Set(renderedRecord.pullRequests.keys());
  const generated = new Set(generatedPullRequests);
  const allowedHistorical = new Set(allowedHistoricalPullRequests);
  const missing = [...canonical].filter((number) => !current.has(number));
  const stale = [...current].filter((number) => !canonical.has(number));
  const generatedMissing = [...canonical].filter((number) => !generated.has(number));
  const generatedUnexpected = [...generated].filter(
    (number) => !canonical.has(number) && !allowedHistorical.has(number),
  );
  const missingRowEvidence = missing.map((number) => ({
    number,
    reason: "canonical-source-row-missing-from-current-record",
    targetCommits: targetCommitsForPullRequest(source, number),
  }));
  const staleRowEvidence = stale.map((number) => {
    const node = nodes.get(number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? new Date(node.mergedAt).toISOString()
        : undefined;
    const mergedTimestamp = mergedAt ? Date.parse(mergedAt) : Number.NaN;
    const sourceContextCommits = source.inventory.commits
      .filter((commit) => commit.references.includes(number))
      .map((commit) => commit.commit)
      .toSorted();
    const crossRepositoryReferences = [
      ...new Set(
        source.inventory.commits.flatMap((commit) =>
          referenceLabelsIn(`${commit.subject}\n${commit.body}`).filter(
            (reference) =>
              !reference.startsWith("#") &&
              reference.endsWith(`#${number}`) &&
              !reference.toLowerCase().startsWith(`${repo}#`),
          ),
        ),
      ),
    ].toSorted();
    const category =
      crossRepositoryReferences.length > 0
        ? "cross-repository-reference-number-collision"
        : sourceContextCommits.length > 0
          ? "historical-context-reference-without-ownership"
          : Number.isFinite(mergedTimestamp) &&
              mergedTimestamp < source.inventory.range.mergeBaseTimestamp
            ? "pre-range-row-without-source-evidence"
            : node?.__typename === "PullRequest"
              ? "pull-request-without-canonical-source-evidence"
              : "non-pull-request-or-unresolved-row";
    return {
      category,
      crossRepositoryReferences,
      mergedAt,
      number,
      recordedReferences: renderedRecord.pullRequests.get(number)?.references ?? [],
      sourceContextCommits,
      title: node?.title,
    };
  });
  return {
    canonicalRows: summarizedNumbers(canonical),
    coverage:
      canonical.size === 0
        ? 1
        : [...canonical].filter((number) => current.has(number)).length / canonical.size,
    currentRows: summarizedNumbers(current),
    equation: `${current.size} - ${stale.length} + ${missing.length} = ${canonical.size}`,
    generatedCoverage:
      canonical.size === 0
        ? 1
        : [...canonical].filter((number) => generated.has(number)).length / canonical.size,
    generatedMissingRows: summarizedNumbers(generatedMissing),
    generatedRows: summarizedNumbers(generated),
    generatedUnexpectedRows: summarizedNumbers(generatedUnexpected),
    missingRowEvidence: summarizedRecords(missingRowEvidence),
    missingRows: summarizedNumbers(missing),
    staleRowEvidence: summarizedRecords(staleRowEvidence),
    staleRows: summarizedNumbers(stale),
  };
}

function manifestFor(
  options,
  source,
  ledger,
  directCommitRecords,
  reconciliation,
  {
    changelogSha256,
    invocation,
    reconciliations,
    releaseSectionSha256,
    seedAuthorization,
    tooling,
  },
) {
  const directCommits = directCommitRecords.map((commit) => ({
    ...editorialClassification(commit.subject),
    commit: commit.hash,
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
  const generatedManifestDirect = {
    count: directCommits.length,
    members: directCommits.map((commit) => commit.commit).toSorted(),
    sha256: createHash("sha256")
      .update(
        directCommits
          .map((commit) => commit.commit)
          .toSorted()
          .map((commit) => `${commit}\n`)
          .join(""),
      )
      .digest("hex"),
  };
  const inventoryManifestDirect = source.inventory.partitions.commits.manifestDirect;
  if (
    generatedManifestDirect.count !== inventoryManifestDirect.count ||
    generatedManifestDirect.sha256 !== inventoryManifestDirect.sha256
  ) {
    fail("generated direct-commit ledger does not match the source inventory");
  }
  const referenceEntries = summarizedReferenceEntries(ledger.entries);
  const manifestPullRequests = ledger.pullRequests.map((entry) => ({
    number: entry.number,
    title: entry.title,
    type: entry.type,
    editorialEligible: entry.editorialEligible,
    thanks: entry.thanks,
    externalReferences: entry.externalReferences,
    relatedReferences: [...new Set([...entry.priorReferences, ...referencesIn(entry.title)])],
    linkedIssues: entry.linkedIssues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      reporter: issue.thanks,
    })),
  }));
  const issueReferenceCount = referenceEntries.records.filter(
    (entry) => entry.type === "Issue",
  ).length;
  const pullRequestReferenceNumbers = new Set(
    referenceEntries.records
      .filter((entry) => entry.type === "PullRequest")
      .map((entry) => entry.number),
  );
  if (
    referenceEntries.count !== ledger.entries.length ||
    issueReferenceCount !== ledger.issues.length ||
    manifestPullRequests.length !== ledger.pullRequests.length ||
    manifestPullRequests.some((entry) => !pullRequestReferenceNumbers.has(entry.number))
  ) {
    fail("release reference entry counts do not match the generated ledger");
  }
  return {
    schemaVersion: 6,
    artifacts: {
      changelogSha256,
      releaseSectionSha256,
    },
    base: options.base,
    finalTarget: source.finalTarget,
    invocation,
    inventory: source.inventory,
    directReconciliation: {
      equation: source.inventory.partitions.directReconciliation.equation,
      exclusiveDirect: source.inventory.partitions.commits.exclusiveDirect,
      generatedManifestDirect,
      inventoryManifestDirect,
      ownershipOverlap: source.inventory.partitions.commits.directOwnershipOverlap,
    },
    reconciliation,
    reconciliations,
    seedAuthorization,
    target: options.target,
    tooling,
    mergeBase: source.mergeBase,
    version: options.version,
    shippedBaselines: source.shippedBaselines,
    source: {
      references: ledger.entries.length,
      referenceEntries,
      pullRequests: ledger.pullRequests.length,
      issues: ledger.issues.length,
      directCommits: directCommits.length,
      unlinkedCommits: unlinkedCommits.length,
    },
    pullRequests: manifestPullRequests,
    directCommits,
    unlinkedCommits,
  };
}

function releaseChecks(changelog, version, releaseTags) {
  const checks = [];
  for (const tag of releaseTags) {
    const release = githubApi([`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
    const verification = verifyGithubReleaseNotes({
      body: release.body ?? "",
      changelog,
      version,
      tag,
      repository: repo,
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (
    options.manifestPath &&
    canonicalFilesystemPath(options.manifestPath) === canonicalFilesystemPath("CHANGELOG.md")
  ) {
    fail("--manifest must not alias CHANGELOG.md");
  }
  const manifestSnapshot = options.manifestPath ? fileSnapshot(options.manifestPath) : undefined;
  const invocation = normalizedInvocation(options);
  let verifiedManifestSnapshot = manifestSnapshot;
  let pendingManifestContent;
  if (options.manifestPath) {
    pendingManifestContent = manifestContent({ invocation, schemaVersion: 6 }, "pending");
    commitOutputTransaction([
      {
        content: pendingManifestContent,
        expected: manifestSnapshot,
        failureSentinel: true,
        path: options.manifestPath,
      },
    ]);
    verifiedManifestSnapshot = contentSnapshot(pendingManifestContent);
  }
  const changelogSnapshot = fileSnapshot("CHANGELOG.md");
  if (!changelogSnapshot.exists) {
    fail("CHANGELOG.md does not exist");
  }
  const tooling = toolingIdentity(options);
  let changelog = changelogSnapshot.bytes.toString("utf8");
  let section = sectionFor(changelog, options.version);
  const source = sourceCommits(options);
  const shippedBaselineRecords = options.shippedRefs.map(shippedBaselineFor);
  const shippedExclusions = exactShippedPullRequestExclusions(source, shippedBaselineRecords);
  source.shippedBaselines = shippedExclusions.baselines;
  const preexistingNotes = sourceBeforeContributionRecord(section.source, "release section");
  const noteReferences = releaseNoteReferences(preexistingNotes, shippedExclusions.baselines);
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
  // A rewrite replaces the generated record wholesale. Validate existing rows only
  // in audit mode so stale rows cannot prevent the command that removes them.
  const effectiveRenderedRecordReferences = options.writeLedger ? [] : renderedRecordReferences;
  let priorRecord = { legacyIssues: new Map(), pullRequests: new Map() };
  let priorRecordTarget;
  let seedAuthorization = null;
  if (options.seedRef) {
    const seedCommit = git(["rev-parse", "--verify", `${options.seedRef}^{commit}`]);
    const seedChangelog = git(["show", `${seedCommit}:CHANGELOG.md`]);
    const seedSection = sectionFor(seedChangelog, options.version);
    const seed = completeContributionRecord(seedSection, `seed ref ${options.seedRef}`);
    if (seed.base !== options.base) {
      fail(
        `seed ref ${options.seedRef} contribution record base mismatch: expected ${options.base}, found ${seed.base}`,
      );
    }
    if (
      !isCommitAncestor(seed.target, seedCommit) ||
      !isCommitAncestor(seed.target, source.target)
    ) {
      fail(
        `seed ref ${options.seedRef} contribution target ${seed.target} is not an ancestor of both the seed and current source target`,
      );
    }
    const targetTimestamp = Number(git(["show", "-s", "--format=%ct", `${seed.target}^{commit}`]));
    if (!Number.isSafeInteger(targetTimestamp) || targetTimestamp < 0) {
      fail(`seed ref ${options.seedRef} has an invalid contribution target timestamp`);
    }
    priorRecordTarget = {
      commit: seed.target,
      timestamp: targetTimestamp * 1_000,
    };
    priorRecord = seed.record;
    seedAuthorization = {
      commit: seedCommit,
      ref: options.seedRef,
      releaseSectionSha256: sha256(seedSection.source),
      target: seed.target,
    };
  }
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
  const references = [...source.references];
  appendReferences(references, noteReferences);
  appendReferences(references, effectiveRenderedRecordReferences);
  appendReferences(references, recordedReferences);
  let nodes = resolveReferences(references);
  const contamination = contaminatingPullRequestReferences({
    noteReferences,
    recordedReferences: effectiveRenderedRecordReferences,
    sourcePullRequests: source.pullRequests,
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
  const legacyIssuePullRequests = [...legacyIssuesByPullRequest(priorRecord, nodes).keys()].filter(
    (number) => !shippedExclusions.pullRequests.has(number),
  );
  appendReferences(references, legacyIssuePullRequests);
  nodes = resolveReferences(references);
  const unresolvedSourceReferences = references.filter((number) => !nodes.has(number));
  if (unresolvedSourceReferences.length > 0) {
    fail(
      `GitHub could not resolve source references: ${unresolvedSourceReferences
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
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
  nodes = resolveReferences(resolvedReferences);
  const relationshipDrift = [
    ...unresolvedRelationshipMembers(
      nodes,
      references.filter((number) => nodes.get(number)?.__typename === "PullRequest"),
      "closingIssuesReferences",
    ),
    ...unresolvedRelationshipMembers(
      nodes,
      priorRecord.legacyIssues.keys(),
      "closedByPullRequestsReferences",
    ),
  ];
  if (relationshipDrift.length > 0) {
    fail(
      `GitHub relationships changed while resolving release references: ${relationshipDrift
        .map(
          (entry) =>
            `#${entry.source} ${entry.connectionName} now includes unresolved #${entry.member}`,
        )
        .join(", ")}; rerun the verifier`,
    );
  }
  const invalidRecordedPullRequests = [...priorRecord.pullRequests.keys()].filter((number) => {
    const node = nodes.get(number);
    return (
      node?.__typename !== "PullRequest" ||
      !node.mergedAt ||
      !priorRecordTarget ||
      !pullRequestMergedByTarget(node, priorRecordTarget.commit, priorRecordTarget.timestamp)
    );
  });
  if (invalidRecordedPullRequests.length > 0) {
    fail(
      `seed contribution record contains unresolved PRs or PRs merged after its claimed target: ${invalidRecordedPullRequests
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const unresolvedTitleReferences = titleReferenceNumbers.filter((number) => !nodes.has(number));
  if (unresolvedTitleReferences.length > 0) {
    fail(
      `GitHub could not resolve PR-title references: ${unresolvedTitleReferences
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
    resolvedReferences,
    nodes,
    source.coauthorsByReference,
    resolvedHandles,
    relationships,
    priorRecord,
    source.pullRequests,
    source.revertedReferences,
    source.shippedBaselines,
    source.targetTimestamp,
  );
  let candidateChangelog = changelog;
  let candidateSection = section;
  if (options.writeLedger) {
    candidateChangelog = replaceLedger(
      changelog,
      section,
      ledger.ledger,
      ledger.pullRequests,
      relationships.directCommits,
    );
    candidateSection = sectionFor(candidateChangelog, options.version);
  }
  const afterWriteRecord = options.writeLedger
    ? completeContributionRecord(candidateSection, "generated release section", {
        base: options.base,
        target: source.target,
      }).record
    : renderedRecord;
  const generatedPullRequests = ledger.pullRequests.map((entry) => entry.number);
  const allowedHistoricalPullRequests = [...priorRecord.pullRequests.keys()];
  const staleRenderedPullRequests = [
    ...new Set(
      [renderedRecord, afterWriteRecord].flatMap((record) =>
        [...record.pullRequests.keys()].filter((number) => !source.pullRequests.has(number)),
      ),
    ),
  ];
  const staleNodes =
    staleRenderedPullRequests.length === 0
      ? new Map()
      : resolveReferences(staleRenderedPullRequests);
  const reconciliationNodes = new Map([...nodes, ...staleNodes]);
  const beforeWriteReconciliation = ledgerReconciliationFor(
    source,
    renderedRecord,
    generatedPullRequests,
    allowedHistoricalPullRequests,
    reconciliationNodes,
  );
  const afterWriteReconciliation = ledgerReconciliationFor(
    source,
    afterWriteRecord,
    generatedPullRequests,
    allowedHistoricalPullRequests,
    reconciliationNodes,
  );
  const reconciliations = {
    afterWrite: afterWriteReconciliation,
    beforeWrite: beforeWriteReconciliation,
  };
  const reconciliation = afterWriteReconciliation;
  const manifest = manifestFor(
    { ...options, target: source.target },
    source,
    ledger,
    relationships.directCommits,
    reconciliation,
    {
      changelogSha256: sha256(candidateChangelog),
      invocation,
      reconciliations,
      releaseSectionSha256: sha256(candidateSection.source),
      seedAuthorization,
      tooling,
    },
  );

  const errors = ledgerChecks(
    candidateSection,
    ledger.pullRequests,
    nodes,
    relationships.directCommits,
    source.shippedBaselines,
    { base: options.base, target: source.target },
  );
  if (reconciliation.generatedMissingRows.count > 0) {
    errors.push(
      `generated contribution record is missing canonical PRs: ${reconciliation.generatedMissingRows.members
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  if (reconciliation.generatedUnexpectedRows.count > 0) {
    errors.push(
      `generated contribution record contains non-canonical PRs outside --seed-ref: ${reconciliation.generatedUnexpectedRows.members
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  const github = options.checkGithub
    ? releaseChecks(candidateChangelog, options.version, options.releaseTags)
    : [];
  for (const check of github) {
    if (!check.matches) {
      errors.push(
        `GitHub release ${check.tag} does not match the ${options.version} CHANGELOG section`,
      );
    }
  }
  const writeVerifiedLedger = options.writeLedger && errors.length === 0;
  const outputs = [];
  // The pending marker makes either crash point non-pass. The final manifest
  // is committed only after the candidate changelog bytes are in place.
  if (writeVerifiedLedger && options.manifestPath) {
    outputs.push({
      content: pendingManifestContent,
      expected: verifiedManifestSnapshot,
      failureSentinel: true,
      path: options.manifestPath,
    });
  }
  if (writeVerifiedLedger) {
    outputs.push({
      content: candidateChangelog,
      expected: changelogSnapshot,
      path: "CHANGELOG.md",
    });
  }
  if (options.manifestPath) {
    outputs.push({
      content: manifestContent(manifest, errors.length === 0 ? "pass" : "fail"),
      ...(writeVerifiedLedger
        ? { replacesPrevious: true }
        : { expected: verifiedManifestSnapshot }),
      path: options.manifestPath,
    });
  }
  commitOutputTransaction(outputs, {
    guards: writeVerifiedLedger ? [] : [{ expected: changelogSnapshot, path: "CHANGELOG.md" }],
  });
  if (writeVerifiedLedger) {
    changelog = candidateChangelog;
    section = candidateSection;
  }

  const result = {
    base: options.base,
    finalTarget: source.finalTarget,
    inventorySha256: source.inventory.sha256,
    target: source.target,
    mergeBase: source.mergeBase,
    version: options.version,
    shippedBaselines: source.shippedBaselines,
    source: {
      references: ledger.entries.length,
      pullRequests: ledger.pullRequests.length,
      issues: ledger.issues.length,
      directCommits: manifest.directCommits.length,
      unlinkedCommits: manifest.unlinkedCommits.length,
    },
    github,
    reconciliation,
    reconciliations,
    errors,
    toolingSha256: tooling.aggregateSha256,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${options.version}: ${ledger.pullRequests.length} PRs, ${ledger.issues.length} issues, ${errors.length === 0 ? "verified" : `${errors.length} errors`}\n`,
    );
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
