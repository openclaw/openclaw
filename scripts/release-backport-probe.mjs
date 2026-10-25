#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.runtime.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const HEADER = [
  "candidate",
  "baseline",
  "status",
  "conflict_count",
  "touched_file_count",
  "touched_file",
  "conflict",
];

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (options.accept?.includes(result.status)) {
    return result;
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function resolveCommit(value, label, cwd) {
  const result = git(["rev-parse", "--verify", `${value}^{commit}`], { cwd });
  const oid = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(oid)) {
    throw new Error(`Unable to resolve ${label} as one commit: ${value}`);
  }
  return oid;
}

function candidateParent(candidate, cwd) {
  const line = git(["rev-list", "--parents", "-n", "1", candidate], { cwd }).stdout.trim();
  const entries = line.split(" ");
  if (entries.length !== 2) {
    throw new Error(
      `Backport probe requires a single-parent candidate; ${candidate} has ${entries.length - 1} parents`,
    );
  }
  return entries[1];
}

function nulPaths(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function tsv(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n");
}

export function probeBackport({ baseline, candidate, cwd = process.cwd() }) {
  const resolvedBaseline = resolveCommit(baseline, "baseline", cwd);
  const resolvedCandidate = resolveCommit(candidate, "candidate", cwd);
  const parent = candidateParent(resolvedCandidate, cwd);
  const touched = nulPaths(
    git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", parent, resolvedCandidate], {
      cwd,
      encoding: null,
    }).stdout,
  ).toSorted();
  const merge = git(
    [
      "-c",
      "core.quotePath=false",
      "merge-tree",
      "--write-tree",
      `--merge-base=${parent}`,
      "--name-only",
      "--no-messages",
      resolvedBaseline,
      resolvedCandidate,
    ],
    { accept: [0, 1], cwd },
  );
  const lines = merge.stdout.trim().split("\n").filter(Boolean);
  const tree = lines.shift();
  if (!tree || !/^[0-9a-f]{40}$/u.test(tree)) {
    throw new Error(`git merge-tree returned no result tree for ${resolvedCandidate}`);
  }
  const conflicts = new Set(lines);
  const baselineTree = git(["rev-parse", `${resolvedBaseline}^{tree}`], { cwd }).stdout.trim();
  const status =
    merge.status === 1 ? "conflicted" : tree === baselineTree ? "already-covered" : "clean";
  const paths = [...new Set([...touched, ...conflicts])].toSorted((left, right) =>
    left.localeCompare(right),
  );
  return {
    baseline: resolvedBaseline,
    candidate: resolvedCandidate,
    conflictCount: conflicts.size,
    conflicts,
    paths,
    status,
    touchedFileCount: touched.length,
  };
}

export function formatBackportProbes(probes) {
  const rows = [HEADER];
  for (const probe of probes) {
    const paths = probe.paths.length > 0 ? probe.paths : [""];
    for (const file of paths) {
      rows.push([
        probe.candidate,
        probe.baseline,
        probe.status,
        probe.conflictCount,
        probe.touchedFileCount,
        file,
        probe.conflicts.has(file) ? 1 : 0,
      ]);
    }
  }
  return `${rows.map((row) => row.map(tsv).join("\t")).join("\n")}\n`;
}

export function runBackportProbe(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: stripLeadingPackageManagerSeparator(args),
    options: {
      baseline: { type: "string" },
      candidate: { type: "string", multiple: true },
    },
    strict: true,
  });
  if (!values.baseline || !values.candidate?.length) {
    throw new Error(
      "Usage: pnpm release:backport-probe -- --baseline <commit> --candidate <commit> [--candidate <commit> ...]",
    );
  }
  process.stdout.write(
    formatBackportProbes(
      values.candidate.map((candidate) => probeBackport({ baseline: values.baseline, candidate })),
    ),
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    runBackportProbe();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
