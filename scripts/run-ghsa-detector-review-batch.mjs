#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_MODEL = "claude-opus-4.6";
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));
const DEFAULT_REPO = "openclaw/openclaw";

function printHelp() {
  console.log(`Usage: node run-ghsa-detector-review-batch.mjs [--input <file>] [options]

Run headless GHSA detector reviews in parallel against any coding harness
(Rovo Dev / Claude Code / Codex / OpenCode / custom). Pass --harness <name>
to pick one of the built-in adapters or --harness-cmd '<template>' for a
custom invocation.

Options:
  --input <file>            Advisory export JSON file
  --ghsa <id>               Limit to one or more GHSA ids (repeatable)
  --state <state>           Limit to one or more advisory states (repeatable)
  --limit <n>               Limit the number of queued advisories
  --concurrency <n>         Parallel worker count (default: ${DEFAULT_CONCURRENCY})
  --run-id <id>             Override the generated run id
  --resume                  Reuse an existing run directory and skip succeeded cases
  --run-dir <dir>           Override the run directory
  --worktree-root <dir>     Override the detached worktree root
  --model <id>              Model to use (default: ${DEFAULT_MODEL})
  --harness <name>          Coding-harness adapter to invoke. Built-in adapters:
                            rovodev, claude, codex, opencode (default: claude)
  --harness-cmd <template>  Override the built-in adapter with a custom shell-style
                            command template. Substitutions: {prompt}, {model},
                            {output_file}. Example: 'codex exec --model {model} {prompt}'
  --timeout-ms <ms>         Per-case timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --fail-fast               Stop queueing new cases after the first failure
  --prompt-suffix-file <p>  Append the contents of this file to every case prompt
  --validate-coverage       After each case, run the OpenGrep general rule against
                            the vulnerable commit's changed files. If A=yes but the
                            rule produces 0 findings, mark the case as no-coverage.
  --retry-no-coverage <N>   When --validate-coverage is on, automatically rerun any
                            case marked 'no-coverage' up to N more times. Default: 0.
                            The retry uses the same prompt suffix; the agent gets a
                            fresh worktree but inherits the failed status as a hint.
  --no-summary-csv          Skip writing run-summary.csv at end of run.
  --help                    Show this help
`);
}

function isDirectRun() {
  const direct = process.argv[1];
  return Boolean(direct && import.meta.url.endsWith(direct));
}

function toLower(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function normalizeGhsaId(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("GHSA id is required");
  }
  return trimmed.toUpperCase();
}

function ghsaSlug(ghsaId) {
  return normalizeGhsaId(ghsaId).toLowerCase();
}

function assertPositiveInt(raw, flagName) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return value;
}

function replaceForPath(value) {
  return String(value).replaceAll(":", "-");
}

export function buildRunId(now = new Date()) {
  return replaceForPath(now.toISOString().replace(/\.\d{3}Z$/, "Z"));
}

export function buildGitHubAdvisoriesFetchArgs() {
  return [
    "gh",
    "api",
    "--paginate",
    "--slurp",
    `/repos/${DEFAULT_REPO}/security-advisories?per_page=100`,
  ];
}

export function buildCasePaths(params) {
  const slug = ghsaSlug(params.ghsaId);
  const caseDir = path.join(params.runDir, "cases", slug);
  const caseWorkspaceRoot = path.join(caseDir, ".tmp", "ghsa-detector-review", slug);
  return {
    caseDir,
    caseWorkspaceRoot,
    advisoryPath: path.join(caseDir, "advisory.json"),
    promptPath: path.join(caseDir, "prompt.md"),
    stdoutPath: path.join(caseDir, "harness-stdout.log"),
    lastMessagePath: path.join(caseDir, "last-message.md"),
    summaryPath: path.join(caseDir, "summary.json"),
    logsDir: path.join(caseDir, "logs"),
    stderrPath: path.join(caseDir, "logs", "stderr.log"),
    reportPath: path.join(caseWorkspaceRoot, "report.md"),
  };
}

function advisoryAccepted(advisory) {
  return advisory?.submission?.accepted === true;
}

export function selectAdvisories(input, options = {}) {
  const states = new Set((options.states ?? []).map((entry) => toLower(entry)).filter(Boolean));
  const ghsaIds = new Set(
    (options.ghsaIds ?? []).map((entry) => normalizeGhsaId(entry)).filter(Boolean),
  );
  const acceptedOnly = options.acceptedOnly ?? true;

  let selected = [...input];
  if (acceptedOnly) {
    selected = selected.filter((entry) => advisoryAccepted(entry));
  }
  if (states.size > 0) {
    selected = selected.filter((entry) => states.has(toLower(entry.state)));
  }
  if (ghsaIds.size > 0) {
    selected = selected.filter((entry) => ghsaIds.has(normalizeGhsaId(entry.ghsa_id)));
  }
  if (options.limit) {
    selected = selected.slice(0, options.limit);
  }
  return selected;
}

