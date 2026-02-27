import type { BotPluginApi, BotPluginService, BotPluginServiceContext } from "bot/plugin-sdk";
import {
  emptyPluginConfigSchema,
  emitDiagnosticEvent,
  onDiagnosticEvent,
  jsonResult,
} from "bot/plugin-sdk";
import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

type ErrorCategory = "lint" | "typecheck" | "test" | "build" | "ssr" | "unknown";

type CiFailurePayload = {
  event: string;
  repo: string;
  ref: string;
  sha: string;
  run_id: number;
  run_url: string;
  failed_jobs: string[];
  logs_tail: string;
};

type FixLoopConfig = {
  enabled: boolean;
  maxIterations: number;
  maxBudgetPerLoopUsd: number;
  maxBudgetPerDayUsd: number;
  branches: string[];
  modelStrategy: Record<ErrorCategory, string>;
  escalation: {
    channel: string;
    to: string;
  };
};

type FixLoopState = {
  activeLoops: Map<number, FixLoopRun>;
  dailySpendUsd: number;
  dailySpendDate: string;
  consecutiveFailures: number;
  circuitBreakerUntil: number;
  workspaceDir: string;
};

type FixLoopRun = {
  runId: number;
  sha: string;
  startedAt: number;
  iteration: number;
  category: ErrorCategory;
  totalCostUsd: number;
  status: "running" | "success" | "exhausted" | "escalated";
};

type FixLoopRecord = {
  runId: number;
  sha: string;
  category: ErrorCategory;
  iterations: number;
  totalCostUsd: number;
  status: string;
  startedAt: number;
  endedAt: number;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), ".hanzo", "bot", "ci-fix-loop");
const HISTORY_FILE = join(STATE_DIR, "history.json");

const DEFAULT_CONFIG: FixLoopConfig = {
  enabled: true,
  maxIterations: 5,
  maxBudgetPerLoopUsd: 2.0,
  maxBudgetPerDayUsd: 10.0,
  branches: ["main"],
  modelStrategy: {
    lint: "anthropic/claude-sonnet-4-5",
    typecheck: "anthropic/claude-sonnet-4-5",
    test: "anthropic/claude-opus-4-6",
    build: "anthropic/claude-sonnet-4-5",
    ssr: "anthropic/claude-sonnet-4-5",
    unknown: "anthropic/claude-opus-4-6",
  },
  escalation: {
    channel: "slack",
    to: "#ci-alerts",
  },
};

// ─── Error Classifier ────────────────────────────────────────────────────────

const ERROR_PATTERNS: Array<{ category: ErrorCategory; patterns: RegExp[] }> = [
  {
    category: "lint",
    patterns: [
      /oxlint/i,
      /eslint/i,
      /oxfmt/i,
      /prettier/i,
      /formatting/i,
      /lint.*error/i,
      /error.*lint/i,
      /swiftlint/i,
      /swiftformat/i,
    ],
  },
  {
    category: "typecheck",
    patterns: [
      /tsgo/i,
      /tsc.*error/i,
      /type.*error/i,
      /TS\d{4,5}/,
      /cannot find name/i,
      /property.*does not exist/i,
      /type.*is not assignable/i,
      /has no exported member/i,
    ],
  },
  {
    category: "test",
    patterns: [
      /vitest/i,
      /test.*fail/i,
      /assertion.*error/i,
      /expect.*received/i,
      /FAIL\s+\S+\.test\./,
      /test suite failed/i,
    ],
  },
  {
    category: "build",
    patterns: [
      /build.*fail/i,
      /tsdown/i,
      /compilation.*error/i,
      /module not found/i,
      /cannot resolve/i,
      /webpack.*error/i,
      /rollup.*error/i,
      /esbuild.*error/i,
    ],
  },
  {
    category: "ssr",
    patterns: [
      /localStorage/i,
      /window is not defined/i,
      /document is not defined/i,
      /navigator is not defined/i,
      /server.*side.*render/i,
      /SSR/i,
    ],
  },
];

function classifyError(logs: string, failedJobs: string[]): ErrorCategory {
  // Check job names first
  const jobStr = failedJobs.join(" ").toLowerCase();
  if (jobStr.includes("lint") || jobStr.includes("format")) return "lint";
  if (jobStr.includes("type") || jobStr.includes("check")) return "typecheck";
  if (jobStr.includes("test")) return "test";
  if (jobStr.includes("build")) return "build";

  // Pattern-match the logs
  for (const { category, patterns } of ERROR_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(logs)) {
        return category;
      }
    }
  }

  return "unknown";
}

