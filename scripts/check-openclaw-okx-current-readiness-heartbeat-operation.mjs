import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  OKX_HEARTBEAT_NEXT_SAFE_TASK,
  OKX_HEARTBEAT_READ_ONLY_ENV_LOCKS,
  buildOkxCurrentReadinessHeartbeatOperation,
} from "./openclaw-okx-current-readiness-heartbeat-operation.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:current-readiness:heartbeat"],
  "node scripts/openclaw-okx-current-readiness-heartbeat-operation.mjs --write-state --json",
);
assert.equal(
  scripts["okx:current-readiness:heartbeat:check"],
  "node scripts/check-openclaw-okx-current-readiness-heartbeat-operation.mjs",
);
assert.equal(
  scripts["okx:current-readiness:heartbeat:execute"],
  "node scripts/openclaw-okx-current-readiness-heartbeat-operation.mjs --execute --write-state --json",
);
assert.deepEqual(OKX_HEARTBEAT_READ_ONLY_ENV_LOCKS, {
  OPENCLAW_OKX_HEARTBEAT_OPERATION: "1",
  OPENCLAW_OKX_PRIVATE_ORDER_QUERY_ENABLED: "0",
  OPENCLAW_OKX_ORDER_WRITE_ENABLED: "0",
  OPENCLAW_OKX_CANCEL_ENABLED: "0",
  OPENCLAW_OKX_WITHDRAWAL_ENABLED: "0",
});

const staleCurrentReadiness = {
  exists: true,
  path: "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json",
  digest: "fixture-stale",
  report: {
    status: "blocked",
    generatedAt: "2026-05-24T20:00:00.000Z",
    machineLine:
      "okxCurrentReadiness=blocked quote=ok scheduler=blocked schedulerNextRunAt=2026-05-24T20:05:00.000Z demo=ready_no_exchange_write paperAudit=ready_read_only telegram=pass freshness=blocked noOrderWrite=true",
    readiness: {
      marketSnapshotScheduler: {
        nextRunAt: "2026-05-24T20:05:00.000Z",
        nextRunWithinGrace: false,
      },
    },
    sourceFreshness: { ok: false },
    blockers: ["market_snapshot_scheduler_stale"],
    safety: { noOrderWrite: true },
  },
};

const readyCurrentReadiness = {
  exists: true,
  path: "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json",
  digest: "fixture-ready",
  report: {
    status: "ready_read_only",
    generatedAt: "2026-05-24T20:10:00.000Z",
    machineLine:
      "okxCurrentReadiness=ready quote=ok scheduler=pass schedulerNextRunAt=2026-05-24T20:15:00.000Z demo=ready_no_exchange_write paperAudit=ready_read_only telegram=pass freshness=ok noOrderWrite=true",
    readiness: {
      marketSnapshotScheduler: {
        nextRunAt: "2026-05-24T20:15:00.000Z",
        nextRunWithinGrace: true,
      },
    },
    sourceFreshness: { ok: true },
    blockers: [],
    safety: { noOrderWrite: true },
  },
};

const refreshWorkflow = {
  exists: true,
  path: "reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json",
  digest: "fixture-refresh",
  report: {
    status: "planned_read_only",
    machineLine: "okxCurrentReadinessRefresh=planned steps=0/7 freshness=planned noOrderWrite=true",
  },
};

const inventoryProbe = {
  exists: true,
  path: "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
  digest: "fixture-inventory-probe",
  report: {
    summary: {
      okxCurrentReadinessInventoryProbeClosure: {
        status: "ready",
        machineLine:
          "okxInventoryProbe=pass summaryProbes=5/5 publishProbes=16/16 summary=telegram+controlled noOrderWrite=true",
        missingTokens: [],
        publishProbeCount: 16,
        noOrderWrite: true,
      },
    },
  },
};

