import { SessionManager } from "@mariozechner/pi-coding-agent";
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../src/config/config.js";

/**
 * WM/STM/LTM smoke harness (manual, uses a real model call).
 *
 * Goal:
 * - Exercise the pre-compaction memory flush prompt against a workspace that already has the optional
 *   WM/STM/LTM layout (`STM.md`, `WORKING.md`, `ltm/`).
 * - Validate routing and hygiene (STM vs LTM vs daily evidence) via a second, read-only validator run.
 *
 * Prereqs:
 * - Node 22+
 * - API key in env or repo-root `.env` (this file imports `dotenv/config`)
 *   - `OPENAI_API_KEY=...`
 *
 * Run (recommended):
 * - `node --import tsx scripts/repro/memory-wm-stm-ltm-smoke.ts --scenario rich --verbose`
 *
 * Keep artifacts:
 * - `node --import tsx scripts/repro/memory-wm-stm-ltm-smoke.ts --scenario rich --dump ./tmp`
 *
 * What to inspect after a run:
 * - The temp workspace: `<run>/workspace/*` (the updated memory files)
 * - Inputs + outputs: `<run>/artifacts/*`
 *   - `artifacts/seed-conversation.md` (seed transcript we injected)
 *   - `artifacts/prompts/*` (flush + validator prompts)
 *   - `artifacts/before/*` and `artifacts/after/*` (snapshots)
 *   - `artifacts/validator/verdict.json` (JSON pass/fail verdict)
 *   - `artifacts/meta.json` (paths + run metadata)
 * - Raw session logs (tool calls, etc): `<run>/sessions/*.jsonl`
 *
 * Notes:
 * - This is intentionally NOT a CI test. It requires a live model key and is allowed to be slower/flakier.
 * - This harness denies `exec`/`process`/`edit` so the model uses full-file `write` for generated memory files.
 */
type CliArgs = {
  provider: string;
  model: string;
  cleanup: boolean;
  verbose: boolean;
  scenario: "minimal" | "rich";
  validate: boolean;
  dumpDir?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    provider: "openai",
    model: "gpt-5.2",
    cleanup: false,
    verbose: false,
    scenario: "minimal",
    validate: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--provider") {
      args.provider = (argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--model") {
      args.model = (argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--scenario") {
      const value = (argv[i + 1] ?? "").trim();
      if (value !== "minimal" && value !== "rich") {
        throw new Error(`--scenario must be "minimal" or "rich" (got: ${value || "<empty>"})`);
      }
      args.scenario = value;
      i += 1;
      continue;
    }
    if (arg === "--rich") {
      args.scenario = "rich";
      continue;
    }
    if (arg === "--minimal") {
      args.scenario = "minimal";
      continue;
    }
    if (arg === "--cleanup") {
      args.cleanup = true;
      continue;
    }
    if (arg === "--verbose") {
      args.verbose = true;
      continue;
    }
    if (arg === "--no-validate") {
      args.validate = false;
      continue;
    }
    if (arg === "--dump") {
      args.dumpDir = (argv[i + 1] ?? "").trim() || undefined;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }
  if (!args.provider) {
    throw new Error("--provider is required");
  }
  if (!args.model) {
    throw new Error("--model is required");
  }
  return args;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(
    [
      "WM/STM/LTM smoke harness (manual, uses a real model call).",
      "",
      "Usage:",
      "  OPENAI_API_KEY=... node --import tsx scripts/repro/memory-wm-stm-ltm-smoke.ts [--scenario minimal|rich] [--provider openai] [--model gpt-5.2] [--cleanup] [--verbose] [--dump <dir>]",
      "  # or: OPENAI_API_KEY=... bun scripts/repro/memory-wm-stm-ltm-smoke.ts ...",
      "",
      "What it does:",
      "- Creates a temporary OpenClaw workspace with STM.md / WORKING.md / ltm/ and a seeded session transcript.",
      "- Runs a pre-compaction memory flush turn that updates STM/LTM/WORKING.",
      "- Optionally runs a validator agent that checks the results and prints a JSON verdict.",
      "",
      "Options:",
      "  --provider  Model provider (default: openai)",
      "  --model     Model id (default: gpt-5.2)",
      "  --scenario  Seed scenario (minimal|rich) (default: minimal)",
      "  --no-validate  Skip validator agent run",
      "  --cleanup   Delete the temp workspace after the run",
      "  --verbose   Print extra debug info (paths + model output)",
      "  --dump      Copy temp run artifacts to <dir> (keeps workspace + sessions)",
      "",
      "Notes:",
      "- You may see a Node warning about SQLite being experimental; it's safe to ignore.",
      "  To hide it: NODE_NO_WARNINGS=1 (or node --no-warnings).",
      "- OPENAI_API_KEY can be provided via environment variables or a repo-root .env file.",
    ].join("\n"),
  );
  process.exit(code);
}

function assertContains(haystack: string, needle: string, label: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`Assertion failed (${label}): missing "${needle}"`);
  }
}

