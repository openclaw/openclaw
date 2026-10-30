#!/usr/bin/env node
// Runs the fast generated-artifact and docs checks CI fails on, selected from
// staged paths. guard-staged-content.mjs runs this and redacts its output.
// Typecheck, lint and tests stay with hosted CI.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  hasAgentsInstructionInput,
  hasConfigDocInput,
  hasLineCapRatchetInput,
  hasNativeI18nInput,
  isDocsMarkdownLintPath,
} from "../changed-lanes.mts";
import { hasProtocolGenerationInput } from "../lib/ci-check-family-scope.mts";
import { toolingDependencyOptions } from "../lib/tooling-dependencies.mjs";

type FreshnessCheck = {
  name: string;
  script: string;
  /** Explicitly opts this entry into qualified tooling without a workspace link. */
  toolingEntrypoint?: string;
  args: string[];
  fix: string;
  /** Staged paths that select the check. A trigger list, not the check's full input set. */
  selects: (paths: string[]) => boolean;
  /**
   * Which unstaged edits can change the verdict: "index" checks read staged bytes only;
   * "tree" checks import the working-tree code graph, so any unstaged edit skips them.
   */
  unstagedInputs: "index" | "tree" | ((paths: string[]) => boolean);
};

/** Selects freshness checks for staged paths; an empty list means the hook adds no work. */
export function selectStagedFreshnessChecks(paths: string[]): FreshnessCheck[] {
  const docs = paths.filter((file) => isDocsMarkdownLintPath(file) && existsSync(file));
  const checks: FreshnessCheck[] = [
    {
      name: "docs markdown lint",
      script: "lint:docs",
      args: ["--no-globs", ...docs],
      fix: "pnpm lint:docs:fix",
      selects: () => docs.length > 0,
      // markdownlint reads only the named files and its config.
      unstagedInputs: (changed) =>
        changed.some((file) => docs.includes(file) || file.startsWith("config/markdownlint")),
    },
    {
      name: "AGENTS.md bootstrap size",
      script: "check:agents-md-size",
      args: [],
      fix: "cut rules or move them to the owning scoped AGENTS.md",
      selects: hasAgentsInstructionInput,
      unstagedInputs: "tree",
    },
    {
      name: "protocol generated models",
      script: "protocol:check",
      args: [],
      fix: "pnpm protocol:gen:swift && pnpm protocol:gen:kotlin",
      selects: hasProtocolGenerationInput,
      unstagedInputs: "tree",
    },
    {
      name: "native app i18n inventory",
      script: "native:i18n:verify",
      toolingEntrypoint: "scripts/native-app-i18n.ts",
      args: ["verify"],
      fix: "pnpm native:i18n:baseline from an independently installed checkout of this branch",
      selects: hasNativeI18nInput,
      unstagedInputs: "tree",
    },
    {
      name: "config docs baseline",
      script: "config:docs:check",
      args: [],
      fix: "pnpm config:docs:gen",
      selects: hasConfigDocInput,
      unstagedInputs: "tree",
    },
    {
      name: "line-cap growth ratchet",
      script: "check:line-cap-ratchet",
      args: ["--staged", "--base", "HEAD"],
      fix: "move new code or tests to a sibling file",
      selects: hasLineCapRatchetInput,
      unstagedInputs: "index",
    },
  ];
  return checks.filter((check) => check.selects(paths));
}

function gitPaths(args: string[]) {
  const result = spawnSync("git", [...args, "-z"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

function replayingCommits() {
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).stdout.trim();
  // Same operation states as format-staged.sh; hosted CI checks the replayed result.
  return [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "sequencer",
    "rebase-merge",
    "rebase-apply",
  ]
    .map((name) => path.join(gitDir, name))
    .some((file) => existsSync(file));
}

// pnpm startup dominates these checks, so plain `node ...` package scripts run directly.
function resolveCommand(check: FreshnessCheck): [string, string[]] {
  if (check.toolingEntrypoint) {
    const tooling = toolingDependencyOptions(process.cwd(), check.script, { tsx: true });
    return [
      process.versions.bun ? "node" : process.execPath,
      [
        ...(tooling.execArgv ?? []),
        "--import",
        tooling.tsxImport ?? new URL("../tsx.mjs", import.meta.url).href,
        check.toolingEntrypoint,
        ...check.args,
      ],
    ];
  }
  const script = JSON.parse(readFileSync("package.json", "utf8")).scripts?.[check.script];
  if (typeof script === "string" && /^node(?: [\w./:=@-]+)+$/u.test(script)) {
    return [process.execPath, [...script.split(" ").slice(1), ...check.args]];
  }
  return ["pnpm", ["run", check.script, ...check.args]];
}

// Independent read-only checks run together so the hook costs the slowest one.
async function run(check: FreshnessCheck) {
  let invocation: [string, string[]];
  try {
    invocation = resolveCommand(check);
  } catch (error) {
    return { check, status: 1, output: String(error) };
  }
  const [command, args] = invocation;
  return await new Promise<{ check: FreshnessCheck; status: number; output: string }>((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: check.toolingEntrypoint ? { ...process.env, TSX_DISABLE_CACHE: "1" } : process.env,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ check, status: 1, output: String(error) }));
    child.on("close", (status) => resolve({ check, status: status ?? 1, output }));
  });
}

if (import.meta.main && !replayingCommits()) {
  const staged = gitPaths([
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    "--diff-filter=ACDMRT",
  ]);
  const selected = selectStagedFreshnessChecks(staged);
  // Judge only the bytes being committed: unstaged edits a check may read skip it.
  const unstaged = selected.length ? gitPaths(["diff", "--name-only", "--no-renames"]) : [];
  const checks = selected.filter((check) => {
    const { unstagedInputs } = check;
    const dirty =
      unstagedInputs === "tree"
        ? unstaged.length > 0
        : unstagedInputs !== "index" && unstagedInputs(unstaged);
    if (dirty) {
      process.stdout.write(
        `[pre-commit] ${check.name} skipped: its inputs have unstaged changes.\n`,
      );
      return false;
    }
    return true;
  });
  for (const { check, status, output } of await Promise.all(checks.map(run))) {
    if (status !== 0) {
      process.stderr.write(
        `${output.trimEnd()}\n[pre-commit] ${check.name} failed (pnpm ${check.script}). Fix: ${check.fix}.\n`,
      );
      process.exitCode = 1;
    }
  }
}
