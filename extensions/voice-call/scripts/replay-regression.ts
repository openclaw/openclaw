#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateReplayQuality,
  type ReplayRule,
  type ReplayTurn,
  type ReplayViolation,
} from "../src/response-quality.ts";

type Args = {
  callIds: string[];
  rawDir: string;
  callsFile: string;
  outPath: string;
  latestPath: string;
  json: boolean;
  help: boolean;
};

type ViolationRecord = ReplayViolation & {
  callId: string;
};

type CallReport = {
  callId: string;
  source: string;
  turnsAnalyzed: number;
  passed: boolean;
  violations: ViolationRecord[];
};

type ReplayReport = {
  generatedAt: string;
  rules: ReplayRule[];
  inputs: {
    rawDir: string;
    callsFile: string;
    callIds: string[];
  };
  calls: CallReport[];
  summary: {
    totalCalls: number;
    failedCalls: number;
    totalViolations: number;
    violationsByRule: Record<ReplayRule, number>;
  };
};

const DEFAULT_RAW_DIR = path.join(os.homedir(), ".openclaw", "voice-calls", "postsync", "raw");
const DEFAULT_CALLS_FILE = path.join(os.homedir(), ".openclaw", "voice-calls", "calls.jsonl");

function usage(): void {
  console.log(
    `Usage: node scripts/replay-regression.ts --call-id <id> [--call-id <id> ...] [--raw-dir <path>] [--calls-file <path>] [--out <path>] [--latest <path>] [--json]\n\n` +
      `Replay bot transcript turns and fail on response-quality regressions.\n` +
      `Exit codes: 0=pass, 1=violations found, 2=invalid input or artifact load failure.`,
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    callIds: [],
    rawDir: DEFAULT_RAW_DIR,
    callsFile: DEFAULT_CALLS_FILE,
    outPath: "",
    latestPath: "",
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--call-id") {
      const next = String(argv[i + 1] ?? "").trim();
      if (next) {
        args.callIds.push(next);
      }
      i += 1;
      continue;
    }
    if (token === "--raw-dir") {
      const next = String(argv[i + 1] ?? "").trim();
      if (next) {
        args.rawDir = next;
      }
      i += 1;
      continue;
    }
    if (token === "--calls-file") {
      const next = String(argv[i + 1] ?? "").trim();
      if (next) {
        args.callsFile = next;
      }
      i += 1;
      continue;
    }
    if (token === "--out") {
      args.outPath = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--latest") {
      args.latestPath = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
  }

  args.callIds = Array.from(new Set(args.callIds));
  return args;
}

function getRecordTimeMs(record: Record<string, unknown>): number {
  const candidates = [record.endedAt, record.answeredAt, record.startedAt];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 0;
}

function parseTranscriptLike(value: unknown): ReplayTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const turns: ReplayTurn[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const speaker = (item as { speaker?: unknown }).speaker;
    const text = (item as { text?: unknown }).text;
    if ((speaker === "user" || speaker === "bot") && typeof text === "string") {
      turns.push({ speaker, text });
    }
  }
  return turns;
}

function resolveLatestRawFile(rawDir: string, callId: string): string | null {
  if (!fs.existsSync(rawDir)) {
    return null;
  }
  const entries = fs
    .readdirSync(rawDir)
    .filter((name) => name.startsWith(`${callId}-`) && name.endsWith(".json"));

  if (entries.length === 0) {
    return null;
  }

  const ranked = entries
    .map((name) => {
      const match = name.match(/-(\d+)\.json$/);
      const ts = match ? Number(match[1]) : 0;
      return { name, ts };
    })
    .sort((a, b) => b.ts - a.ts || b.name.localeCompare(a.name));

  return path.join(rawDir, ranked[0].name);
}

function loadTranscriptFromRaw(rawDir: string, callId: string): { turns: ReplayTurn[]; source: string } | null {
  const filePath = resolveLatestRawFile(rawDir, callId);
  if (!filePath) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const turns = parseTranscriptLike(parsed?.call?.transcript);
    if (turns.length === 0) {
      return null;
    }
    return { turns, source: filePath };
  } catch {
    return null;
  }
}