function assertMaxLines(text: string, maxLines: number, label: string) {
  const lines = text.split("\n").length;
  if (lines > maxLines) {
    throw new Error(`Assertion failed (${label}): ${lines} lines (max ${maxLines})`);
  }
}

type ValidatorVerdict = {
  pass: boolean;
  issues?: string[];
  notes?: Record<string, unknown>;
};

function extractRunText(result: { payloads?: Array<{ text?: string }> }): string {
  const texts = (result.payloads ?? [])
    .map((payload) => (payload.text ?? "").trim())
    .filter(Boolean);
  return texts.join("\n\n").trim();
}

function parseValidatorVerdict(rawText: string): ValidatorVerdict {
  const text = rawText.trim();
  if (!text) {
    throw new Error("Validator returned empty output.");
  }
  const tryParse = (candidate: string): ValidatorVerdict | null => {
    try {
      return JSON.parse(candidate) as ValidatorVerdict;
    } catch {
      return null;
    }
  };

  const direct = tryParse(text);
  if (direct) {
    return direct;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const extracted = text.slice(start, end + 1);
    const parsed = tryParse(extracted);
    if (parsed) {
      return parsed;
    }
  }

  throw new Error(`Validator did not return parseable JSON. Raw:\n${text}`);
}

type SeedMessage = {
  role: "user" | "assistant";
  text: string;
};

function buildSeedMessages(params: {
  scenario: "minimal" | "rich";
  today: string;
  yesterday: string;
}): SeedMessage[] {
  if (params.scenario === "minimal") {
    return [
      {
        role: "user",
        text: [
          "We are implementing an optional WM/STM/LTM memory layout for OpenClaw.",
          "",
          "Decisions to remember (keep the exact tokens):",
          "- MEMTAG_DECISION_WORKING_NOT_INDEXED: WORKING.md is a projection and should not be indexed by memory_search.",
          "- MEMTAG_DECISION_LTM_OPTIN: only treat ltm/ as memory when ltm/index.md exists OR ltm/nodes/ exists.",
          "- MEMTAG_DECISION_FLUSH_TRIGGER: STM/LTM/WORKING maintenance happens during the pre-compaction memory flush, not on every 'remember this'.",
          "",
          "Short-term todos (keep the exact tokens):",
          "- MEMTAG_TODO_SMOKE_HARNESS: add a manual smoke harness under scripts/repro/.",
          "- MEMTAG_TODO_DOCS: update docs to describe the optional WM/STM/LTM layout.",
          "",
          "Preference (keep the exact token):",
          "- MEMTAG_PREF_TEXT_ONLY: keep memory text-only; no DB required for the source of truth.",
        ].join("\n"),
      },
      {
        role: "assistant",
        text: [
          "Acknowledged. I'll wire WM/STM/LTM support as an optional layout, keep WORKING.md unindexed,",
          "gate ltm/ opt-in by structure, and rely on the pre-compaction flush for consolidation.",
        ].join(" "),
      },
    ];
  }

  return [
    {
      role: "user",
      text: [
        `Today is ${params.today}. We’re testing OpenClaw’s optional WM/STM/LTM memory layout with a realistic seed.`,
        "",
        "Scenario: an engineer (Alex) is iterating on an agentic memory system and is feeding the agent a mix of durable decisions, short-term tasks, and one-off run noise.",
        "",
        "Durable (should land in LTM, not STM):",
        "- MEMTAG_DECISION_WORKING_NOT_INDEXED: WORKING.md is a projection and should NOT be indexed by memory_search.",
        "- MEMTAG_DECISION_LTM_OPTIN: only treat ltm/ as memory when ltm/index.md exists OR ltm/nodes/ exists.",
        "- MEMTAG_DECISION_FLUSH_TRIGGER: STM/LTM/WORKING maintenance happens during pre-compaction memory flush, not on every 'remember this'.",
        "- MEMTAG_PREF_TEXT_ONLY: memory source of truth stays text-only (markdown files).",
        "- MEMTAG_DECISION_VALIDATOR_AGENT: use a second agent run to validate the memory output.",
        "",
        "Short-term (should land in STM with TTL):",
        "- MEMTAG_TODO_RICH_SEED: expand the smoke harness seed to be realistic (multi-turn, mixed signal).",
        "- MEMTAG_TODO_VALIDATOR_RUN: run a validator agent that reads the files and returns a JSON verdict.",
        "- MEMTAG_TODO_DUMP_ARTIFACTS: add a --dump flag to keep inputs/outputs for inspection.",
        "",
        "Ephemeral run noise (should NOT land in STM or LTM; daily log only if needed):",
        "- MEMTAG_EPHEMERAL_SQLITE_WARNING: Node printed an ExperimentalWarning about SQLite.",
        "- MEMTAG_EPHEMERAL_GIT_ERROR: the model tried git and got 'fatal: not a git repository'.",
        "- MEMTAG_EPHEMERAL_TMPPATH: temp workspace path looked like /var/folders/.../openclaw-wm-stm-ltm-smoke-XXXX.",
        "",
        "Also: we’re keeping changes minimal and avoiding new CI integration tests for this (manual harness only).",
      ].join("\n"),
    },
    {
      role: "assistant",
      text: [
        "Got it. I’ll consolidate durable items into LTM nodes, track near-term work in STM with TTL,",
        "keep WORKING.md as a small projection, and keep run-noise out of STM/LTM.",
      ].join(" "),
    },
    {
      role: "user",
      text: [
        "Extra context from yesterday’s work:",
        `- We already have a daily evidence log for ${params.yesterday}.`,
        "- The last run was noisy and the model tried to use `edit` with exact-match diffs; that’s brittle for generated files.",
        "- We want full-file rewrites for STM/LTM/WORKING in this harness to avoid edit failures.",
        "",
        "Please don’t store the temp paths or raw warnings in long-term memory; they’re only useful as evidence.",
      ].join("\n"),
    },
    {
      role: "assistant",
      text: "Understood. I’ll treat those as ephemeral run evidence and keep durable memory clean.",
    },
  ];
}

