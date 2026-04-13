#!/usr/bin/env -S node --import tsx
// Lesson-engine CLI entry point.
//
// Usage:
//   lesson-engine <subcommand> [--agent <name>] [--all] [--dry-run] [--apply] [...]
//
// Subcommands: migrate | dedupe | forget | status | maintenance | scan | distill | gate
//
// Stdout: single machine-readable JSON document (pretty-printed).
// Stderr: human-readable summary.
// Exit codes: 0 = success, 1 = user error, 2 = runtime error.

import * as fs from "node:fs";
import * as path from "node:path";
import { dedupeFile, type DedupeResult } from "../src/dedupe.js";
import {
  ClaudeCliProvider,
  DEFAULT_MIN_CLUSTER_SIZE,
  type DistillLLMProvider,
  distillAll,
  readCandidatesFile,
  writeCandidatesFile,
} from "../src/distill.js";
import {
  readScannerState,
  scanAll,
  writeScannerState,
  writeSeedsAppend,
} from "../src/error-scanner.js";
import { forgetFile, type ForgetResult, DEFAULT_MAX_ACTIVE } from "../src/forget.js";
import { DEFAULT_CONFIDENCE_THRESHOLD, gateCandidates } from "../src/gate.js";
import { migrateFile, type MigrateResult } from "../src/migrate.js";
import type { LessonCandidate, MaintenanceState } from "../src/types.js";
import {
  VALID_AGENTS,
  atomicWriteJson,
  isValidAgent,
  lessonsFilePath,
  maintenanceStatePath,
  nowIso,
  readJson,
} from "../src/utils.js";

type Subcommand =
  | "migrate"
  | "dedupe"
  | "forget"
  | "status"
  | "maintenance"
  | "scan"
  | "distill"
  | "gate"
  | "help";

interface ParsedArgs {
  command: Subcommand;
  agent?: string;
  all: boolean;
  dryRun: boolean;
  apply: boolean;
  maxActive?: number;
  minCluster?: number;
  confidence?: number;
  root?: string;
  help: boolean;
}

const HELP = `lesson-engine — offline maintenance for agent lessons-learned.json

Usage:
  lesson-engine <command> [options]

Commands:
  migrate       Normalize schema + write .bak.<ts>.
  dedupe        Merge near-duplicate active lessons (TF-IDF cosine >= 0.6).
  forget        Score lessons, demote tail active → stale, expire stale → archive.
  maintenance   Run dedupe then forget; persist maintenance-state.json.
  status        Report current counts per lifecycle.
  scan          Scan session JSONL logs for tool failure error seeds.
  distill       Cluster error seeds and distill into lesson candidates via LLM.
  gate          Promote or reject lesson candidates based on confidence + dedup.

Options:
  --agent <name>      One of: ${VALID_AGENTS.join(", ")}
  --all               Apply to all four agents.
  --dry-run           Default. Compute & report without writing.
  --apply             Actually write to disk (atomic + .bak).
  --max-active <N>    Active cap for forget (default ${DEFAULT_MAX_ACTIVE}).
  --min-cluster <N>   Minimum cluster size for distill (default ${DEFAULT_MIN_CLUSTER_SIZE}).
  --confidence <N>    Confidence threshold for gate (default ${DEFAULT_CONFIDENCE_THRESHOLD}).
  --root <path>       Override AGENT_DATA_ROOT for this invocation.
  -h, --help          Print this help.
`;

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const out: ParsedArgs = {
    command: (command ?? "help") as Subcommand,
    all: false,
    dryRun: true,
    apply: false,
    help: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case "--agent":
        out.agent = rest[++i];
        break;
      case "--all":
        out.all = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--apply":
        out.apply = true;
        out.dryRun = false;
        break;
      case "--max-active":
        out.maxActive = Number(rest[++i]);
        break;
      case "--min-cluster":
        out.minCluster = Number(rest[++i]);
        break;
      case "--confidence":
        out.confidence = Number(rest[++i]);
        break;
      case "--root":
        out.root = rest[++i];
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        if (a?.startsWith("--")) {
          throw new UserError(`Unknown flag: ${a}`);
        }
    }
  }
  return out;
}

class UserError extends Error {}

function resolveAgents(args: ParsedArgs): string[] {
  if (args.all) return [...VALID_AGENTS];
  if (!args.agent) {
    throw new UserError("Either --agent <name> or --all is required.");
  }
  if (!isValidAgent(args.agent)) {
    throw new UserError(`Unknown agent '${args.agent}'. Valid: ${VALID_AGENTS.join(", ")}.`);
  }
  return [args.agent];
}

function summarizeMigrate(r: MigrateResult): string {
  if (r.alreadyMigrated)
    return `[${r.agent}] migrate: already up-to-date (${r.totalLessons} lessons)`;
  const write = r.wrote ? "wrote" : r.dryRun ? "dry-run" : "skipped";
  return `[${r.agent}] migrate: ${r.mutatedCount}/${r.totalLessons} mutated (${write})${
    r.backupPath ? ` backup=${r.backupPath}` : ""
  }`;
}

