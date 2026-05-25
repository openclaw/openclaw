#!/usr/bin/env node
/**
 * OT connector dry-run — start mqtt-simulate + opcua-simulate via ConnectorManager (no real devices).
 *
 * Usage:
 *   pnpm claworks:ot-dry-run
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function log(msg) {
  console.log(`[ot-dry-run] ${msg}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitReady(manager, id, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const row = manager.list().find((c) => c.id === id);
    if (row?.ready) return row;
    await sleep(100);
  }
  throw new Error(`connector ${id} did not become ready`);
}

async function main() {
  const { ConnectorManager, resolveConnectorConfigs } =
    await import("../packages/claworks-runtime/src/index.ts");

  const configs = resolveConnectorConfigs(
    {
      plant_mqtt: { preset: "mqtt", simulate: true, enabled: true },
      plant_opcua: { preset: "opcua", simulate: true, enabled: true },
    },
    root,
  );

  const manager = new ConnectorManager({
    logger: (m) => log(m),
  });

  try {
    for (const [id, config] of Object.entries(configs)) {
      log(`starting ${id} (${config.command} ${(config.args ?? []).join(" ")})`);
      await manager.start(id, config);
      const status = await waitReady(manager, id);
      log(`${id} ready (${status.command})`);
    }

    const listed = manager.list();
    assert(listed.length === 2, `expected 2 connectors, got ${listed.length}`);
    assert(
      listed.every((c) => c.ready),
      "all simulate connectors must be ready",
    );

    log("ALL OT DRY-RUN CHECKS PASSED");
  } finally {
    await manager.stopAll();
  }
}

main().catch((err) => {
  console.error(`[ot-dry-run] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
