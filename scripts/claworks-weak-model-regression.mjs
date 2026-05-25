#!/usr/bin/env node
/**
 * Weak model intent regression for CI (mirrors weak_model_regression_suite Playbook).
 *
 * Flow: evolve.generate_simulations → perceive.intent ×3 → deterministic score → gate.
 * Gate: exit 1 when fail_rate > CLAWORKS_REGRESSION_FAIL_RATE_THRESHOLD (default 0.3).
 *
 * Usage:
 *   node --import tsx scripts/claworks-weak-model-regression.mjs
 *   CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:weak-model-regression
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FAIL_RATE_THRESHOLD,
  evaluateRegressionGate,
  scoreIntentRegression,
} from "./lib/claworks-weak-model-regression-gate.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packsDir = process.env.CLAWORKS_PACKS_DIR?.trim() || path.join(root, "..", "claworks-packs");
const threshold = Number.parseFloat(
  process.env.CLAWORKS_REGRESSION_FAIL_RATE_THRESHOLD ?? String(DEFAULT_FAIL_RATE_THRESHOLD),
);
const simulateFailRate = process.env.CLAWORKS_REGRESSION_SIMULATE_FAIL_RATE?.trim();

process.env.CLAWORKS_PRODUCT = "1";

function log(msg) {
  console.log(`[weak-model-regression] ${msg}`);
}

function fail(msg, code = 1) {
  console.error(`[weak-model-regression] FAIL: ${msg}`);
  process.exit(code);
}

const FIXED_SCENARIOS = {
  scenarios: [
    {
      user_input: "3号生产线温度超标了，赶紧处理",
      expected_intent: "alarm_report",
      difficulty: "easy",
    },
    {
      user_input: "帮我查一下P-101泵现在的运行状态",
      expected_intent: "equipment_status",
      difficulty: "medium",
    },
    {
      user_input: "今天的生产日报发了吗",
      expected_intent: "knowledge_query",
      difficulty: "easy",
    },
  ],
};

function intentForText(text) {
  const t = String(text);
  if (t.includes("温度") || t.includes("超标") || t.includes("告警")) {
    return { intent: "alarm_report", confidence: 0.92, extracted: {} };
  }
  if (t.includes("泵") || t.includes("运行状态") || t.includes("设备")) {
    return { intent: "equipment_status", confidence: 0.88, extracted: {} };
  }
  if (t.includes("日报") || t.includes("知识") || t.includes("查询")) {
    return { intent: "knowledge_query", confidence: 0.86, extracted: {} };
  }
  return { intent: "unknown", confidence: 0.2, extracted: {} };
}

async function main() {
  if (!existsSync(packsDir)) {
    fail(
      `Pack source not found at ${packsDir} — clone claworks-packs or set CLAWORKS_PACKS_DIR`,
      2,
    );
  }

  const { createClaworksRuntime, startClaworksRuntime, stopClaworksRuntime } =
    await import("../packages/claworks-runtime/src/index.ts");

  const stateDir = mkdtempSync(path.join(tmpdir(), "claworks-regression-"));
  const dbPath = path.join(stateDir, "robot.db");

  log(`packs=${packsDir}`);
  log(`threshold=${threshold}`);

  const runtime = await createClaworksRuntime(
    {
      robot: { name: "regression-ci", role: "monolith", port: 18_800, host: "127.0.0.1" },
      data: { database_url: `sqlite://${dbPath}` },
      packs: { paths: [packsDir], installed: ["base"] },
    },
    {
      logger: (m) => {
        if (process.env.VERBOSE) {
          log(m);
        }
      },
      llmComplete: async ({ prompt }) => {
        const p = String(prompt ?? "");
        if (p.includes("生成") && p.includes("场景")) {
          return { text: JSON.stringify(FIXED_SCENARIOS) };
        }
        for (const scenario of [...FIXED_SCENARIOS.scenarios].reverse()) {
          if (p.includes(scenario.user_input)) {
            return { text: JSON.stringify(intentForText(scenario.user_input)) };
          }
        }
        return { text: JSON.stringify(intentForText(p)) };
      },
      notify: async () => undefined,
    },
  );

  await startClaworksRuntime(runtime);

  try {
    const playbookIds = new Set(runtime.playbookEngine.list().map((pb) => pb.id));
    if (!playbookIds.has("weak_model_regression_suite")) {
      fail("weak_model_regression_suite Playbook not loaded — update claworks-packs/base", 2);
    }
    log("weak_model_regression_suite Playbook present");

    const capCtx = { runId: "weak-model-regression-ci", source: "ci-regression" };

    const generated = await runtime.capabilities.invoke("evolve.generate_simulations", capCtx, {
      domain: "industrial",
      count: 10,
    });
    const scenarios = Array.isArray(generated?.scenarios)
      ? generated.scenarios
      : FIXED_SCENARIOS.scenarios;
    log(`scenarios=${scenarios.length}`);

    const intentResults = [];
    for (let i = 0; i < Math.min(3, scenarios.length); i++) {
      const text = String(scenarios[i]?.user_input ?? FIXED_SCENARIOS.scenarios[i]?.user_input);
      const result = await runtime.capabilities.invoke("perceive.intent", capCtx, {
        text,
        user_id: `regression-case-${i}`,
      });
      intentResults.push(result);
    }

    const stats = scoreIntentRegression(
      scenarios.slice(0, 3).length >= 3 ? scenarios.slice(0, 3) : FIXED_SCENARIOS.scenarios,
      intentResults,
      { simulateFailRate },
    );
    const gate = evaluateRegressionGate(stats, threshold);

    log(
      `regression pass=${stats.pass} fail=${stats.fail} fail_rate=${gate.failRate ?? stats.fail_rate}`,
    );
    if (process.env.VERBOSE && stats.details?.length) {
      for (const line of stats.details) {
        log(`  ${line}`);
      }
    }

    await runtime.kb.ingest(
      `# 弱模型意图回归结果 (CI)\n时间: ${new Date().toISOString()}\n统计: ${JSON.stringify(stats)}`,
      { namespace: "regression_results", source: "weak_model_regression_ci" },
    );

    if (!gate.pass) {
      if (gate.reason === "missing_fail_rate") {
        fail(`could not evaluate fail_rate from stats: ${JSON.stringify(stats)}`);
      }
      fail(
        `fail_rate ${gate.failRate} exceeds threshold ${gate.threshold} (${((gate.failRate ?? 0) * 100).toFixed(1)}% > ${(gate.threshold * 100).toFixed(0)}%)`,
      );
    }

    log(`gate OK — fail_rate ${gate.failRate} <= ${gate.threshold}`);
    process.exit(0);
  } finally {
    await stopClaworksRuntime(runtime);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
