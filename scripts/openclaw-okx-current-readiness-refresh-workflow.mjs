import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const STATE_DIR = path.join(repoRoot, "reports", "hermes-agent", "state");
const DEFAULT_REPORT_PATH = path.join(
  STATE_DIR,
  "openclaw-okx-current-readiness-refresh-workflow-latest.json",
);
const CURRENT_READINESS_REPORT =
  "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json";

export const REFRESH_STEPS = [
  {
    id: "market_snapshot",
    command: ["pnpm", "okx:market-snapshot"],
    report: "reports/hermes-agent/state/openclaw-okx-market-snapshot-gate-latest.json",
  },
  {
    id: "market_snapshot_scheduler",
    command: ["pnpm", "okx:market-snapshot:scheduler"],
    report: "reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json",
  },
  {
    id: "demo_simulation",
    command: ["pnpm", "okx:demo-simulation"],
    report: "reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json",
  },
  {
    id: "paper_audit_log",
    command: ["pnpm", "okx:paper-audit-log"],
    report: "reports/hermes-agent/state/openclaw-okx-paper-audit-log-latest.json",
  },
  {
    id: "paper_audit_summary",
    command: ["pnpm", "okx:paper-audit-summary"],
    report: "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
  },
  {
    id: "telegram_shortcuts",
    command: ["pnpm", "capital-hft:telegram-trading-shortcuts:check"],
    report: "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
  },
  {
    id: "current_readiness_summary",
    command: ["pnpm", "okx:current-readiness:check"],
    report: CURRENT_READINESS_REPORT,
  },
];

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function commandText(step) {
  return step.command.join(" ");
}

function pnpmBin() {
  return "pnpm";
}

function quoteWindowsCmdArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=-]+$/u.test(text) ? text : `"${text.replaceAll('"', '""')}"`;
}

function spawnSpec(bin, args) {
  if (process.platform === "win32" && bin === "pnpm") {
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", [pnpmBin(), ...args].map(quoteWindowsCmdArg).join(" ")],
    };
  }
  return {
    bin: bin === "pnpm" ? pnpmBin() : bin,
    args,
  };
}