export function buildPrompt(params) {
  const ghsaId = normalizeGhsaId(params.advisory.ghsa_id);
  const summary = String(params.advisory.summary ?? "").trim();
  const state = String(params.advisory.state ?? "").trim() || "unknown";
  const lines = [
    `Follow the GHSA detector-review specification at \`${params.skillPath}\` for this advisory.`,
    "",
    `Review advisory \`${ghsaId}\` in this openclaw worktree and produce the detector-review outputs required by the spec.`,
    "",
    "Constraints:",
    `- Advisory JSON: \`${params.advisoryPath}\``,
    `- Pre-seeded case workspace: \`${params.caseWorkspaceRoot}\``,
    "- Write all detector-review artifacts into that case workspace, not into the worktree's own `.tmp` directory.",
    "- Perform any required repo inspection, git history recovery, detector generation, and testing in the isolated worktree for this case.",
    "- Keep the final response concise and include the fix commit, vulnerable commit/tree, detector decisions for A/B/C, and the artifact paths you wrote.",
    "",
    "Advisory summary:",
    `- GHSA: \`${ghsaId}\``,
    `- State: \`${state}\``,
    `- Summary: ${summary || "(no summary provided)"}`,
  ];
  const suffix = String(params.promptSuffix ?? "").trim();
  if (suffix) {
    lines.push("", suffix);
  }
  return lines.join("\n");
}

/**
 * Build an enhanced prompt suffix for a case that previously came back as
 * 'no-coverage' (A=yes shipped but rule produces 0 findings on the
 * vulnerable commit's changed files). Concatenates the base suffix with
 * targeted feedback about the prior failure.
 */
export function buildNoCoverageRetrySuffix({ basePromptSuffix, attempt, previousCoverage }) {
  const fix = previousCoverage?.fix || "<unknown fix commit>";
  const vuln = previousCoverage?.vuln || "<unknown vuln commit>";
  const changed = previousCoverage?.changedFiles ?? "<unknown>";
  const lines = [
    String(basePromptSuffix ?? "").trim(),
    "",
    "## RETRY (previous attempt failed coverage check)",
    "",
    `This is retry attempt ${attempt + 1}. The previous version of this case shipped \`A=yes\` but produced **0 findings** when the rule was run against the vulnerable commit's changed files.`,
    "",
    `- Previous fix commit: \`${fix}\``,
    `- Previous vulnerable commit: \`${vuln}\``,
    `- Files changed by fix: ${changed}`,
    "",
    "Mandatory diagnostic before writing any rule:",
    "1. `git show <vuln-commit>:<file>` for each fix-changed source file",
    "2. Identify the *exact* tokens, identifiers, or structural patterns present in the **vulnerable** code that distinguish it from the **patched** code",
    "3. Build a rule whose patterns appear in those vulnerable files",
    "4. Re-run the Step 5.5 coverage validation in the skill against the **vuln commit** files (not your synthetic fixtures)",
    "5. If after careful inspection the vuln commit genuinely lacks any matchable token (because the fix is purely additive), set `A=no` OR include the literal phrase `Rule unmatchable on vuln commit because fix is additive` in the report's Coverage validation section, and validate against synthetic fixtures only.",
    "",
    "Acceptable outcomes for this retry:",
    "- A=yes with >=1 finding on vuln-commit changed files (preferred)",
    "- A=yes with the additive-fix annotation if the fix truly adds new symbols/keys",
    "- A=no with a clear technical justification of why no rule can match",
    "",
    "Unacceptable: A=yes with 0 findings on vuln commit and no additive-fix annotation.",
  ];
  return lines.join("\n").trim();
}

/**
 * Built-in coding-harness adapters. Each adapter is a function that takes
 * `{ model, prompt, lastMessagePath }` and returns an `argv` array suitable
 * for `spawn`. The runner invokes the chosen harness in the case worktree as
 * a non-interactive single-prompt agent.
 *
 * Adapters intentionally pass the prompt and require the agent to write any
 * artifacts inside the case workspace (which is referenced from the prompt).
 * Where the harness has a way to capture the final assistant message to a
 * file, we use it; otherwise we just rely on stdout being captured by the
 * runner.
 */
