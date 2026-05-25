#!/usr/bin/env node
/**
 * ClaWorks evolution chain smoke — in-process runtime (no live Gateway build).
 *
 * Verifies:
 *   autonomy.learn_opportunity (knowledge_gap) → evolution.simulation_requested → evolution.regression_requested
 *   weak_model_regression_suite Playbook completes on regression_requested
 *   GET /v1/evolve/drafts
 *   pending sandbox promotions survive runtime stop/start (same SQLite)
 *   evolution_weekly_export schedule playbook is loaded
 *
 * Usage:
 *   node --import tsx scripts/claworks-evolution-chain-smoke.mjs
 *   CLAWORKS_PACKS_DIR=/path/to/claworks-packs node --import tsx scripts/claworks-evolution-chain-smoke.mjs
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packsDir = process.env.CLAWORKS_PACKS_DIR?.trim() || path.join(root, "..", "claworks-packs");

process.env.CLAWORKS_PRODUCT = "1";

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function log(msg) {
  console.log(`[claworks:evolution-smoke] ${msg}`);
}

const WEAK_MODEL_REGRESSION_PLAYBOOK_ID = "weak_model_regression_suite";

async function waitForEvent(eventLog, type, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (eventLog.some((e) => e.type === type)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for event ${type}`);
}

async function waitForPlaybookRun(engine, playbookId, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runs = await engine.listRuns({ playbookId, limit: 5 });
    const run = runs.find((r) => r.status === "completed" || r.status === "failed");
    if (run) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for playbook ${playbookId} run`);
}

function buildRuntimeConfig(stateDir, dbName = "robot.db") {
  return {
    robot: { name: "evolution-smoke", role: "monolith", port: 18_802, host: "127.0.0.1" },
    data: { database_url: `sqlite://${path.join(stateDir, dbName)}` },
    packs: {
      paths: [packsDir, path.join(stateDir, "packs")],
      installed: ["base", "process-industry"],
    },
  };
}

async function main() {
  const {
    createClaworksRuntime,
    startClaworksRuntime,
    stopClaworksRuntime,
    createClaworksRestHandler,
  } = await import("../packages/claworks-runtime/src/index.ts");

  const stateDir = mkdtempSync(path.join(tmpdir(), "claworks-evolution-"));
  const dbPath = path.join(stateDir, "robot.db");
  log(`state=${stateDir}`);
  log(`packs=${packsDir}`);

  const eventLog = [];
  const runtime = await createClaworksRuntime(buildRuntimeConfig(stateDir), {
    logger: (m) => log(m),
    llmComplete: async () => ({
      text: JSON.stringify({
        intent: "knowledge_query",
        confidence: 0.85,
        extracted: {},
      }),
    }),
  });

  runtime.kernel.bus.subscribe("*", async (event) => {
    eventLog.push({ type: event.type, source: event.source, payload: event.payload });
  });

  await startClaworksRuntime(runtime);

  const playbookIds = new Set(runtime.playbookEngine.list().map((p) => p.id));
  log(`loaded playbooks: ${playbookIds.size}`);
  assert(playbookIds.has(WEAK_MODEL_REGRESSION_PLAYBOOK_ID), "missing weak_model_regression_suite");
  assert(playbookIds.has("evolution_weekly_export"), "missing evolution_weekly_export");
  assert(
    playbookIds.has("evolution_sandbox_promotion_hitl"),
    "missing evolution_sandbox_promotion_hitl",
  );

  const weeklyExport = runtime.playbookEngine
    .list()
    .find((p) => p.id === "evolution_weekly_export");
  assert(
    weeklyExport?.trigger?.kind === "schedule",
    "evolution_weekly_export must be schedule trigger",
  );
  assert(
    typeof weeklyExport.trigger.cron === "string" && weeklyExport.trigger.cron.length > 0,
    "evolution_weekly_export missing cron",
  );
  log(`evolution_weekly_export cron=${weeklyExport.trigger.cron}`);

  // ── 1) autonomy.learn_opportunity → simulation → regression chain ────────
  eventLog.length = 0;
  await runtime.kernel.publish("autonomy.learn_opportunity", "evolution-smoke", {
    signal: "knowledge_gap",
    description: "smoke: 知识缺口触发进化链",
    detected_at: new Date().toISOString(),
    metadata: {
      gap_type: "knowledge_gap",
      count: 6,
      last_input: "查一下产线 OEE 趋势",
    },
  });

  await waitForEvent(eventLog, "autonomy.learn_handled");
  await waitForEvent(eventLog, "evolution.simulation_requested");
  await waitForEvent(eventLog, "evolution.regression_requested");

  const simEvt = eventLog.find((e) => e.type === "evolution.simulation_requested");
  const regEvt = eventLog.find((e) => e.type === "evolution.regression_requested");
  assert(simEvt?.payload?.auto === true || simEvt?.payload?.reason, "simulation_requested payload");
  assert(
    regEvt?.payload?.chained_from === "evolution.simulation_requested",
    "regression_requested must chain from simulation_requested",
  );
  log("autonomy → simulation_requested → regression_requested OK");

  const regressionRun = await waitForPlaybookRun(
    runtime.playbookEngine,
    WEAK_MODEL_REGRESSION_PLAYBOOK_ID,
  );
  assert(
    regressionRun.status === "completed",
    `weak_model_regression_suite must complete, got ${regressionRun.status}`,
  );
  log(`weak_model_regression_suite completed run_id=${regressionRun.id}`);

  // ── 2) GET /v1/evolve/drafts ─────────────────────────────────────────────
  const rest = createClaworksRestHandler(runtime);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    req.url = url.pathname + url.search;
    await rest(req, res);
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const draftsRes = await fetch(`${base}/v1/evolve/drafts`);
  const draftsBody = await draftsRes.json();
  assert(draftsRes.status === 200, `GET /v1/evolve/drafts failed: ${draftsRes.status}`);
  assert(draftsBody.status === "ok", "drafts response missing status=ok");
  assert(Array.isArray(draftsBody.drafts), "drafts must be array");
  log(`GET /v1/evolve/drafts OK (count=${draftsBody.count ?? draftsBody.drafts.length})`);

  await new Promise((resolve) => server.close(() => resolve()));

  // ── 3) pending promotions survive stop/start ─────────────────────────────
  const sandboxPack = {
    version: "smoke-sandbox-1.0",
    generated_at: new Date().toISOString(),
    generated_by: "evolution-smoke",
    source_robot_id: "evolution-smoke",
    improved_playbooks: [{ id: "ev_smoke_sandbox_pb", name: "Smoke Sandbox PB", steps: [] }],
    summary: "evolution chain smoke sandbox",
  };

  const importResult = await runtime.evolutionSync.importEvolutionPack(sandboxPack, {
    sandbox: true,
  });
  assert(
    importResult.pending_promotion === true,
    "expected pending_promotion after sandbox import",
  );
  const pendingBefore = runtime.evolutionSync.listPendingSandboxPromotions();
  assert(pendingBefore.length === 1, "expected one pending promotion");
  const promotionId = pendingBefore[0].promotion_id;
  log(`sandbox pending promotion_id=${promotionId}`);

  await stopClaworksRuntime(runtime);

  const runtime2 = await createClaworksRuntime(buildRuntimeConfig(stateDir), {
    logger: (m) => log(`[restart] ${m}`),
    llmComplete: async () => ({
      text: JSON.stringify({ intent: "none", confidence: 0.2, extracted: {} }),
    }),
  });
  await startClaworksRuntime(runtime2);

  const pendingAfter = runtime2.evolutionSync.listPendingSandboxPromotions();
  assert(pendingAfter.length === 1, "pending promotion lost after restart");
  assert(
    pendingAfter[0].promotion_id === promotionId,
    `promotion_id mismatch: ${pendingAfter[0].promotion_id} !== ${promotionId}`,
  );
  assert(
    pendingAfter[0].pack.version === sandboxPack.version,
    "pack version mismatch after restart",
  );
  log("pending promotions survive runtime stop/start OK");

  await stopClaworksRuntime(runtime2);

  log(`db=${dbPath} (ops: inspect cw_evolution_pending_promotions for manual verification)`);
  log("ALL EVOLUTION CHAIN CHECKS PASSED");
}

main().catch((err) => {
  console.error("[claworks:evolution-smoke] FAILED", err);
  process.exit(1);
});