function tailText(value, limit = 1200) {
  const text = String(value ?? "").trim();
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function readOnlyEnv() {
  return {
    ...process.env,
    OPENCLAW_OKX_REFRESH_WORKFLOW: "1",
    OPENCLAW_OKX_PRIVATE_ORDER_QUERY_ENABLED: "0",
    OPENCLAW_OKX_ORDER_WRITE_ENABLED: "0",
    OPENCLAW_OKX_CANCEL_ENABLED: "0",
    OPENCLAW_OKX_WITHDRAWAL_ENABLED: "0",
  };
}

async function readJsonReport(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return {
      exists: true,
      path: relativePath,
      digest: sha256Text(raw),
      report: JSON.parse(raw.replace(/^\uFEFF/u, "")),
    };
  } catch {
    return {
      exists: false,
      path: relativePath,
      digest: "",
      report: null,
    };
  }
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function runStep(step) {
  const startedAtMs = Date.now();
  const [bin, ...args] = step.command;
  const spawn = spawnSpec(bin, args);
  const child = spawnSync(spawn.bin, spawn.args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: readOnlyEnv(),
    shell: false,
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAtMs;
  const exitCode = typeof child.status === "number" ? child.status : child.error ? 1 : 0;
  return {
    id: step.id,
    command: commandText(step),
    report: step.report,
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    durationMs,
    stdoutTail: tailText(child.stdout),
    stderrTail: tailText(child.stderr || child.error?.message),
  };
}

function plannedStep(step) {
  return {
    id: step.id,
    command: commandText(step),
    report: step.report,
    status: "planned",
    exitCode: null,
    durationMs: 0,
    stdoutTail: "",
    stderrTail: "",
  };
}

function skippedStep(step) {
  return {
    id: step.id,
    command: commandText(step),
    report: step.report,
    status: "skipped_after_failure",
    exitCode: null,
    durationMs: 0,
    stdoutTail: "",
    stderrTail: "",
  };
}

function runRefreshSteps({ dryRun }) {
  const steps = [];
  let blocked = false;
  for (const step of REFRESH_STEPS) {
    if (dryRun) {
      steps.push(plannedStep(step));
      continue;
    }
    if (blocked) {
      steps.push(skippedStep(step));
      continue;
    }
    const result = runStep(step);
    steps.push(result);
    if (result.status !== "pass") {
      blocked = true;
    }
  }
  return steps;
}

function buildBlockers({ dryRun, steps, currentReadiness }) {
  if (dryRun) {
    return [];
  }
  const blockers = [];
  for (const step of steps) {
    if (step.status === "fail") {
      blockers.push(`${step.id}_failed`);
    }
    if (step.status === "skipped_after_failure") {
      blockers.push(`${step.id}_skipped`);
    }
  }
  const summary = currentReadiness.report ?? {};
  const safety = summary.safety ?? {};
  if (!currentReadiness.exists) {
    blockers.push("current_readiness_report_missing");
  } else if (summary.status !== "ready_read_only") {
    blockers.push("current_readiness_not_ready");
  }
  if (summary.sourceFreshness?.ok !== true) {
    blockers.push("source_freshness_not_ok");
  }
  if (safety.noOrderWrite !== true) {
    blockers.push("no_order_write_not_locked");
  }
  return [...new Set(blockers)];
}

function schedulerNextRunAtFromCurrentReadiness(currentReadiness) {
  const report = currentReadiness.report ?? {};
  const machineLine = typeof report.machineLine === "string" ? report.machineLine : "";
  const machineLineMatch = /\bschedulerNextRunAt=([^\s]+)/u.exec(machineLine);
  const candidates = [
    report.schedulerNextRunAt,
    report.readiness?.marketSnapshotScheduler?.nextRunAt,
    machineLineMatch?.[1],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return "unavailable";
}

export async function buildOkxCurrentReadinessRefreshWorkflow(options = {}) {
  const dryRun = options.dryRun === true;
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const steps = runRefreshSteps({ dryRun });
  const currentReadiness = await readJsonReport(CURRENT_READINESS_REPORT);
  const blockers = buildBlockers({ dryRun, steps, currentReadiness });
  const ready = blockers.length === 0 && !dryRun;
  const planned = dryRun && blockers.length === 0;
  const passedSteps = steps.filter((step) => step.status === "pass").length;
  const freshnessStatus = dryRun
    ? "planned"
    : currentReadiness.report?.sourceFreshness?.ok === true
      ? "ok"
      : "blocked";
  const noOrderWrite = dryRun ? true : currentReadiness.report?.safety?.noOrderWrite === true;
  const schedulerNextRunAt = schedulerNextRunAtFromCurrentReadiness(currentReadiness);
  const machineLine = [
    `okxCurrentReadinessRefresh=${ready ? "pass" : planned ? "planned" : "blocked"}`,
    `steps=${passedSteps}/${REFRESH_STEPS.length}`,
    `freshness=${freshnessStatus}`,
    `schedulerNextRunAt=${schedulerNextRunAt}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");

  return {
    schema: "openclaw.okx.current-readiness-refresh-workflow.v1",
    generatedAt,
    provider: "okx",
    language: "zh-TW",
    mode: dryRun
      ? "planned_read_only_current_readiness_refresh"
      : "read_only_current_readiness_refresh",
    status: ready ? "ready_read_only" : planned ? "planned_read_only" : "blocked",
    code: ready
      ? "okx_current_readiness_refresh_ready"
      : planned
        ? "okx_current_readiness_refresh_planned"
        : "okx_current_readiness_refresh_blocked",
    summary_zh_tw: ready
      ? "OKX current-readiness refresh workflow 已完成：來源報告與 Telegram closure 已刷新，freshness=ok，noOrderWrite=true。"
      : planned
        ? "OKX current-readiness refresh workflow 已完成乾跑規劃；未執行任何外部或本地刷新命令。"
        : `OKX current-readiness refresh workflow 阻擋：${blockers.join("、")}。`,
    blockers,
    markers: [
      ready
        ? "current_readiness_refresh_workflow_ready"
        : planned
          ? "current_readiness_refresh_workflow_planned"
          : "current_readiness_refresh_workflow_blocked",
      dryRun ? "refresh_workflow_dry_run" : "refresh_workflow_executed",
      freshnessStatus === "ok" ? "source_freshness_ok" : `source_freshness_${freshnessStatus}`,
      "read_only_refresh_workflow",
      "submitted_order_false",
      "exchange_write_false",
      "order_status_query_false",
      "cancel_submitted_false",
      schedulerNextRunAt !== "unavailable"
        ? "scheduler_next_run_visible"
        : "scheduler_next_run_unavailable",
    ],
    machineLine,
    schedulerNextRunAt,
    steps,
    stepOrder: REFRESH_STEPS.map((step) => step.id),
    reports: {
      workflow: repoRelative(DEFAULT_REPORT_PATH),
      currentReadiness: {
        path: CURRENT_READINESS_REPORT,
        exists: currentReadiness.exists,
        digest: currentReadiness.digest,
        status: currentReadiness.report?.status ?? "missing",
        machineLine: currentReadiness.report?.machineLine ?? "",
        schedulerNextRunAt,
      },
      sources: Object.fromEntries(REFRESH_STEPS.map((step) => [step.id, step.report])),
    },
    safety: {
      readOnly: true,
      paperOnly: true,
      demoOnly: true,
      summaryOnly: true,
      refreshOnly: true,
      executionAllowed: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      orderPlacementEnabled: false,
      submittedOrder: false,
      exchangeWriteAttempted: false,
      orderStatusQueryExecuted: false,
      cancelOrderEnabled: false,
      cancelSubmitted: false,
      exchangeCancelAttempted: false,
      withdrawalEnabled: false,
      noOrderWrite,
    },
    commands: {
      planned: REFRESH_STEPS.map(commandText),
      executed: dryRun
        ? []
        : steps.filter((step) => step.status === "pass").map((step) => step.command),
      notExecuted: [
        "GET /api/v5/trade/order",
        "GET /api/v5/trade/orders-pending",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
        "POST /api/v5/asset/withdrawal",
      ],
      forbidden: [
        "okx spot place",
        "okx swap place",
        "okx futures place",
        "okx spot cancel",
        "okx swap cancel",
        "GET /api/v5/trade/order",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
        "POST /api/v5/asset/withdrawal",
      ],
    },
    rollbackPath: [
      "Remove package scripts okx:current-readiness:refresh and okx:current-readiness:refresh:check.",
      "Delete scripts/openclaw-okx-current-readiness-refresh-workflow.mjs and scripts/check-openclaw-okx-current-readiness-refresh-workflow.mjs.",
      "Delete reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json and .sha256.",
      "Remove refresh workflow references from skills/openclaw-okx-cex-status/SKILL.md, docs/automation/module-skill-inventory.md, and scripts/openclaw-autonomous-inventory.mjs.",
    ],
    nextSafeTask:
      "把 OKX heartbeat operation report 納入 sc:tr:assist 快速狀態列；仍保持 noOrderWrite=true。",
  };
}

async function main() {
  const reportPath = path.resolve(argValue("--out", DEFAULT_REPORT_PATH));
  const report = await buildOkxCurrentReadinessRefreshWorkflow({
    dryRun: hasFlag("--dry-run"),
  });
  if (hasFlag("--write-state")) {
    await writeJsonWithHash(reportPath, report);
  }
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "OKX_CURRENT_READINESS_REFRESH_WORKFLOW",
      `status=${report.status}`,
      `code=${report.code}`,
      `machineLine=${report.machineLine}`,
      `blockers=${report.blockers.join("/")}`,
      `report=${repoRelative(reportPath)}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] === currentFile) {
  await main();
}
