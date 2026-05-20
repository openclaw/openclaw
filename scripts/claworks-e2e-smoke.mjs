#!/usr/bin/env node
/**
 * ClaWorks end-to-end smoke (in-process runtime, no full gateway build required).
 *
 * Usage:
 *   node --import tsx scripts/claworks-e2e-smoke.mjs
 *   CLAWORKS_PACKS_DIR=/path/to/claworks-packs node --import tsx scripts/claworks-e2e-smoke.mjs
 *
 * Optional HTTP check (gateway must be running on 18800):
 *   CLAWORKS_E2E_HTTP=1 node --import tsx scripts/claworks-e2e-smoke.mjs
 */
import { mkdtempSync } from "node:fs";
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
  console.log(`[claworks:e2e] ${msg}`);
}

async function main() {
  const {
    createClaworksRuntime,
    startClaworksRuntime,
    stopClaworksRuntime,
    bridgeImMessage,
    bridgeWebhookPayload,
  } = await import("../packages/claworks-runtime/src/index.ts");
  const stateDir = mkdtempSync(path.join(tmpdir(), "claworks-e2e-"));
  const dbPath = path.join(stateDir, "robot.db");

  log(`state=${stateDir}`);
  log(`packs=${packsDir}`);

  const runtime = await createClaworksRuntime(
    {
      robot: { name: "e2e-robot", role: "monolith", port: 18_800, host: "127.0.0.1" },
      data: { database_url: `sqlite://${dbPath}` },
      packs: {
        paths: [packsDir, path.join(stateDir, "packs")],
        installed: ["base", "process-industry"],
      },
    },
    {
      logger: (m) => log(m),
      llmComplete: async () => ({
        text: JSON.stringify({
          intent: "alarm_report",
          confidence: 0.9,
          extracted: { alarm_id: "im-e2e-1" },
        }),
      }),
    },
  );

  await startClaworksRuntime(runtime);

  const playbookIds = new Set(runtime.playbookEngine.list().map((p) => p.id));
  log(`loaded playbooks: ${[...playbookIds].sort().join(", ")}`);
  assert(playbookIds.has("ingest_text_to_kb"), "missing ingest_text_to_kb pack playbook");
  assert(playbookIds.has("diagnose_on_alarm"), "missing diagnose_on_alarm pack playbook");
  assert(
    playbookIds.has("classify_webhook_to_business_event"),
    "missing classify_webhook_to_business_event pack playbook",
  );

  // 0) IM intent_route bridge (no EventBus flood)
  const imResult = await bridgeImMessage(runtime, {
    channel: "feishu",
    messageId: "e2e-im-1",
    userId: "e2e-user",
    text: "泵站振动异常，请查告警",
  });
  assert(
    imResult.action === "intent_routed" || imResult.action === "published",
    `im bridge unexpected action=${imResult.action}`,
  );
  log(`bridgeImMessage OK (action=${imResult.action})`);

  const whResult = await bridgeWebhookPayload(runtime, {
    source: "mes-e2e",
    webhookId: "wh-e2e-1",
    body: { probe: true },
    subjectId: "webhook:mes-e2e",
  });
  assert(
    whResult.action === "intent_routed" || whResult.action === "published",
    `webhook bridge unexpected action=${whResult.action}`,
  );
  log(`bridgeWebhookPayload OK (action=${whResult.action})`);

  // 1) Manual KB ingest
  const ingestRun = await runtime.playbookEngine.trigger("ingest_text_to_kb", {
    text: "E2E smoke: pump seal inspection notes.",
    title: "e2e-smoke",
    layer: "specs",
  });
  assert(ingestRun.status === "completed", `ingest run status=${ingestRun.status}`);
  const hits = await runtime.kb.search("pump seal", { limit: 3 });
  assert(hits.length > 0, "KB search returned no hits after ingest");
  log(`ingest_text_to_kb OK (run=${ingestRun.id})`);

  // 2) Event: MRO scaffold
  const mroMatches = await runtime.kernel.publish("alarm.created", "e2e", {
    mro_alarm_to_wo: true,
    alarm_id: "mro-1",
    equipment_id: "eq-mro",
    priority: "P3",
  });
  assert(
    mroMatches.some((m) => m.playbookId === "mro_alarm_to_workorder"),
    "mro_alarm_to_workorder did not match",
  );
  log("mro_alarm_to_workorder matched");

  // 3) Event: diagnose_on_alarm (expect HITL on create_wo — confidence 0.82 < 0.9)
  const diagMatches = await runtime.kernel.publish("alarm.created", "e2e", {
    priority: "P1",
    alarm_id: "al-e2e-1",
    equipment_id: "pump-e2e",
    reading_values: { vibration: 4.2 },
  });
  assert(
    diagMatches.some((m) => m.playbookId === "diagnose_on_alarm"),
    "diagnose_on_alarm did not match",
  );

  const diagRuns = await runtime.playbookEngine.listRuns({
    playbookId: "diagnose_on_alarm",
    limit: 5,
  });
  assert(diagRuns.length > 0, "no diagnose_on_alarm runs");
  const latest = diagRuns[0];
  assert(
    latest.status === "waiting_hitl" || latest.status === "completed",
    `unexpected diagnose run status=${latest.status}`,
  );
  log(`diagnose_on_alarm OK (run=${latest.id} status=${latest.status})`);

  if (latest.status === "waiting_hitl") {
    const resumed = await runtime.playbookEngine.submitHitlDecision(
      latest.id,
      "create_wo",
      "approve",
      "e2e auto-approve",
    );
    assert(resumed.status === "completed", `HITL resume status=${resumed.status}`);
    log("HITL approve → completed");
  }

  const { items: workOrders } = await runtime.objectStore.query("WorkOrder", { limit: 10 });
  assert(workOrders.length > 0, "expected at least one WorkOrder after diagnose flow");
  log(`WorkOrder created: ${workOrders[0]?.id}`);

  // 4) MES dispatch playbook (manual trigger with WO payload)
  const mesRun = await runtime.playbookEngine.trigger("dispatch_mes_on_workorder_created", {
    source_alarm_id: "al-e2e-1",
    workorder_id: workOrders[0]?.id,
    station_id: "S1",
  });
  assert(mesRun.status === "completed", `dispatch_mes status=${mesRun.status}`);
  log("dispatch_mes_on_workorder_created OK");

  // 5) Event-driven MES: publish workorder.created
  const woEvents = [];
  const origPublish = runtime.kernel.publish.bind(runtime.kernel);
  runtime.kernel.publish = async (type, source, payload, correlationId) => {
    const matches = await origPublish(type, source, payload, correlationId);
    if (type === "workorder.created") {
      woEvents.push(payload);
    }
    return matches;
  };
  await runtime.objectStore.create(
    "WorkOrder",
    { equipment_id: "pump-e2e-2", source_alarm_id: "al-e2e-2", station_id: "S1" },
    {
      runId: "e2e",
      playbookId: "e2e",
      variables: {},
      objectStore: runtime.objectStore,
      kb: runtime.kb,
      robot: runtime.robot,
      publishEvent: async (type, source, payload, correlationId) => {
        await runtime.kernel.publish(type, source, payload, correlationId);
      },
    },
  );
  const mesEventRuns = await runtime.playbookEngine.listRuns({
    playbookId: "dispatch_mes_on_workorder_created",
    limit: 10,
  });
  assert(mesEventRuns.length >= 2, "expected event-triggered MES run");
  log("workorder.created → dispatch_mes matched");

  // 6) reload_packs_and_notify (manual)
  const reloadRun = await runtime.playbookEngine.trigger("reload_packs_and_notify", {
    tenant_id: "e2e",
  });
  assert(reloadRun.status === "completed", `reload_packs status=${reloadRun.status}`);
  const reloadStep = reloadRun.steps.find((s) => s.stepId === "reload");
  assert(reloadStep?.output?.status === "ok", "reload_packs step missing ok status");
  log(`reload_packs_and_notify OK (packs=${reloadStep?.output?.total ?? "?"})`);

  await stopClaworksRuntime(runtime);

  if (process.env.CLAWORKS_E2E_HTTP === "1") {
    const port = process.env.CLAWORKS_GATEWAY_PORT || "18800";
    const base = `http://127.0.0.1:${port}`;
    log(`HTTP probe ${base}/v1/health`);
    const health = await fetch(`${base}/v1/health`);
    assert(health.ok, `gateway health failed: ${health.status}`);
    const ev = await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "alarm.created",
        payload: { mro_alarm_to_wo: true, alarm_id: "http-1", equipment_id: "eq-http" },
      }),
    });
    assert(ev.status === 202, `POST /v1/events failed: ${ev.status}`);
    log("HTTP /v1/events OK");
  }

  log("ALL CHECKS PASSED");
}

main().catch((err) => {
  console.error("[claworks:e2e] FAILED", err);
  process.exit(1);
});
