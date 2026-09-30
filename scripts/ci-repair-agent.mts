#!/usr/bin/env node
// Dependency-free: the publisher runs this trusted copy without installing or executing the candidate.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const REPO = "openclaw/openclaw";
const REMOTE = `https://github.com/${REPO}.git`;
const SHA = /^[a-f0-9]{40}$/u;
const TEST = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const PATH = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/u;
const MAX_PATCH = 256 * 1024;
const OUT = resolve(process.env.CI_REPAIR_ARTIFACTS ?? ".artifacts/ci-repair");

type Run = {
  id: number;
  attempt: number;
  sha: string;
  event: string;
  branch: string;
  path: string;
  repository: string;
  headRepository: string;
  status: string;
  conclusion: string;
  createdAt: string;
};
type Job = {
  id: number;
  name: string;
  conclusion: string;
  steps: { name: string; conclusion: string }[];
};
type Result = {
  action: "fix" | "diagnose";
  patch: string;
  failingTests: string[];
  cause: string;
  classification: "deterministic-break" | "flake" | "infra" | "unknown";
  evidence: string;
  confidence: "high" | "medium" | "low";
};
type Verdict = { passed: boolean; reasons: string[]; files: string[]; changedLines: number };
type TestEvidence = {
  file: string;
  reproduction: "pending" | "reproduced" | "not-reproduced";
  previousFailures: number[];
};
type Context = {
  run: Run;
  classification: string;
  tests: TestEvidence[];
  jobs: (Job & {
    classification: string;
    tests: string[];
    shardOrder: string[];
    excerpt: string;
    previousFailures: number[];
  })[];
  history: { run: Run; unavailable: boolean }[];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 16000) {
    throw new Error("Invalid string");
  }
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid positive integer");
  }
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected an array");
  }
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  for (const candidate of choices) {
    if (candidate === value) {
      return candidate;
    }
  }
  throw new Error("Invalid enum value");
}
export function parseResult(value: unknown): Result {
  const data = record(value);
  const action = choice(data.action, ["fix", "diagnose"]);
  if (
    typeof data.patch !== "string" ||
    Buffer.byteLength(data.patch) > MAX_PATCH ||
    (action === "diagnose" ? data.patch !== "" : !data.patch.trim())
  ) {
    throw new Error("A fix requires patch text; a diagnosis requires an empty patch");
  }
  return {
    action,
    patch: data.patch,
    failingTests: array(data.failingTests).map(testPath),
    cause: string(data.cause),
    classification: choice(data.classification, [
      "deterministic-break",
      "flake",
      "infra",
      "unknown",
    ]),
    evidence: string(data.evidence),
    confidence: choice(data.confidence, ["high", "medium", "low"]),
  };
}
function safePath(value: unknown): string {
  const path = string(value);
  if (
    !PATH.test(path) ||
    path.split("/").some((part) => part === "." || part === ".." || part.startsWith(".git"))
  ) {
    throw new Error("Invalid relative path");
  }
  return path;
}
function testPath(value: unknown): string {
  const path = safePath(value);
  if (!TEST.test(path)) {
    throw new Error("Not a test file");
  }
  return path;
}

