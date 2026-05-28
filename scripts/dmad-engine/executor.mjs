#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const EXECUTION_LOG = path.join(ROOT, ".openclaw", "dmad", "patterns", "dmad-execution-log.jsonl");

const denyKeywords = [
  "send_future_order",
  "send_os_future_order",
  "send_stock_order",
  "--dangerously-auto-approve",
  "--enable-orders",
  "allowLiveTrading=true",
  "rm -rf",
  "remove-item -recurse",
];

function trimText(value, maxChars = 1200) {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)} ...`;
}

function normalizeSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) {
    return [];
  }
  return rawSteps
    .map((entry, index) => {
      if (typeof entry === "string") {
        return {
          order: index + 1,
          command: entry,
          validation: null,
          rollback: null,
          requiresApproval: false,
        };
      }
      const command = typeof entry?.command === "string" ? entry.command : "";
      if (command.length === 0) {
        return null;
      }
      return {
        order: Number.isFinite(entry?.order) ? entry.order : index + 1,
        command,
        validation: typeof entry?.validation === "string" ? entry.validation : null,
        rollback: typeof entry?.rollback === "string" ? entry.rollback : null,
        requiresApproval: entry?.requiresApproval === true,
      };
    })
    .filter(Boolean);
}

function isAllowedPrefix(command) {
  return /^(pnpm|node|tsx|powershell|pwsh)\s+/i.test(command);
}

function safetyCheckStep(step) {
  const command = String(step?.command ?? "").trim();
  if (command.length === 0) {
    return { ok: false, reason: "empty_command" };
  }
  if (!isAllowedPrefix(command)) {
    return { ok: false, reason: "command_prefix_not_allowed" };
  }
  const lower = command.toLowerCase();
  if (denyKeywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
    return { ok: false, reason: "command_keyword_denied" };
  }
  return { ok: true, reason: null };
}

function runCommand(command, timeoutMs = 60_000) {
  try {
    const stdout = execSync(command, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return { ok: true, output: trimText(stdout), error: null };
  } catch (error) {
    const message = [
      error?.stdout ? String(error.stdout) : "",
      error?.stderr ? String(error.stderr) : "",
      error?.message ? String(error.message) : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { ok: false, output: trimText(message), error: trimText(message) };
  }
}

async function appendExecutionLog(entry) {
  await fs.mkdir(path.dirname(EXECUTION_LOG), { recursive: true });
  await fs.appendFile(EXECUTION_LOG, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function execute(plan, options = {}) {
  const startedAt = new Date().toISOString();
  const steps = normalizeSteps(plan?.solution?.steps);
  const result = {
    status: "failed",
    completedSteps: 0,
    totalSteps: steps.length,
    stepResults: [],
    rollbacks: [],
    startedAt,
    endedAt: null,
  };

  if (plan?.confidence != null && Number(plan.confidence) < 0.5) {
    result.stepResults.push({
      step: 0,
      status: "fail",
      output: "blocked_by_policy:confidence_lt_0_5",
      durationMs: 0,
    });
    result.endedAt = new Date().toISOString();
    await appendExecutionLog({ ...result, strategy: plan?.solution?.strategy ?? "unknown" });
    return result;
  }

  if (plan?.destructive === true) {
    result.stepResults.push({
      step: 0,
      status: "fail",
      output: "blocked_by_policy:destructive_requires_approval",
      durationMs: 0,
    });
    result.endedAt = new Date().toISOString();
    await appendExecutionLog({ ...result, strategy: plan?.solution?.strategy ?? "unknown" });
    return result;
  }

  for (const step of steps) {
    if (step.requiresApproval) {
      result.stepResults.push({
        step: step.order,
        status: "fail",
        output: "blocked_by_policy:requires_approval",
        durationMs: 0,
      });
      break;
    }
    const safety = safetyCheckStep(step);
    if (!safety.ok) {
      result.stepResults.push({
        step: step.order,
        status: "fail",
        output: `blocked_by_policy:${safety.reason}`,
        durationMs: 0,
      });
      break;
    }

    const startMs = Date.now();
    const run = runCommand(step.command, Number(options.stepTimeoutMs ?? 90_000));
    result.stepResults.push({
      step: step.order,
      status: run.ok ? "pass" : "fail",
      output: run.output,
      durationMs: Date.now() - startMs,
    });
    if (!run.ok) {
      if (step.rollback) {
        const rollbackRun = runCommand(step.rollback, Number(options.rollbackTimeoutMs ?? 60_000));
        result.rollbacks.push({
          step: step.order,
          rollback: step.rollback,
          status: rollbackRun.ok ? "pass" : "fail",
          output: rollbackRun.output,
        });
      }
      result.status = "failed";
      result.endedAt = new Date().toISOString();
      await appendExecutionLog({ ...result, strategy: plan?.solution?.strategy ?? "unknown" });
      return result;
    }
    result.completedSteps += 1;

    if (step.validation) {
      const validationRun = runCommand(
        step.validation,
        Number(options.validationTimeoutMs ?? 60_000),
      );
      result.stepResults.push({
        step: step.order,
        status: validationRun.ok ? "validation_pass" : "validation_fail",
        output: validationRun.output,
        durationMs: 0,
      });
      if (!validationRun.ok) {
        result.status = "failed";
        result.endedAt = new Date().toISOString();
        await appendExecutionLog({ ...result, strategy: plan?.solution?.strategy ?? "unknown" });
        return result;
      }
    }
  }

  result.status = "success";
  result.endedAt = new Date().toISOString();
  await appendExecutionLog({ ...result, strategy: plan?.solution?.strategy ?? "unknown" });
  return result;
}
