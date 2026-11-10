/**
 * Cold journaled PR transition; fixture preparation: pr-restore-memory.md.
 * node scripts/perf/pr-restore-memory.mjs --fixture /path/to/cold-checkout
 *   --base /path/to/base-tooling --candidate /path/to/candidate-tooling
 *   --source <oid> --target <oid> --output /path/to/results --pairs 5
 *
 * The fixture must be clean at source, with target trees present and blobs missing.
 * Use a local file:// promisor for repeatable CPU/RSS measurements; keep network
 * timings separate. Each arm gets a private copy, removed after verification.
 * macOS /usr/bin/time -l and Linux /usr/bin/time -v report descendant peak RSS
 * and total child CPU. Git Trace2 counts fetches. No Gateway or live state is used.
 * Add --git-metrics for a separate pass measuring each selected Git invocation,
 * excluding the Node containment validator from Git's peak-RSS measurement.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      ["fixture", "base", "candidate", "source", "target", "output", "pairs"].map((name) => [
        name,
        { type: "string" },
      ]),
    ),
    "git-metrics": { type: "boolean", default: false },
  },
});
for (const name of ["fixture", "base", "candidate", "source", "target", "output"]) {
  assert(values[name], `Missing --${name}`);
}
const pairs = Number(values.pairs ?? 5);
assert(Number.isSafeInteger(pairs) && pairs > 0, "Invalid --pairs");
const output = path.resolve(values.output);
fs.mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { env, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command}: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}
function resources(text) {
  const apple = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(text);
  const peakRssBytes = apple
    ? Number(/(\d+)\s+maximum resident set size/.exec(text)?.[1])
    : Number(/Maximum resident set size \(kbytes\): (\d+)/.exec(text)?.[1]) * 1024;
  const cpuSeconds = apple
    ? Number(apple[2]) + Number(apple[3])
    : Number(/User time \(seconds\): ([\d.]+)/.exec(text)?.[1]) +
      Number(/System time \(seconds\): ([\d.]+)/.exec(text)?.[1]);
  assert(
    Number.isFinite(peakRssBytes) && Number.isFinite(cpuSeconds),
    "Missing resource measurements",
  );
  return { peakRssBytes, cpuSeconds };
}
const realGit =
  process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || run("sh", ["-c", "command -v git"]);
const gitWrapper = path.join(output, "measure-git.sh");
if (values["git-metrics"]) {
  fs.writeFileSync(
    gitWrapper,
    `#!/bin/sh\nexec /usr/bin/time ${process.platform === "darwin" ? "-l" : "-v"} -o "$PR_RESTORE_GIT_METRICS/$$.time" "$PR_RESTORE_REAL_GIT" "$@"\n`,
    { mode: 0o700, flag: "wx" },
  );
}
const results = [];
for (let pair = 0; pair < pairs; pair++) {
  for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
    const name = `${pair + 1}-${arm}`;
    const checkout = path.join(output, name);
    assert(!fs.existsSync(checkout), `Refusing to overwrite ${checkout}`);
    run("cp", [
      process.platform === "darwin" ? "-cR" : "--reflink=auto",
      ...(process.platform === "darwin" ? [] : ["-R"]),
      path.resolve(values.fixture),
      checkout,
    ]);
    const trace = path.join(output, `${name}.trace.jsonl`);
    const log = path.join(output, `${name}.time.txt`);
    const gitMetrics = path.join(output, `${name}.git`);
    if (values["git-metrics"]) {
      fs.mkdirSync(gitMetrics);
    }
    const fd = fs.openSync(log, "wx");
    const started = performance.now();
    const loadBefore = os.loadavg();
    let result;
    try {
      result = spawnSync(
        "/usr/bin/time",
        [
          process.platform === "darwin" ? "-l" : "-v",
          process.platform === "darwin" ? "/bin/bash" : "bash",
          "-c",
          'set -euo pipefail; source "$1/scripts/pr-lib/worktree.sh"; canonical_repo_root="$PWD"; write_review_transition_journal 42 "$2" "$3" detached ""; recover_review_transition 42',
          "pr-restore-memory",
          path.resolve(values[arm]),
          values.source,
          values.target,
        ],
        {
          cwd: checkout,
          env: {
            ...env,
            GIT_TRACE2_EVENT: trace,
            ...(values["git-metrics"]
              ? {
                  OPENCLAW_PR_GIT: gitWrapper,
                  PR_RESTORE_GIT_METRICS: gitMetrics,
                  PR_RESTORE_REAL_GIT: realGit,
                }
              : {}),
          },
          stdio: ["ignore", fd, fd],
        },
      );
    } finally {
      fs.closeSync(fd);
    }
    const elapsedMs = performance.now() - started;
    const logText = fs.readFileSync(log, "utf8");
    assert.equal(result.status, 0, `${name} failed: ${logText}`);
    assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: checkout }), values.target);
    assert.equal(
      run("git", ["write-tree"], { cwd: checkout }),
      run("git", ["rev-parse", `${values.target}^{tree}`], { cwd: checkout }),
    );
    assert.equal(
      run("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: checkout }),
      "",
    );
    const events = fs
      .readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const gitResources = values["git-metrics"]
      ? fs
          .readdirSync(gitMetrics)
          .map((file) => resources(fs.readFileSync(path.join(gitMetrics, file), "utf8")))
      : [];
    const measurement = {
      pair: pair + 1,
      arm,
      elapsedMs,
      ...resources(logText),
      ...(gitResources.length
        ? {
            gitPeakRssBytes: Math.max(...gitResources.map((entry) => entry.peakRssBytes)),
            gitCpuSeconds: gitResources.reduce((sum, entry) => sum + entry.cpuSeconds, 0),
          }
        : {}),
      fetches: events.filter((event) => event.event === "cmd_name" && event.name === "fetch")
        .length,
      loadBefore,
      loadAfter: os.loadavg(),
    };
    results.push(measurement);
    fs.writeFileSync(path.join(output, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(measurement));
    fs.rmSync(checkout, { recursive: true });
  }
}