const publishBridgeStatus = {
  exists: true,
  path: "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-bridge-latest.json",
  digest: "fixture-publish-bridge-status",
  report: {
    status: "dry_run_ok",
    upstreamStatus: "dry_run_ok",
    upstreamMessageTokenCounts: {
      shortcutChecks: 1,
      localExecutorDispatch: 1,
      positionSnapshot: 1,
      okxRefresh: 1,
      okxHeartbeat: 1,
      executeRequired: 1,
      noOrderWrite: 4,
      okxContract: 1,
      nextCommand: 1,
      dmadGate: 1,
    },
    upstreamMessageTokenCountsSummaryZhTw:
      "messageTokenCounts 快捷檢查=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 executeRequired=1 noOrderWrite=true=4 OKX合約=1 下一步指令=1 DMAD=1",
    upstreamNoOrderWriteCount: 4,
    upstreamExecuteRequiredCount: 1,
    upstreamOkxContractCount: 1,
    upstreamDmadGateCount: 1,
    upstreamNoOrderWriteVerified: true,
    upstreamOkxContractVerified: true,
    upstreamDmadGateVerified: true,
  },
};

const stalePlan = await buildOkxCurrentReadinessHeartbeatOperation({
  currentReadiness: staleCurrentReadiness,
  refreshWorkflow,
  inventoryProbe,
  publishBridgeStatus,
  now: new Date("2026-05-24T20:12:00.000Z"),
});