function buildDeterministicFlushOverride(params: {
  scenario: "minimal" | "rich";
  today: string;
}): string {
  if (params.scenario === "minimal") {
    return [
      "Deterministic smoke harness instructions (follow exactly):",
      "- Do NOT create new files or folders in the workspace; only update existing files.",
      "- Do NOT use exec/process tools in this turn.",
      "- Before writing, use memory_get to read: STM.md, WORKING.md, ltm/index.md, ltm/nodes/project.agentic-memory.md.",
      "- Use the write tool (full-file overwrite) for STM.md / WORKING.md / ltm/index.md / ltm/nodes/project.agentic-memory.md; do not use edit.",
      "- Update these files and ensure the markers land in the correct one:",
      "  - STM.md must contain: MEMTAG_TODO_SMOKE_HARNESS and MEMTAG_TODO_DOCS",
      "  - WORKING.md must contain: MEMTAG_WORKING_PROJECTION (and only WORKING.md should contain this token)",
      "  - ltm/nodes/project.agentic-memory.md must contain: MEMTAG_DECISION_WORKING_NOT_INDEXED, MEMTAG_DECISION_LTM_OPTIN, MEMTAG_DECISION_FLUSH_TRIGGER, MEMTAG_PREF_TEXT_ONLY",
      "  - ltm/index.md must link to ltm/nodes/project.agentic-memory.md",
      "- Keep STM.md <= 160 lines and WORKING.md <= 160 lines.",
      "- Prefer writing by reading current file contents first.",
    ].join("\n");
  }

  return [
    "Deterministic smoke harness instructions (follow exactly):",
    "- Do NOT create new files or folders in the workspace; only update existing files.",
    "- Do NOT use exec/process/edit tools in this turn.",
    "- Before writing, use memory_get to read: STM.md, WORKING.md, ltm/index.md, ltm/nodes/project.agentic-memory.md, memory/inbox.md, memory/daily/" +
      params.today +
      ".md.",
    "- Use the write tool (full-file overwrite) for STM.md / WORKING.md / ltm/index.md / ltm/nodes/project.agentic-memory.md / memory/inbox.md / memory/daily/" +
      params.today +
      ".md. Do not use edit.",
    "",
    "WM/STM/LTM routing rules:",
    "- Durable decisions and stable preferences belong in LTM (ltm/nodes/*).",
    "- Short-term tasks and near-term context belong in STM.md with TTL (exp within 7 days).",
    "- WORKING.md is a projection of current objective + constraints + pointers; keep it small.",
    "- Ephemeral run noise must NOT appear in STM.md or LTM nodes; record it only as evidence in today’s daily log if needed.",
    "",
    "Must-haves:",
    "- WORKING.md must contain MEMTAG_WORKING_PROJECTION.",
    "- STM.md must contain the short-term tokens: MEMTAG_TODO_RICH_SEED, MEMTAG_TODO_VALIDATOR_RUN, MEMTAG_TODO_DUMP_ARTIFACTS.",
    "- LTM node must contain the durable tokens: MEMTAG_DECISION_WORKING_NOT_INDEXED, MEMTAG_DECISION_LTM_OPTIN, MEMTAG_DECISION_FLUSH_TRIGGER, MEMTAG_PREF_TEXT_ONLY, MEMTAG_DECISION_VALIDATOR_AGENT.",
    "- memory/daily/" +
      params.today +
      ".md must contain the ephemeral tokens: MEMTAG_EPHEMERAL_SQLITE_WARNING, MEMTAG_EPHEMERAL_GIT_ERROR, MEMTAG_EPHEMERAL_TMPPATH.",
    "- ltm/index.md must link to nodes/project.agentic-memory.md.",
    "",
    "Must-NOTs:",
    "- STM.md must NOT contain any MEMTAG_DECISION_* tokens.",
    "- STM.md must NOT contain any MEMTAG_EPHEMERAL_* tokens.",
    "- LTM node must NOT contain any MEMTAG_EPHEMERAL_* tokens.",
    "",
    "- Keep STM.md <= 200 lines and WORKING.md <= 200 lines.",
  ].join("\n");
}

