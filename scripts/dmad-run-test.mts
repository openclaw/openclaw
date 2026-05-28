/**
 * dmad-run-test.mts — DMAD 完整多輪辯論執行測試
 *
 * 用法：pnpm dmad:run-test [-- --fail-on-degraded]
 * 環境變數：
 *   DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=360000  總耗時上限；0 代表只輸出 timeout 診斷報告
 *   DMAD_RUN_TEST_AGENT_TIMEOUT_MS=90000   每個 agent 呼叫 timeout（ms）
 *   DMAD_RUN_TEST_MOA_TIMEOUT_MS=60000      MoA 聚合 timeout（ms）
 *   DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS=20000 驗證 timeout（ms）
 *   DMAD_RUN_TEST_MAX_ROUNDS=3   最大辯論輪數（>=1）
 *   DMAD_RUN_TEST_CONVERGENCE_THRESHOLD=0.69  收斂門檻（0-1）
 *   DMAD_RUN_TEST_VARIANCE_THRESHOLD=0.05  立場變化門檻（0-1）
 *   DMAD_RUN_TEST_REPORT_PATH=reports/...  覆寫報告輸出路徑
 * 目的：驗證 dmad-debate.ts 的完整執行路徑（不只是 adapter）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb } from "./lib/sqlite-compat.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const DB_PATH = path.join(
  REPO_ROOT,
  "extensions/evolution-learning/.claude/evolution-state/nuwa.db",
);
const DEFAULT_TOTAL_TIMEOUT_MS = 360_000;
const DEFAULT_AGENT_TIMEOUT_MS = 90_000;
const DEFAULT_MOA_TIMEOUT_MS = 60_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_CONVERGENCE_THRESHOLD = 0.69;
const DEFAULT_VARIANCE_THRESHOLD = 0.05;
const DEFAULT_REPORT_PATH = path.join(REPO_ROOT, "reports/dmad-run-test-latest.json");
const REPORT_PATH = resolveDmadRunTestReportPath(process.env.DMAD_RUN_TEST_REPORT_PATH);

export interface DmadRunProgressEvent {
  phase: string;
  status: "start" | "complete" | "error";
  at: string;
  round?: number;
  agent?: string;
  durationMs?: number;
  error?: string;
}

export interface DmadRunActiveAgent {
  agent: string;
  phase: string;
  round?: number;
  startedAt: string;
}

export interface DmadRunProgressSnapshot {
  activePhase: string;
  activeAgents: DmadRunActiveAgent[];
  latestProgress: DmadRunProgressEvent | null;
  phaseTimingsMs: Record<string, number>;
}

export function resolveDmadRunTestReportPath(value?: string): string {
  const reportPath = value?.trim();
  if (!reportPath) {
    return DEFAULT_REPORT_PATH;
  }
  return path.isAbsolute(reportPath) ? reportPath : path.resolve(REPO_ROOT, reportPath);
}

function phaseTimingKey(event: DmadRunProgressEvent): string {
  if (event.phase === "agent" && event.agent) {
    return `round${event.round ?? 0}.${event.agent}`;
  }
  return event.round ? `${event.phase}.round${event.round}` : event.phase;
}

export function createDmadRunProgressTracker() {
  const activeAgents = new Map<string, DmadRunActiveAgent>();
  const phaseTimingsMs: Record<string, number> = {};
  let activePhase = "preflight";
  let latestProgress: DmadRunProgressEvent | null = null;

  const onProgress = (event: DmadRunProgressEvent) => {
    latestProgress = event;
    if (event.status === "start") {
      activePhase = event.phase;
      if (event.phase === "agent" && event.agent) {
        const key = `${event.round ?? 0}:${event.agent}`;
        activeAgents.set(key, {
          agent: event.agent,
          phase: event.phase,
          round: event.round,
          startedAt: event.at,
        });
      }
      return;
    }

    if (event.durationMs !== undefined) {
      const key = phaseTimingKey(event);
      phaseTimingsMs[key] = (phaseTimingsMs[key] ?? 0) + event.durationMs;
    }
    if (event.phase === "agent" && event.agent) {
      activeAgents.delete(`${event.round ?? 0}:${event.agent}`);
    }
    if (activeAgents.size === 0) {
      activePhase = event.status === "error" ? event.phase : "runDMAD";
    }
  };

  const snapshot = (totalMs: number): DmadRunProgressSnapshot => ({
    activePhase: activeAgents.size > 0 ? "agent" : activePhase,
    activeAgents: [...activeAgents.values()],
    latestProgress,
    phaseTimingsMs: { ...phaseTimingsMs, total: totalMs },
  });

  return { onProgress, snapshot };
}

export function parseDmadRunTestFlags(args: readonly string[]) {
  return {
    failOnDegraded: args.includes("--fail-on-degraded"),
  };
}

export function getDmadRunTestExitCode(opts: {
  failOnDegraded: boolean;
  qualityStatus?: string;
}): number {
  return opts.failOnDegraded && opts.qualityStatus === "degraded_agents" ? 2 : 0;
}

export function parseDmadRunTestTotalTimeoutMs(
  value: string | undefined,
  fallback = DEFAULT_TOTAL_TIMEOUT_MS,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function parseDmadRunTestAgentTimeoutMs(
  value: string | undefined,
  fallback = DEFAULT_AGENT_TIMEOUT_MS,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function parseDmadRunTestStageTimeoutMs(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1_000, Math.floor(parsed));
}

export function defaultDmadRunTestMoaTimeoutMs(agentTimeoutMs: number): number {
  return Math.min(agentTimeoutMs, DEFAULT_MOA_TIMEOUT_MS);
}

export function defaultDmadRunTestVerificationTimeoutMs(agentTimeoutMs: number): number {
  return Math.min(agentTimeoutMs, DEFAULT_VERIFICATION_TIMEOUT_MS);
}

export function parseDmadRunTestMaxRounds(
  value: string | undefined,
  fallback = DEFAULT_MAX_ROUNDS,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const integer = Math.floor(parsed);
  if (integer < 1 || integer > 10) {
    return fallback;
  }
  return integer;
}

export function parseDmadRunTestConvergenceThreshold(
  value: string | undefined,
  fallback = DEFAULT_CONVERGENCE_THRESHOLD,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return fallback;
  }
  return parsed;
}

export function parseDmadRunTestVarianceThreshold(
  value: string | undefined,
  fallback = DEFAULT_VARIANCE_THRESHOLD,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return fallback;
  }
  return parsed;
}

export function buildDmadRunTimeoutReport(opts: {
  task: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalTimeoutMs: number;
  aborted?: boolean;
  activePhase?: string;
  activeAgents?: DmadRunActiveAgent[];
  latestProgress?: DmadRunProgressEvent | null;
  phaseTimingsMs?: Record<string, number>;
}) {
  return {
    ok: false,
    runStatus: "timeout",
    task: opts.task,
    rounds: [],
    finalAnswer: "",
    convergenceScore: 0,
    totalRounds: 0,
    stoppedBy: "timeout",
    patternSlugsUsed: [],
    hadCliError: true,
    cliErrorSummary: {
      claudeMissing: 0,
      claudeFailed: 0,
      codexMissing: 0,
      codexFailed: 0,
    },
    qualityStatus: "degraded_agents",
    degradedReason: "run_timeout",
    trajectoryScores: {
      claude: 0,
      codex: 0,
      openclaw: 0,
    },
    estimatedCostUsd: 0,
    startedAt: opts.startedAt,
    completedAt: opts.completedAt,
    durationMs: opts.durationMs,
    totalTimeoutMs: opts.totalTimeoutMs,
    aborted: opts.aborted ?? false,
    timeoutPhase: opts.activePhase ?? "runDMAD",
    activeAgents: opts.activeAgents ?? [],
    latestProgress: opts.latestProgress ?? null,
    phaseTimingsMs: opts.phaseTimingsMs ?? {
      runDMAD: opts.durationMs,
      total: opts.durationMs,
    },
  };
}

export class DmadRunTestTimeoutError extends Error {
  constructor(readonly totalTimeoutMs: number) {
    super(`DMAD run-test exceeded total timeout ${totalTimeoutMs}ms`);
    this.name = "DmadRunTestTimeoutError";
  }
}

export function withDmadRunTimeout<T>(
  promise: Promise<T>,
  totalTimeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  if (totalTimeoutMs === 0) {
    onTimeout?.();
    return Promise.reject(new DmadRunTestTimeoutError(totalTimeoutMs));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new DmadRunTestTimeoutError(totalTimeoutMs));
    }, totalTimeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export function writeDmadRunReport(report: unknown, reportPath = REPORT_PATH) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

export function buildDmadRunReportWithConfig<T extends object>(
  report: T,
  runConfig: {
    totalTimeoutMs: number;
    agentTimeoutMs: number;
    moaTimeoutMs: number;
    verificationTimeoutMs: number;
    maxRounds: number;
    convergenceThreshold: string;
    varianceThreshold: string;
  },
): T & {
  runConfig: {
    totalTimeoutMs: number;
    agentTimeoutMs: number;
    moaTimeoutMs: number;
    verificationTimeoutMs: number;
    maxRounds: number;
    convergenceThreshold: string;
    varianceThreshold: string;
  };
} {
  return {
    ...report,
    runConfig,
  };
}

function formatFixed(value: number, digits = 4): string {
  return value.toFixed(digits);
}

export function buildRunConfigSummary(opts: {
  totalTimeoutMs: number;
  agentTimeoutMs: number;
  moaTimeoutMs: number;
  verificationTimeoutMs: number;
  maxRounds: number;
  convergenceThreshold: number;
  varianceThreshold: number;
}) {
  return {
    totalTimeoutMs: opts.totalTimeoutMs,
    agentTimeoutMs: opts.agentTimeoutMs,
    moaTimeoutMs: opts.moaTimeoutMs,
    verificationTimeoutMs: opts.verificationTimeoutMs,
    maxRounds: opts.maxRounds,
    convergenceThreshold: formatFixed(opts.convergenceThreshold),
    varianceThreshold: formatFixed(opts.varianceThreshold),
  };
}

function writeTimeoutSummary(
  report: ReturnType<typeof buildDmadRunTimeoutReport>,
  failOnDegraded: boolean,
  runConfig: ReturnType<typeof buildRunConfigSummary>,
) {
  process.stdout.write(
    JSON.stringify(buildDmadRunTimeoutStdoutSummary(report, failOnDegraded, runConfig)) + "\n",
  );
}

export function buildDmadRunTimeoutStdoutSummary(
  report: ReturnType<typeof buildDmadRunTimeoutReport>,
  failOnDegraded: boolean,
  runConfig: ReturnType<typeof buildRunConfigSummary>,
) {
  return {
    ok: false,
    failOnDegraded,
    runConfig,
    runStatus: report.runStatus,
    qualityStatus: report.qualityStatus,
    degradedReason: report.degradedReason,
    durationMs: report.durationMs,
    totalTimeoutMs: report.totalTimeoutMs,
    aborted: report.aborted,
    timeoutPhase: report.timeoutPhase,
    activeAgents: report.activeAgents,
    latestProgress: report.latestProgress,
    phaseTimingsMs: report.phaseTimingsMs,
  };
}

export function buildDmadRunSuccessStdoutSummary(
  opts: {
    qualityStatus: string;
    degradedReason?: string | null;
    totalRounds: number;
    stoppedBy: string;
    convergenceScore: number;
    stabilityScores: number[];
    hadCliError: boolean;
    cliErrorSummary: {
      claudeMissing: number;
      claudeFailed: number;
      codexMissing: number;
      codexFailed: number;
    };
    patternSlugsUsed: string[];
    trajectoryScores: {
      claude: number;
      codex: number;
      openclaw: number;
    };
    phaseTimingsMs: Record<string, number>;
    roundTimingsMs: Record<string, number>[];
  },
  failOnDegraded: boolean,
  runConfig: ReturnType<typeof buildRunConfigSummary>,
  latestProgress: DmadRunProgressEvent | null,
  durationMs: number,
) {
  return {
    ok: true,
    failOnDegraded,
    runConfig,
    qualityStatus: opts.qualityStatus,
    degradedReason: opts.degradedReason ?? null,
    rounds: opts.totalRounds,
    stoppedBy: opts.stoppedBy,
    convergenceScore: opts.convergenceScore,
    stabilityScores: opts.stabilityScores,
    hadCliError: opts.hadCliError,
    cliErrorSummary: opts.cliErrorSummary,
    patternsUsed: opts.patternSlugsUsed,
    trajectoryScores: opts.trajectoryScores,
    phaseTimingsMs: opts.phaseTimingsMs,
    roundTimingsMs: opts.roundTimingsMs,
    latestProgress,
    durationMs,
  };
}

function isDirectRun(): boolean {
  return Boolean(
    process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

const flags = parseDmadRunTestFlags(process.argv.slice(2));

async function main() {
  const task =
    process.env.DMAD_RUN_TEST_TASK?.trim() ||
    "評估 OpenClaw DMAD 三方辯論系統的穩定性，並給出三項具體改進建議。";
  const systemContext = `
OpenClaw DMAD（Diversity-enhanced Multi-Agent Debate）系統已完整實作並通過驗證，以下是已確認的事實：

【架構】
- 三個代理：Claude CLI（語言推理）、Codex CLI（技術可行性）、OpenClaw（pattern 框架，零費用）
- 停止條件：semantic cosine similarity > 0.69 收斂、立場變化 < 5%、或達最大 3 輪
- MoA 聚合：預設沿用 Claude Haiku，可用 moaModel 升級

【已驗證運作狀態（2026-05-19）】
- Claude CLI v2.1.140：正常回應，約 30s/輪
- Codex CLI v0.128.0：正常回應，約 37s/輪（gpt-5.3-codex）
- Ollama qwen3:14b：正常回應，約 4s/輪
- nuwa.db：8 張表、5 個 pattern（strict-cto, creative-architect, pragmatic-engineer, 另 2 個）
- 完整三輪辯論耗時約 450-810 秒

【已知問題（待改進）】
- 各代理回應語言不一致（已加入繁體中文規則修正中）
- 三方對話收斂分已改用 semantic embedding，閾值校準為 0.69
- DB 寫入失敗採靜默略過（需改為告警）
- 缺乏降級機制（spawn 失敗時無備援）

【技術實作位置】
- 主引擎：extensions/evolution-learning/src/dmad-debate.ts
- 適配器：tools/openclaw_runtime/adapters/（claude_code_cli_adapter.js, codex_cli_adapter.js, local_model_adapter.js）
- 資料庫層：scripts/lib/sqlite-compat.mjs（sql.js WASM fallback）
- 健康檢查：tools/openclaw_runtime/adapters/health-check.mjs
`.trim();

  const totalTimeoutMs = parseDmadRunTestTotalTimeoutMs(process.env.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS);
  const agentTimeoutMs = parseDmadRunTestAgentTimeoutMs(process.env.DMAD_RUN_TEST_AGENT_TIMEOUT_MS);
  const moaTimeoutMs = parseDmadRunTestStageTimeoutMs(
    process.env.DMAD_RUN_TEST_MOA_TIMEOUT_MS,
    defaultDmadRunTestMoaTimeoutMs(agentTimeoutMs),
  );
  const verificationTimeoutMs = parseDmadRunTestStageTimeoutMs(
    process.env.DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS,
    defaultDmadRunTestVerificationTimeoutMs(agentTimeoutMs),
  );
  const maxRounds = parseDmadRunTestMaxRounds(process.env.DMAD_RUN_TEST_MAX_ROUNDS);
  const convergenceThreshold = parseDmadRunTestConvergenceThreshold(
    process.env.DMAD_RUN_TEST_CONVERGENCE_THRESHOLD,
  );
  const varianceThreshold = parseDmadRunTestVarianceThreshold(
    process.env.DMAD_RUN_TEST_VARIANCE_THRESHOLD,
  );
  const runConfig = buildRunConfigSummary({
    totalTimeoutMs,
    agentTimeoutMs,
    moaTimeoutMs,
    verificationTimeoutMs,
    maxRounds,
    convergenceThreshold,
    varianceThreshold,
  });
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  if (totalTimeoutMs === 0) {
    const report = buildDmadRunTimeoutReport({
      task,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: 0,
      totalTimeoutMs,
      aborted: false,
      activePhase: "preflight",
      activeAgents: [],
      latestProgress: null,
      phaseTimingsMs: {
        preflight: 0,
        total: 0,
      },
    });
    const reportWithConfig = buildDmadRunReportWithConfig(report, runConfig);
    writeDmadRunReport(reportWithConfig);
    console.error(`[dmad-run-test] 總耗時上限為 0ms，輸出 timeout 診斷報告：${REPORT_PATH}`);
    writeTimeoutSummary(report, flags.failOnDegraded, runConfig);
    process.exitCode = 3;
    return;
  }

  console.error("[dmad-run-test] 載入 dmad-debate.ts...");
  console.error(`[dmad-run-test] 總耗時上限：${totalTimeoutMs}ms`);
  console.error(`[dmad-run-test] 單輪 agent timeout：${agentTimeoutMs}ms`);
  console.error(`[dmad-run-test] MoA timeout：${moaTimeoutMs}ms`);
  console.error(`[dmad-run-test] 驗證 timeout：${verificationTimeoutMs}ms`);
  console.error(`[dmad-run-test] 最大輪數：${maxRounds}`);
  console.error(`[dmad-run-test] 收斂門檻：${convergenceThreshold}`);
  console.error(`[dmad-run-test] 變化門檻：${varianceThreshold}`);

  // 動態 import（tsx 會即時編譯 TypeScript）
  const { runDMAD } = await import("../extensions/evolution-learning/src/dmad-debate.js");

  console.error("[dmad-run-test] 開啟 nuwa.db...");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (await openDb(DB_PATH, { readonly: false, fileMustExist: true })) as any;

  console.error(`[dmad-run-test] 開始 DMAD 辯論，任務：${task.slice(0, 50)}...`);
  console.error(
    `[dmad-run-test] 預計 ${maxRounds} 輪（動態超時），每輪依 agent timeout 與模型負載而定...`,
  );

  const progressTracker = createDmadRunProgressTracker();
  const runAbortController = new AbortController();
  let runAbortedByTimeout = false;
  let result: Awaited<ReturnType<typeof runDMAD>>;
  try {
    result = await withDmadRunTimeout(
      runDMAD(task, db, {
        maxRounds,
        convergenceThreshold,
        varianceThreshold,
        claudeModel: "claude-haiku-4-5",
        codexModel: "gpt-5.3-codex",
        timeoutMs: agentTimeoutMs,
        moaTimeoutMs,
        verificationTimeoutMs,
        allowMoaFallback: true,
        allowVerificationFallback: true,
        systemContext,
        onProgress: progressTracker.onProgress,
        abortSignal: runAbortController.signal,
      }),
      totalTimeoutMs,
      () => {
        runAbortedByTimeout = true;
        runAbortController.abort(new Error("dmad-run-test timeout"));
      },
    );
  } catch (err) {
    if (err instanceof DmadRunTestTimeoutError) {
      const durationMs = Date.now() - startMs;
      const progressSnapshot = progressTracker.snapshot(durationMs);
      const report = buildDmadRunTimeoutReport({
        task,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs,
        totalTimeoutMs: err.totalTimeoutMs,
        aborted: runAbortedByTimeout,
        activePhase: progressSnapshot.activePhase,
        activeAgents: progressSnapshot.activeAgents,
        latestProgress: progressSnapshot.latestProgress,
        phaseTimingsMs: progressSnapshot.phaseTimingsMs,
      });
      const reportWithConfig = buildDmadRunReportWithConfig(report, runConfig);
      try {
        db.close();
      } catch {
        // ignore close failure while emitting timeout diagnostics
      }
      writeDmadRunReport(reportWithConfig);
      console.error(`[dmad-run-test] 超過總耗時上限，已寫入 timeout 報告：${REPORT_PATH}`);
      writeTimeoutSummary(report, flags.failOnDegraded, runConfig);
      process.exit(3);
    }
    throw err;
  }

  const durationMs = Date.now() - startMs;
  const finalProgressSnapshot = progressTracker.snapshot(durationMs);

  db.close();

  // 輸出摘要
  console.error("\n==============================");
  console.error(`[dmad-run-test] 完成！`);
  console.error(`  輪數：${result.totalRounds}`);
  console.error(`  停止原因：${result.stoppedBy}`);
  console.error(`  最終收斂分：${result.convergenceScore.toFixed(4)}`);
  console.error(`  品質狀態：${result.qualityStatus}`);
  if (result.degradedReason) {
    console.error(`  降級原因：${result.degradedReason}`);
  }
  console.error(`  CLI 降級：${result.hadCliError ? "是" : "否"}`);
  console.error(`  CLI 錯誤摘要：${JSON.stringify(result.cliErrorSummary)}`);
  console.error(`  使用 patterns：${result.patternSlugsUsed.join(", ") || "（無）"}`);
  console.error(
    `  軌跡分：Claude ${result.trajectoryScores.claude.toFixed(2)} / Codex ${result.trajectoryScores.codex.toFixed(2)} / OpenClaw ${result.trajectoryScores.openclaw.toFixed(2)}`,
  );
  console.error(`  估算費用：$${result.estimatedCostUsd}`);
  console.error(`  總耗時：${(durationMs / 1000).toFixed(1)}s`);
  console.error(`  Phase timings：${JSON.stringify(result.phaseTimingsMs)}`);
  console.error("==============================\n");

  // 各輪摘要
  for (const r of result.rounds) {
    console.error(
      `[輪 ${r.round}] 收斂分 ${r.convergenceScore.toFixed(3)} / 穩定分 ${r.stabilityScore.toFixed(3)} / CLI降級 ${r.hadCliError ? "是" : "否"}`,
    );
    if (r.cliErrors.length > 0) {
      console.error(`  CLI錯誤：${r.cliErrors.join(", ")}`);
    }
    console.error(`  Claude：${r.claudeResponse.slice(0, 80)}...`);
    console.error(`  Codex ：${r.codexResponse.slice(0, 80)}...`);
    console.error(`  OClaw ：${r.openclawResponse.slice(0, 80)}...`);
  }

  console.error(`\n[MoA 最終答案]\n${result.finalAnswer.slice(0, 300)}...\n`);

  // 寫報告
  const reportWithConfig = buildDmadRunReportWithConfig(result, runConfig);
  writeDmadRunReport(reportWithConfig);
  console.error(`[dmad-run-test] 報告寫入：${REPORT_PATH}`);

  // stdout 給 cron runner 用
  process.stdout.write(
    JSON.stringify(
      buildDmadRunSuccessStdoutSummary(
        {
          qualityStatus: result.qualityStatus,
          degradedReason: result.degradedReason,
          totalRounds: result.totalRounds,
          stoppedBy: result.stoppedBy,
          convergenceScore: result.convergenceScore,
          stabilityScores: result.rounds.map((r) => r.stabilityScore),
          hadCliError: result.hadCliError,
          cliErrorSummary: result.cliErrorSummary,
          patternSlugsUsed: result.patternSlugsUsed,
          trajectoryScores: result.trajectoryScores,
          phaseTimingsMs: result.phaseTimingsMs,
          roundTimingsMs: result.rounds.map((r) => r.timingsMs),
        },
        flags.failOnDegraded,
        runConfig,
        finalProgressSnapshot.latestProgress,
        durationMs,
      ),
    ) + "\n",
  );

  const exitCode = getDmadRunTestExitCode({
    failOnDegraded: flags.failOnDegraded,
    qualityStatus: result.qualityStatus,
  });
  if (exitCode !== 0) {
    console.error(
      `[dmad-run-test] fail-on-degraded：${result.degradedReason ?? "degraded_agents"}`,
    );
    process.exitCode = exitCode;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("[dmad-run-test] 失敗：", err);
    process.exitCode = 1;
  });
}
