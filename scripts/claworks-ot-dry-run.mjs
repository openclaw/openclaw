#!/usr/bin/env node
/**
 * OT connector dry-run — start mqtt-simulate + opcua-simulate via ConnectorManager (no live OT).
 *
 * Usage:
 *   pnpm claworks:ot-dry-run
 *
 * Env:
 *   CLAWORKS_ROOT — repo root (default: parent of scripts/)
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.CLAWORKS_ROOT = process.env.CLAWORKS_ROOT?.trim() || root;

function log(msg) {
  console.log(`[ot-dry-run] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(manager, ids, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const statuses = manager.list();
    if (ids.every((id) => statuses.find((s) => s.id === id)?.ready)) {
      return statuses;
    }
    await sleep(100);
  }
  throw new Error(`connectors not ready within ${deadlineMs}ms: ${JSON.stringify(manager.list())}`);
}

async function main() {
  const { ConnectorManager } =
    await import("../packages/claworks-runtime/src/interfaces/connectors/connector-manager.ts");
  const { resolveConnectorConfigs } =
    await import("../packages/claworks-runtime/src/interfaces/connectors/presets.ts");

  const configs = resolveConnectorConfigs({
    mqtt: { preset: "mqtt", simulate: true, enabled: true },
    opcua: { preset: "opcua", simulate: true, enabled: true },
  });

  const manager = new ConnectorManager({ logger: (msg) => log(msg) });
  const ids = Object.keys(configs);

  try {
    for (const [id, cfg] of Object.entries(configs)) {
      await manager.start(id, cfg);
      log(`started ${id}`);
    }

    const statuses = await waitForReady(manager, ids);
    log(`ready: ${statuses.map((s) => `${s.id}=ok`).join(", ")}`);

    const mqttStart = await manager.invoke("mqtt", "start", { simulate: true });
    log(`mqtt start → ${JSON.stringify(mqttStart)}`);

    const opcuaConnect = await manager.invoke("opcua", "connect");
    log(`opcua connect → ${JSON.stringify(opcuaConnect)}`);

    const opcuaAlarm = await manager.invoke("opcua", "simulate_alarm");
    log(`opcua simulate_alarm → ${JSON.stringify(opcuaAlarm)}`);

    const mqttMsg = await manager.invoke("mqtt", "simulate_message");
    log(`mqtt simulate_message → ${JSON.stringify(mqttMsg)}`);

    log("ALL OT DRY-RUN CHECKS PASSED");
  } finally {
    await manager.stopAll();
  }
}

main().catch((err) => {
  console.error("[ot-dry-run] FAILED", err);
  process.exit(1);
});
