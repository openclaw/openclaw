import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorManager } from "./connector-manager.js";

const echoBridge = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../connectors/echo/echo-bridge.mjs",
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ConnectorManager", () => {
  let manager: ConnectorManager;

  afterEach(async () => {
    if (manager) {
      await manager.stopAll();
    }
  });

  it("forwards connector events to handler", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    manager = new ConnectorManager({
      onEvent: async (ev) => {
        events.push({ type: ev.type, payload: ev.payload });
      },
    });

    await manager.start("echo", {
      command: process.execPath,
      args: [echoBridge],
    });

    for (let i = 0; i < 20; i++) {
      const status = manager.list();
      if (status[0]?.ready) {
        break;
      }
      await sleep(50);
    }

    expect(manager.list()[0]?.ready).toBe(true);

    await manager.invoke("echo", "emit_test_alarm");

    for (let i = 0; i < 20; i++) {
      if (events.length > 0) {
        break;
      }
      await sleep(50);
    }

    expect(events[0]?.type).toBe("alarm.created");
    expect(events[0]?.payload.mro_alarm_to_wo).toBe(true);
  });

  it("returns invoke result from connector", async () => {
    manager = new ConnectorManager();
    await manager.start("echo", {
      command: process.execPath,
      args: [echoBridge],
    });

    for (let i = 0; i < 20; i++) {
      if (manager.list()[0]?.ready) {
        break;
      }
      await sleep(50);
    }

    const result = await manager.invoke("echo", "ping");
    expect(result).toEqual({ pong: true });
  });
});