assert.equal(stalePlan.schema, "openclaw.okx.current-readiness-heartbeat-operation.v1");
assert.equal(stalePlan.status, "refresh_available_read_only");
assert.equal(stalePlan.code, "okx_current_readiness_heartbeat_refresh_available");
assert.match(
  stalePlan.summary_zh_tw,
  /sc:tr:okxrefresh|pnpm okx:current-readiness:heartbeat:execute/u,
);
assert.match(stalePlan.machineLine, /okxCurrentReadinessHeartbeat=refresh_available/u);
assert.match(stalePlan.machineLine, /telegram=sc:tr:okxrefresh/u);
assert.match(stalePlan.machineLine, /command=okx:current-readiness:refresh/u);
assert.match(stalePlan.machineLine, /inventoryProbe=ready/u);
assert.match(stalePlan.machineLine, /schedulerNextRunAt=2026-05-24T20:05:00.000Z/u);
assert.match(stalePlan.machineLine, /noOrderWrite=true/u);
assert.deepEqual(stalePlan.blockers, [
  "current_readiness_not_ready",
  "source_freshness_not_ok",
  "source_market_snapshot_scheduler_stale",
]);
assert.equal(stalePlan.action.telegramCallback, "sc:tr:okxrefresh");
assert.equal(stalePlan.action.heartbeatCommand, "pnpm okx:current-readiness:heartbeat");
assert.equal(stalePlan.action.executeCommand, "pnpm okx:current-readiness:heartbeat:execute");
assert.equal(stalePlan.action.refreshCommand, "pnpm okx:current-readiness:refresh");
assert.equal(stalePlan.action.oneClickRefresh, true);
assert.equal(stalePlan.action.executeRequired, true);
assert.equal(stalePlan.safety.readOnly, true);
assert.equal(stalePlan.safety.noOrderWrite, true);
assert.equal(stalePlan.safety.sourceNoOrderWrite, true);
assert.equal(stalePlan.safety.privateOrderQueryEnabled, false);
assert.equal(stalePlan.safety.orderPlacementEnabled, false);
assert.equal(stalePlan.safety.cancelOrderEnabled, false);
assert.equal(stalePlan.safety.withdrawalEnabled, false);
assert.equal(stalePlan.reports.inventoryProbe.ready, true);
assert.equal(stalePlan.reports.inventoryProbe.telegramShortcutReady, true);
assert.equal(stalePlan.reports.inventoryProbe.noOrderWrite, true);
assert.equal(stalePlan.reports.inventoryProbe.publishProbeCount, 16);
assert.deepEqual(stalePlan.reports.inventoryProbe.missingTokens, []);
assert.match(stalePlan.reports.inventoryProbe.machineLine, /okxInventoryProbe=pass/u);
assert.match(stalePlan.reports.inventoryProbe.machineLine, /publishBridge=pass/u);
assert.match(stalePlan.reports.inventoryProbe.machineLine, /upstreamNoOrderWriteVerified=true/u);
assert.match(stalePlan.reports.inventoryProbe.machineLine, /upstreamDmadGateVerified=true/u);
assert.match(stalePlan.reports.inventoryProbe.machineLine, /upstreamOkxContractVerified=true/u);
assert.match(stalePlan.reports.inventoryProbe.machineLine, /noOrderWrite=true=4/u);
assert.match(stalePlan.reports.inventoryProbe.machineLine, /本地執行器=1/u);
assert.match(stalePlan.reports.inventoryProbe.machineLine, /OKX合約=1/u);
assert.match(stalePlan.reports.inventoryProbe.machineLine, /DMAD=1/u);
assert.equal(stalePlan.reports.inventoryProbe.publishBridgeStatus.ready, true);
assert.equal(stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamNoOrderWriteCount, 4);
assert.equal(stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamOkxContractCount, 1);
assert.equal(stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamDmadGateCount, 1);
assert.equal(
  stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamNoOrderWriteVerified,
  true,
);
assert.equal(stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamDmadGateVerified, true);
assert.equal(
  stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamOkxContractVerified,
  true,
);
assert.match(
  stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamMessageTokenCountsSummaryZhTw,
  /noOrderWrite=true=4/u,
);
assert.match(
  stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamMessageTokenCountsSummaryZhTw,
  /本地執行器=1/u,
);
assert.match(
  stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamMessageTokenCountsSummaryZhTw,
  /倉位快照=1/u,
);
assert.match(
  stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamMessageTokenCountsSummaryZhTw,
  /OKX合約=1/u,
);
assert.match(
  stalePlan.reports.inventoryProbe.publishBridgeStatus.upstreamMessageTokenCountsSummaryZhTw,
  /DMAD=1/u,
);
assert.ok(stalePlan.markers.includes("heartbeat_refresh_available"));
assert.ok(stalePlan.markers.includes("telegram_okxrefresh_available"));
assert.ok(stalePlan.markers.includes("read_only_heartbeat_operation"));
assert.ok(stalePlan.markers.includes("inventory_probe_ready"));
assert.ok(stalePlan.markers.includes("publish_bridge_status_ready"));
assert.ok(stalePlan.commands.available.includes("pnpm okx:current-readiness:heartbeat:execute"));
assert.ok(stalePlan.commands.available.includes("pnpm okx:current-readiness:refresh"));
assert.ok(stalePlan.commands.notExecuted.includes("GET /api/v5/trade/order"));
assert.ok(stalePlan.commands.notExecuted.includes("POST /api/v5/trade/order"));
assert.ok(stalePlan.commands.notExecuted.includes("POST /api/v5/trade/cancel-order"));
assert.ok(stalePlan.commands.forbidden.includes("POST /api/v5/trade/order"));
assert.ok(stalePlan.commands.forbidden.includes("POST /api/v5/trade/cancel-order"));
assert.equal(stalePlan.nextSafeTask, OKX_HEARTBEAT_NEXT_SAFE_TASK);

const executePlan = await buildOkxCurrentReadinessHeartbeatOperation({
  execute: true,
  skipRun: true,
  currentReadiness: staleCurrentReadiness,
  refreshWorkflow,
  inventoryProbe,
  publishBridgeStatus,
  now: new Date("2026-05-24T20:13:00.000Z"),
});

