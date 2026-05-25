import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorManager } from "./connector-manager.js";
import { resolveConnectorConfigs } from "./presets.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../../");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(manager: ConnectorManager, ids: string[], deadlineMs = 20_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const statuses = manager.list();
    if (ids.every((id) => statuses.find((s) => s.id === id)?.ready)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`connectors not ready: ${JSON.stringify(manager.list())}`);
}

describe("OT connectors simulate dry-run", () => {
  let manager: ConnectorManager;

  afterEach(async () => {
    if (manager) {
      await manager.stopAll();
    }
  });

  it("starts mqtt/opcua/modbus simulate presets and invokes methods", async () => {
    const configs = resolveConnectorConfigs(
      {
        mqtt: { preset: "mqtt", simulate: true, enabled: true },
        opcua: { preset: "opcua", simulate: true, enabled: true },
        modbus: { preset: "modbus", simulate: true, enabled: true },
      },
      root,
    );
    manager = new ConnectorManager();
    const ids = Object.keys(configs);
    for (const [id, cfg] of Object.entries(configs)) {
      await manager.start(id, cfg);
    }
    await waitForReady(manager, ids);

    const mqtt = await manager.invoke("mqtt", "simulate_message");
    expect(mqtt).toBeTruthy();

    const opcua = await manager.invoke("opcua", "simulate_alarm");
    expect(opcua).toBeTruthy();

    const modbus = await manager.invoke("modbus", "read_holding", { address: 0, count: 1 });
    expect(modbus).toBeTruthy();
  }, 30_000);
});