async function writeWorkspaceFiles(params: {
  workspaceDir: string;
  today: string;
  yesterday: string;
  scenario: "minimal" | "rich";
}) {
  const { workspaceDir, today, yesterday, scenario } = params;
  await fs.mkdir(workspaceDir, { recursive: true });

  const bootstrapFiles: Array<{ name: string; content: string }> = [
    {
      name: "AGENTS.md",
      content: ["# Agents", "", "This is a temporary smoke workspace."].join("\n"),
    },
    { name: "SOUL.md", content: "# Soul\n" },
    { name: "TOOLS.md", content: "# Tools\n" },
    { name: "IDENTITY.md", content: "# Identity\n" },
    { name: "USER.md", content: "# User\n" },
    { name: "HEARTBEAT.md", content: "# Heartbeat\n" },
    { name: "BOOTSTRAP.md", content: "# Bootstrap\n" },
  ];
  await Promise.all(
    bootstrapFiles.map(async (file) => {
      await fs.writeFile(path.join(workspaceDir, file.name), file.content, "utf-8");
    }),
  );

  await fs.mkdir(path.join(workspaceDir, "memory", "daily"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "ltm", "nodes"), { recursive: true });

  await fs.writeFile(
    path.join(workspaceDir, "MEMORY.md"),
    ["# Legacy Memory", "", "- Existing long-term notes live here."].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "STM.md"),
    [
      "# Short-Term Memory (rolling 7 days)",
      `last_updated: ${today}`,
      "",
      "## Now (24–48h)",
      "- [I4 | exp: 2099-01-01] placeholder (should be replaced by flush)",
      "",
      "## This week",
      "- [I3 | exp: 2099-01-01] placeholder (should be replaced by flush)",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "WORKING.md"),
    [
      "# Working Memory (generated)",
      `generated: ${today}`,
      "",
      "## Current objective",
      "placeholder objective (should be replaced by flush)",
      "",
      "## Constraints",
      "- WORKING.md is a projection.",
      "",
      "## Loaded memory pointers",
      "- STM: STM.md",
      "- LTM: ltm/index.md",
    ].join("\n"),
    "utf-8",
  );

  await fs.writeFile(
    path.join(workspaceDir, "memory", `${today}.md`),
    [
      `# ${today}`,
      "",
      "## Captures (legacy daily)",
      "- placeholder (may be updated by flush)",
    ].join("\n"),
    "utf-8",
  );

  await fs.writeFile(
    path.join(workspaceDir, "memory", "daily", `${today}.md`),
    [
      `# ${today}`,
      "",
      "## Captures (seed)",
      "- Seeded conversation includes durable decisions + short-term todos.",
    ].join("\n"),
    "utf-8",
  );

  if (scenario === "rich") {
    await fs.writeFile(
      path.join(workspaceDir, "memory", "daily", `${yesterday}.md`),
      [
        `# ${yesterday}`,
        "",
        "## Captures (yesterday seed)",
        "- Prior iteration: discussed adding a richer smoke harness seed and validator agent run.",
      ].join("\n"),
      "utf-8",
    );
  }

  await fs.writeFile(
    path.join(workspaceDir, "memory", "inbox.md"),
    scenario === "rich"
      ? [
          "# Inbox",
          "",
          "- type: todo",
          "  summary: MEMTAG_TODO_RICH_SEED (expand the seed to be realistic)",
          "- type: todo",
          "  summary: MEMTAG_TODO_VALIDATOR_RUN (validate memory output with a second agent)",
          "- type: todo",
          "  summary: MEMTAG_TODO_DUMP_ARTIFACTS (persist inputs/outputs for inspection)",
          "- type: note",
          "  summary: MEMTAG_EPHEMERAL_SQLITE_WARNING (experimental sqlite warning occurred in one run)",
        ].join("\n")
      : ["# Inbox", "", "- placeholder (may be updated by flush)"].join("\n"),
    "utf-8",
  );

  await fs.writeFile(
    path.join(workspaceDir, "ltm", "index.md"),
    [
      "# LTM Index",
      "",
      "## Entry points",
      "- [Project: Agentic Memory System](nodes/project.agentic-memory.md)",
    ].join("\n"),
    "utf-8",
  );

  await fs.writeFile(
    path.join(workspaceDir, "ltm", "nodes", "project.agentic-memory.md"),
    [
      "# Project: Agentic Memory System",
      "",
      "type: project",
      `updated: ${today}`,
      "",
      "## Summary",
      "placeholder (should be updated by flush)",
    ].join("\n"),
    "utf-8",
  );
}

