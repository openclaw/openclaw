#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { think } from "./brain.mjs";
import { callCodexExecute } from "./codex-bridge.mjs";
import { execute } from "./executor.mjs";
import { learn } from "./learner.mjs";
import { scan } from "./scanner.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const REPORT_DIR = path.join(ROOT, "reports", "hermes-agent", "state");
const QUEUE_DIR = path.join(ROOT, ".openclaw", "dmad", "queue");
const REPORT_PATH = path.join(REPORT_DIR, "dmad-engine-cycle-latest.json");
const WATCH_INTERVAL_MS = 5 * 60 * 1000;

const argSet = new Set(process.argv.slice(2));
const isDryRun = argSet.has("--dry-run");
const isWatch = argSet.has("--watch");
const isReport = argSet.has("--report");
const codexOnly = argSet.has("--codex-only");
const maxDiagnoses = Number.parseInt(
  process.env.OPENCLAW_DMAD_MAX_DIAGNOSES ?? (isDryRun ? "8" : "24"),
  10,
);

async function ensureQueueDirs() {
  const dirs = [
    path.join(QUEUE_DIR, "pending"),
    path.join(QUEUE_DIR, "done"),
    path.join(QUEUE_DIR, "approval-needed"),
    path.join(QUEUE_DIR, "failed"),
    path.join(QUEUE_DIR, "completed"),
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function writeReport(report) {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (isReport) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

async function writeEscalationTaskPack(escalations) {
  if (!Array.isArray(escalations) || escalations.length === 0) {
    return null;
  }
  const payload = {
    schema: "openclaw.dmad.escalation-task-pack.v1",
    generatedAt: new Date().toISOString(),
    source: "dmad-engine-auto",
    escalations: escalations.map((item) => ({
      blocker: item?.diagnosis?.blocker ?? "unknown",
      gateId: item?.diagnosis?.gateId ?? "unknown",
      severity: item?.diagnosis?.severity ?? "warning",
      evidence: item?.diagnosis?.evidence ?? {},
      reason: item?.plan?.reason ?? item?.plan?.source ?? "escalate",
      suggestedSolution: item?.plan?.suggestedSolution ?? item?.plan?.solution ?? null,
      codexOutput: item?.plan?.codexOutput ?? null,
      action: "需要 Codex/Claude 分析與修復",
    })),
  };
  const filePath = path.join(QUEUE_DIR, "pending", `esc-${Date.now().toString(36)}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

async function writeQueueItem(folderName, payload) {
  const filePath = path.join(QUEUE_DIR, folderName, `${Date.now().toString(36)}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function buildCodexQueueBrief(escalation) {
  return [
    "## DMAD 自動任務",
    "工作目錄: D:\\OpenClaw",
    `Blocker: ${escalation?.blocker ?? "unknown"}`,
    `Gate: ${escalation?.gateId ?? "unknown"}`,
    `Evidence: ${JSON.stringify(escalation?.evidence ?? {}, null, 2)}`,
    "",
    "## 要求",
    "1. 分析根因",
    "2. 執行最小安全修復",
    "3. 跑驗證確認修復成功",
    "4. 不得修改 gate 門檻、不得下單、不得讀取 secrets",
  ].join("\n");
}

async function processQueuedTasks() {
  const pendingDir = path.join(QUEUE_DIR, "pending");
  const doneDir = path.join(QUEUE_DIR, "done");
  const files = await fs.readdir(pendingDir);
  const jsonFiles = files.filter((name) => name.endsWith(".json"));
  const taskSummaries = [];
  for (const fileName of jsonFiles.slice(0, 3)) {
    const fullPath = path.join(pendingDir, fileName);
    const raw = await fs.readFile(fullPath, "utf8");
    let task;
    try {
      task = JSON.parse(raw);
    } catch {
      await fs.rename(fullPath, path.join(QUEUE_DIR, "failed", fileName));
      taskSummaries.push({ file: fileName, status: "invalid_json" });
      continue;
    }
    if (
      task?.schema !== "openclaw.dmad.escalation-task-pack.v1" ||
      !Array.isArray(task?.escalations)
    ) {
      await fs.rename(fullPath, path.join(doneDir, fileName));
      taskSummaries.push({ file: fileName, status: "ignored_schema" });
      continue;
    }
    let successCount = 0;
    for (const escalation of task.escalations.slice(0, 3)) {
      const codexResult = await callCodexExecute(buildCodexQueueBrief(escalation), {
        timeoutMs: 360_000,
      });
      if (codexResult.ok) {
        successCount += 1;
      }
    }
    await fs.rename(fullPath, path.join(doneDir, fileName));
    taskSummaries.push({
      file: fileName,
      status: "processed",
      escalations: task.escalations.length,
      codexSuccess: successCount,
    });
  }
  return taskSummaries;
}

export async function runCycle() {
  await ensureQueueDirs();
  const startedAt = Date.now();
  const report = {
    schema: "openclaw.dmad.engine-cycle.v2",
    cycleAt: new Date().toISOString(),
    dryRun: isDryRun,
    codexOnly,
    phases: {},
    status: "running",
  };

  const diagnoses = await scan();
  const scopedDiagnoses = diagnoses.slice(
    0,
    Number.isFinite(maxDiagnoses) ? maxDiagnoses : diagnoses.length,
  );
  report.phases.scan = {
    blockerCount: diagnoses.length,
    scopedBlockerCount: scopedDiagnoses.length,
    blockers: diagnoses.map((item) => item.blocker),
  };

  if (diagnoses.length === 0) {
    report.status = "healthy";
    report.phases.queue = {
      processed: await processQueuedTasks(),
    };
    report.durationMs = Date.now() - startedAt;
    await writeReport(report);
    return report;
  }

  const plans = [];
  for (const diagnosis of scopedDiagnoses) {
    const plan = await think(diagnosis, {
      codexOnly,
      skipCodex: isDryRun && !codexOnly,
    });
    plans.push({ diagnosis, plan });
  }
  report.phases.think = {
    total: plans.length,
    autoExecute: plans.filter((item) => item.plan?.decision === "auto_execute").length,
    escalate: plans.filter((item) => item.plan?.decision === "escalate").length,
    sources: {
      pattern: plans.filter((item) => item.plan?.source === "pattern_exact_match").length,
      ollama: plans.filter((item) => item.plan?.source === "ollama_reasoning").length,
      codex: plans.filter((item) => item.plan?.source === "codex_reasoning").length,
    },
  };

  if (isDryRun) {
    const escalations = plans.filter((item) => item.plan?.decision === "escalate");
    const escalationPack = await writeEscalationTaskPack(escalations);
    report.status = "dry_run";
    report.phases.execute = {
      skipped: true,
      escalationCount: escalations.length,
      escalationPack,
    };
    report.durationMs = Date.now() - startedAt;
    await writeReport(report);
    return report;
  }

  const results = [];
  for (const item of plans) {
    const { diagnosis, plan } = item;
    if (plan?.decision !== "auto_execute") {
      continue;
    }
    if (plan?.requiresApproval) {
      await writeQueueItem("approval-needed", {
        schema: "openclaw.dmad.approval-needed.v1",
        generatedAt: new Date().toISOString(),
        diagnosis,
        plan,
      });
      continue;
    }
    const execution = await execute(plan, {
      stepTimeoutMs: 90_000,
      validationTimeoutMs: 60_000,
      rollbackTimeoutMs: 60_000,
    });
    results.push({ diagnosis, plan, result: execution });
    await writeQueueItem("completed", {
      schema: "openclaw.dmad.execution-result.v1",
      generatedAt: new Date().toISOString(),
      diagnosis,
      plan,
      result: execution,
    });
  }

  const escalations = plans.filter((item) => item.plan?.decision === "escalate");
  const escalationPack = await writeEscalationTaskPack(escalations);
  report.phases.execute = {
    executed: results.length,
    success: results.filter((entry) => entry.result?.status === "success").length,
    failed: results.filter((entry) => entry.result?.status !== "success").length,
    escalationCount: escalations.length,
    escalationPack,
  };

  for (const item of results) {
    await learn(item.diagnosis, item.plan, item.result);
  }
  report.phases.learn = {
    processed: results.length,
  };

  const postDiagnoses = await scan();
  report.phases.verify = {
    before: diagnoses.length,
    after: postDiagnoses.length,
    resolved: diagnoses.length - postDiagnoses.length,
    remaining: postDiagnoses.map((item) => item.blocker),
  };

  report.phases.queue = {
    processed: await processQueuedTasks(),
  };

  report.status = postDiagnoses.length === 0 ? "all_resolved" : "partial";
  report.durationMs = Date.now() - startedAt;
  await writeReport(report);
  return report;
}

async function main() {
  if (isWatch) {
    while (true) {
      await runCycle();
      await new Promise((resolve) => {
        setTimeout(resolve, WATCH_INTERVAL_MS);
      });
    }
  } else {
    await runCycle();
  }
}

if (path.resolve(process.argv[1] ?? "") === __filename) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}
