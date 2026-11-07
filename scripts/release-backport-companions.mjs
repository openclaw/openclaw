#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { basename, dirname, extname } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SCHEMA = "openclaw.release-backport-companions.v1";
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const MANUAL_CHECKS = [
  "Trace consumer, producer, imports/exports, generated inputs, lifecycle, workflow, fixture, and planner contracts; path/name heuristics are not dependency closure.",
  "Inspect differently named and cross-directory tests; neighbor-test names do not prove behavioral coverage.",
  "Inspect selected and candidate diffs when a candidate blob differs; an intentional adaptation still needs an evidenced disposition.",
  "Resolve original PRs manually when commit messages do not carry a usable PR number, and search follow-ups that omit that number.",
];

function git(args, { allowEmpty = false } = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    if (allowEmpty && result.status === 1) {
      return "";
    }
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function resolveCommit(ref, label) {
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error(`${label} did not resolve to an exact commit`);
  }
  return sha;
}

function assertAncestor(ancestor, descendant, message) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(message);
  }
}

function assertMergeBase(left, right) {
  const result = spawnSync("git", ["merge-base", left, right], { encoding: "utf8" });
  if (result.status !== 0 || !/^[a-f0-9]{40}\s*$/u.test(result.stdout)) {
    throw new Error("baseline and scan end have no auditable merge base");
  }
}

function revList(range) {
  return git(["rev-list", range])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseNameStatus(raw) {
  const fields = raw.split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      continue;
    }
    if (/^[RC][0-9]+$/u.test(status)) {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) {
        throw new Error("git returned an incomplete rename/copy record");
      }
      entries.push({ status, path, previousPath });
      continue;
    }
    const path = fields[index++];
    if (!path) {
      throw new Error("git returned an incomplete changed-path record");
    }
    entries.push({ status, path });
  }
  return entries;
}

function changedEntries(commitOrRange) {
  const args = commitOrRange.includes("..")
    ? ["diff", "--name-status", "-z", "-M", commitOrRange]
    : ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "-M", commitOrRange];
  return parseNameStatus(git(args));
}