function buildValidatorSystemPrompt(params: {
  scenario: "minimal" | "rich";
  today: string;
}): string {
  if (params.scenario === "minimal") {
    return [
      "Validator agent for WM/STM/LTM smoke harness.",
      "Rules:",
      "- Do NOT use write/edit/exec/process tools.",
      "- Do NOT reply with NO_REPLY; you must return a JSON verdict.",
      "- Use memory_get to read: STM.md, WORKING.md, ltm/index.md, ltm/nodes/project.agentic-memory.md.",
      "",
      "Validate:",
      "- STM.md contains: MEMTAG_TODO_SMOKE_HARNESS and MEMTAG_TODO_DOCS",
      "- WORKING.md contains: MEMTAG_WORKING_PROJECTION",
      "- ltm/nodes/project.agentic-memory.md contains: MEMTAG_DECISION_WORKING_NOT_INDEXED, MEMTAG_DECISION_LTM_OPTIN, MEMTAG_DECISION_FLUSH_TRIGGER, MEMTAG_PREF_TEXT_ONLY",
      "- ltm/index.md links to nodes/project.agentic-memory.md",
      "",
      'Reply with JSON only: {"pass": boolean, "issues": string[]}.',
    ].join("\n");
  }

  return [
    "Validator agent for WM/STM/LTM smoke harness.",
    "Rules:",
    "- Do NOT use write/edit/exec/process tools.",
    "- Do NOT reply with NO_REPLY; you must return a JSON verdict.",
    "- Use memory_get to read: STM.md, WORKING.md, ltm/index.md, ltm/nodes/project.agentic-memory.md, memory/daily/" +
      params.today +
      ".md.",
    "",
    "Validate routing:",
    "- WORKING.md contains MEMTAG_WORKING_PROJECTION and includes pointers to STM.md and ltm/index.md.",
    "- STM.md contains MEMTAG_TODO_RICH_SEED, MEMTAG_TODO_VALIDATOR_RUN, MEMTAG_TODO_DUMP_ARTIFACTS.",
    "- STM.md contains no MEMTAG_DECISION_* tokens and no MEMTAG_EPHEMERAL_* tokens.",
    "- ltm/nodes/project.agentic-memory.md contains MEMTAG_DECISION_WORKING_NOT_INDEXED, MEMTAG_DECISION_LTM_OPTIN, MEMTAG_DECISION_FLUSH_TRIGGER, MEMTAG_PREF_TEXT_ONLY, MEMTAG_DECISION_VALIDATOR_AGENT.",
    "- ltm/nodes/project.agentic-memory.md contains no MEMTAG_EPHEMERAL_* tokens.",
    "- ltm/index.md links to nodes/project.agentic-memory.md.",
    "- memory/daily/" +
      params.today +
      ".md contains MEMTAG_EPHEMERAL_SQLITE_WARNING, MEMTAG_EPHEMERAL_GIT_ERROR, MEMTAG_EPHEMERAL_TMPPATH.",
    "",
    "Validate basic structure (best effort; do not require exact prose):",
    "- STM.md has a last_updated field and uses TTL-style expirations (exp: ...).",
    "- WORKING.md has a Current objective section and is plausibly a projection (not a dump).",
    "- LTM node is high-level (summary + decisions/preferences), not a transcript.",
    "",
    'Reply with JSON only: {"pass": boolean, "issues": string[]}.',
  ].join("\n");
}

const DEFAULT_VALIDATOR_PROMPT =
  "Validate the workspace memory files per the system prompt and return a JSON verdict.";