function loadTranscriptFromCallsJsonl(callsFile: string, callId: string): { turns: ReplayTurn[]; source: string } | null {
  if (!fs.existsSync(callsFile)) {
    return null;
  }

  const lines = fs
    .readFileSync(callsFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let bestMatch: { turns: ReplayTurn[]; timeMs: number } | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.callId !== callId) {
        continue;
      }
      const turns = parseTranscriptLike(parsed.transcript);
      if (turns.length === 0) {
        continue;
      }
      const timeMs = getRecordTimeMs(parsed);
      if (!bestMatch || timeMs >= bestMatch.timeMs) {
        bestMatch = { turns, timeMs };
      }
    } catch {
      // ignore malformed lines
    }
  }

  if (!bestMatch) {
    return null;
  }

  return { turns: bestMatch.turns, source: callsFile };
}

function loadTranscript(args: Args, callId: string): { turns: ReplayTurn[]; source: string } | null {
  return loadTranscriptFromRaw(args.rawDir, callId) ?? loadTranscriptFromCallsJsonl(args.callsFile, callId);
}

function writeJsonFile(targetPath: string, value: unknown): void {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function inferLatestPath(outPath: string): string | null {
  const normalized = path.resolve(outPath);
  const marker = `${path.sep}runs${path.sep}`;
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) {
    return null;
  }
  const root = normalized.slice(0, idx);
  return path.join(root, "latest.json");
}

function buildReport(args: Args): { report: ReplayReport; missingCallIds: string[] } {
  const calls: CallReport[] = [];
  const missingCallIds: string[] = [];

  for (const callId of args.callIds) {
    const loaded = loadTranscript(args, callId);
    if (!loaded) {
      missingCallIds.push(callId);
      continue;
    }

    const { turns, source } = loaded;
    const { violations } = evaluateReplayQuality(turns);
    const records: ViolationRecord[] = violations.map((violation) => ({ ...violation, callId }));

    calls.push({
      callId,
      source,
      turnsAnalyzed: turns.filter((turn) => turn.speaker === "bot").length,
      passed: records.length === 0,
      violations: records,
    });
  }

  const violationsByRule: Record<ReplayRule, number> = {
    NO_ELONGATED_TOKEN: 0,
    NO_CONSECUTIVE_DUPLICATE_BOT_LINE: 0,
  };

  let totalViolations = 0;
  let failedCalls = 0;
  for (const call of calls) {
    if (!call.passed) {
      failedCalls += 1;
    }
    for (const violation of call.violations) {
      violationsByRule[violation.rule] += 1;
      totalViolations += 1;
    }
  }

  const report: ReplayReport = {
    generatedAt: new Date().toISOString(),
    rules: ["NO_ELONGATED_TOKEN", "NO_CONSECUTIVE_DUPLICATE_BOT_LINE"],
    inputs: {
      rawDir: path.resolve(args.rawDir),
      callsFile: path.resolve(args.callsFile),
      callIds: [...args.callIds],
    },
    calls,
    summary: {
      totalCalls: calls.length,
      failedCalls,
      totalViolations,
      violationsByRule,
    },
  };

  return { report, missingCallIds };
}

function run(): number {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return 0;
  }

  if (args.callIds.length === 0) {
    console.error("replay-regression: at least one --call-id is required");
    return 2;
  }

  const { report, missingCallIds } = buildReport(args);
  if (missingCallIds.length > 0) {
    console.error(`replay-regression: could not load artifacts for callId(s): ${missingCallIds.join(", ")}`);
    return 2;
  }

  if (args.outPath) {
    writeJsonFile(args.outPath, report);

    const latestPath = args.latestPath || inferLatestPath(args.outPath);
    if (latestPath) {
      writeJsonFile(latestPath, report);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Replay regression report");
    console.log(`calls: ${report.summary.totalCalls}`);
    console.log(`failed: ${report.summary.failedCalls}`);
    console.log(`violations: ${report.summary.totalViolations}`);
    console.log(`rules: ${report.rules.join(", ")}`);
    if (args.outPath) {
      console.log(`output: ${path.resolve(args.outPath)}`);
      const latestPath = args.latestPath || inferLatestPath(args.outPath);
      if (latestPath) {
        console.log(`latest: ${path.resolve(latestPath)}`);
      }
    }
  }

  return report.summary.totalViolations > 0 ? 1 : 0;
}

const code = run();
process.exit(code);