assert.equal(executePlan.mode, "heartbeat_execute_read_only_refresh");
assert.equal(executePlan.status, "refresh_available_read_only");
assert.match(executePlan.machineLine, /okxCurrentReadinessHeartbeat=refresh_available/u);
assert.match(executePlan.machineLine, /telegram=sc:tr:okxrefresh/u);
assert.match(executePlan.machineLine, /noOrderWrite=true/u);
assert.equal(executePlan.action.refreshCommand, "pnpm okx:current-readiness:refresh");
assert.equal(executePlan.action.executeCommand, "pnpm okx:current-readiness:heartbeat:execute");
assert.equal(executePlan.action.executeRequired, true);
assert.equal(executePlan.refreshRun, null);
assert.equal(executePlan.safety.heartbeatOnly, false);
assert.equal(executePlan.safety.refreshOnly, true);
assert.equal(executePlan.safety.readOnly, true);
assert.equal(executePlan.safety.noOrderWrite, true);
assert.equal(executePlan.safety.privateOrderQueryEnabled, false);
assert.equal(executePlan.safety.orderPlacementEnabled, false);
assert.equal(executePlan.safety.cancelOrderEnabled, false);
assert.equal(executePlan.safety.withdrawalEnabled, false);
assert.deepEqual(executePlan.commands.executed, []);
assert.ok(executePlan.commands.available.includes("pnpm okx:current-readiness:refresh"));
assert.ok(executePlan.commands.notExecuted.includes("GET /api/v5/trade/order"));
assert.ok(executePlan.commands.notExecuted.includes("POST /api/v5/trade/order"));
assert.ok(executePlan.commands.notExecuted.includes("POST /api/v5/trade/cancel-order"));
assert.ok(executePlan.commands.notExecuted.includes("POST /api/v5/asset/withdrawal"));
assert.ok(executePlan.commands.forbidden.includes("GET /api/v5/trade/order"));
assert.ok(executePlan.commands.forbidden.includes("POST /api/v5/trade/order"));
assert.ok(executePlan.commands.forbidden.includes("POST /api/v5/trade/cancel-order"));
assert.ok(executePlan.commands.forbidden.includes("POST /api/v5/asset/withdrawal"));
assert.equal(executePlan.nextSafeTask, OKX_HEARTBEAT_NEXT_SAFE_TASK);

const readyPlan = await buildOkxCurrentReadinessHeartbeatOperation({
  currentReadiness: readyCurrentReadiness,
  refreshWorkflow,
  inventoryProbe,
  publishBridgeStatus,
  now: new Date("2026-05-24T20:12:00.000Z"),
});

assert.equal(readyPlan.status, "ready_idle_read_only");
assert.equal(readyPlan.code, "okx_current_readiness_heartbeat_ready_idle");
assert.match(readyPlan.machineLine, /okxCurrentReadinessHeartbeat=idle/u);
assert.match(readyPlan.machineLine, /inventoryProbe=ready/u);
assert.match(readyPlan.machineLine, /schedulerNextRunAt=2026-05-24T20:15:00.000Z/u);
assert.equal(readyPlan.blockers.length, 0);
assert.equal(readyPlan.action.executeRequired, false);
assert.equal(readyPlan.refreshRun, null);
assert.equal(readyPlan.reports.inventoryProbe.ready, true);
assert.equal(
  readyPlan.reports.inventoryProbe.publishBridgeStatus.upstreamNoOrderWriteVerified,
  true,
);
assert.equal(readyPlan.reports.inventoryProbe.publishBridgeStatus.upstreamDmadGateVerified, true);
assert.equal(
  readyPlan.reports.inventoryProbe.publishBridgeStatus.upstreamOkxContractVerified,
  true,
);
assert.equal(readyPlan.nextSafeTask, OKX_HEARTBEAT_NEXT_SAFE_TASK);
assert.match(readyPlan.nextSafeTask, /schedulerNextRunAt/u);
assert.match(readyPlan.nextSafeTask, /noOrderWrite=true/u);

process.stdout.write(
  [
    "OKX_CURRENT_READINESS_HEARTBEAT_OPERATION_CHECK=OK",
    `stale=${stalePlan.status}`,
    `execute=${executePlan.mode}/${executePlan.status}`,
    `ready=${readyPlan.status}`,
    `machineLine=${stalePlan.machineLine}`,
    `nextSafeTask=${readyPlan.nextSafeTask}`,
  ].join("\n") + "\n",
);
