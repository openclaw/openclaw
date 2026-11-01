#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { inspectActionsArtifactZipWithPolicy } from "./lib/actions-artifact-archive.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { execGhRead } from "./lib/plain-gh.mjs";

// A single archive read avoids gh run view's per-job fallback request ceiling.
function downloadRunLog(runId, repo) {
  const archive = execGhRead(["api", `repos/${repo}/actions/runs/${runId}/logs`], {
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  const entries = inspectActionsArtifactZipWithPolicy(archive, {
    minEntries: 1,
    maxEntries: 1024,
    maxArchiveBytes: 256 * 1024 * 1024,
    maxExpandedBytes: 512 * 1024 * 1024,
    allowPath: (name) => name.endsWith(".txt"),
    maxEntryBytes: () => 128 * 1024 * 1024,
  });
  const wholeJobs = [...entries].filter(([name]) => !name.includes("/"));
  return (wholeJobs.length ? wholeJobs : [...entries])
    .flatMap(([name, bytes]) => {
      const job = name.includes("/") ? name.split("/")[0] : name.slice(0, -4).replace(/^\d+_/u, "");
      return Buffer.from(bytes)
        .toString("utf8")
        .split("\n")
        .filter((line) => line.includes("[shard:"))
        .map((line) => `${job}\tlog\t${line}`);
    })
    .join("\n");
}

/** Summarize the shard wrapper's output, retaining missing/incomplete timing evidence. */
export function compareTestRuntimeLogs(log) {
  const rows = new Map();
  for (const raw of log.split("\n")) {
    // gh run view --log prefixes each line with job, step, and timestamp.
    const columns = raw.split("\t");
    const job = columns.length >= 3 ? columns[0] : "";
    const line = stripVTControlCharacters(columns.at(-1));
    const match = /\[shard:((?:bun:|bun-native:|node-subset:)?)([^\]]+)\]\s*(.*)/u.exec(line);
    if (!match) {
      continue;
    }
    const [, prefix, shard, message] = match;
    if (["resource-snapshot", "resources", "cache", "completion"].includes(shard)) {
      continue;
    }
    const runtime = prefix === "bun:" ? "bun" : prefix === "bun-native:" ? "bun-native" : "node";
    const key = JSON.stringify([job, shard, runtime]);
    let row = rows.get(key);
    if (!row && message !== "begin") {
      // Packed plans use a richer timing key for begin/end than for child output.
      const active = [...new Set(rows.values())].filter(
        (candidate) =>
          candidate.job === job &&
          candidate.runtime === runtime &&
          candidate.incompleteInvocations &&
          (candidate.shard.endsWith(shard) || candidate.shard.includes(`${shard}#`)),
      );
      if (active.length === 1) {
        row = active[0];
        row.shard = shard;
        rows.set(key, row);
      }
    }
    if (!row) {
      row = {
        job,
        shard,
        runtime,
        durationSeconds: 0,
        durationReports: 0,
        wrapperSeconds: 0,
        completedInvocations: 0,
        incompleteInvocations: 0,
        failedInvocations: 0,
        failedTests: 0,
        failedFiles: 0,
        caseMilliseconds: 0,
        caseLines: 0,
        failures: [],
        started: null,
        summaries: new Set(),
      };
      rows.set(key, row);
    }
    const timestamp = /^(\d{4}-\d\d-\d\dT[^ ]+Z) /u.exec(line)?.[1];
    if (message === "begin") {
      row.incompleteInvocations += 1;
      row.started = timestamp ? Date.parse(timestamp) : null;
    }
    const end = /^end \(exit (\d+)\)$/u.exec(message);
    if (end) {
      row.completedInvocations += 1;
      row.incompleteInvocations = Math.max(0, row.incompleteInvocations - 1);
      row.failedInvocations += Number(end[1]) === 0 ? 0 : 1;
      if (row.started !== null && timestamp) {
        row.wrapperSeconds += (Date.parse(timestamp) - row.started) / 1_000;
      }
      row.started = null;
    }
    const duration = /^Duration\s+([\d.]+)(ms|s)\b/u.exec(message.trim());
    const failed = /^(Test Files|Tests)\s+(\d+) failed\b/u.exec(message.trim());
    // The project runner can repeat Vitest's aggregate summary after its reporter.
    const summaryKey = `${row.caseLines}/${row.completedInvocations}/${message.trim()}`;
    const repeatedSummary = row.summaries.has(summaryKey);
    if (duration && !repeatedSummary) {
      row.durationSeconds += Number(duration[1]) / (duration[2] === "ms" ? 1_000 : 1);
      row.durationReports += 1;
    }
    if (failed && !repeatedSummary) {
      row[failed[1] === "Tests" ? "failedTests" : "failedFiles"] += Number(failed[2]);
    }
    if (duration || failed) {
      row.summaries.add(summaryKey);
    }
    const test = /^\s*([✓✔×✕❯])\s+(.+?)(?:\s+([\d.]+)ms)?\s*$/u.exec(message);
    if (test) {
      if (test[3] && test[2].includes(" > ")) {
        row.caseMilliseconds += Number(test[3]);
        row.caseLines += 1;
      }
      if (["×", "✕", "❯"].includes(test[1])) {
        row.failures.push(test[2]);
      }
    }
  }
  return [...new Set(rows.values())]
    .filter(
      (row) =>
        row.durationReports ||
        row.completedInvocations ||
        row.incompleteInvocations ||
        row.caseLines ||
        row.failures.length,
    )
    .map(({ started: _started, summaries: _summaries, ...row }) =>
      Object.assign(row, {
        // Case times overlap under parallel execution; they are never wall time.
        wallSeconds:
          row.completedInvocations && row.wrapperSeconds > 0
            ? row.wrapperSeconds
            : row.durationReports
              ? row.durationSeconds
              : null,
        wallSource:
          row.completedInvocations && row.wrapperSeconds > 0
            ? "wrapper"
            : row.durationReports
              ? "vitest-duration"
              : "missing",
      }),
    )
    .toSorted(
      (left, right) =>
        left.job.localeCompare(right.job) ||
        left.shard.localeCompare(right.shard) ||
        left.runtime.localeCompare(right.runtime),
    );
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string", default: "openclaw/openclaw" },
      "log-file": { type: "string" },
      "save-log": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/ci-compare-test-runtimes.mjs <run-id> [--repo owner/repo] [--save-log file] [--json]\n       node scripts/ci-compare-test-runtimes.mjs --log-file file [--json]",
    );
    return;
  }
  if (positionals.length > 1 || (!values["log-file"] && !/^\d+$/u.test(positionals[0] ?? ""))) {
    throw new Error("Provide a CI run id or --log-file; use --help for usage.");
  }
  const log = values["log-file"]
    ? readFileSync(values["log-file"], "utf8")
    : downloadRunLog(positionals[0], values.repo);
  if (values["save-log"]) {
    writeFileSync(values["save-log"], log);
  }
  const rows = compareTestRuntimeLogs(log);
  if (rows.length === 0) {
    throw new Error("No shard timing or test evidence found in the run logs.");
  }
  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(
      "job\tshard\truntime\twall seconds\tsource\tfailed invocations/tests/files\tincomplete",
    );
    for (const row of rows) {
      console.log(
        [
          row.job,
          row.shard,
          row.runtime,
          row.wallSeconds?.toFixed(3) ?? "unknown",
          row.wallSource,
          `${row.failedInvocations}/${row.failedTests}/${row.failedFiles}`,
          row.incompleteInvocations,
        ].join("\t"),
      );
    }
    console.log(
      "Vitest Duration excludes wrapper/setup time; case sums are not wall time. Missing or incomplete evidence is not a passing result.",
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
