#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const PATTERN_FILE = path.join(
  ROOT,
  ".openclaw",
  "dmad",
  "patterns",
  "dmad-pattern-registry.jsonl",
);
const HISTORY_FILE = path.join(
  ROOT,
  ".openclaw",
  "dmad",
  "patterns",
  "dmad-execution-history.jsonl",
);

async function loadPatterns() {
  try {
    const raw = await fs.readFile(PATTERN_FILE, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function savePatterns(patterns) {
  const lines = patterns.map((pattern) => JSON.stringify(pattern));
  await fs.writeFile(PATTERN_FILE, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
}

function summarizeDurationMs(result) {
  if (!Array.isArray(result?.stepResults)) {
    return 0;
  }
  return result.stepResults.reduce((sum, step) => sum + Number(step?.durationMs ?? 0), 0);
}

export async function learn(diagnosis, plan, result) {
  const now = new Date().toISOString();
  const patterns = await loadPatterns();
  const history = {
    timestamp: now,
    blocker: diagnosis?.blocker ?? "unknown",
    gateId: diagnosis?.gateId ?? diagnosis?.category ?? "unknown",
    strategy: plan?.solution?.strategy ?? "unknown",
    source: plan?.source ?? "unknown",
    status: result?.status ?? "failed",
    stepsCompleted: Number(result?.completedSteps ?? 0),
    stepsTotal: Number(result?.totalSteps ?? 0),
    durationMs: summarizeDurationMs(result),
  };
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.appendFile(HISTORY_FILE, `${JSON.stringify(history)}\n`, "utf8");

  const blocker = String(diagnosis?.blocker ?? "");
  const gateId = String(diagnosis?.gateId ?? diagnosis?.category ?? "");
  const existing = patterns.find(
    (pattern) =>
      String(pattern?.blocker ?? "") === blocker && String(pattern?.category ?? "") === gateId,
  );

  if (existing) {
    const best = existing.bestSolution ?? {};
    const successCount = Number(best.successCount ?? 0) + (result?.status === "success" ? 1 : 0);
    const failCount = Number(best.failCount ?? 0) + (result?.status === "failed" ? 1 : 0);
    if (result?.status === "success") {
      const incomingConfidence = Number(plan?.confidence ?? 0);
      const existingConfidence = Number(best.confidenceFromHistory ?? 0);
      if (incomingConfidence > existingConfidence && plan?.solution?.steps) {
        best.strategy = plan.solution.strategy;
        best.steps = plan.solution.steps;
      }
    }
    best.successCount = successCount;
    best.failCount = failCount;
    best.confidenceFromHistory =
      successCount + failCount > 0 ? successCount / (successCount + failCount) : 0.5;
    existing.bestSolution = best;
    existing.lastMatchedAt = now;
    existing.matchCount = Number(existing.matchCount ?? 0) + 1;
    await savePatterns(patterns);
    return { patternsTotal: patterns.length, updated: true, newPattern: false };
  }

  if (result?.status === "success") {
    patterns.push({
      patternId: `auto-${Date.now().toString(36)}`,
      fingerprint: `${gateId}|${blocker}`,
      category: gateId,
      blocker,
      matchCriteria: {
        blockerEquals: blocker,
      },
      bestSolution: {
        strategy: plan?.solution?.strategy ?? "auto_generated",
        steps: plan?.solution?.steps ?? [],
        confidenceFromHistory: 0.5,
        successCount: 1,
        failCount: 0,
      },
      registeredAt: now,
      lastMatchedAt: now,
      matchCount: 1,
    });
    await savePatterns(patterns);
    return { patternsTotal: patterns.length, updated: false, newPattern: true };
  }

  await savePatterns(patterns);
  return { patternsTotal: patterns.length, updated: false, newPattern: false };
}