export const HARNESS_ADAPTERS = {
  rovodev: ({ model, prompt, lastMessagePath }) => [
    "acli",
    "rovodev",
    "legacy",
    "--yolo",
    "--config-override",
    JSON.stringify({ agent: { modelId: model } }),
    "--output-file",
    lastMessagePath,
    prompt,
  ],
  claude: ({ model, prompt }) => {
    // claude code: non-interactive single-prompt mode via -p
    const argv = ["claude", "--dangerously-skip-permissions"];
    if (model) {
      argv.push("--model", model);
    }
    argv.push("-p", prompt);
    return argv;
  },
  codex: ({ model, prompt }) => {
    // codex exec: non-interactive single-prompt mode
    const argv = ["codex", "exec", "--full-auto"];
    if (model) {
      argv.push("--model", model);
    }
    argv.push(prompt);
    return argv;
  },
  opencode: ({ model, prompt }) => {
    // opencode run: non-interactive single-prompt mode
    const argv = ["opencode", "run"];
    if (model) {
      argv.push("--model", model);
    }
    argv.push(prompt);
    return argv;
  },
};

/**
 * Substitute placeholders in a custom harness-cmd template into a runnable
 * argv array. The template is parsed shell-style; supported placeholders:
 *
 *   {prompt}           - the case prompt
 *   {model}            - the configured model id
 *   {output_file}      - path the agent should write its final message to
 *   {output-file}      - same (kebab-case alias)
 *   {last_message}     - same
 *
 * Example:
 *   --harness-cmd 'codex exec --model {model} {prompt}'
 *
 * Note: this is a deliberately simple shell-style splitter; no quoting beyond
 * single-/double-quoted segments. For anything more elaborate, prefer wrapping
 * the harness in a shell script and passing that as the binary.
 */
export function buildHarnessExecArgsFromTemplate(template, substitutions) {
  const tokens = splitShellTokens(template);
  const out = [];
  for (const tok of tokens) {
    out.push(applySubstitutions(tok, substitutions));
  }
  return out;
}

function splitShellTokens(input) {
  const tokens = [];
  let buf = "";
  let quote = null; // null | '"' | "'"
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) {
    tokens.push(buf);
  }
  return tokens;
}

function applySubstitutions(value, subs) {
  return value
    .replaceAll("{prompt}", subs.prompt ?? "")
    .replaceAll("{model}", subs.model ?? "")
    .replaceAll("{output_file}", subs.lastMessagePath ?? "")
    .replaceAll("{output-file}", subs.lastMessagePath ?? "")
    .replaceAll("{last_message}", subs.lastMessagePath ?? "");
}

export function buildHarnessExecArgs(params) {
  const subs = {
    model: params.model,
    prompt: params.prompt,
    lastMessagePath: params.lastMessagePath,
  };
  if (params.harnessCmd) {
    return buildHarnessExecArgsFromTemplate(params.harnessCmd, subs);
  }
  const adapter = HARNESS_ADAPTERS[params.harness];
  if (!adapter) {
    throw new Error(
      `Unknown harness: ${params.harness}. Built-in adapters: ${Object.keys(HARNESS_ADAPTERS).join(", ")}. Use --harness-cmd to provide a custom command.`,
    );
  }
  return adapter(subs);
}