// ─── Budget Gate ─────────────────────────────────────────────────────────────

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Reset daily spend counter if a new day has started. Call before budget checks. */
function resetDailySpendIfNeeded(state: FixLoopState): void {
  const today = getTodayKey();
  if (state.dailySpendDate !== today) {
    state.dailySpendUsd = 0;
    state.dailySpendDate = today;
  }
  // Reset circuit breaker + consecutive failures after cooldown expires
  if (state.circuitBreakerUntil > 0 && state.circuitBreakerUntil <= Date.now()) {
    state.consecutiveFailures = 0;
    state.circuitBreakerUntil = 0;
  }
}

function checkBudget(
  state: FixLoopState,
  config: FixLoopConfig,
  run?: FixLoopRun,
): { allowed: boolean; reason?: string } {
  // Circuit breaker check
  if (state.circuitBreakerUntil > Date.now()) {
    const remaining = Math.ceil((state.circuitBreakerUntil - Date.now()) / 60_000);
    return { allowed: false, reason: `Circuit breaker active for ${remaining} more minutes` };
  }

  // Daily budget check
  if (state.dailySpendUsd >= config.maxBudgetPerDayUsd) {
    return {
      allowed: false,
      reason: `Daily budget exhausted: $${state.dailySpendUsd.toFixed(2)} / $${config.maxBudgetPerDayUsd.toFixed(2)}`,
    };
  }

  // Per-loop budget check
  if (run && run.totalCostUsd >= config.maxBudgetPerLoopUsd) {
    return {
      allowed: false,
      reason: `Loop budget exhausted: $${run.totalCostUsd.toFixed(2)} / $${config.maxBudgetPerLoopUsd.toFixed(2)}`,
    };
  }

  return { allowed: true };
}

// ─── Token Verification ──────────────────────────────────────────────────────

function verifyToken(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

// ─── Diff Guard ──────────────────────────────────────────────────────────────

function buildDiffGuardPrompt(): string {
  return [
    "",
    "## Safety Guardrails",
    "- Do NOT delete or skip tests. Fix them properly.",
    "- Do NOT disable lint rules. Fix the underlying issue.",
    "- Do NOT modify more than 200 lines total.",
    "- Do NOT touch more than 10 files.",
    "- Work on a fix branch: `fix/ci-<run_id>`.",
    "- Run `pnpm check` locally before pushing.",
    "- If unsure, STOP and output: ESCALATE: <reason>",
    "",
  ].join("\n");
}

// ─── Agent Prompt Builder ────────────────────────────────────────────────────

function buildFixPrompt(
  payload: CiFailurePayload,
  category: ErrorCategory,
  iteration: number,
): string {
  const lines: string[] = [];

  lines.push("# CI Fix Loop - Autonomous Repair");
  lines.push("");
  lines.push(`**Iteration:** ${iteration}`);
  lines.push(`**Error Category:** ${category}`);
  lines.push(`**Run URL:** ${payload.run_url}`);
  lines.push(`**SHA:** ${payload.sha}`);
  lines.push(`**Failed Jobs:** ${payload.failed_jobs.join(", ")}`);
  lines.push("");
  lines.push("## CI Failure Logs");
  lines.push("```");
  const maxLogLen = 8000;
  const logs =
    payload.logs_tail.length > maxLogLen ? payload.logs_tail.slice(-maxLogLen) : payload.logs_tail;
  lines.push(logs);
  lines.push("```");
  lines.push("");
  lines.push("## Instructions");
  lines.push("");

  switch (category) {
    case "lint":
      lines.push("1. Run `pnpm check` to reproduce the lint/format errors locally.");
      lines.push(
        "2. Fix the lint/format issues. Use `pnpm exec oxfmt --write .` for format errors.",
      );
      lines.push("3. Run `pnpm check` again to verify.");
      break;
    case "typecheck":
      lines.push("1. Run `pnpm check` to reproduce the type errors locally.");
      lines.push("2. Read the erroring files and fix type issues.");
      lines.push("3. Run `pnpm check` again to verify.");
      break;
    case "test":
      lines.push("1. Run `pnpm test` to reproduce the test failures locally.");
      lines.push("2. Read the failing test files and the source code they test.");
      lines.push("3. Fix the source code (not the tests) unless the tests are wrong.");
      lines.push("4. Run `pnpm test` again to verify.");
      break;
    case "build":
      lines.push("1. Run `pnpm build` to reproduce the build errors locally.");
      lines.push("2. Fix import/export issues, missing modules, etc.");
      lines.push("3. Run `pnpm build` again to verify.");
      break;
    case "ssr":
      lines.push(
        "1. Look for browser-only APIs used at module scope (localStorage, window, document).",
      );
      lines.push("2. Guard them with `typeof window !== 'undefined'` or use `instrumentation.ts`.");
      lines.push("3. Run `pnpm build` to verify no SSR errors.");
      break;
    case "unknown":
      lines.push("1. Analyze the logs carefully to determine the root cause.");
      lines.push("2. Apply the minimal fix needed.");
      lines.push("3. Run `pnpm check` to verify nothing is broken.");
      break;
  }

  lines.push("");
  lines.push(buildDiffGuardPrompt());
  lines.push("");
  lines.push("## Workflow");
  lines.push("");
  lines.push(
    `1. Create branch \`fix/ci-${payload.run_id}\` from the failing SHA if not already on it.`,
  );
  lines.push("2. Apply fixes.");
  lines.push("3. Run `pnpm check` (includes format, types, lint).");
  lines.push("4. If check passes, commit with message: `fix(ci): <what you fixed>`");
  lines.push("5. Push the branch and create a PR to main.");
  lines.push("");
  lines.push("If you cannot fix the issue within this iteration, output:");
  lines.push("ESCALATE: <description of what you tried and why it didn't work>");

  return lines.join("\n");
}

// ─── History Persistence ─────────────────────────────────────────────────────

let historyCache: FixLoopRecord[] | null = null;

function loadHistory(): FixLoopRecord[] {
  if (historyCache) return historyCache;
  try {
    if (existsSync(HISTORY_FILE)) {
      historyCache = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
      return historyCache!;
    }
  } catch {
    // Ignore corrupt history
  }
  historyCache = [];
  return historyCache;
}

function appendHistory(record: FixLoopRecord): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const history = loadHistory();
  history.push(record);
  // Keep last 100 records
  const trimmed = history.slice(-100);
  historyCache = trimmed;
  writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}

