import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { z } from "zod";
import outputSchema from "../.github/codex/prompts/ci-test-selection.schema.json" with { type: "json" };
import { isTestFileTarget } from "./lib/changed-path-facts.mjs";
import { decodeNodeTestGroups } from "./lib/ci-node-test-groups-codec.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const DIFF_PROMPT_CHARS = 80_000;
const DIFF_LIMIT_CHARS = 320_000;
// JSON imports widen schema keywords to strings; the schema parser validates them.
const outputValidator = z.fromJSONSchema(outputSchema as z.core.JSONSchema.JSONSchema);
const strings = z.array(z.string());
const groupSchema = z.object({
  configs: strings,
  includePatterns: strings.optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const rowSchema = groupSchema.partial().extend({
  check_name: z.string(),
  targets: strings.optional(),
  groups: z.array(groupSchema).optional(),
  groups_gzip_base64: z.string().optional(),
});
const preparedSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.string(),
  base: z.string(),
  head: z.string(),
  candidates: strings,
  floor: strings,
  prefixes: strings,
  nodeJobs: strings,
  preparedAtMs: z.number(),
  fileSeconds: z.record(z.string(), z.number()).optional(),
});
type Prepared = z.infer<typeof preparedSchema>;
type CodexOutput = {
  keep: { path: string; reason: string }[];
  confidence: "high" | "medium" | "low";
  summary: string;
};
type Selection = ReturnType<typeof finalizeSelection>;
const sorted = (files: Iterable<string>) => [...new Set(files)].toSorted();

/** Bounded directory trie: splitting a collapsed prefix never exceeds the line budget. */
export function groupCandidates(files: string[], maxLines = 500) {
  const entries = sorted(
    files.map((file) => (file.includes("/") ? `${file.split("/")[0]}/` : file)),
  );
  const under = (prefix: string) => files.filter((file) => file.startsWith(prefix));
  for (let index = 0; index < entries.length; index++) {
    const prefix = entries[index]!;
    if (!prefix.endsWith("/")) {
      continue;
    }
    const members = under(prefix);
    const children =
      members.length <= 8
        ? sorted(members)
        : sorted(
            members.map((file) => {
              const rest = file.slice(prefix.length);
              const slash = rest.indexOf("/");
              return slash < 0 ? file : prefix + rest.slice(0, slash + 1);
            }),
          );
    if (entries.length - 1 + children.length <= maxLines && children[0] !== prefix) {
      entries.splice(index, 1, ...children);
      index--;
    }
  }
  return {
    prefixes: entries.filter((entry) => entry.endsWith("/")),
    lines: entries.map((entry) =>
      entry.endsWith("/") ? `${entry} (${under(entry).length} files)` : entry,
    ),
  };
}

/** The model cannot alter the candidate universe or any deterministic floor member. */
export function finalizeSelection(
  prepared: Prepared,
  raw?: string,
  outcome = "success",
  durationMs = 0,
) {
  let status = prepared.status;
  let output: CodexOutput | undefined;
  if (status === "ready") {
    if (outcome !== "success") {
      status = `fallback:codex-${outcome || "failure"}`;
    } else if (!raw?.trim()) {
      status = "fallback:missing-output";
    } else {
      try {
        const parsed = outputValidator.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          status = "fallback:invalid-schema";
        } else {
          // The checked-in output schema owns this validated external boundary.
          output = parsed.data as CodexOutput;
          status = output.confidence === "low" ? "fallback:low-confidence" : "shadow";
        }
      } catch {
        status = "fallback:invalid-json";
      }
    }
  }
  const candidates = sorted(prepared.candidates);
  const candidateSet = new Set(candidates);
  const floor = sorted(prepared.floor.filter((file) => candidateSet.has(file)));
  const kept = new Set(floor);
  let invalidEntries = 0;
  for (const entry of output?.keep ?? []) {
    const matches = candidateSet.has(entry.path)
      ? [entry.path]
      : prepared.prefixes.includes(entry.path) && entry.path.endsWith("/")
        ? candidates.filter((file) => file.startsWith(entry.path))
        : [];
    if (!matches.length) {
      invalidEntries++;
    }
    for (const file of matches) {
      kept.add(file);
    }
  }
  const selected = status === "shadow" ? sorted(kept) : candidates;
  const selectedSet = new Set(selected);
  const pruned = candidates.filter((file) => !selectedSet.has(file));
  const completeTimings =
    pruned.length > 0 && pruned.every((file) => prepared.fileSeconds?.[file] !== undefined);
  return {
    schemaVersion: 1 as const,
    status,
    base: prepared.base,
    head: prepared.head,
    candidates,
    floor,
    selected,
    pruned,
    counts: {
      candidates: candidates.length,
      floor: floor.length,
      prunable: candidates.length - floor.length,
      selected: selected.length,
      pruned: pruned.length,
    },
    ...(completeTimings
      ? {
          estimatedPrunedSeconds: pruned.reduce(
            (total, file) => total + prepared.fileSeconds![file]!,
            0,
          ),
        }
      : {}),
    codex: {
      confidence: output?.confidence ?? null,
      summary: output?.summary ?? "",
      invalidEntries,
      durationMs,
    },
  };
}