async function writeArtifactFile(params: {
  artifactsDir: string;
  relPath: string;
  content: string;
}): Promise<void> {
  const absPath = path.join(params.artifactsDir, params.relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, params.content, "utf-8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const provider = args.provider;
  const model = args.model;

  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("Missing OPENAI_API_KEY (required for this smoke harness).");
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wm-stm-ltm-smoke-"));
  const stateDir = path.join(tmpRoot, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(tmpRoot, "workspace");
  const artifactsDir = path.join(tmpRoot, "artifacts");
  const sessionKey = "agent:main:smoke";
  const sessionFile = path.join(tmpRoot, "sessions", `${crypto.randomUUID()}.jsonl`);
  const runId = crypto.randomUUID();

  process.env.OPENCLAW_STATE_DIR = stateDir;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await writeWorkspaceFiles({ workspaceDir, today, yesterday, scenario: args.scenario });

  const seedMessages = buildSeedMessages({ scenario: args.scenario, today, yesterday });
  await fs.mkdir(artifactsDir, { recursive: true });
  await writeArtifactFile({
    artifactsDir,
    relPath: "seed-conversation.md",
    content: seedMessages
      .map((entry) => [`## ${entry.role.toUpperCase()}`, "", entry.text, ""].join("\n"))
      .join("\n"),
  });

  const sessionManager = SessionManager.open(sessionFile);
  const ts = Date.now();
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  seedMessages.forEach((entry, idx) => {
    if (entry.role === "assistant") {
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: entry.text }],
        api: "openai-responses",
        provider: "openclaw",
        model: "seed",
        usage,
        stopReason: "stop",
        timestamp: ts + idx,
      });
      return;
    }
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: entry.text }],
      timestamp: ts + idx,
    });
  });
  const sessionId = sessionManager.getSessionId();

  const { listMemoryFiles } = await import("../../src/memory/internal.js");
  const indexed = await listMemoryFiles(workspaceDir);
  if (!indexed.some((file) => path.basename(file) === "STM.md")) {
    throw new Error("Expected STM.md to be included in memory discovery.");
  }
  if (!indexed.some((file) => file.replace(/\\/g, "/").endsWith("/ltm/index.md"))) {
    throw new Error("Expected ltm/index.md to be included in memory discovery (opt-in).");
  }
  if (indexed.some((file) => path.basename(file) === "WORKING.md")) {
    throw new Error("Expected WORKING.md to NOT be included in memory discovery.");
  }

  const { runEmbeddedPiAgent } = await import("../../src/agents/pi-embedded.js");
  const { DEFAULT_MEMORY_FLUSH_PROMPT, DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT } =
    await import("../../src/auto-reply/reply/memory-flush.js");
  const cfg: OpenClawConfig = {
    tools: {
      deny: ["exec", "process", "edit"],
    },
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          enabled: true,
          provider: "openai",
          model: "text-embedding-3-small",
          store: { path: path.join(stateDir, "memory", "{agentId}.sqlite") },
          sync: { watch: false, intervalMinutes: 0, onSearch: false, onSessionStart: false },
          query: { maxResults: 6, minScore: 0.2 },
        },
      },
    },
  };

  const validatorCfg: OpenClawConfig = {
    ...cfg,
    tools: {
      deny: ["exec", "process", "edit", "write"],
    },
    agents: {
      ...cfg.agents,
      list: [
        ...(cfg.agents?.list ?? []),
        {
          id: "validator",
          workspace: workspaceDir,
        },
      ],
    },
  };

  const beforeStm = await fs.readFile(path.join(workspaceDir, "STM.md"), "utf-8");
  const beforeWorking = await fs.readFile(path.join(workspaceDir, "WORKING.md"), "utf-8");
  const beforeLtm = await fs.readFile(
    path.join(workspaceDir, "ltm", "nodes", "project.agentic-memory.md"),
    "utf-8",
  );

  const flushOverride = buildDeterministicFlushOverride({ scenario: args.scenario, today });
  const extraSystemPrompt = [DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT, flushOverride]
    .filter(Boolean)
    .join("\n\n");

  await writeArtifactFile({
    artifactsDir,
    relPath: "prompts/flush.prompt.txt",
    content: DEFAULT_MEMORY_FLUSH_PROMPT,
  });
  await writeArtifactFile({
    artifactsDir,
    relPath: "prompts/flush.system.txt",
    content: extraSystemPrompt,
  });

  const result = await runEmbeddedPiAgent({
    sessionId,
    sessionKey,
    sessionFile,
    workspaceDir,
    agentDir,
    config: cfg,
    prompt: DEFAULT_MEMORY_FLUSH_PROMPT,
    extraSystemPrompt,
    provider,
    model,
    timeoutMs: 300_000,
    runId,
  });

  const afterStmPath = path.join(workspaceDir, "STM.md");
  const afterWorkingPath = path.join(workspaceDir, "WORKING.md");
  const afterLtmNodePath = path.join(workspaceDir, "ltm", "nodes", "project.agentic-memory.md");
  const afterIndexPath = path.join(workspaceDir, "ltm", "index.md");

  const afterStm = await fs.readFile(afterStmPath, "utf-8");
  const afterWorking = await fs.readFile(afterWorkingPath, "utf-8");
  const afterLtmNode = await fs.readFile(afterLtmNodePath, "utf-8");
  const afterIndex = await fs.readFile(afterIndexPath, "utf-8");
  const afterInbox = await fs.readFile(path.join(workspaceDir, "memory", "inbox.md"), "utf-8");
  const afterDaily = await fs.readFile(
    path.join(workspaceDir, "memory", "daily", `${today}.md`),
    "utf-8",
  );

  await writeArtifactFile({ artifactsDir, relPath: "before/STM.md", content: beforeStm });
  await writeArtifactFile({ artifactsDir, relPath: "before/WORKING.md", content: beforeWorking });
  await writeArtifactFile({
    artifactsDir,
    relPath: "before/ltm/nodes/project.agentic-memory.md",
    content: beforeLtm,
  });

  await writeArtifactFile({ artifactsDir, relPath: "after/STM.md", content: afterStm });
  await writeArtifactFile({ artifactsDir, relPath: "after/WORKING.md", content: afterWorking });
  await writeArtifactFile({ artifactsDir, relPath: "after/ltm/index.md", content: afterIndex });
  await writeArtifactFile({
    artifactsDir,
    relPath: "after/ltm/nodes/project.agentic-memory.md",
    content: afterLtmNode,
  });
  await writeArtifactFile({ artifactsDir, relPath: "after/memory/inbox.md", content: afterInbox });
  await writeArtifactFile({
    artifactsDir,
    relPath: `after/memory/daily/${today}.md`,
    content: afterDaily,
  });

  const { getMemorySearchManager } = await import("../../src/memory/index.js");
  const { manager, error } = await getMemorySearchManager({ cfg, agentId: "main" });
  if (!manager) {
    throw new Error(`memory manager unavailable: ${error ?? "unknown error"}`);
  }
  await manager.readFile({ relPath: "STM.md" });
  await manager.readFile({ relPath: "WORKING.md" });
  await manager.readFile({ relPath: "ltm/index.md" });
  await manager.readFile({ relPath: "ltm/nodes/project.agentic-memory.md" });

  if (args.scenario === "minimal") {
    assertContains(afterStm, "MEMTAG_TODO_SMOKE_HARNESS", "STM.md");
    assertContains(afterStm, "MEMTAG_TODO_DOCS", "STM.md");
    assertMaxLines(afterStm, 160, "STM.md");

    assertContains(afterWorking, "MEMTAG_WORKING_PROJECTION", "WORKING.md");
    assertMaxLines(afterWorking, 160, "WORKING.md");

    assertContains(afterLtmNode, "MEMTAG_DECISION_WORKING_NOT_INDEXED", "ltm node");
    assertContains(afterLtmNode, "MEMTAG_DECISION_LTM_OPTIN", "ltm node");
    assertContains(afterLtmNode, "MEMTAG_DECISION_FLUSH_TRIGGER", "ltm node");
    assertContains(afterLtmNode, "MEMTAG_PREF_TEXT_ONLY", "ltm node");

    assertContains(afterIndex, "nodes/project.agentic-memory.md", "ltm/index.md");
  } else {
    assertContains(afterWorking, "MEMTAG_WORKING_PROJECTION", "WORKING.md");
    assertMaxLines(afterWorking, 200, "WORKING.md");

    assertContains(afterStm, "MEMTAG_TODO_RICH_SEED", "STM.md");
    assertContains(afterStm, "MEMTAG_TODO_VALIDATOR_RUN", "STM.md");
    assertContains(afterStm, "MEMTAG_TODO_DUMP_ARTIFACTS", "STM.md");
    assertMaxLines(afterStm, 200, "STM.md");

    if (afterStm.includes("MEMTAG_DECISION_")) {
      throw new Error("Assertion failed (STM.md): contains MEMTAG_DECISION_* token(s)");
    }
    if (afterStm.includes("MEMTAG_EPHEMERAL_")) {
      throw new Error("Assertion failed (STM.md): contains MEMTAG_EPHEMERAL_* token(s)");
    }

    assertContains(afterLtmNode, "MEMTAG_DECISION_WORKING_NOT_INDEXED", "ltm node");
    assertContains(afterLtmNode, "MEMTAG_DECISION_LTM_OPTIN", "ltm node");
    assertContains(afterLtmNode, "MEMTAG_DECISION_FLUSH_TRIGGER", "ltm node");
    assertContains(afterLtmNode, "MEMTAG_PREF_TEXT_ONLY", "ltm node");
    assertContains(afterLtmNode, "MEMTAG_DECISION_VALIDATOR_AGENT", "ltm node");
    if (afterLtmNode.includes("MEMTAG_EPHEMERAL_")) {
      throw new Error("Assertion failed (ltm node): contains MEMTAG_EPHEMERAL_* token(s)");
    }

    assertContains(afterIndex, "nodes/project.agentic-memory.md", "ltm/index.md");

    assertContains(afterDaily, "MEMTAG_EPHEMERAL_SQLITE_WARNING", "daily log");
    assertContains(afterDaily, "MEMTAG_EPHEMERAL_GIT_ERROR", "daily log");
    assertContains(afterDaily, "MEMTAG_EPHEMERAL_TMPPATH", "daily log");
  }

  if (beforeStm === afterStm) {
    throw new Error("Expected STM.md to be updated, but it did not change.");
  }
  if (beforeWorking === afterWorking) {
    throw new Error("Expected WORKING.md to be updated, but it did not change.");
  }
  if (beforeLtm === afterLtmNode) {
    throw new Error(
      "Expected ltm/nodes/project.agentic-memory.md to be updated, but it did not change.",
    );
  }

  if (args.verbose) {
    // eslint-disable-next-line no-console
    console.log("\n--- model output (text only) ---");
    // eslint-disable-next-line no-console
    console.log(extractRunText(result) || "<empty>");
    // eslint-disable-next-line no-console
    console.log(`Artifacts: ${artifactsDir}`);
  }

  let validatorSessionFile: string | null = null;

  if (args.validate) {
    const validatorAgentDir = path.join(stateDir, "agents", "validator", "agent");
    const validatorSessionKey = "agent:validator:smoke";
    validatorSessionFile = path.join(tmpRoot, "sessions", `${crypto.randomUUID()}.validator.jsonl`);

    const validatorSessionManager = SessionManager.open(validatorSessionFile);
    validatorSessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Seed: validate WM/STM/LTM smoke output." }],
      timestamp: Date.now(),
    });
    const validatorSessionId = validatorSessionManager.getSessionId();

    const validatorSystemPrompt = buildValidatorSystemPrompt({
      scenario: args.scenario,
      today,
    });
    await writeArtifactFile({
      artifactsDir,
      relPath: "prompts/validator.prompt.txt",
      content: DEFAULT_VALIDATOR_PROMPT,
    });
    await writeArtifactFile({
      artifactsDir,
      relPath: "prompts/validator.system.txt",
      content: validatorSystemPrompt,
    });

    const validatorResult = await runEmbeddedPiAgent({
      sessionId: validatorSessionId,
      sessionKey: validatorSessionKey,
      sessionFile: validatorSessionFile,
      workspaceDir,
      agentDir: validatorAgentDir,
      config: validatorCfg,
      prompt: DEFAULT_VALIDATOR_PROMPT,
      extraSystemPrompt: validatorSystemPrompt,
      provider,
      model,
      timeoutMs: 300_000,
      runId: crypto.randomUUID(),
    });

    const verdictText = extractRunText(validatorResult);
    await writeArtifactFile({
      artifactsDir,
      relPath: "validator/verdict.json",
      content: verdictText || "<empty>",
    });

    const verdict = parseValidatorVerdict(verdictText);
    if (!verdict || typeof verdict.pass !== "boolean") {
      throw new Error(`Validator returned invalid verdict: ${verdictText}`);
    }
    if (!verdict.pass) {
      const issues = Array.isArray(verdict.issues) ? verdict.issues.join("; ") : "unknown issues";
      throw new Error(`Validator reported failure: ${issues}`);
    }

    if (args.verbose) {
      // eslint-disable-next-line no-console
      console.log("\n--- validator verdict ---");
      // eslint-disable-next-line no-console
      console.log(verdictText);
    }
  }

  await writeArtifactFile({
    artifactsDir,
    relPath: "meta.json",
    content: JSON.stringify(
      {
        scenario: args.scenario,
        provider,
        model,
        tmpRoot,
        workspaceDir,
        sessionFile,
        validatorSessionFile: validatorSessionFile ?? undefined,
        artifactsDir,
      },
      null,
      2,
    ),
  });

  // eslint-disable-next-line no-console
  console.log("OK: WM/STM/LTM smoke run passed.");
  // eslint-disable-next-line no-console
  console.log(`Scenario:  ${args.scenario}`);
  // eslint-disable-next-line no-console
  console.log(`Workspace: ${workspaceDir}`);
  // eslint-disable-next-line no-console
  console.log(`Session:   ${sessionFile}`);
  if (validatorSessionFile) {
    // eslint-disable-next-line no-console
    console.log(`Validator: ${validatorSessionFile}`);
  }
  // eslint-disable-next-line no-console
  console.log(`Artifacts: ${artifactsDir}`);
  // eslint-disable-next-line no-console
  console.log(`Model:     ${provider}/${model}`);

  if (args.dumpDir) {
    const resolvedDumpDir = path.resolve(args.dumpDir);
    const target = path.join(resolvedDumpDir, path.basename(tmpRoot));
    await fs.mkdir(resolvedDumpDir, { recursive: true });
    await fs.cp(tmpRoot, target, { recursive: true });
    // eslint-disable-next-line no-console
    console.log(`Dumped:    ${target}`);
  }

  if (args.cleanup && !args.dumpDir) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

await main();