// ─── Fix Loop Controller ─────────────────────────────────────────────────────

function createFixLoopController(api: BotPluginApi, state: FixLoopState, config: FixLoopConfig) {
  async function handleCiFailure(payload: CiFailurePayload): Promise<void> {
    if (!config.enabled) {
      api.logger.info("CI fix loop disabled, ignoring failure.");
      return;
    }

    // Check branch is monitored
    const branch = payload.ref.replace("refs/heads/", "");
    if (!config.branches.includes(branch)) {
      api.logger.info(`Branch ${branch} not monitored, ignoring.`);
      return;
    }

    // Skip if already processing this run
    if (state.activeLoops.has(payload.run_id)) {
      api.logger.info(`Already processing run ${payload.run_id}, skipping.`);
      return;
    }

    // Classify the error
    const category = classifyError(payload.logs_tail, payload.failed_jobs);
    api.logger.info(`CI failure classified as: ${category} (run ${payload.run_id})`);

    // Budget check
    resetDailySpendIfNeeded(state);
    const budgetCheck = checkBudget(state, config);
    if (!budgetCheck.allowed) {
      api.logger.warn(`Budget gate blocked fix loop: ${budgetCheck.reason}`);
      await escalate(payload, category, budgetCheck.reason!);
      return;
    }

    // Start fix loop
    const run: FixLoopRun = {
      runId: payload.run_id,
      sha: payload.sha,
      startedAt: Date.now(),
      iteration: 0,
      category,
      totalCostUsd: 0,
      status: "running",
    };
    state.activeLoops.set(payload.run_id, run);

    try {
      await runFixLoop(payload, run);
    } finally {
      state.activeLoops.delete(payload.run_id);
      appendHistory({
        runId: run.runId,
        sha: run.sha,
        category: run.category,
        iterations: run.iteration,
        totalCostUsd: run.totalCostUsd,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: Date.now(),
      });
    }
  }

  async function runFixLoop(payload: CiFailurePayload, run: FixLoopRun): Promise<void> {
    const fixBranch = `fix/ci-${run.runId}`;

    while (run.iteration < config.maxIterations) {
      run.iteration++;
      api.logger.info(
        `Fix loop iteration ${run.iteration}/${config.maxIterations} for run ${run.runId}`,
      );

      // Budget check per iteration
      resetDailySpendIfNeeded(state);
      const budgetCheck = checkBudget(state, config, run);
      if (!budgetCheck.allowed) {
        run.status = "exhausted";
        await escalate(payload, run.category, budgetCheck.reason!);
        return;
      }

      // Select model based on category
      const model = config.modelStrategy[run.category] ?? config.modelStrategy.unknown;
      const prompt = buildFixPrompt(payload, run.category, run.iteration);

      try {
        const result = await runAgentFix(prompt, model, payload.run_id);

        if (result.includes("ESCALATE:")) {
          const reason = result.split("ESCALATE:")[1]?.trim() ?? "Agent requested escalation";
          run.status = "escalated";
          await escalate(payload, run.category, reason);
          return;
        }

        // Poll CI on the fix branch (not main)
        api.logger.info(`Iteration ${run.iteration} complete. Waiting for CI to re-run...`);
        const ciPassed = await pollCiStatus(payload.repo, fixBranch);

        if (ciPassed) {
          run.status = "success";
          state.consecutiveFailures = 0;
          api.logger.info(`CI fixed after ${run.iteration} iteration(s)! Run ${run.runId}`);
          return;
        }

        api.logger.info(`CI still failing after iteration ${run.iteration}.`);
      } catch (err) {
        api.logger.error(`Fix loop iteration error: ${String(err)}`);
      }
    }

    // Exhausted max iterations
    run.status = "exhausted";
    state.consecutiveFailures++;

    if (state.consecutiveFailures >= 3) {
      state.circuitBreakerUntil = Date.now() + 60 * 60 * 1000;
      api.logger.warn("Circuit breaker activated: 3 consecutive failures. Pausing for 1 hour.");
    }

    await escalate(
      payload,
      run.category,
      `Exhausted ${config.maxIterations} iterations. Cost: $${run.totalCostUsd.toFixed(2)}`,
    );
  }

  async function runAgentFix(prompt: string, model: string, runId: number): Promise<string> {
    // Write prompt to a temp file to avoid shell injection
    const promptFile = join(tmpdir(), `ci-fix-${runId}-${Date.now()}.txt`);
    try {
      writeFileSync(promptFile, prompt, "utf-8");

      // Use spawnSync with argument array — no shell interpolation
      const result = spawnSync("hanzo-bot", ["agent", "--model", model, "--non-interactive"], {
        input: prompt,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 10,
        timeout: 360_000,
        cwd: state.workspaceDir || process.cwd(),
        env: {
          ...process.env,
          BOT_CI_FIX_LOOP: "1",
          BOT_CI_RUN_ID: String(runId),
        },
      });

      const output = (result.stdout ?? "") + (result.stderr ?? "");
      if (result.error) {
        return `ESCALATE: Agent process error: ${String(result.error)}`;
      }
      return output;
    } finally {
      try {
        unlinkSync(promptFile);
      } catch {
        // cleanup is best-effort
      }
    }
  }

  async function pollCiStatus(repo: string, branch: string): Promise<boolean> {
    const maxWaitMs = 10 * 60 * 1000;
    const pollIntervalMs = 30_000;
    const startTime = Date.now();

    // Initial delay to let CI trigger
    await new Promise((resolve) => setTimeout(resolve, 60_000));

    while (Date.now() - startTime < maxWaitMs) {
      try {
        // Use spawnSync with argument array — no shell injection
        const result = spawnSync(
          "gh",
          [
            "run",
            "list",
            "--repo",
            repo,
            "--branch",
            branch,
            "--limit",
            "1",
            "--json",
            "status,conclusion",
          ],
          { encoding: "utf-8", timeout: 30_000 },
        );
        if (result.stdout) {
          const runs = JSON.parse(result.stdout);
          if (runs.length > 0) {
            const latest = runs[0];
            if (latest.status === "completed") {
              return latest.conclusion === "success";
            }
          }
        }
      } catch {
        // gh not available or parse error, continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return false;
  }

  async function escalate(
    payload: CiFailurePayload,
    category: ErrorCategory,
    reason: string,
  ): Promise<void> {
    const message = [
      "**CI Fix Loop Escalation**",
      "",
      `**Repo:** ${payload.repo}`,
      `**Run:** ${payload.run_url}`,
      `**Category:** ${category}`,
      `**Reason:** ${reason}`,
      `**Failed Jobs:** ${payload.failed_jobs.join(", ")}`,
    ].join("\n");

    api.logger.warn(`Escalation: ${reason}`);

    // Use spawnSync with argument array — safe from injection
    try {
      spawnSync(
        "gh",
        [
          "issue",
          "create",
          "--repo",
          payload.repo,
          "--title",
          `CI Fix Loop: ${category} failure needs manual intervention`,
          "--body",
          message,
          "--label",
          "ci-fix-loop",
        ],
        { encoding: "utf-8", timeout: 30_000 },
      );
    } catch {
      // Best-effort escalation
    }
  }

  return { handleCiFailure };
}

// ─── Fix Loop Service ────────────────────────────────────────────────────────

function createFixLoopService(api: BotPluginApi, state: FixLoopState): BotPluginService {
  let unsubDiagnostics: (() => void) | null = null;

  return {
    id: "ci-fix-loop",
    start: (ctx: BotPluginServiceContext) => {
      mkdirSync(STATE_DIR, { recursive: true });
      ctx.logger.info("CI fix loop service started.");

      // Capture workspace dir from service context
      if (ctx.workspaceDir) {
        state.workspaceDir = ctx.workspaceDir;
      }

      // Subscribe to diagnostic events for cost tracking (daily spend only)
      unsubDiagnostics = onDiagnosticEvent((evt) => {
        if (evt.type === "model.usage" && typeof evt.costUsd === "number") {
          resetDailySpendIfNeeded(state);
          state.dailySpendUsd += evt.costUsd;
        }
      });
    },
    stop: () => {
      if (unsubDiagnostics) {
        unsubDiagnostics();
        unsubDiagnostics = null;
      }
    },
  };
}

// ─── Plugin Definition ───────────────────────────────────────────────────────

const plugin = {
  id: "ci-fix-loop",
  name: "CI Fix Loop",
  description:
    "Autonomous CI failure detection, classification, and fix loop. " +
    "Monitors CI webhook events, classifies errors, runs targeted agent fixes, " +
    "and manages budget/iteration limits with circuit breaker safety.",
  configSchema: emptyPluginConfigSchema(),

  register(api: BotPluginApi) {
    // Single shared state for service, HTTP handler, and tools
    const state: FixLoopState = {
      activeLoops: new Map(),
      dailySpendUsd: 0,
      dailySpendDate: getTodayKey(),
      consecutiveFailures: 0,
      circuitBreakerUntil: 0,
      workspaceDir: process.cwd(),
    };

    const config: FixLoopConfig = {
      ...DEFAULT_CONFIG,
      ...((api.pluginConfig as Partial<FixLoopConfig>) ?? {}),
    };

    const controller = createFixLoopController(api, state, config);

    // ── Service: background cost tracking ────────────────────────────
    api.registerService(createFixLoopService(api, state));

    // ── HTTP Route: /hooks/ci — receives CI failure webhooks ─────────
    api.registerHttpRoute({
      path: "/hooks/ci",
      handler: async (req, res) => {
        // Auth: reject if token is missing or mismatched
        const token =
          (req.headers["x-bot-token"] as string | undefined) ??
          req.headers["authorization"]?.replace("Bearer ", "");
        const expectedToken = process.env["BOT_HOOKS_TOKEN"];

        if (!expectedToken) {
          api.logger.warn("BOT_HOOKS_TOKEN not set — CI webhook endpoint is unauthenticated");
        }

        if (expectedToken && !verifyToken(token, expectedToken)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }

        // Read body with size limit
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 512_000) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "payload too large" }));
            return;
          }
        }

        let payload: CiFailurePayload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
          return;
        }

        if (!payload.run_id || !payload.repo || !payload.failed_jobs) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing required fields: run_id, repo, failed_jobs" }));
          return;
        }

        const category = classifyError(payload.logs_tail ?? "", payload.failed_jobs);
        api.logger.info(`Received CI failure webhook: run=${payload.run_id}, category=${category}`);

        // Respond immediately
        resetDailySpendIfNeeded(state);
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            accepted: true,
            run_id: payload.run_id,
            category,
            budget_remaining: config.maxBudgetPerDayUsd - state.dailySpendUsd,
          }),
        );

        // Emit diagnostic for observability
        emitDiagnosticEvent({
          type: "webhook.received",
          channel: "ci",
          updateType: "ci.failure",
          chatId: payload.run_id,
        });

        // Fire-and-forget the fix loop
        void controller.handleCiFailure(payload).catch((err) => {
          api.logger.error(`CI fix loop error: ${String(err)}`);
        });
      },
    });

    // ── Tool: ci_fix_status — query active fix loops ─────────────────
    api.registerTool({
      name: "ci_fix_status",
      label: "CI Fix Status",
      description: "Check the status of active CI fix loops and recent history.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["active", "history", "budget"],
            description: "What to query: active loops, fix history, or budget status",
          },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: { action: string }) {
        if (params.action === "active") {
          const active = Array.from(state.activeLoops.values()).map((r) => ({
            runId: r.runId,
            sha: r.sha.slice(0, 8),
            category: r.category,
            iteration: r.iteration,
            costUsd: r.totalCostUsd.toFixed(2),
            status: r.status,
            elapsedMin: ((Date.now() - r.startedAt) / 60_000).toFixed(1),
          }));
          return jsonResult({ activeLoops: active });
        }

        if (params.action === "history") {
          const history = loadHistory().slice(-10);
          return jsonResult({ recentHistory: history });
        }

        if (params.action === "budget") {
          resetDailySpendIfNeeded(state);
          return jsonResult({
            dailySpend: state.dailySpendUsd.toFixed(2),
            dailyLimit: config.maxBudgetPerDayUsd.toFixed(2),
            perLoopLimit: config.maxBudgetPerLoopUsd.toFixed(2),
            circuitBreakerActive: state.circuitBreakerUntil > Date.now(),
            consecutiveFailures: state.consecutiveFailures,
          });
        }

        return jsonResult({ error: `Unknown action: ${params.action}` });
      },
    });

    // ── Tool: ci_classify_error — test the error classifier ──────────
    api.registerTool({
      name: "ci_classify_error",
      label: "CI Classify Error",
      description:
        "Classify CI error logs into a category (lint, typecheck, test, build, ssr, unknown).",
      parameters: {
        type: "object" as const,
        properties: {
          logs: {
            type: "string",
            description: "CI failure log text to classify",
          },
          failed_jobs: {
            type: "string",
            description: "Comma-separated list of failed job names",
          },
        },
        required: ["logs"],
      },
      async execute(_toolCallId: string, params: { logs: string; failed_jobs?: string }) {
        const jobs = params.failed_jobs?.split(",").map((j) => j.trim()) ?? [];
        const category = classifyError(params.logs, jobs);
        const model = config.modelStrategy[category];
        return jsonResult({ category, recommendedModel: model });
      },
    });

    // ── Tool: ci_budget_check — check budget constraints ─────────────
    api.registerTool({
      name: "ci_budget_check",
      label: "CI Budget Check",
      description:
        "Check if a CI fix loop would be allowed under current budget and circuit breaker constraints.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      async execute(_toolCallId: string) {
        resetDailySpendIfNeeded(state);
        const result = checkBudget(state, config);
        return jsonResult({
          allowed: result.allowed,
          reason: result.reason ?? "Budget available",
          dailySpend: state.dailySpendUsd.toFixed(2),
          dailyLimit: config.maxBudgetPerDayUsd.toFixed(2),
          circuitBreaker:
            state.circuitBreakerUntil > Date.now()
              ? `Active until ${new Date(state.circuitBreakerUntil).toISOString()}`
              : "Inactive",
        });
      },
    });

    // ── Diagnostic listener: log CI-related events ───────────────────
    onDiagnosticEvent((evt) => {
      if (evt.type === "webhook.received" && "channel" in evt && evt.channel === "ci") {
        api.logger.info(`CI webhook event: ${JSON.stringify(evt)}`);
      }
    });

    // ── Inject CI context into agent start ────────────────────────────
    api.on(
      "before_agent_start",
      async () => {
        if (!process.env["BOT_CI_FIX_LOOP"]) return;

        const runId = process.env["BOT_CI_RUN_ID"];
        return {
          prependContext: [
            "## CI Fix Loop Context",
            "",
            `You are running as an autonomous CI fix agent (run: ${runId}).`,
            "Follow the instructions exactly. Do not deviate from the fix plan.",
            "If you cannot fix the issue, output: ESCALATE: <reason>",
            "",
          ].join("\n"),
        };
      },
      { priority: 95 },
    );
  },
};

export default plugin;