export function extractFailingTestFiles(log: string) {
  const files = new Set<string>();
  const add = (value: string) => {
    const normalized = value
      .replaceAll("%0A", "\n")
      .replaceAll("%0D", "\r")
      .replaceAll("%2C", ",")
      .replaceAll("%25", "%")
      .replaceAll("\\", "/")
      .replace(/^\.\//u, "");
    const relative = /(?:^|[\s/])((?:src|test|extensions|packages|ui)\/.*)$/u.exec(normalized)?.[1];
    if (relative && !relative.split("/").includes("..") && isTestFileTarget(relative)) {
      files.add(relative);
    }
  };
  for (const line of stripVTControlCharacters(log).split(/\r?\n/u)) {
    const annotation = /::error\s+[^\r\n]*?\bfile=([^,\r\n]*?)(?:,|::)/u.exec(line);
    if (annotation?.[1]) {
      add(annotation[1]);
    }
    const failure = /\bFAIL\s+(?:\[[^\]]+\]\s+)?(.+?\.(?:test|spec)\.[cm]?[jt]sx?)(?=\s|$)/u.exec(
      line,
    );
    if (failure?.[1]) {
      add(failure[1]);
    }
  }
  return sorted(files);
}

export function classifyFailures(
  selection: Pick<Selection, "candidates" | "floor" | "selected">,
  files: string[],
) {
  const candidates = new Set(selection.candidates),
    floor = new Set(selection.floor),
    selected = new Set(selection.selected);
  return sorted(files).map((file) => ({
    path: file,
    classification: !candidates.has(file)
      ? "outside-candidates"
      : floor.has(file)
        ? "floor"
        : selected.has(file)
          ? "codex-kept"
          : "codex-pruned",
    miss: candidates.has(file) && !selected.has(file),
  }));
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function summary(file: string, text: string) {
  writeFileSync(file, text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
}
function writeSelection(dir: string, selection: Selection) {
  writeJson(path.join(dir, "selection.json"), selection);
  const count = selection.counts;
  summary(
    path.join(dir, "summary.md"),
    `### Codex test selection (shadow)\n\nStatus: ${selection.status}. Candidates: ${count.candidates}; floor: ${count.floor}; selected: ${count.selected}; would prune: ${count.pruned}. Invalid entries: ${selection.codex.invalidEntries}.\n\nThe complete deterministic plan still runs; this does not gate merging.\n`,
  );
  console.log(JSON.stringify({ status: selection.status, ...selection.counts }));
}
function git(args: string[], cwd = process.cwd()) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/** Exact targets come from preflight; Vitest owns file discovery for whole-config rows. */
async function candidateFiles(rows: z.infer<typeof rowSchema>[]) {
  const files = new Set<string>();
  const { writeVitestIncludeFile } = await import("./test-projects.test-support.mts");
  for (const row of rows) {
    if (row.targets?.length) {
      row.targets.forEach((file) => files.add(file));
      continue;
    }
    const groups = row.groups_gzip_base64
      ? decodeNodeTestGroups(row.groups_gzip_base64).map((group) => groupSchema.parse(group))
      : (row.groups ?? [groupSchema.parse({ ...row, configs: row.configs ?? [] })]);
    for (const group of groups) {
      if (
        group.includePatterns?.length &&
        group.includePatterns.every((file) => isTestFileTarget(file) && !/[*?{}[\]]/u.test(file))
      ) {
        group.includePatterns.forEach((file) => files.add(file));
        continue;
      }
      if (!group.configs.length) {
        throw new Error("missing-inventory-config");
      }
      const { createVitest } = await import("vitest/node");
      const previous = { ...process.env };
      const scratch = mkdtempSync(path.join(tmpdir(), "openclaw-selection-inventory-"));
      try {
        Object.assign(process.env, group.env);
        delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
        if (group.includePatterns?.length) {
          const includes = path.join(scratch, "include.json");
          writeVitestIncludeFile(includes, group.includePatterns);
          process.env.OPENCLAW_VITEST_INCLUDE_FILE = includes;
        }
        const ctx = await createVitest({ config: false, watch: false, projects: group.configs });
        try {
          for (const spec of await ctx.globTestSpecifications()) {
            files.add(path.relative(process.cwd(), spec.moduleId).replaceAll("\\", "/"));
          }
        } finally {
          await ctx.close();
        }
      } finally {
        for (const key of Object.keys(process.env)) {
          if (!(key in previous)) {
            delete process.env[key];
          }
        }
        Object.assign(process.env, previous);
        rmSync(scratch, { recursive: true });
      }
    }
  }
  return sorted(files).filter(isTestFileTarget);
}

const contextSchema = z.object({
  changedPaths: strings,
  fallbackReason: z.string().nullish(),
  options: z
    .object({
      baseRef: z.string().optional(),
      runnerBackend: z.string().optional(),
      releaseFastLane: z.boolean().optional(),
      dedicatedCoreTypeChecks: z.boolean().optional(),
      dedicatedBuildArtifacts: z.boolean().optional(),
      dedicatedNativeChecks: z
        .object({ macos: z.boolean(), ios: z.boolean(), android: z.boolean() })
        .optional(),
      includeReleaseOnlyToolingShards: z.boolean().optional(),
      includeReleaseOnlyRuntimeTests: z.boolean().optional(),
      includePrExemptRuntimeTests: z.boolean().optional(),
      dedicatedUiE2e: z.boolean().optional(),
      dedicatedMaxLinesRatchet: z.boolean().optional(),
      dedicatedContractShards: z
        .array(z.object({ task: z.string(), includePatterns: strings }))
        .optional(),
    })
    .nullish(),
});

async function prepare(base: string, head: string, dir: string) {
  const changedPaths = git(["diff", "--name-only", "-z", "--no-renames", base, head, "--"])
    .split("\0")
    .filter(Boolean);
  const context = process.env.OPENCLAW_CI_SELECTION_CONTEXT
    ? contextSchema.parse(JSON.parse(process.env.OPENCLAW_CI_SELECTION_CONTEXT))
    : undefined;
  if (
    context &&
    JSON.stringify(sorted(context.changedPaths)) !== JSON.stringify(sorted(changedPaths))
  ) {
    throw new Error("changed-paths-mismatch");
  }
  const { createChangedNodeTestShards, createChangedExtensionFallbackShards } =
    await import("./lib/ci-changed-node-test-plan.mts");
  const { createNodeTestShardBundles } = await import("./lib/ci-node-test-plan.mts");
  const { readToolingFileTimings } = await import("./lib/ci-test-timings.mts");
  let fallbackReason = context?.fallbackReason;
  let prunableTargets: string[] = [];
  const options = context?.options ?? {
    baseRef: base,
    runnerBackend: "hybrid",
    dedicatedCoreTypeChecks: true,
    dedicatedBuildArtifacts: false,
    includeReleaseOnlyToolingShards: false,
    includeReleaseOnlyRuntimeTests: false,
    includePrExemptRuntimeTests: false,
  };
  const changed = createChangedNodeTestShards(changedPaths, {
    ...options,
    onFallback: (reason) => {
      fallbackReason = reason;
    },
    onSelectionEvidence: (evidence) => {
      prunableTargets = evidence.prunableTargets;
    },
  });
  const rows = process.env.OPENCLAW_CI_SELECTION_MATRIX
    ? z
        .object({ include: z.array(rowSchema) })
        .parse(JSON.parse(process.env.OPENCLAW_CI_SELECTION_MATRIX)).include
    : (
        changed ?? [
          ...createNodeTestShardBundles({
            changedPaths,
            compactMode: "pull-request",
            runnerBackend: options.runnerBackend,
            includeReleaseOnlyPluginShards: false,
            includeReleaseOnlyToolingShards: false,
            includeReleaseOnlyRuntimeTests: false,
            includePrExemptRuntimeTests: false,
            includeProofTests: false,
          }),
          ...createChangedExtensionFallbackShards(changedPaths, {
            includePrExemptRuntimeTests: false,
          }),
        ]
      )
        .filter((row) => !row.requiresDist)
        .map((row) => rowSchema.parse({ ...row, check_name: row.checkName }));
  const candidates = await candidateFiles(rows);
  const prunableSet = new Set(prunableTargets);
  const floor = candidates.filter((file) => !prunableSet.has(file));
  const prunable = candidates.filter((file) => prunableSet.has(file));
  const diffResult = spawnSync(
    "git",
    ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", base, head, "--"],
    { encoding: "utf8", maxBuffer: DIFF_LIMIT_CHARS * 4, stdio: ["ignore", "pipe", "pipe"] },
  );
  const oversized =
    diffResult.error && "code" in diffResult.error && diffResult.error.code === "ENOBUFS";
  if (!oversized && (diffResult.error || diffResult.status !== 0)) {
    throw new Error("diff-unavailable");
  }
  const diff = diffResult.stdout ?? "";
  const grouped = groupCandidates(prunable);
  const prepared: Prepared = {
    schemaVersion: 1,
    status:
      changed === null || fallbackReason
        ? "skipped:broad-fallback"
        : oversized || diff.length > DIFF_LIMIT_CHARS
          ? "skipped:diff-too-large"
          : !prunable.length
            ? "skipped:no-prunable-candidates"
            : "ready",
    base,
    head,
    candidates,
    floor,
    prefixes: grouped.prefixes,
    nodeJobs: rows.map((row) => row.check_name),
    preparedAtMs: Date.now(),
    fileSeconds: {
      ...readToolingFileTimings(options.runnerBackend === "github" ? "github" : "blacksmith"),
    },
  };
  writeJson(path.join(dir, "prepared.json"), prepared);
  const prompt = readFileSync(
    new URL("../.github/codex/prompts/ci-test-selection.md", import.meta.url),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "prompt.md"),
    `${prompt}\n${JSON.stringify({ base, head, stat: git(["diff", "--stat", base, head, "--"]), changedPaths, floorCount: floor.length, prunableCandidates: grouped.lines, diff: diff.slice(0, DIFF_PROMPT_CHARS), truncated: diff.length > DIFF_PROMPT_CHARS }, null, 2)}\n`,
  );
  // A usable all-candidate artifact exists even if the model step is interrupted.
  writeSelection(dir, finalizeSelection(prepared));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${prepared.status === "ready"}\n`);
  }
  return prepared;
}

async function finalize(dir: string, outcome = process.env.OPENCLAW_CI_CODEX_OUTCOME ?? "success") {
  let prepared: Prepared;
  try {
    prepared = preparedSchema.parse(
      JSON.parse(readFileSync(path.join(dir, "prepared.json"), "utf8")),
    );
  } catch {
    // Preflight's immutable matrix can recover the all-test artifact even when
    // preparation failed before publishing its provenance or prompt.
    const rows = z
      .object({ include: z.array(rowSchema) })
      .parse(JSON.parse(process.env.OPENCLAW_CI_SELECTION_MATRIX ?? "null")).include;
    const candidates = await candidateFiles(rows);
    prepared = {
      schemaVersion: 1,
      status: "fallback:prepare-error",
      base: process.env.CHECKOUT_BASE_SHA ?? "",
      head: git(["rev-parse", "HEAD"]),
      candidates,
      floor: candidates,
      prefixes: [],
      nodeJobs: rows.map((row) => row.check_name),
      preparedAtMs: Date.now(),
    };
    writeJson(path.join(dir, "prepared.json"), prepared);
  }
  if (process.env.OPENCLAW_CI_PREPARE_OUTCOME === "failure") {
    prepared.status = "fallback:prepare-error";
  }
  let raw: string | undefined;
  try {
    raw = readFileSync(path.join(dir, "codex-output.json"), "utf8");
  } catch {
    /* Missing output keeps the deterministic plan. */
  }
  const selection = finalizeSelection(
    prepared,
    raw,
    outcome,
    prepared.status === "ready" ? Math.max(0, Date.now() - prepared.preparedAtMs) : 0,
  );
  writeSelection(dir, selection);
}

const jobSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  run_attempt: z.number().optional(),
});
async function report(dir: string) {
  const errors: string[] = [],
    unknown: { job: string; reason: string }[] = [];
  let failures: ReturnType<typeof classifyFailures> = [];
  let inspectedJobs = 0;
  const runId = process.env.GITHUB_RUN_ID ?? "",
    attempt = process.env.GITHUB_RUN_ATTEMPT ?? "",
    repo = process.env.GITHUB_REPOSITORY ?? "";
  try {
    const prepared = preparedSchema.parse(
      JSON.parse(readFileSync(path.join(dir, "prepared.json"), "utf8")),
    );
    const selection = z
      .object({ candidates: strings, floor: strings, selected: strings })
      .parse(JSON.parse(readFileSync(path.join(dir, "selection.json"), "utf8")));
    if (
      !/^\d+$/u.test(runId) ||
      !/^[1-9]\d*$/u.test(attempt) ||
      !/^[\w.-]+\/[\w.-]+$/u.test(repo)
    ) {
      throw new Error("invalid-run-context");
    }
    const api = async (endpoint: string) => {
      const response = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`github-http-${response.status}`);
      }
      return response;
    };
    const jobs: z.infer<typeof jobSchema>[] = [];
    for (let page = 1; ; page++) {
      const response = await api(
        `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      );
      const result = z.object({ jobs: z.array(jobSchema) }).parse(await response.json());
      jobs.push(...result.jobs);
      if (result.jobs.length < 100) {
        break;
      }
    }
    const nodeJobs = jobs.filter((job) => prepared.nodeJobs.includes(job.name));
    for (const name of prepared.nodeJobs) {
      if (!nodeJobs.some((job) => job.name === name)) {
        unknown.push({ job: name, reason: "missing-in-attempt" });
      }
    }
    const failedFiles = new Set<string>();
    for (const job of nodeJobs) {
      if (job.run_attempt !== undefined && job.run_attempt !== Number(attempt)) {
        unknown.push({ job: job.name, reason: "different-attempt" });
        continue;
      }
      if (job.conclusion === "success") {
        continue;
      }
      if (job.conclusion !== "failure") {
        unknown.push({ job: job.name, reason: job.conclusion ?? job.status });
        if (job.conclusion !== "timed_out") {
          continue;
        }
      }
      try {
        const files = extractFailingTestFiles(
          await (await api(`actions/jobs/${job.id}/logs`)).text(),
        );
        inspectedJobs++;
        if (!files.length) {
          unknown.push({ job: job.name, reason: "no-failing-file-found" });
        }
        files.forEach((file) => failedFiles.add(file));
      } catch {
        errors.push(`job-${job.id}:log-unavailable`);
        unknown.push({ job: job.name, reason: "log-unavailable" });
      }
    }
    failures = classifyFailures(selection, [...failedFiles]);
  } catch {
    errors.push("report-input-or-jobs-unavailable");
  }
  const misses = failures.filter((failure) => failure.miss).length;
  const result = {
    schemaVersion: 1,
    runId,
    attempt,
    status: errors.length ? "error" : unknown.length ? "partial" : "complete",
    inspectedJobs,
    failures,
    misses,
    unknown,
    errors,
  };
  writeJson(path.join(dir, "report.json"), result);
  const display = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll("|", "&#124;")
      .replaceAll("`", "&#96;")
      .replace(/[\r\n]/gu, " ");
  summary(
    path.join(dir, "report-summary.md"),
    `### Codex test selection report (shadow)\n\nStatus: ${result.status}. MISS files: ${misses}. Unknown jobs: ${unknown.length}. Errors: ${errors.length}.\n\n${failures.map((file) => `- ${file.miss ? "**MISS** " : ""}${display(file.path)}: ${file.classification}\n`).join("")}\nCancelled, skipped, missing, and unreadable jobs are unknown, not evidence that selection was safe.\n`,
  );
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      "output-dir": { type: "string", default: "artifacts/codex-test-selection" },
      model: { type: "string" },
    },
  });
  const command = positionals[0],
    dir = path.resolve(values["output-dir"]);
  if (command === "report") {
    try {
      mkdirSync(dir, { recursive: true });
      await report(dir);
    } catch {
      // Even artifact/output failures must not turn this observational command into a gate.
      try {
        writeJson(path.join(dir, "report.json"), {
          schemaVersion: 1,
          status: "error",
          errors: ["report-write-failed"],
        });
      } catch {
        /* The output filesystem may be unavailable. */
      }
    }
    return;
  }
  mkdirSync(dir, { recursive: true });
  if (command === "finalize") {
    await finalize(dir);
    return;
  }
  if (command !== "prepare" && command !== "backtest") {
    throw new Error(
      "usage: prepare|finalize|report|backtest [--base ref --head ref --output-dir path --model model]",
    );
  }
  if (!values.base || !values.head) {
    throw new Error("--base and --head are required");
  }
  const base = git(["rev-parse", "--verify", `${values.base}^{commit}`]),
    head = git(["rev-parse", "--verify", `${values.head}^{commit}`]);
  const origin = process.cwd();
  let temporary: string | undefined;
  try {
    if (head !== git(["rev-parse", "HEAD"])) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error("checkout-head-mismatch");
      }
      temporary = mkdtempSync(path.join(tmpdir(), "openclaw-selection-head-"));
      const checkout = path.join(temporary, "checkout");
      git(["worktree", "add", "--detach", checkout, head]);
      if (existsSync(path.join(origin, "node_modules"))) {
        symlinkSync(path.join(origin, "node_modules"), path.join(checkout, "node_modules"), "dir");
      }
      process.chdir(checkout);
    }
    const prepared = await prepare(base, head, dir);
    if (command === "backtest") {
      let outcome = "skipped";
      if (prepared.status === "ready") {
        const args = [
          "exec",
          "--sandbox",
          "read-only",
          "--output-schema",
          fileURLToPath(
            new URL("../.github/codex/prompts/ci-test-selection.schema.json", import.meta.url),
          ),
          "--output-last-message",
          path.join(dir, "codex-output.json"),
          "-c",
          'model_reasoning_effort="medium"',
          ...(values.model ? ["--model", values.model] : []),
          "-",
        ];
        const result = spawnSync("codex", args, {
          input: readFileSync(path.join(dir, "prompt.md"), "utf8"),
          encoding: "utf8",
          timeout: 8 * 60_000,
          stdio: ["pipe", "ignore", "ignore"],
        });
        outcome =
          result.error && "code" in result.error && result.error.code === "ETIMEDOUT"
            ? "timeout"
            : result.status === 0
              ? "success"
              : "failure";
      }
      await finalize(dir, outcome);
    }
  } finally {
    process.chdir(origin);
    if (temporary) {
      const checkout = path.join(temporary, "checkout");
      if (existsSync(path.join(checkout, ".git"))) {
        if (existsSync(path.join(checkout, "node_modules"))) {
          rmSync(path.join(checkout, "node_modules"));
        }
        git(["worktree", "remove", checkout]);
      }
      rmSync(temporary, { recursive: true });
    }
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(
      "[ci-codex-test-selection] command failed; no test execution or gate was changed",
    );
    process.exitCode = process.argv[2] === "report" ? 0 : 1;
  }
}