export function parseFailures(log: string): string[] {
  const files = new Set<string>();
  for (const line of stripVTControlCharacters(log).split(/\r?\n/u)) {
    const fail =
      /\bFAIL\s+(?:(?:\[[^\]]+\]|\|[^|]+\||[a-zA-Z0-9_-]+)\s+)?([^\s>]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=\s|$)/u.exec(
        line,
      )?.[1];
    const annotation = /::error\s+[^\r\n]*?\bfile=([^,\r\n]+?)(?=,|::)/u.exec(line)?.[1];
    for (const raw of [fail, annotation]) {
      if (!raw) {
        continue;
      }
      const path = raw
        .replaceAll("%2C", ",")
        .replaceAll("%25", "%")
        .replace(/^\.\//u, "")
        .replace(/:\d+(?::\d+)?$/u, "");
      try {
        files.add(testPath(path));
      } catch {
        /* Non-test diagnostics are not executable test selectors. */
      }
    }
  }
  return [...files].toSorted();
}
export function classifyJob(
  job: Job,
  tests: readonly string[] = [],
): "tests" | "infra" | "unknown" {
  const failed = job.steps.filter(
    (step) => step.conclusion === "failure" || step.conclusion === "timed_out",
  );
  if (
    tests.length ||
    failed.some(
      (step) =>
        /\b(test|tests|vitest)\b/iu.test(step.name) &&
        !/\btest[- ]types\b/iu.test(step.name) &&
        !/^(setup|install|prepare|download|upload|cache)\b/iu.test(step.name),
    )
  ) {
    return "tests";
  }
  if (
    !failed.length ||
    job.name === "openclaw/ci-gate" ||
    failed.every((step) =>
      /^(set up|setup|install|checkout|prepare|download|upload|restore|save cache|post |complete job)/iu.test(
        step.name,
      ),
    )
  ) {
    return "infra";
  }
  return "unknown";
}
export function isInfraOnly(jobs: readonly Job[]): boolean {
  return jobs.length > 0 && jobs.every((job) => classifyJob(job) === "infra");
}
function excerpt(log: string): string {
  const lines = stripVTControlCharacters(log).split(/\r?\n/u);
  const selected = new Set<number>();
  const failures = lines.flatMap((line, i) =>
    /\bFAIL\s|(?:^|Z\s+)(?:::error|##\[error\])/u.test(line) ? [i] : [],
  );
  for (const i of failures) {
    for (
      let j = Math.max(0, i - 15);
      j < Math.min(lines.length, i + 35) && selected.size < 300;
      j++
    ) {
      selected.add(j);
    }
  }
  if (!selected.size) {
    for (let i = Math.max(0, lines.length - 300); i < lines.length; i++) {
      selected.add(i);
    }
  }
  return [...selected]
    .toSorted((a, b) => a - b)
    .map((i) => `${i + 1}: ${(lines[i] ?? "").slice(0, 1000)}`)
    .join("\n");
}

function forbiddenPath(path: string): boolean {
  return (
    /(?:^|\/)(?:\.github|patches|__snapshots__|node_modules|dist|build|coverage|generated|__generated__|protocol-gen|CHANGELOG[^/]*)(?:\/|$)/iu.test(
      path,
    ) ||
    /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|\.npmrc|\.gitattributes|\.gitmodules|\.[A-Za-z]*ignore|CHANGELOG[^/]*|vitest[^/]*\.[cm]?[jt]s|[^/]*(?:baseline|ratchet|inventory)[^/]*)$/iu.test(
      path,
    ) ||
    /(?:\.snap$|\.generated\.|^test\/vitest\/|^scripts\/ci-repair-agent\.|(?:^|\/)AGENTS(?:\.override)?\.md$)/iu.test(
      path,
    )
  );
}
const FORBIDDEN_ADDITION =
  /(?:\.\s*(?:skip|only|todo|fails)\b|\[\s*["'](?:skip|only|todo|fails)["']\s*\]|\bretr(?:y|ies)\b|\b(?:testTimeout|hookTimeout)\b|\bvi\s*\.\s*setConfig\b|@ts-(?:nocheck|ignore|expect-error)\b|\b(?:eslint|oxlint)-disable)/u;
const TEST_LIKE_PATH = /(?:\.test\.|test-support|test-utils|\.test-harness\.|(?:^|\/)test\/)/u;
// Added fragments may omit the surrounding test call; reject controls conservatively in test code.
const FORBIDDEN_TEST_ADDITION =
  /(?:\.\s*(?:skip|run)If\b|\[\s*["'](?:skip|run)If["']\s*\]|(["']?)\b(?:skip|only|todo|fails|timeout|retry|repeats)\1\s*:|\[\s*(["'`])(?:skip|only|todo|fails|timeout|retry|repeats)\2\s*\]\s*:|,\s*[+-]?(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)\s*,?\s*\))/u;
const assertionCount = (text: string) =>
  [...text.matchAll(/\b(?:expect\s*\(|assert(?:\s*\.\s*\w+)?\s*\()/gu)].length;
export const patchSha256 = (patch: string) => createHash("sha256").update(patch).digest("hex");

// Parse only ordinary, existing regular-file unified diffs. Ambiguous Git path quoting,
// modes, binary patches, combined diffs and mail containing multiple commits fail closed.
export function guardPatch(patch: string, result: Result, expectedSha256?: string): Verdict {
  const reasons: string[] = [];
  const files: string[] = [];
  let changedLines = 0;
  if (
    Buffer.byteLength(patch) > MAX_PATCH ||
    patch.includes("\0") ||
    patch.includes("\r") ||
    patch.includes("\uFFFD")
  ) {
    reasons.push("Invalid or oversized patch");
  }
  if (
    expectedSha256 !== undefined &&
    (!/^[a-f0-9]{64}$/u.test(expectedSha256) || patchSha256(patch) !== expectedSha256)
  ) {
    reasons.push("Patch sha256 mismatch");
  }
  if (result.action !== "fix" || result.confidence !== "high") {
    reasons.push("A fix requires high confidence");
  }
  if (result.classification !== "deterministic-break" && result.classification !== "flake") {
    reasons.push("Unresolved classification");
  }
  if ((patch.match(/^From [a-f0-9]{40} Mon Sep 17 00:00:00 2001$/gmu) ?? []).length > 1) {
    reasons.push("Multiple commits");
  }
  const sections = patch.split(/^diff --git /mu);
  const preamble = sections[0] ?? "";
  if (
    preamble &&
    (!/^From [a-f0-9]{40} Mon Sep 17 00:00:00 2001\n/u.test(preamble) ||
      /^(?:diff |--- |\+\+\+ |@@|Index:|GIT binary patch)/mu.test(preamble))
  ) {
    reasons.push("Unexpected patch preamble");
  }
  for (const section of sections.slice(1)) {
    const lines = section.replace(/\n$/u, "").split("\n");
    const header = /^a\/(\S+) b\/(\S+)$/u.exec(lines[0] ?? "");
    if (!header || header[1] !== header[2]) {
      reasons.push("Added, deleted, renamed or ambiguous path");
      continue;
    }
    let path: string;
    try {
      path = safePath(header[1]);
    } catch {
      reasons.push("Invalid patch path");
      continue;
    }
    if (files.includes(path)) {
      reasons.push(`Duplicate file: ${path}`);
    }
    files.push(path);
    if (forbiddenPath(path)) {
      reasons.push(`Forbidden path: ${path}`);
    }
    if (
      !/^index [a-f0-9]+\.\.[a-f0-9]+ 100644$/u.test(lines[1] ?? "") ||
      lines[2] !== `--- a/${path}` ||
      lines[3] !== `+++ b/${path}`
    ) {
      reasons.push(`Not an existing regular text file: ${path}`);
      continue;
    }
    let index = 4;
    let removed = "";
    let added = "";
    let hunks = 0;
    while (index < lines.length) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(
        lines[index++] ?? "",
      );
      if (!hunk) {
        reasons.push(`Malformed hunk: ${path}`);
        break;
      }
      hunks++;
      let oldLeft = Number(hunk[2] ?? 1);
      let newLeft = Number(hunk[4] ?? 1);
      while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const line = lines[index++] ?? "";
        if (line === "\\ No newline at end of file") {
          continue;
        }
        if (line.startsWith("-")) {
          oldLeft--;
          removed += `${line.slice(1)}\n`;
          changedLines++;
        } else if (line.startsWith("+")) {
          newLeft--;
          added += `${line.slice(1)}\n`;
          changedLines++;
        } else if (line.startsWith(" ")) {
          oldLeft--;
          newLeft--;
        } else {
          reasons.push(`Invalid hunk line: ${path}`);
          break;
        }
        if (oldLeft < 0 || newLeft < 0) {
          break;
        }
      }
      if (oldLeft !== 0 || newLeft !== 0) {
        reasons.push(`Truncated hunk: ${path}`);
      }
      if (lines[index] === "\\ No newline at end of file") {
        index++;
      }
    }
    if (!hunks) {
      reasons.push(`No text hunks: ${path}`);
    }
    if (
      FORBIDDEN_ADDITION.test(added) ||
      ((TEST.test(path) || TEST_LIKE_PATH.test(path)) && FORBIDDEN_TEST_ADDITION.test(added))
    ) {
      reasons.push(`Forbidden added pattern: ${path}`);
    }
    if (assertionCount(added) < assertionCount(removed)) {
      reasons.push(`Assertion count decreased: ${path}`);
    }
  }
  if (!files.length || files.length > 4) {
    reasons.push("Patch must modify 1–4 files");
  }
  if (!changedLines || changedLines > 80) {
    reasons.push("Patch must change 1–80 lines");
  }
  return { passed: reasons.length === 0, reasons, files, changedLines };
}

// Escape HTML and Markdown, including mentions, so model/log text cannot inject a PR section.
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\p{Cc}/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/gu, "\\$&")
    .replaceAll("@", "&#64;");
}
export function renderPrBody(input: {
  runId: number;
  attempt: number;
  result: Result;
  tests: string[];
  guard: Verdict;
  prove: string;
  base: string;
}): string {
  const e = escapeMarkdown;
  return `Repairs failures from https://github.com/${REPO}/actions/runs/${integer(input.runId)}/attempts/${integer(input.attempt)}.\n\nFailing tests:\n\n${input.tests.map((file) => `- ${e(file)}`).join("\n")}\n\nClassification: ${e(input.result.classification)}\n\nCause: ${e(input.result.cause)}\n\nEvidence: ${e(input.result.evidence)}\n\nGuard: ${input.guard.passed ? "passed" : "failed"}; ${input.guard.files.length} files, ${input.guard.changedLines} changed lines.\n\nProof: ${e(input.prove)}\n\nThe prove verdict is evidence recorded by the repair job; this PR's own CI and review are authoritative.\n\nRepair was proved on base ${e(input.base)}. Publication applies the same guarded patch to current main without executing it; the PR's own CI verifies that resulting tree.\n\nThe CI repair agent opened this PR. It needs review before merging. Auto-merge is not enabled.\n`;
}

function readJson(name: string): unknown {
  const path = join(OUT, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
    throw new Error(`Invalid artifact: ${name}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}
function save(name: string, value: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, name),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}
function output(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}
function note(message: string) {
  console.log(message);
  mkdirSync(OUT, { recursive: true });
  appendFileSync(join(OUT, "summary.md"), `${escapeMarkdown(message)}\n\n`);
}
function command(
  program: string,
  args: string[],
  cwd = process.cwd(),
  env = process.env,
  timeout = 120000,
): string {
  return execFileSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function git(args: string[], cwd = process.cwd(), extraEnv: NodeJS.ProcessEnv = {}): string {
  const owner = process.env.CI_GIT_OWNER;
  if (!owner) {
    throw new Error("CI_GIT_OWNER must name the trusted Git lifecycle owner");
  }
  return command(
    "python3",
    [
      "-I",
      "-S",
      owner,
      "--checkout-git",
      "90",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "credential.helper=",
      ...args,
    ],
    cwd,
    {
      ...process.env,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      CI_REPAIR_READ_TOKEN: undefined,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv,
    },
    0, // The Git owner must finish descendant cleanup before this parent returns.
  );
}
function githubRead(args: string[]): string {
  const env = { ...process.env };
  const readToken = env.CI_REPAIR_READ_TOKEN;
  if (env.GITHUB_ACTIONS === "true" && !readToken) {
    throw new Error("CI_REPAIR_READ_TOKEN is required for workflow admission reads");
  }
  // In publish, GH_TOKEN is the app writer. Admission and log reads must never use it.
  if (readToken) {
    env.GH_TOKEN = readToken;
    delete env.GITHUB_TOKEN;
  }
  return command("gh", args, process.cwd(), env);
}
async function api(path: string): Promise<unknown> {
  return JSON.parse(githubRead(["api", `repos/${REPO}/${path}`]));
}
async function pages(path: string, field?: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const rows = array(field ? record(data)[field] : data);
    result.push(...rows);
    if (rows.length < 100) {
      return result;
    }
  }
  throw new Error("Admission pagination budget exceeded");
}
function parseRun(value: unknown): Run {
  const run = record(value);
  const sha = string(run.head_sha);
  if (!SHA.test(sha)) {
    throw new Error("Invalid run SHA");
  }
  return {
    id: integer(run.id),
    attempt: integer(run.run_attempt),
    sha,
    event: string(run.event),
    branch: string(run.head_branch),
    path: string(run.path),
    repository: string(record(run.repository).full_name),
    headRepository: string(record(run.head_repository).full_name),
    status: string(run.status),
    conclusion: run.conclusion === null ? "" : string(run.conclusion),
    createdAt: string(run.created_at),
  };
}
export function canonicalFailure(run: Run, dispatch: boolean): boolean {
  return (
    run.repository === REPO &&
    run.headRepository === REPO &&
    run.branch === "main" &&
    run.path === ".github/workflows/ci.yml" &&
    run.status === "completed" &&
    run.conclusion === "failure" &&
    (run.event === "schedule" || (dispatch && run.event === "push"))
  );
}
async function jobsFor(run: Run): Promise<Job[]> {
  return (await pages(`actions/runs/${run.id}/attempts/${run.attempt}/jobs`, "jobs"))
    .map((value) => {
      const job = record(value);
      return {
        id: integer(job.id),
        name: string(job.name),
        conclusion: job.conclusion === null ? "" : string(job.conclusion),
        steps: array(job.steps ?? []).map((stepValue) => {
          const step = record(stepValue);
          return {
            name: string(step.name),
            conclusion: step.conclusion === null ? "" : string(step.conclusion),
          };
        }),
      };
    })
    .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out");
}
async function inFlightOrRecovered(run: Run): Promise<string | undefined> {
  const query = new URLSearchParams({
    branch: "main",
    event: "schedule",
    status: "success",
    created: `>${run.createdAt}`,
    per_page: "5",
  });
  const recovered = array(
    record(await api(`actions/workflows/ci.yml/runs?${query}`)).workflow_runs,
  );
  if (
    recovered
      .map(parseRun)
      .some(
        (later) =>
          later.repository === REPO &&
          later.headRepository === REPO &&
          later.branch === "main" &&
          later.event === "schedule" &&
          later.path === ".github/workflows/ci.yml" &&
          later.status === "completed" &&
          later.conclusion === "success" &&
          later.createdAt > run.createdAt,
      )
  ) {
    return "A later scheduled main CI run recovered";
  }
  const refs = git(["ls-remote", REMOTE, "refs/heads/ci-repair/*"]).trim();
  for (const line of refs ? refs.split("\n") : []) {
    const match = /^[a-f0-9]{40}\trefs\/heads\/(ci-repair\/\S+)$/u.exec(line);
    if (!match?.[1]) {
      throw new Error("Invalid repair branch advertisement");
    }
    const headQuery = new URLSearchParams({
      head: `openclaw:${match[1]}`,
      state: "open",
      per_page: "1",
    });
    if (array(await api(`pulls?${headQuery}`)).length) {
      return "An open ci-repair/ PR already exists";
    }
  }
  return undefined;
}
async function verify() {
  output("allowed", "false");
  const dispatch = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  if (
    process.env.GITHUB_REPOSITORY !== REPO ||
    (dispatch && process.env.GITHUB_REF !== "refs/heads/main")
  ) {
    note("Only canonical default-branch workflows are admitted");
    return;
  }
  const event = record(JSON.parse(readFileSync(string(process.env.GITHUB_EVENT_PATH), "utf8")));
  const expected = dispatch ? undefined : record(event.workflow_run);
  const id = dispatch ? integer(Number(process.env.INPUT_RUN_ID)) : integer(expected?.id);
  const run = parseRun(await api(`actions/runs/${id}`));
  if (
    run.id !== id ||
    !canonicalFailure(run, dispatch) ||
    (expected &&
      (run.sha !== expected.head_sha ||
        run.attempt !== expected.run_attempt ||
        expected.conclusion !== "failure" ||
        expected.event !== "schedule" ||
        expected.head_branch !== "main" ||
        expected.path !== ".github/workflows/ci.yml" ||
        record(expected.head_repository).full_name !== REPO))
  ) {
    note("CI completion is not the exact failed canonical main attempt");
    return;
  }
  const skip = await inFlightOrRecovered(run);
  if (skip) {
    note(skip);
    return;
  }
  const jobs = await jobsFor(run);
  if (isInfraOnly(jobs)) {
    note("All failed jobs are infrastructure or aggregate failures, with no failed test step");
    return;
  }
  const latest = parseRun(await api(`actions/runs/${id}`));
  if (
    latest.sha !== run.sha ||
    latest.attempt !== run.attempt ||
    !canonicalFailure(latest, dispatch)
  ) {
    note("Run changed during admission");
    return;
  }
  output("run_id", String(id));
  output("attempt", String(run.attempt));
  output("head_sha", run.sha);
  output("dry_run", dispatch && process.env.INPUT_DRY_RUN !== "false" ? "true" : "false");
  output("allowed", "true");
  note(`Admitted CI run ${id}, attempt ${run.attempt}, ${run.sha}`);
}
async function jobEvidence(run: Run) {
  const evidence = [];
  for (const job of await jobsFor(run)) {
    let log = "";
    let unavailable = false;
    try {
      const cache = join(OUT, "raw", `${job.id}.log`);
      if (existsSync(cache)) {
        log = readFileSync(cache, "utf8");
      } else {
        // Native gh rejects ANSI-colored job logs by default. Capture them as data;
        // parsing and excerpts strip terminal controls before use.
        log = githubRead([
          "api",
          "--allow-escape-sequences",
          `repos/${REPO}/actions/jobs/${job.id}/logs`,
        ]);
        mkdirSync(join(OUT, "raw"), { recursive: true });
        writeFileSync(cache, log);
      }
    } catch {
      unavailable = true;
    }
    const tests = parseFailures(log);
    const shardOrder = [
      ...new Set(
        stripVTControlCharacters(log)
          .split("\n")
          .filter((line) => /pnpm test|run-vitest|test-projects/u.test(line))
          .flatMap((line) => line.match(/[a-zA-Z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?/gu) ?? [])
          .filter((file) => {
            try {
              testPath(file);
              return true;
            } catch {
              return false;
            }
          }),
      ),
    ];
    evidence.push({
      ...job,
      tests,
      shardOrder,
      classification: classifyJob(job, tests),
      excerpt: unavailable ? "Job log unavailable" : excerpt(log),
      previousFailures: [] as number[],
      unavailable,
    });
  }
  return evidence;
}
async function collect(id: number) {
  const run = parseRun(await api(`actions/runs/${id}`));
  if (!canonicalFailure(run, true)) {
    throw new Error("Collect requires a failed canonical scheduled/push main CI run");
  }
  if (
    process.env.CI_REPAIR_ATTEMPT &&
    (run.attempt !== Number(process.env.CI_REPAIR_ATTEMPT) ||
      run.sha !== process.env.CI_REPAIR_HEAD_SHA)
  ) {
    throw new Error("Run changed since admission");
  }
  const jobs = await jobEvidence(run);
  const tests: TestEvidence[] = [...new Set(jobs.flatMap((job) => job.tests))]
    .toSorted()
    .map((file) => ({ file, reproduction: "pending", previousFailures: [] }));
  const query = new URLSearchParams({
    branch: "main",
    event: "schedule",
    created: `<${run.createdAt}`,
    per_page: "6",
  });
  const previous = array(
    record(await api(`actions/workflows/ci.yml/runs?${query}`)).workflow_runs,
  ).map(parseRun);
  const history: Context["history"] = [];
  for (const prior of previous) {
    if (
      prior.repository !== REPO ||
      prior.headRepository !== REPO ||
      prior.createdAt >= run.createdAt
    ) {
      throw new Error("Invalid scheduled history");
    }
    try {
      const failures = prior.conclusion === "failure" ? await jobEvidence(prior) : [];
      history.push({
        run: prior,
        unavailable: failures.some((job) => job.unavailable) || prior.status !== "completed",
      });
      for (const job of jobs) {
        if (failures.some((other) => other.name === job.name)) {
          job.previousFailures.push(prior.id);
        }
      }
      for (const test of tests) {
        if (failures.some((job) => job.tests.includes(test.file))) {
          test.previousFailures.push(prior.id);
        }
      }
    } catch {
      history.push({ run: prior, unavailable: true });
    }
  }
  const context: Context = {
    run,
    classification:
      jobs.length && jobs.every((job) => job.classification === "infra") ? "infra" : "unknown",
    jobs,
    tests,
    history,
  };
  save("context.json", context);
  save(
    "failures.md",
    `# Failed CI ${id}, attempt ${run.attempt}\n\nClassification: ${context.classification}. Test-bearing jobs: ${jobs.filter((job) => job.classification === "tests").length}.\n\n${jobs.map((job) => `## ${escapeMarkdown(job.name)} (${job.classification})\n\nTests: ${job.tests.map(escapeMarkdown).join(", ") || "none extracted"}\n\nAlso failed in: ${job.previousFailures.join(", ") || "none observed"}\n\n<pre>${job.excerpt.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>\n`).join("\n")}`,
  );
  note(
    `Collected ${jobs.length} failed jobs; classification=${context.classification}; tests=${tests.map((test) => test.file).join(", ") || "none"}`,
  );
  console.log(
    JSON.stringify(
      {
        run_id: id,
        classification: context.classification,
        jobs: jobs.map((job) => ({
          name: job.name,
          classification: job.classification,
          tests: job.tests,
        })),
      },
      null,
      2,
    ),
  );
}
function contextData(): { runId: number; attempt: number; sha: string; tests: TestEvidence[] } {
  const data = record(readJson("context.json"));
  const run = record(data.run);
  const sha = string(run.sha);
  if (!SHA.test(sha)) {
    throw new Error("Invalid context SHA");
  }
  return {
    runId: integer(run.id),
    attempt: integer(run.attempt),
    sha,
    tests: array(data.tests).map((value) => {
      const test = record(value);
      return {
        file: testPath(test.file),
        reproduction: choice(test.reproduction, ["pending", "reproduced", "not-reproduced"]),
        previousFailures: array(test.previousFailures).map(integer),
      };
    }),
  };
}
const CANDIDATE_ENV_DENYLIST = new Set([
  "GITHUB_OUTPUT",
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CI_REPAIR_READ_TOKEN",
]);

export function buildCandidateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !CANDIDATE_ENV_DENYLIST.has(key)),
  );
}

function installDependencies() {
  const installed = spawnSync(
    "timeout",
    ["--signal=TERM", "--kill-after=15s", "600s", "pnpm", "install", "--frozen-lockfile"],
    {
      stdio: "inherit",
      env: buildCandidateEnv(process.env),
    },
  );
  if (installed.error || installed.status !== 0) {
    throw new Error(
      `Candidate dependency installation failed (exit=${installed.status ?? "unavailable"})`,
    );
  }
}

export function dependencyInputsChanged(paths: readonly string[]): boolean {
  return paths.some((path) =>
    /(?:^|\/)(?:pnpm-lock\.yaml|package\.json|pnpm-workspace\.yaml|\.npmrc)$|^patches\//u.test(
      path,
    ),
  );
}

function testOnce(file: string, name: string): boolean {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) {
    throw new Error(`Test unavailable in this tree: ${file}`);
  }
  // GNU timeout owns the complete pnpm process group on the disposable Linux runner.
  const result = spawnSync(
    "timeout",
    ["--signal=TERM", "--kill-after=15s", "480s", "pnpm", "test", file, "--maxWorkers=1"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: buildCandidateEnv(process.env),
    },
  );
  save(
    name,
    `${result.stdout ?? ""}\n${result.stderr ?? ""}\nexit=${result.status}; error=${result.error?.message ?? "none"}\n`,
  );
  if (result.error || result.status === 124 || result.status === 137 || result.status === 127) {
    throw new Error(`Test execution incomplete: ${file}`);
  }
  if (
    result.status !== 0 &&
    !parseFailures(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).includes(file)
  ) {
    throw new Error(
      `Test command failed without a named test failure: ${file}; inspect reproduction log`,
    );
  }
  return result.status === 0;
}
function reproduce() {
  const context = contextData();
  const incompleteJobs = array(record(readJson("context.json")).jobs).some((value) => {
    const job = record(value);
    return (
      job.classification === "tests" && (job.unavailable === true || array(job.tests).length === 0)
    );
  });
  if (!context.tests.length || context.tests.length > 8 || incompleteJobs) {
    save("result.json", {
      action: "diagnose",
      patch: "",
      failingTests: context.tests.map((test) => test.file),
      cause: "No complete, bounded set of failing test files",
      classification: "unknown",
      confidence: "low",
      evidence:
        "Inspect failures.md: logs are incomplete, no test paths were extracted, or more than eight files failed. No repair was attempted.",
    });
    note("No complete, bounded set of failing test files; diagnosis only");
    output("has_tests", "false");
    return;
  }
  const data = record(readJson("context.json"));
  for (const [index, test] of context.tests.entries()) {
    test.reproduction = testOnce(test.file, `reproduce-${index}.log`)
      ? "not-reproduced"
      : "reproduced";
    save("context.json", { ...data, tests: context.tests });
  }
  save("context.json", {
    ...data,
    tests: context.tests,
    classification: context.tests.every((test) => test.reproduction === "reproduced")
      ? "deterministic-break"
      : "flake",
  });
  output("has_tests", "true");
  note(
    `Reproduction: ${context.tests.map((test) => `${test.file}: ${test.reproduction}`).join("; ")}`,
  );
}
function recordGuard(verdict: Verdict): Verdict {
  save("guard.json", verdict);
  save("guard.log", JSON.stringify(verdict, null, 2));
  output("passed", String(verdict.passed));
  note(`Guard ${verdict.passed ? "passed" : `refused: ${verdict.reasons.join("; ")}`}`);
  return verdict;
}
function applyResultPatch() {
  let result: Result;
  try {
    result = parseResult(readJson("result.json"));
  } catch {
    recordGuard({
      passed: false,
      reasons: ["Invalid structured result or patch"],
      files: [],
      changedLines: 0,
    });
    return;
  }
  const verdict = guardPatch(result.patch, result);
  if (!verdict.passed) {
    recordGuard(verdict);
    return;
  }
  save("proposed.patch", result.patch);
  try {
    git(["apply", "--check", join(OUT, "proposed.patch")]);
    git(["apply", join(OUT, "proposed.patch")]);
  } catch {
    verdict.passed = false;
    verdict.reasons.push("Patch does not apply cleanly to the candidate checkout");
    recordGuard(verdict);
    return;
  }
  note("Patch text guard passed; patch applied to candidate checkout");
  workingGuard();
}
function workingGuard(): Verdict {
  const context = contextData();
  const result = parseResult(readJson("result.json"));
  const patch = git([
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--full-index",
    "HEAD",
    "--",
  ]);
  save("repair.patch", patch);
  const verdict = guardPatch(patch, result);
  if (git(["rev-parse", "HEAD"]).trim() !== context.sha) {
    verdict.reasons.push("Agent changed HEAD");
  }
  if (git(["diff", "--cached", "--name-only"]).trim()) {
    verdict.reasons.push("Agent staged changes");
  }
  if (git(["ls-files", "--others", "--exclude-standard"]).trim()) {
    verdict.reasons.push("Agent created untracked files");
  }
  if (!context.tests.length || context.tests.some((test) => test.reproduction === "pending")) {
    verdict.reasons.push("Missing reproduction evidence");
  }
  if (
    !result.failingTests.length ||
    result.failingTests.some((file) => !context.tests.some((test) => test.file === file))
  ) {
    verdict.reasons.push("Result names uncollected tests");
  }
  verdict.passed = !verdict.reasons.length;
  return recordGuard(verdict);
}
function configureAuthor(cwd = process.cwd()) {
  git(["config", "user.name", "openclaw-ci-repair[bot]"], cwd);
  git(["config", "user.email", "openclaw-ci-repair[bot]@users.noreply.github.com"], cwd);
}
function commitMessage(result: Result): string {
  return `fix(test): ${
    result.cause
      .replace(/[^a-zA-Z0-9 ,:/()-]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 90) || "repair failing CI tests"
  }`;
}
function prepareRepair() {
  const verdict = workingGuard();
  if (!verdict.passed) {
    return;
  }
  const result = parseResult(readJson("result.json"));
  configureAuthor();
  git(["add", "--", ...verdict.files]);
  git(["commit", "--no-verify", "-m", commitMessage(result)]);
  git(["fetch", "--no-tags", REMOTE, "+refs/heads/main:refs/remotes/origin/main"]);
  const base = git(["rev-parse", "origin/main"]).trim();
  try {
    git(["rebase", "--no-autostash", "origin/main"]);
  } catch {
    git(["rebase", "--abort"]);
    note("Repair conflicts with current main; no publication");
    return;
  }
  if (git(["rev-list", "--count", `${base}..HEAD`]).trim() !== "1") {
    note("Rebase did not retain exactly one repair commit");
    return;
  }
  const patch = git([
    "format-patch",
    "-1",
    "--stdout",
    "--no-signature",
    "--no-stat",
    "--full-index",
  ]);
  const rebased = guardPatch(patch, result);
  save("repair.patch", patch);
  save("guard.json", rebased);
  save("guard.log", JSON.stringify(rebased, null, 2));
  if (!rebased.passed) {
    note(`Rebased guard refused: ${rebased.reasons.join("; ")}`);
    return;
  }
  save("repair-base.json", { base });
  output("prepared", "true");
}
function prove() {
  const context = contextData();
  const result = parseResult(readJson("result.json"));
  const patch = readFileSync(join(OUT, "repair.patch"), "utf8");
  const guard = guardPatch(patch, result);
  if (!guard.passed) {
    throw new Error("Rebased patch no longer passes guard");
  }
  const base = string(record(readJson("repair-base.json")).base);
  if (!SHA.test(base)) {
    throw new Error("Invalid repair base");
  }
  const files = [
    ...new Set([
      ...context.tests.map((test) => test.file),
      ...guard.files.filter((file) => TEST.test(file)),
    ]),
  ];
  const log: string[] = [];
  const changedPaths = git([
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    context.sha,
    "HEAD",
    "--",
  ]).split("\0");
  if (dependencyInputsChanged(changedPaths)) {
    log.push("Dependency inputs changed since the failed revision; refreshing dependencies");
    save("prove.log", log.join("\n"));
    try {
      installDependencies();
    } catch (error) {
      log.push(
        `Dependency refresh failed; no publication: ${error instanceof Error ? error.message : "installation failed"}`,
      );
      save("prove.log", log.join("\n"));
      throw error;
    }
    log.push("Dependencies refreshed with pnpm install --frozen-lockfile");
  } else {
    log.push("Dependency refresh not needed: dependency inputs match the failed revision");
  }
  save("prove.log", log.join("\n"));
  note(log.at(-1)!);
  for (const [index, file] of files.entries()) {
    const rounds =
      context.tests.find((test) => test.file === file)?.reproduction === "not-reproduced" ? 5 : 1;
    for (let round = 1; round <= rounds; round++) {
      const started = performance.now();
      const passed = testOnce(file, `prove-${index}-${round}.log`);
      log.push(
        `${file}: ${round}/${rounds} ${passed ? "passed" : "FAILED"}; ${Math.round(performance.now() - started)} ms wall`,
      );
      save("prove.log", log.join("\n"));
      if (!passed) {
        note(`Proof failed: ${file}; no publication`);
        return;
      }
    }
  }
  if (
    git(["diff", "HEAD", "--name-only"]).trim() ||
    git(["ls-files", "--others", "--exclude-standard"]).trim()
  ) {
    throw new Error("Proof changed tracked or untracked source");
  }
  if (
    git(["format-patch", "-1", "--stdout", "--no-signature", "--no-stat", "--full-index"]) !== patch
  ) {
    throw new Error("Proof changed the repair commit");
  }
  save("publish-request.json", {
    run_id: context.runId,
    attempt: context.attempt,
    base,
    patch_sha256: patchSha256(patch),
    guard: "passed",
    prove: "passed",
  });
  output("publish_request", "true");
  note(
    `Proof passed for ${files.length} files. Non-reproduced failures received five consecutive passes; review is still required.`,
  );
}
function publicationData() {
  const request = record(readJson("publish-request.json"));
  const context = contextData();
  if (
    integer(request.run_id) !== Number(process.env.CI_REPAIR_RUN_ID) ||
    integer(request.attempt) !== Number(process.env.CI_REPAIR_ATTEMPT) ||
    context.runId !== request.run_id ||
    context.attempt !== request.attempt ||
    context.sha !== process.env.CI_REPAIR_HEAD_SHA ||
    request.guard !== "passed" ||
    request.prove !== "passed" ||
    !context.tests.length ||
    context.tests.some((test) => test.reproduction === "pending")
  ) {
    throw new Error("Invalid publish request or evidence identity");
  }
  const base = string(request.base);
  if (!SHA.test(base)) {
    throw new Error("Invalid base commit");
  }
  const path = join(OUT, "repair.patch");
  if (
    !lstatSync(path).isFile() ||
    lstatSync(path).isSymbolicLink() ||
    lstatSync(path).size > MAX_PATCH
  ) {
    throw new Error("Invalid patch artifact");
  }
  const patch = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    readFileSync(path),
  );
  const result = parseResult(readJson("result.json"));
  const guard = guardPatch(patch, result, string(request.patch_sha256));
  if (!guard.passed) {
    throw new Error(`Publisher guard refused: ${guard.reasons.join("; ")}`);
  }
  return { context, base, patch, result, guard };
}
async function publicationAdmission() {
  const run = parseRun(await api(`actions/runs/${integer(Number(process.env.CI_REPAIR_RUN_ID))}`));
  if (
    !canonicalFailure(run, true) ||
    run.attempt !== Number(process.env.CI_REPAIR_ATTEMPT) ||
    run.sha !== process.env.CI_REPAIR_HEAD_SHA
  ) {
    throw new Error("Failed run changed since verification");
  }
  const reason = await inFlightOrRecovered(run);
  if (reason) {
    throw new Error(reason);
  }
}
async function preparePublish() {
  output("ready", "false");
  const data = publicationData();
  await publicationAdmission();
  const cwd = string(process.env.CI_REPAIR_PUBLISH_DIR);
  if (existsSync(cwd)) {
    throw new Error("Publisher directory must be fresh");
  }
  mkdirSync(cwd, { recursive: true });
  git(["init", "--template=", "."], cwd);
  git(["fetch", "--no-tags", REMOTE, "+refs/heads/main:refs/remotes/origin/main"], cwd);
  git(["merge-base", "--is-ancestor", data.base, "origin/main"], cwd);
  git(["checkout", "--detach", "origin/main"], cwd);
  // This directory is data only. Continue running the controller from the trusted checkout.
  git(["apply", "--check", join(OUT, "repair.patch")], cwd);
  git(["apply", "--index", join(OUT, "repair.patch")], cwd);
  configureAuthor(cwd);
  git(["commit", "--no-verify", "-m", commitMessage(data.result)], cwd);
  const actual = guardPatch(
    git(["diff", "--no-ext-diff", "--no-textconv", "--full-index", "HEAD^", "HEAD", "--"], cwd),
    data.result,
  );
  if (!actual.passed) {
    throw new Error("Applied patch failed trusted guard");
  }
  save("publisher-guard.json", actual);
  save(
    "pr-body.md",
    renderPrBody({
      runId: data.context.runId,
      attempt: data.context.attempt,
      result: data.result,
      tests: data.context.tests.map((test) => test.file),
      guard: actual,
      prove: string(readFileSync(join(OUT, "prove.log"), "utf8")),
      base: data.base,
    }),
  );
  const branch = `ci-repair/${data.context.runId}`;
  if (git(["ls-remote", REMOTE, `refs/heads/${branch}`], cwd).trim()) {
    throw new Error("Repair branch already exists; never overwrite it");
  }
  output("ready", "true");
  note(`Trusted publisher prepared ${branch}; patch code was not executed`);
}
async function publish() {
  const data = publicationData();
  await publicationAdmission();
  const cwd = string(process.env.CI_REPAIR_PUBLISH_DIR);
  const branch = `ci-repair/${data.context.runId}`;
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error("App token unavailable");
  }
  // The empty lease requires an absent ref atomically; an existing branch is never updated.
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  git(
    ["push", `--force-with-lease=refs/heads/${branch}:`, REMOTE, `HEAD:refs/heads/${branch}`],
    cwd,
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: auth,
    },
  );
  const url = command("gh", [
    "pr",
    "create",
    "--repo",
    REPO,
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    commitMessage(data.result),
    "--body-file",
    join(OUT, "pr-body.md"),
  ]).trim();
  save("pr-url.txt", url);
  note(`Opened ${url}; review required, auto-merge remains disabled`);
  const labels = JSON.parse(
    githubRead(["label", "list", "--repo", REPO, "--search", "ci-repair", "--json", "name"]),
  );
  if (array(labels).some((value) => record(value).name === "ci-repair")) {
    command("gh", ["pr", "edit", url, "--repo", REPO, "--add-label", "ci-repair"]);
  }
}
export async function main(args: string[]) {
  const [operation, id] = args;
  try {
    switch (operation) {
      case "install":
        installDependencies();
        break;
      case "verify":
        await verify();
        break;
      case "collect":
        await collect(integer(Number(id ?? process.env.CI_REPAIR_RUN_ID)));
        break;
      case "reproduce":
        reproduce();
        break;
      case "guard":
        applyResultPatch();
        break;
      case "prepare-repair":
        prepareRepair();
        break;
      case "prove":
        prove();
        break;
      case "prepare-publish":
        await preparePublish();
        break;
      case "publish":
        await publish();
        break;
      case "render-pr-body": {
        const data = publicationData();
        save(
          "pr-body.md",
          renderPrBody({
            runId: data.context.runId,
            attempt: data.context.attempt,
            result: data.result,
            tests: data.context.tests.map((test) => test.file),
            guard: data.guard,
            prove: readFileSync(join(OUT, "prove.log"), "utf8"),
            base: data.base,
          }),
        );
        break;
      }
      case "summary": {
        if (existsSync(join(OUT, "result.json"))) {
          try {
            const result = parseResult(readJson("result.json"));
            note(`${result.action}: ${result.classification}; ${result.cause}; ${result.evidence}`);
          } catch {
            note("No valid structured agent result; publication is not authorized");
          }
        }
        if (process.env.GITHUB_STEP_SUMMARY && existsSync(join(OUT, "summary.md"))) {
          appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(join(OUT, "summary.md")));
        }
        break;
      }
      default:
        throw new Error(
          "Usage: ci-repair-agent.mjs install|verify|collect <run-id>|reproduce|guard|prepare-repair|prove|prepare-publish|publish|render-pr-body|summary",
        );
    }
  } catch (error) {
    // Child stderr can contain credentials; never forward execFile errors verbatim.
    const message =
      error instanceof Error && !Object.hasOwn(error, "stderr")
        ? error.message
        : "External command failed; publication stopped";
    note(`${operation}: ${message}`);
    process.exitCode = 1;
  }
}
