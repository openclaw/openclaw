// Synthetic checkout.diff workload through the production read/worker owners.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    seed: { type: "boolean" },
    untracked: { type: "string", default: "100" },
    boundary: { type: "string", default: "worker" },
    summary: { type: "boolean" },
    mutate: { type: "boolean" },
    samples: { type: "string", default: "40" },
    "poll-ms": { type: "string", default: "0" },
    "start-at": { type: "string" },
    output: { type: "string" },
    revision: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Seed once into a new synthetic directory:
  node --import ./scripts/tsx.mjs scripts/perf/checkout-diff-measure.ts --state-dir <path> --seed
Measure that fixture on the authorized benchmark host:
  ... --state-dir <path> --boundary worker --summary --mutate --samples 40 --output <file>
Use --boundary read for loadCheckoutDiff, omit --summary for full patches, and
omit --mutate for unchanged polls. Set --poll-ms 10050 to cross the old summary
cache TTL. --start-at <epoch-ms> synchronizes concurrent baseline/candidate pairs.
Git trace2 counts real subprocesses; its small write cost is included on both sides.
No Gateway, network client, production state, or model is involved.`);
  process.exit(0);
}
const integer = (raw: string, label: string, min = 0) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
if (!values["state-dir"]) {
  throw new Error("--state-dir must name a task-owned synthetic fixture");
}
if (values.boundary !== "worker" && values.boundary !== "read") {
  throw new Error("--boundary must be worker or read");
}
const root = path.resolve(values["state-dir"]);
const repo = path.join(root, "repository");
const marker = path.join(root, "checkout-diff-fixture.json");
const trace = path.join(root, "git-trace.jsonl");
const untracked = integer(values.untracked, "--untracked", 4);
if (untracked > 100) {
  throw new Error("--untracked must not exceed the 100-file diff response cap");
}
const samples = integer(values.samples, "--samples", 1);
const pollMs = integer(values["poll-ms"], "--poll-ms");
const gitEnv = {
  ...process.env,
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  TMPDIR: path.join(root, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Synthetic Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-10-19T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-19T00:00:00Z",
  GIT_TRACE2_EVENT: undefined,
};
const git = (...args: string[]) =>
  promisify(execFile)("git", ["-C", repo, ...args], { env: gitEnv });

async function seed() {
  await fs.mkdir(root);
  for (const directory of [repo, gitEnv.HOME, gitEnv.TMPDIR]) {
    await fs.mkdir(directory);
  }
  await git("init", "--template=", "--initial-branch=main");
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored/\n");
  for (const file of ["modified.txt", "staged.txt", "deleted.txt"]) {
    await fs.writeFile(path.join(repo, file), "Synthetic tracked content\n");
  }
  await git("add", ".");
  await git("-c", "commit.gpgSign=false", "commit", "-m", "test: seed synthetic diff");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  await fs.writeFile(path.join(repo, "modified.txt"), "Synthetic tracked content\nChanged 0\n");
  await fs.writeFile(path.join(repo, "staged.txt"), "Synthetic staged content\n");
  await git("add", "staged.txt");
  await fs.unlink(path.join(repo, "deleted.txt"));
  await fs.mkdir(path.join(repo, "new"));
  for (let index = 0; index < untracked - 4; index++) {
    await fs.writeFile(
      path.join(repo, "new", `text-${String(index).padStart(3, "0")}.txt`),
      `Synthetic untracked file ${index}\n${"Added content\n".repeat(16)}`,
    );
  }
  await fs.writeFile(path.join(repo, "new", "binary.bin"), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(repo, "new", "large.txt"), "Large synthetic content\n".repeat(6000));
  await fs.writeFile(path.join(repo, "new", "empty.txt"), "");
  await fs.symlink("../modified.txt", path.join(repo, "new", "link.txt"));
  await fs.mkdir(path.join(repo, "ignored"));
  await fs.writeFile(path.join(repo, "ignored", "hidden.txt"), "Ignored synthetic content\n");
  const fixture = { format: "openclaw-checkout-diff-v1", head, untracked, tracked: 3 };
  await fs.writeFile(marker, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify(fixture));
}

function summarize(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  return {
    count: numbers.length,
    mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
    p50: sorted[Math.ceil(numbers.length * 0.5) - 1],
    p99: sorted[Math.ceil(numbers.length * 0.99) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
}

async function measure() {
  const fixture: unknown = JSON.parse(await fs.readFile(marker, "utf8"));
  if (
    !fixture ||
    typeof fixture !== "object" ||
    !("format" in fixture) ||
    fixture.format !== "openclaw-checkout-diff-v1" ||
    !("head" in fixture) ||
    typeof fixture.head !== "string" ||
    !("untracked" in fixture) ||
    typeof fixture.untracked !== "number"
  ) {
    throw new Error("Expected an offline fixture created with --seed");
  }
  const expectedFiles = fixture.untracked + 3;
  Object.assign(process.env, gitEnv, { GIT_TRACE2_EVENT: trace });
  const [{ loadCheckoutDiff }, { runGitWorkerOperation }, { drainGlobalSingletonLifecycleState }] =
    await Promise.all([
      import("../../src/sessions/session-diff.js"),
      import("../../src/infra/git-worker.js"),
      import("../../src/shared/global-singleton.js"),
    ]);
  const input = {
    cwd: repo,
    scope: "all" as const,
    summaryOnly: values.summary === true,
  };
  const request = () =>
    values.boundary === "read"
      ? loadCheckoutDiff({ ...input, sessionKey: "synthetic-diff" })
      : runGitWorkerOperation({ type: "checkout.diff", input });
  const sample = async (index: number) => {
    if (values.mutate) {
      await fs.writeFile(
        path.join(repo, "modified.txt"),
        `Synthetic tracked content\nChanged ${index}\n`,
      );
    }
    await fs.writeFile(trace, "");
    const startedAt = Date.now();
    const started = performance.now();
    const result = await request();
    const elapsedMs = performance.now() - started;
    if (result.unavailableReason || result.files.length !== expectedFiles) {
      throw new Error(
        `Missing synthetic changes: ${result.files.length}, ${result.unavailableReason}`,
      );
    }
    const commands: string[] = [];
    for (const line of (await fs.readFile(trace, "utf8")).split("\n").filter(Boolean)) {
      const event: { event?: string; argv?: string[] } = JSON.parse(line);
      if (event.event === "start" && event.argv) {
        const command = event.argv.find((arg) =>
          /^(diff|ls-files|rev-parse|rev-list|log|add|hash-object|symbolic-ref|merge-base|show)$/.test(
            arg,
          ),
        );
        commands.push(
          `${command ?? "other"}${event.argv.includes("--no-index") ? " --no-index" : ""}`,
        );
      }
    }
    const { root: _root, ...portable } = result;
    const response = JSON.stringify(portable);
    return {
      startedAt,
      elapsedMs,
      gitCommands: commands.length,
      commands: Object.fromEntries(
        [...new Set(commands)].map((name) => [
          name,
          commands.filter((value) => value === name).length,
        ]),
      ),
      responseBytes: Buffer.byteLength(response),
      responseSha256: createHash("sha256").update(response).digest("hex"),
    };
  };
  try {
    const warmup = await sample(0);
    console.log(JSON.stringify({ ready: true, warmup }));
    if (values["start-at"]) {
      const startAt = integer(values["start-at"], "--start-at", 1);
      if (Date.now() >= startAt) {
        throw new Error("--start-at passed before worker readiness");
      }
      await delay(startAt - Date.now());
    }
    const results = [];
    for (let index = 1; index <= samples; index++) {
      if (pollMs) {
        await delay(pollMs);
      }
      results.push(await sample(index));
    }
    const report = {
      revision: values.revision ?? null,
      boundary: values.boundary,
      summaryOnly: values.summary === true,
      mutate: values.mutate === true,
      pollMs,
      fixture,
      node: process.version,
      latencyMs: summarize(results.map((result) => result.elapsedMs)),
      gitCommands: summarize(results.map((result) => result.gitCommands)),
      warmup,
      samples: results,
    };
    await fs.writeFile(
      path.resolve(values.output ?? path.join(root, "result.json")),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify({ latencyMs: report.latencyMs, gitCommands: report.gitCommands }));
  } finally {
    await drainGlobalSingletonLifecycleState();
  }
}

await (values.seed ? seed() : measure());