function assertSingleParentCommit(sha) {
  const fields = git(["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/u);
  if (fields.length > 2) {
    throw new Error(
      `selected merge commit ${sha} is ambiguous; select its exact constituent commits`,
    );
  }
}

function entryPaths(entries) {
  return [
    ...new Set(entries.flatMap((entry) => [entry.previousPath, entry.path]).filter((path) => path)),
  ].toSorted(compareText);
}

function commitsTouching(range, paths) {
  if (paths.length === 0) {
    return [];
  }
  return [
    ...new Set(
      git(["log", "--format=%H%x00", "--no-renames", range, "--", ...paths])
        .split("\0")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function commitSummary(sha) {
  return git(["show", "-s", "--format=%s", sha]).trim();
}

function commitBody(sha) {
  return git(["show", "-s", "--format=%B", sha]);
}

function commitRecord(sha, selectedPaths) {
  const entries = changedEntries(sha);
  const paths = entryPaths(entries).filter((path) => selectedPaths.has(path));
  return { sha, subject: commitSummary(sha), paths };
}

function pullRequestNumbers(body) {
  return [...new Set([...body.matchAll(/#([1-9][0-9]*)/gu)].map((match) => match[1]))].toSorted(
    (left, right) => Number(left) - Number(right),
  );
}

function commitsMentioning(range, numbers) {
  const commits = new Set();
  for (const number of numbers) {
    const output = git(["log", "--format=%H%x00", "--fixed-strings", `--grep=#${number}`, range], {
      allowEmpty: true,
    });
    for (const sha of output
      .split("\0")
      .map((value) => value.trim())
      .filter(Boolean)) {
      commits.add(sha);
    }
  }
  return [...commits].toSorted(compareText);
}

function treePaths(ref) {
  return git(["ls-tree", "-r", "--name-only", "-z", ref]).split("\0").filter(Boolean);
}

function pathStem(path) {
  let stem = basename(path, extname(path));
  stem = stem.replace(/\.(?:test|spec|fixture)$/u, "");
  return stem;
}

function isTestPath(path) {
  return (
    /(^|\/)(?:test|tests|fixtures?)(\/|$)/u.test(path) || /\.(?:test|spec)\.[^/]+$/u.test(path)
  );
}

function grepReferencePaths(ref, term) {
  if (term.length < 4 || term === "index") {
    return [];
  }
  const output = git(["grep", "-l", "-F", term, ref, "--"], { allowEmpty: true });
  const prefix = `${ref}:`;
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line));
}

function companionCandidates(scanEnd, selectedPaths, selectedEntries) {
  const allPaths = treePaths(scanEnd);
  const neighborTests = new Set();
  const referenceCandidates = new Set();
  const referenceSearchSkipped = new Set();
  for (const path of selectedPaths) {
    const stem = pathStem(path);
    const directory = dirname(path);
    for (const candidate of allPaths) {
      if (
        candidate !== path &&
        isTestPath(candidate) &&
        (pathStem(candidate) === stem ||
          (dirname(candidate) === directory && basename(candidate).startsWith(`${stem}.`)))
      ) {
        neighborTests.add(candidate);
      }
    }
  }
  for (const entry of selectedEntries) {
    const stem = pathStem(entry.path);
    if (stem.length < 4 || stem === "index") {
      referenceSearchSkipped.add(entry.path);
      continue;
    }
    for (const candidate of grepReferencePaths(scanEnd, stem)) {
      if (candidate !== entry.path) {
        referenceCandidates.add(candidate);
      }
    }
  }
  const describe = (path, reason) => ({
    path,
    reason,
    selected: selectedPaths.has(path),
  });
  return {
    neighborTests: [...neighborTests]
      .toSorted(compareText)
      .map((path) => describe(path, "neighbor-test")),
    referenceCandidates: [...referenceCandidates]
      .toSorted(compareText)
      .map((path) => describe(path, "selected-file-reference")),
    referenceSearchSkipped: [...referenceSearchSkipped].toSorted(compareText),
  };
}

function treeObject(ref, path) {
  const line = git(["ls-tree", "-z", ref, "--", path]).split("\0", 1)[0] ?? "";
  return /^[0-7]+ (?:blob|commit) ([a-f0-9]{40})\t/u.exec(line)?.[1] ?? null;
}

function selectedContentExpectations(selectedShas, entriesBySha) {
  const ownerByPath = new Map();
  for (const sha of selectedShas) {
    for (const path of entryPaths(entriesBySha.get(sha) ?? [])) {
      ownerByPath.set(path, sha);
    }
  }
  return [...ownerByPath]
    .map(([path, selectedSha]) => ({ path, selectedSha, object: treeObject(selectedSha, path) }))
    .toSorted((left, right) => compareText(left.path, right.path));
}

export function analyzeBackportCompanions({ baseline, candidate, scanEnd, selected }) {
  if (!Array.isArray(selected) || selected.length === 0) {
    throw new Error("at least one --selected commit is required");
  }
  const baselineSha = resolveCommit(baseline, "baseline");
  const scanEndSha = resolveCommit(scanEnd, "scan end");
  const candidateSha = candidate ? resolveCommit(candidate, "candidate") : undefined;
  const selectedShas = selected.map((ref) => resolveCommit(ref, "selected commit"));
  assertMergeBase(baselineSha, scanEndSha);
  const eligibleSelections = new Set(revList(`${baselineSha}..${scanEndSha}`));
  for (const sha of selectedShas) {
    assertAncestor(
      sha,
      scanEndSha,
      `selected commit ${sha} is not an ancestor of the pinned scan end`,
    );
    assertSingleParentCommit(sha);
    if (!eligibleSelections.has(sha)) {
      throw new Error(`selected commit ${sha} is already reachable from the pinned baseline`);
    }
  }
  if (candidateSha) {
    assertAncestor(
      baselineSha,
      candidateSha,
      "candidate is not a descendant of the pinned baseline",
    );
  }

  const selectedEntriesBySha = new Map(selectedShas.map((sha) => [sha, changedEntries(sha)]));
  const selectedEntries = selectedShas.flatMap((sha) => selectedEntriesBySha.get(sha) ?? []);
  const selectedPathList = entryPaths(selectedEntries);
  const selectedPaths = new Set(selectedPathList);
  const selection = selectedShas.map((sha) => {
    const entries = selectedEntriesBySha.get(sha) ?? [];
    const paths = entryPaths(entries);
    const range = `${sha}..${scanEndSha}`;
    const laterSamePath = commitsTouching(range, paths).map((commit) =>
      commitRecord(commit, new Set(paths)),
    );
    const prNumbers = pullRequestNumbers(commitBody(sha));
    const laterPrMentions = commitsMentioning(range, prNumbers).map((commit) => ({
      sha: commit,
      subject: commitSummary(commit),
    }));
    return {
      sha,
      subject: commitSummary(sha),
      prNumbers,
      prLookupRequired: prNumbers.length === 0,
      entries,
      laterSamePath,
      laterPrMentions,
    };
  });

  const candidateEntries = candidateSha ? changedEntries(`${baselineSha}..${candidateSha}`) : [];
  const candidatePaths = new Set(entryPaths(candidateEntries));
  const expectedContent = selectedContentExpectations(selectedShas, selectedEntriesBySha);
  const comparison = candidateSha
    ? {
        candidateSha,
        candidateEntries,
        missingSelectedPaths: selectedPathList.filter((path) => !candidatePaths.has(path)),
        contentDifferences: expectedContent
          .map((entry) => ({
            path: entry.path,
            selectedSha: entry.selectedSha,
            object: entry.object,
            candidateObject: treeObject(candidateSha, entry.path),
          }))
          .filter((entry) => entry.object !== entry.candidateObject),
        extraCandidatePaths: [...candidatePaths]
          .filter((path) => !selectedPaths.has(path))
          .toSorted(compareText),
      }
    : null;

  return {
    schema: SCHEMA,
    baselineSha,
    scanEndSha,
    selectedPaths: selectedPathList,
    selection,
    companions: companionCandidates(scanEndSha, selectedPaths, selectedEntries),
    comparison,
    manualChecksRequired: MANUAL_CHECKS,
  };
}

function parseArgs(argv) {
  const options = { selected: [], json: false };
  let packageManagerSeparator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" && !packageManagerSeparator) {
      packageManagerSeparator = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--baseline", "--candidate", "--scan-end", "--selected"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a Git ref`);
      }
      if (arg === "--selected") {
        options.selected.push(value);
      } else {
        options[arg.slice(2).replace("-", "")] = value;
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.baseline || !options.scanend || options.selected.length === 0) {
    throw new Error(
      "usage: release-backport-companions --baseline <ref> --scan-end <ref> --selected <commit> [--selected <commit>...] [--candidate <ref>] [--json]",
    );
  }
  return {
    baseline: options.baseline,
    candidate: options.candidate,
    scanEnd: options.scanend,
    selected: options.selected,
    json: options.json,
  };
}

function short(sha) {
  return sha.slice(0, 12);
}

function formatList(values, empty = "none") {
  return values.length === 0 ? empty : values.join(", ");
}

function formatMarkdown(report) {
  const lines = [
    "# Release backport companion audit",
    "",
    "> Heuristic evidence only: this report does not establish dependency closure or approve a backport.",
    "",
    `- Baseline: \`${report.baselineSha}\``,
    `- Scan end: \`${report.scanEndSha}\``,
    `- Selected paths: ${report.selectedPaths.length}`,
  ];
  if (report.comparison) {
    lines.push(
      `- Candidate: \`${report.comparison.candidateSha}\``,
      `- Selected paths absent from candidate delta: ${formatList(report.comparison.missingSelectedPaths.map((path) => `\`${path}\``))}`,
      `- Selected paths with candidate content differences (inspect; release adaptations may be valid): ${formatList(report.comparison.contentDifferences.map((item) => `\`${item.path}\``))}`,
      `- Extra candidate paths: ${formatList(report.comparison.extraCandidatePaths.map((path) => `\`${path}\``))}`,
    );
  } else {
    lines.push("- Candidate comparison: not requested; rerun with `--candidate` after picks");
  }
  for (const item of report.selection) {
    lines.push("", `## ${short(item.sha)} ${item.subject}`);
    lines.push(
      `- Original paths: ${formatList(entryPaths(item.entries).map((path) => `\`${path}\``))}`,
      `- PR references: ${formatList(
        item.prNumbers.map((number) => `#${number}`),
        "none; manual PR lookup required",
      )}`,
      `- Later same-path commits: ${formatList(item.laterSamePath.map((commit) => `\`${short(commit.sha)}\` ${commit.subject}`))}`,
      `- Later PR-number mentions: ${formatList(item.laterPrMentions.map((commit) => `\`${short(commit.sha)}\` ${commit.subject}`))}`,
    );
  }
  lines.push("", "## Existing companion candidates");
  lines.push(
    `- Neighbor tests: ${formatList(report.companions.neighborTests.map((item) => `\`${item.path}\`${item.selected ? " (selected)" : " (unselected)"}`))}`,
    `- Selected-file references/registries: ${formatList(report.companions.referenceCandidates.map((item) => `\`${item.path}\`${item.selected ? " (selected)" : " (unselected)"}`))}`,
    `- Reference searches skipped for generic stems: ${formatList(report.companions.referenceSearchSkipped.map((path) => `\`${path}\``))}`,
    "",
    "Disposition every candidate as present-equivalent, selected, missing, or not-applicable before freezing.",
  );
  lines.push("", "## Manual checks required");
  for (const check of report.manualChecksRequired) {
    lines.push(`- ${check}`);
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = analyzeBackportCompanions(options);
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : formatMarkdown(report),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