function jsonIndent(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, jsonIndent(value), "utf8");
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runCommandDefault(argv, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        resolve({ stdout, stderr, code: null });
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

async function runBestEffortCleanup(cleanup) {
  try {
    await cleanup();
  } catch {}
}

export async function prepareCaseArtifacts(params) {
  await fs.mkdir(params.paths.logsDir, { recursive: true });
  await writeJson(params.paths.advisoryPath, params.advisory);
  await writeText(params.paths.promptPath, params.prompt);
  const initResult = await params.runCommand(
    [
      "python3",
      params.skillInitScript,
      normalizeGhsaId(params.advisory.ghsa_id),
      "--root",
      params.paths.caseDir,
    ],
    { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  if (initResult.code !== 0) {
    throw new Error(
      [
        `Failed to initialize case workspace for ${normalizeGhsaId(params.advisory.ghsa_id)}`,
        initResult.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function createDetachedWorktree(params) {
  await fs.mkdir(path.dirname(params.worktreeDir), { recursive: true });
  const result = await params.runCommand(
    ["git", "-C", params.repoRoot, "worktree", "add", "--detach", params.worktreeDir, "HEAD"],
    { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    throw new Error(
      [`Failed to create worktree for ${params.ghsaId}`, result.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function cleanupDetachedWorktree(params) {
  await runBestEffortCleanup(async () => {
    await params.runCommand(
      ["git", "-C", params.repoRoot, "worktree", "remove", "--force", params.worktreeDir],
      { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
  });
  await runBestEffortCleanup(async () => {
    await params.runCommand(["git", "-C", params.repoRoot, "worktree", "prune"], {
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  });
  await runBestEffortCleanup(async () => {
    await fs.rm(params.worktreeDir, { recursive: true, force: true });
  });
}

export async function runHarnessDefault(params) {
  await fs.mkdir(params.casePaths.logsDir, { recursive: true });
  const startedAt = Date.now();

  return await new Promise((resolve, reject) => {
    const child = spawn(params.args[0], params.args.slice(1), {
      cwd: params.worktreeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const timer =
      params.timeoutMs && params.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            child.kill("SIGKILL");
          }, params.timeoutMs)
        : null;

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });

    child.on("error", async (error) => {
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      await Promise.all([
        fs.writeFile(params.casePaths.stdoutPath, Buffer.concat(stdoutChunks)),
        fs.writeFile(params.casePaths.stderrPath, Buffer.concat(stderrChunks)),
      ]);
      reject(error);
    });

    child.on("close", async (code) => {
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      await Promise.all([
        fs.writeFile(params.casePaths.stdoutPath, Buffer.concat(stdoutChunks)),
        fs.writeFile(params.casePaths.stderrPath, Buffer.concat(stderrChunks)),
      ]);
      resolve({
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function summarizeCaseStatus(params) {
  if (params.exitCode === 0 && params.hasReport) {
    if (
      params.coverageRequired &&
      params.coverage &&
      params.coverage.aDecision === "yes" &&
      params.coverage.findings === 0 &&
      !params.coverage.additiveFix
    ) {
      return "no-coverage";
    }
    return "succeeded";
  }
  if (params.exitCode === 0) {
    return "missing-report";
  }
  return "failed";
}

async function readFileBestEffort(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseReportCommits(reportText) {
  // Match a sha (7-40 hex) optionally followed by parent qualifiers like ^, ^^, ~1, ~3
  // e.g.: f1e1ad7, f1e1ad7^, f1e1ad7~1, f1e1ad7^2
  const shaPart = "([a-f0-9]{7,40}(?:[\\^~][\\^~0-9]*)?)";
  const fixRegex = new RegExp(`Fix commit:[^\\n]*?\\b${shaPart}\\b`, "i");
  const vulnRegex = new RegExp(`Vulnerable commit[^\\n]*?\\b${shaPart}\\b`, "i");
  const fixMatch = fixRegex.exec(reportText);
  const vulnMatch = vulnRegex.exec(reportText);
  return {
    fix: fixMatch ? fixMatch[1] : "",
    vuln: vulnMatch ? vulnMatch[1] : "",
  };
}

function parseADecision(reportText) {
  // Match "| `A` ... | yes |" or "| `A` ... | no |"
  const m = /\|\s*`A`[^|]*\|\s*(yes|no)\s*\|/i.exec(reportText);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Parse the optional "Extracted-as:" hint from the agent's Coverage validation
 * section. Format expected:
 *   Extracted-as:
 *   - path/to/original -> path/to/renamed
 *   - some/file.ext -> some/file.other-ext
 * or inline:
 *   Extracted-as: original.ext -> renamed.ext, other -> other.sh
 *
 * Returns a Map<originalPath, renamedPath>.
 */
function parseExtractedAs(reportText) {
  const map = new Map();
  if (!reportText) {
    return map;
  }

  // Look for a line starting with "Extracted-as" (with optional dash/colon)
  const blockRegex = /(?:^|\n)\s*[-*]?\s*Extracted-as\s*:?\s*(.*?)(?=\n\s*\n|\n##|\n- [A-Z]|$)/is;
  const blockMatch = blockRegex.exec(reportText);
  if (!blockMatch) {
    return map;
  }

  const block = blockMatch[1] || "";
  const arrowRegex = /([^\s,;`]+)\s*(?:->|→)\s*([^\s,;`]+)/g;
  let match;
  while ((match = arrowRegex.exec(block)) !== null) {
    const original = match[1].replace(/^[`'"]+|[`'"]+$/g, "");
    const renamed = match[2].replace(/^[`'"]+|[`'"]+$/g, "");
    if (original && renamed) {
      map.set(original, renamed);
    }
  }
  return map;
}

/**
 * Detect "additive fix" annotations in the report. The agent uses these to flag
 * cases where the rule cannot logically match the vuln commit (e.g. the fix
 * adds new symbols/keys that the rule looks for; they don't exist pre-fix).
 */
function isAdditiveFixAnnotated(reportText) {
  if (!reportText) {
    return false;
  }
  return /Rule\s+unmatchable\s+on\s+vuln\s+commit\s+because\s+fix\s+is\s+additive/i.test(
    reportText,
  );
}

export async function validateCoverage(params) {
  const reportText = await readFileBestEffort(params.reportPath);
  if (!reportText) {
    return { ok: false, reason: "no-report" };
  }
  const aDecision = parseADecision(reportText);
  const { fix, vuln } = parseReportCommits(reportText);
  if (!fix || !vuln) {
    return { ok: false, reason: "no-commits", aDecision };
  }
  const rulePath = path.join(params.caseWorkspaceRoot, "opengrep", "general-rule.yml");
  if (!(await pathExists(rulePath))) {
    return { ok: false, reason: "no-rule", fix, vuln, aDecision };
  }
  const ruleStat = await fs.stat(rulePath);
  if (ruleStat.size === 0) {
    return { ok: false, reason: "empty-rule", fix, vuln, aDecision };
  }

  // Honor agent-declared "additive fix" cases — these legitimately can't have
  // findings on the vuln commit. Mark as ok with a flag so downstream status
  // logic doesn't mark them as no-coverage.
  const additiveFix = isAdditiveFixAnnotated(reportText);

  // Get changed files from fix commit
  const diffResult = await params.runCommand(
    ["git", "-C", params.repoRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", fix],
    { timeoutMs: 30_000 },
  );
  if (diffResult.code !== 0) {
    return {
      ok: false,
      reason: "diff-failed",
      fix,
      vuln,
      aDecision,
      stderr: (diffResult.stderr || "").slice(0, 200),
    };
  }
  const changedFiles = diffResult.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !/\.(md|json|lock)$/i.test(s) && !/^CHANGELOG/i.test(s));

  if (changedFiles.length === 0) {
    return { ok: false, reason: "no-source-files-changed", fix, vuln, aDecision, additiveFix };
  }

  // Honor optional "Extracted-as: <orig> -> <renamed>" hints from the report so
  // opengrep can parse files the agent renamed for parser-friendliness.
  const extractedAs = parseExtractedAs(reportText);

  // Extract files at vuln commit into temp dir
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `ghsa-coverage-${ghsaSlug(params.ghsaId)}-`),
  );
  try {
    for (const file of changedFiles) {
      const renamed = extractedAs.get(file) || file;
      const target = path.join(tmpDir, renamed);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const showResult = await params.runCommand(
        ["git", "-C", params.repoRoot, "show", `${vuln}:${file}`],
        { timeoutMs: 30_000 },
      );
      if (showResult.code === 0) {
        await fs.writeFile(target, showResult.stdout);
      }
    }

    // Run opengrep
    const semResult = await params.runCommand(
      ["opengrep", "scan", "--config", rulePath, "--json", "--no-git-ignore", tmpDir],
      { timeoutMs: 120_000 },
    );
    let findings = 0;
    try {
      const parsed = JSON.parse(semResult.stdout || "{}");
      findings = (parsed.results || []).length;
    } catch {
      return { ok: false, reason: "opengrep-parse-error", fix, vuln, aDecision, additiveFix };
    }

    return {
      ok: true,
      fix,
      vuln,
      aDecision,
      changedFiles: changedFiles.length,
      findings,
      additiveFix,
      extractedAs: extractedAs.size > 0 ? Object.fromEntries(extractedAs) : undefined,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildCaseSummary(params) {
  const summary = {
    ghsaId: params.ghsaId,
    status: params.status,
    exitCode: params.exitCode,
    durationMs: params.durationMs,
    caseDir: params.caseDir,
    caseWorkspaceRoot: params.caseWorkspaceRoot,
    reportPath: params.reportPath,
    advisoryPath: params.advisoryPath,
    promptPath: params.promptPath,
    stdoutPath: params.stdoutPath,
    lastMessagePath: params.lastMessagePath,
  };
  if (params.coverage) {
    summary.coverage = params.coverage;
  }
  return summary;
}

export async function runSingleCase(params) {
  const ghsaId = normalizeGhsaId(params.advisory.ghsa_id);
  const paths = buildCasePaths({
    repoRoot: params.repoRoot,
    runDir: params.runDir,
    ghsaId,
  });
  const worktreeDir = path.join(params.worktreeRoot, ghsaSlug(ghsaId));
  const prompt = buildPrompt({
    advisory: params.advisory,
    advisoryPath: paths.advisoryPath,
    caseWorkspaceRoot: paths.caseWorkspaceRoot,
    skillPath: params.skillPath,
    promptSuffix: params.promptSuffix,
  });

  await prepareCaseArtifacts({
    paths,
    advisory: params.advisory,
    prompt,
    skillInitScript: params.skillInitScript,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs,
  });

  await createDetachedWorktree({
    repoRoot: params.repoRoot,
    worktreeDir,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs,
    ghsaId,
  });

  let exitCode = -1;
  let durationMs = 0;
  try {
    const result = await params.runHarness({
      args: buildHarnessExecArgs({
        harness: params.harness,
        harnessCmd: params.harnessCmd,
        model: params.model,
        lastMessagePath: paths.lastMessagePath,
        prompt,
      }),
      casePaths: paths,
      worktreeDir,
      timeoutMs: params.timeoutMs,
    });
    exitCode = result.exitCode;
    durationMs = result.durationMs;
  } finally {
    await cleanupDetachedWorktree({
      repoRoot: params.repoRoot,
      worktreeDir,
      runCommand: params.runCommand,
      timeoutMs: params.timeoutMs,
    });
  }

  const hasReport = await pathExists(paths.reportPath);

  let coverage = null;
  if (params.validateCoverage && exitCode === 0 && hasReport) {
    try {
      coverage = await validateCoverage({
        repoRoot: params.repoRoot,
        ghsaId,
        reportPath: paths.reportPath,
        caseWorkspaceRoot: paths.caseWorkspaceRoot,
        runCommand: params.runCommand,
      });
    } catch (error) {
      coverage = { ok: false, reason: "exception", error: String(error) };
    }
  }

  const status = summarizeCaseStatus({
    exitCode,
    hasReport,
    coverageRequired: Boolean(params.validateCoverage),
    coverage,
  });
  const summary = buildCaseSummary({
    ghsaId,
    status,
    exitCode,
    durationMs,
    caseDir: paths.caseDir,
    caseWorkspaceRoot: paths.caseWorkspaceRoot,
    reportPath: paths.reportPath,
    advisoryPath: paths.advisoryPath,
    promptPath: paths.promptPath,
    stdoutPath: paths.stdoutPath,
    lastMessagePath: paths.lastMessagePath,
    coverage,
  });
  await writeJson(paths.summaryPath, summary);
  return summary;
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Write a per-case CSV summary at end of run for quick eyeballing/spreadsheet
 * import. Columns: ghsa,status,exit,duration_s,a_decision,fix,vuln,changed,findings,additive,attempts.
 */
export async function writeRunSummaryCsv(runDir, manifest) {
  const rows = [
    [
      "ghsa",
      "status",
      "exit",
      "duration_s",
      "a_decision",
      "fix",
      "vuln",
      "changed_files",
      "vuln_findings",
      "additive_fix",
      "attempts",
    ].join(","),
  ];
  const entries = Object.entries(manifest.cases || {}).toSorted(([a], [b]) => a.localeCompare(b));
  for (const [ghsaId, info] of entries) {
    const cov = info.coverage || {};
    rows.push(
      [
        csvEscape(ghsaId),
        csvEscape(info.status ?? ""),
        csvEscape(info.exitCode ?? ""),
        csvEscape(info.durationMs != null ? Math.round(info.durationMs / 1000) : ""),
        csvEscape(cov.aDecision ?? ""),
        csvEscape(cov.fix ?? ""),
        csvEscape(cov.vuln ?? ""),
        csvEscape(cov.changedFiles ?? ""),
        csvEscape(cov.findings ?? ""),
        csvEscape(cov.additiveFix ? "yes" : ""),
        csvEscape(info.attempts ?? 1),
      ].join(","),
    );
  }
  const csvPath = path.join(runDir, "run-summary.csv");
  await fs.writeFile(csvPath, rows.join("\n") + "\n");
  return csvPath;
}

function manifestCounts(cases) {
  const entries = Object.values(cases);
  return {
    total: entries.length,
    queued: entries.filter((entry) => entry.status === "queued").length,
    running: entries.filter((entry) => entry.status === "running").length,
    succeeded: entries.filter((entry) => entry.status === "succeeded").length,
    failed: entries.filter(
      (entry) =>
        entry.status !== "queued" && entry.status !== "running" && entry.status !== "succeeded",
    ).length,
  };
}

async function loadAdvisoriesFromInput(inputPath) {
  const parsed = JSON.parse(await fs.readFile(inputPath, "utf8"));
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed?.advisories)) {
    return parsed.advisories;
  }
  throw new Error(`Input file ${inputPath} does not contain an advisories array`);
}

export async function loadAdvisories(params) {
  if (params.inputPath) {
    return {
      advisories: await loadAdvisoriesFromInput(params.inputPath),
      source: { type: "file", path: params.inputPath },
    };
  }

  const result = await params.runCommand(buildGitHubAdvisoriesFetchArgs(), {
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      [`Failed to fetch advisories from ${DEFAULT_REPO}`, result.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const parsed = JSON.parse(result.stdout);
  const advisories = Array.isArray(parsed) ? parsed.flat() : [];
  if (params.runDir) {
    const snapshotPath = path.join(params.runDir, "fetched-advisories.json");
    await writeJson(snapshotPath, {
      repo: DEFAULT_REPO,
      fetchedAt: new Date().toISOString(),
      advisories,
    });
    return {
      advisories,
      source: { type: "github", path: snapshotPath },
    };
  }
  return {
    advisories,
    source: { type: "github" },
  };
}

async function writeManifest(manifestPath, manifest) {
  await writeJson(manifestPath, {
    ...manifest,
    counts: manifestCounts(manifest.cases),
  });
}

function shouldSkipSucceededCase(existingCases, ghsaId, resume) {
  if (!resume) {
    return false;
  }
  return existingCases[ghsaId]?.status === "succeeded";
}

export async function runBatch(params) {
  const runDir =
    params.runDir ??
    path.join(params.repoRoot, ".artifacts", "ghsa-detector-review-runs", params.runId);
  await fs.mkdir(runDir, { recursive: true });

  const manifestPath = path.join(runDir, "manifest.json");
  const manifestEventsPath = path.join(runDir, "manifest.ndjson");
  const existingManifest =
    params.resume && (await pathExists(manifestPath))
      ? JSON.parse(await fs.readFile(manifestPath, "utf8"))
      : null;

  const manifest = {
    runId: params.runId,
    repoRoot: params.repoRoot,
    runDir,
    inputPath: params.inputPath,
    advisorySource: params.advisorySource,
    startedAt: existingManifest?.startedAt ?? new Date().toISOString(),
    finishedAt: null,
    options: {
      concurrency: params.concurrency,
      model: params.model,
      failFast: params.failFast,
      resume: params.resume,
    },
    cases: existingManifest?.cases ?? {},
  };

  for (const advisory of params.advisories) {
    const ghsaId = normalizeGhsaId(advisory.ghsa_id);
    if (!manifest.cases[ghsaId]) {
      manifest.cases[ghsaId] = { status: "queued" };
    }
  }

  await appendJsonLine(manifestEventsPath, {
    type: "run-started",
    runId: params.runId,
    startedAt: new Date().toISOString(),
  });
  await writeManifest(manifestPath, manifest);

  const pending = params.advisories.filter(
    (advisory) =>
      !shouldSkipSucceededCase(manifest.cases, normalizeGhsaId(advisory.ghsa_id), params.resume),
  );
  let aborted = false;

  async function worker() {
    while (pending.length > 0 && !aborted) {
      const advisory = pending.shift();
      if (!advisory) {
        return;
      }
      const ghsaId = normalizeGhsaId(advisory.ghsa_id);
      manifest.cases[ghsaId] = {
        ...manifest.cases[ghsaId],
        status: "running",
        startedAt: new Date().toISOString(),
      };
      await appendJsonLine(manifestEventsPath, {
        type: "case-started",
        ghsaId,
        startedAt: manifest.cases[ghsaId].startedAt,
      });
      await writeManifest(manifestPath, manifest);

      try {
        const maxRetries = params.retryNoCoverage ?? 0;
        let attempt = 0;
        let summary = null;
        let promptSuffix = params.promptSuffix;
        while (true) {
          attempt += 1;
          summary = await params.runSingleCase({
            repoRoot: params.repoRoot,
            runDir,
            advisory,
            skillPath: params.skillPath,
            skillInitScript: params.skillInitScript,
            worktreeRoot: params.worktreeRoot,
            model: params.model,
            harness: params.harness,
            harnessCmd: params.harnessCmd,
            timeoutMs: params.timeoutMs,
            promptSuffix,
            validateCoverage: params.validateCoverage,
            runCommand: params.runCommand,
            runHarness: params.runHarness,
          });
          if (summary.status !== "no-coverage" || attempt > maxRetries) {
            break;
          }
          // Build a stronger retry prompt suffix that includes the prior failure
          promptSuffix = buildNoCoverageRetrySuffix({
            basePromptSuffix: params.promptSuffix,
            attempt,
            previousCoverage: summary.coverage,
          });
        }
        manifest.cases[ghsaId] = {
          ...summary,
          status: summary.status,
          finishedAt: new Date().toISOString(),
          attempts: attempt,
        };
      } catch (error) {
        manifest.cases[ghsaId] = {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        if (params.failFast) {
          aborted = true;
        }
      }

      await appendJsonLine(manifestEventsPath, {
        type: "case-finished",
        ghsaId,
        finishedAt: manifest.cases[ghsaId].finishedAt,
        status: manifest.cases[ghsaId].status,
      });
      await writeManifest(manifestPath, manifest);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(params.concurrency, pending.length || 1) }, () => worker()),
  );

  manifest.finishedAt = new Date().toISOString();
  await appendJsonLine(manifestEventsPath, {
    type: "run-finished",
    runId: params.runId,
    finishedAt: manifest.finishedAt,
    counts: manifestCounts(manifest.cases),
  });
  await writeManifest(manifestPath, manifest);
  return { manifestPath, manifestEventsPath, runDir, manifest };
}

function parseArgs(argv) {
  const options = {
    inputPath: "",
    ghsaIds: [],
    states: [],
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    runId: "",
    resume: false,
    runDir: "",
    worktreeRoot: "",
    model: DEFAULT_MODEL,
    harness: "claude",
    harnessCmd: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    failFast: false,
    promptSuffixFile: "",
    validateCoverage: false,
    retryNoCoverage: 0,
    summaryCsv: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--input":
        options.inputPath = path.resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--ghsa":
        options.ghsaIds.push(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--state":
        options.states.push(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--limit":
        options.limit = assertPositiveInt(argv[index + 1], arg);
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = assertPositiveInt(argv[index + 1], arg);
        index += 1;
        break;
      case "--run-id":
        options.runId = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--run-dir":
        options.runDir = path.resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--worktree-root":
        options.worktreeRoot = path.resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--model":
        options.model = argv[index + 1] ?? DEFAULT_MODEL;
        index += 1;
        break;
      case "--harness": {
        const value = argv[index + 1] ?? "";
        if (!HARNESS_ADAPTERS[value]) {
          throw new Error(
            `Invalid --harness: '${value}'. Built-in adapters: ${Object.keys(HARNESS_ADAPTERS).join(", ")}. Use --harness-cmd for custom commands.`,
          );
        }
        options.harness = value;
        index += 1;
        break;
      }
      case "--harness-cmd":
        options.harnessCmd = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = assertPositiveInt(argv[index + 1], arg);
        index += 1;
        break;
      case "--fail-fast":
        options.failFast = true;
        break;
      case "--prompt-suffix-file":
        options.promptSuffixFile = path.resolve(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--validate-coverage":
        options.validateCoverage = true;
        break;
      case "--retry-no-coverage": {
        const raw = argv[index + 1];
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid value for --retry-no-coverage: ${raw}`);
        }
        options.retryNoCoverage = parsed;
        index += 1;
        break;
      }
      case "--no-summary-csv":
        options.summaryCsv = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.resume && !options.runId && !options.runDir) {
    throw new Error("--resume requires --run-id or --run-dir");
  }
  if (options.retryNoCoverage > 0 && !options.validateCoverage) {
    throw new Error("--retry-no-coverage requires --validate-coverage");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const runId = options.runId || buildRunId();
  const runDir =
    options.runDir ||
    path.join(repoRoot, ".artifacts", "ghsa-detector-review-runs", replaceForPath(runId));
  const worktreeRoot =
    options.worktreeRoot ||
    path.join(os.tmpdir(), "openclaw-ghsa-detector-review-worktrees", replaceForPath(runId));
  await fs.mkdir(runDir, { recursive: true });

  const advisoryLoad = await loadAdvisories({
    inputPath: options.inputPath || undefined,
    runDir,
    runCommand: runCommandDefault,
    timeoutMs: options.timeoutMs,
  });
  const advisories = selectAdvisories(advisoryLoad.advisories, {
    acceptedOnly: true,
    states: options.states,
    ghsaIds: options.ghsaIds,
    limit: options.limit ?? undefined,
  });
  if (advisories.length === 0) {
    throw new Error("No advisories selected");
  }

  // The detector-review spec and per-case init script are checked into this
  // repo at security/detector-review/. We resolve them relative to the script
  // location so the runner works the same regardless of which coding harness
  // (rovodev/claude/codex/opencode/...) is invoking it.
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const detectorReviewDir = path.resolve(scriptDir, "..", "security", "detector-review");
  const skillPath =
    process.env.GHSA_DETECTOR_REVIEW_SPEC ??
    path.join(detectorReviewDir, "detector-review-spec.md");
  const skillInitScript =
    process.env.GHSA_DETECTOR_REVIEW_INIT ??
    path.join(detectorReviewDir, "scripts", "init_case.py");

  let promptSuffix = "";
  if (options.promptSuffixFile) {
    promptSuffix = await fs.readFile(options.promptSuffixFile, "utf8");
  }

  const result = await runBatch({
    repoRoot,
    runId,
    runDir,
    inputPath: options.inputPath || advisoryLoad.source.path || "",
    advisorySource: advisoryLoad.source,
    advisories,
    concurrency: options.concurrency,
    worktreeRoot,
    skillPath,
    skillInitScript,
    model: options.model,
    harness: options.harness,
    harnessCmd: options.harnessCmd,
    timeoutMs: options.timeoutMs,
    promptSuffix,
    validateCoverage: options.validateCoverage,
    retryNoCoverage: options.retryNoCoverage,
    failFast: options.failFast,
    resume: options.resume,
    runCommand: runCommandDefault,
    runHarness: runHarnessDefault,
    runSingleCase,
  });

  if (options.summaryCsv) {
    try {
      const csvPath = await writeRunSummaryCsv(result.runDir, result.manifest);
      console.error(`run-summary.csv written: ${csvPath}`);
    } catch (error) {
      console.error(`Failed to write run-summary.csv: ${error.message ?? error}`);
    }
  }

  console.log(
    jsonIndent({
      runId,
      runDir: result.runDir,
      manifestPath: result.manifestPath,
      counts: manifestCounts(result.manifest.cases),
    }).trim(),
  );
}

try {
  if (isDirectRun()) {
    await main();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