function summarizeDedupe(r: DedupeResult): string {
  const write = r.wrote ? "wrote" : r.dryRun ? "dry-run" : "skipped";
  return `[${r.agent}] dedupe: ${r.merges.length} merges, active ${r.activeBefore}→${r.activeAfter} (${write})`;
}

function summarizeForget(r: ForgetResult): string {
  const write = r.wrote ? "wrote" : r.dryRun ? "dry-run" : "skipped";
  const staled = r.transitions.filter((t) => t.to === "stale").length;
  const archived = r.transitions.filter((t) => t.to === "archive").length;
  return `[${r.agent}] forget: active ${r.activeBefore}→${r.activeAfter}, +${staled} stale, +${archived} archived (${write})`;
}

interface StatusReport {
  agent: string;
  filePath: string;
  exists: boolean;
  totalLessons: number;
  active: number;
  stale: number;
  archive: number;
}

function statusReport(agent: string, root?: string): StatusReport {
  const filePath = lessonsFilePath(agent, root);
  if (!fs.existsSync(filePath)) {
    return {
      agent,
      filePath,
      exists: false,
      totalLessons: 0,
      active: 0,
      stale: 0,
      archive: 0,
    };
  }
  const file = readJson<{ lessons?: { lifecycle?: string }[] }>(filePath);
  const lessons = Array.isArray(file.lessons) ? file.lessons : [];
  return {
    agent,
    filePath,
    exists: true,
    totalLessons: lessons.length,
    active: lessons.filter((l) => (l.lifecycle ?? "active") === "active").length,
    stale: lessons.filter((l) => l.lifecycle === "stale").length,
    archive: lessons.filter((l) => l.lifecycle === "archive").length,
  };
}

function updateMaintenanceState(params: {
  agent: string;
  migrate: MigrateResult;
  dedupe: DedupeResult;
  forget: ForgetResult;
  root?: string;
  now: Date;
}): string {
  const statePath = maintenanceStatePath(params.root);
  let state: MaintenanceState;
  if (fs.existsSync(statePath)) {
    try {
      state = readJson<MaintenanceState>(statePath);
      if (state.version !== 1 || typeof state.agents !== "object") throw new Error("schema");
    } catch {
      state = { version: 1, updatedAt: nowIso(params.now), agents: {} };
    }
  } else {
    state = { version: 1, updatedAt: nowIso(params.now), agents: {} };
  }
  const iso = nowIso(params.now);
  const prior = state.agents[params.agent] ?? {};
  state.agents[params.agent] = {
    ...prior,
    lastMigrateAt: iso,
    lastDedupeAt: iso,
    lastForgetAt: iso,
    lastMaintenanceAt: iso,
    dedupeMerged: params.dedupe.merges.length,
    forgetStale: params.forget.transitions.filter((t) => t.to === "stale").length,
    forgetArchived: params.forget.transitions.filter((t) => t.to === "archive").length,
  };
  state.updatedAt = iso;
  atomicWriteJson(statePath, state);
  return statePath;
}

export interface CliResult {
  stdout: unknown;
  stderr: string[];
  exitCode: number;
}

export interface MainOptions {
  /** Inject an LLM provider for `distill`. Defaults to ClaudeCliProvider. */
  llm?: DistillLLMProvider;
}

async function run(argv: string[], opts: MainOptions = {}): Promise<CliResult> {
  const args = parseArgs(argv);
  const stderr: string[] = [];

  if (args.help || args.command === "help") {
    return { stdout: { help: HELP }, stderr: [HELP], exitCode: 0 };
  }

  const dryRun = !args.apply;
  const now = new Date();

  switch (args.command) {
    case "migrate": {
      const agents = resolveAgents(args);
      const results = agents.map((agent) =>
        migrateFile({ filePath: lessonsFilePath(agent, args.root), agent, dryRun, now }),
      );
      results.forEach((r) => stderr.push(summarizeMigrate(r)));
      return { stdout: { command: "migrate", dryRun, results }, stderr, exitCode: 0 };
    }
    case "dedupe": {
      const agents = resolveAgents(args);
      const results = agents.map((agent) =>
        dedupeFile({ filePath: lessonsFilePath(agent, args.root), agent, dryRun, now }),
      );
      results.forEach((r) => stderr.push(summarizeDedupe(r)));
      return { stdout: { command: "dedupe", dryRun, results }, stderr, exitCode: 0 };
    }
    case "forget": {
      const agents = resolveAgents(args);
      const results = agents.map((agent) =>
        forgetFile({
          filePath: lessonsFilePath(agent, args.root),
          agent,
          dryRun,
          maxActive: args.maxActive,
          now,
        }),
      );
      results.forEach((r) => stderr.push(summarizeForget(r)));
      return { stdout: { command: "forget", dryRun, results }, stderr, exitCode: 0 };
    }
    case "status": {
      const agents = resolveAgents(args);
      const results = agents.map((agent) => statusReport(agent, args.root));
      for (const r of results) {
        stderr.push(
          `[${r.agent}] status: total=${r.totalLessons} active=${r.active} stale=${r.stale} archive=${r.archive}`,
        );
      }
      return { stdout: { command: "status", results }, stderr, exitCode: 0 };
    }
    case "maintenance": {
      const agents = resolveAgents(args);
      const results = agents.map((agent) => {
        const filePath = lessonsFilePath(agent, args.root);
        const migrate = migrateFile({ filePath, agent, dryRun, now });
        const dedupe = dedupeFile({ filePath, agent, dryRun, now });
        const forget = forgetFile({
          filePath,
          agent,
          dryRun,
          maxActive: args.maxActive,
          now,
        });
        let statePath: string | undefined;
        if (!dryRun) {
          statePath = updateMaintenanceState({
            agent,
            migrate,
            dedupe,
            forget,
            root: args.root,
            now,
          });
        }
        stderr.push(summarizeMigrate(migrate));
        stderr.push(summarizeDedupe(dedupe));
        stderr.push(summarizeForget(forget));
        if (statePath) stderr.push(`[${agent}] maintenance-state: ${statePath}`);
        return { agent, filePath, migrate, dedupe, forget, statePath };
      });
      return { stdout: { command: "maintenance", dryRun, results }, stderr, exitCode: 0 };
    }
    case "scan": {
      const agents = args.all ? [...VALID_AGENTS] : resolveAgents(args);
      const { seeds, updatedState } = scanAll({
        agents,
        root: args.root,
        state: readScannerState(args.root),
        now,
      });
      let seedsPath: string | undefined;
      if (!dryRun) {
        if (seeds.length > 0) seedsPath = writeSeedsAppend(seeds, args.root, now);
        writeScannerState(updatedState, args.root);
      }
      stderr.push(
        `[scan] ${seeds.length} error seeds across ${agents.length} agent(s) (${dryRun ? "dry-run" : "applied"})`,
      );
      return {
        stdout: {
          command: "scan",
          dryRun,
          seedCount: seeds.length,
          seedsPath,
          agents,
        },
        stderr,
        exitCode: 0,
      };
    }
    case "distill": {
      // First gather seeds (in-memory; do not modify scanner state here).
      const agents = args.all ? [...VALID_AGENTS] : resolveAgents(args);
      const { seeds } = scanAll({
        agents,
        root: args.root,
        state: readScannerState(args.root),
        now,
      });
      const llm = opts.llm ?? new ClaudeCliProvider();
      const existing = readCandidatesFile(args.root);
      const { candidates, skipped } = await distillAll({
        seeds,
        llm,
        root: args.root,
        minClusterSize: args.minCluster,
        existing,
        now,
      });
      let candidatesPath: string | undefined;
      if (!dryRun && candidates.length > 0) {
        const next = {
          ...existing,
          updatedAt: nowIso(now),
          candidates: [...existing.candidates, ...candidates],
        };
        candidatesPath = writeCandidatesFile(next, args.root);
      }
      stderr.push(
        `[distill] ${candidates.length} new candidate(s), ${skipped} skipped (${dryRun ? "dry-run" : "applied"})`,
      );
      const candidateIds = candidates.map((c: LessonCandidate) => c.id);
      return {
        stdout: {
          command: "distill",
          dryRun,
          newCandidates: candidates.length,
          skipped,
          candidateIds,
          candidatesPath,
        },
        stderr,
        exitCode: 0,
      };
    }
    case "gate": {
      const agents = args.all ? [...VALID_AGENTS] : resolveAgents(args);
      const result = gateCandidates({
        agents,
        root: args.root,
        confidenceThreshold: args.confidence,
        dryRun,
        now,
      });
      stderr.push(
        `[gate] promoted=${result.promoted} rejected=${result.rejected} (${dryRun ? "dry-run" : "applied"})`,
      );
      return { stdout: { command: "gate", dryRun, ...result }, stderr, exitCode: 0 };
    }
    default:
      throw new UserError(`Unknown subcommand: ${String(args.command)}`);
  }
}

/** Entry point used by both the CLI and tests. */
export async function main(
  argv: string[] = process.argv.slice(2),
  opts: MainOptions = {},
): Promise<CliResult> {
  try {
    return await run(argv, opts);
  } catch (err) {
    if (err instanceof UserError) {
      return {
        stdout: { error: err.message },
        stderr: [`error: ${err.message}`, "", HELP],
        exitCode: 1,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: { error: message },
      stderr: [`runtime error: ${message}`],
      exitCode: 2,
    };
  }
}

// CLI bootstrap — only runs when invoked directly.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const resolved = path.resolve(entry);
    return resolved.endsWith("lesson-engine.ts") || resolved.endsWith("lesson-engine.js");
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main().then(({ stdout, stderr, exitCode }) => {
    for (const line of stderr) process.stderr.write(`${line}\n`);
    process.stdout.write(`${JSON.stringify(stdout, null, 2)}\n`);
    process.exit(exitCode);
  });
}
