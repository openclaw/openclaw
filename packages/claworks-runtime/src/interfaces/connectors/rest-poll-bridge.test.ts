import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConnectorManager } from "./connector-manager.js";
import { getConnectorPreset } from "./presets.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const bridgePath = join(root, "connectors/rest-poll/rest-poll-bridge.mjs");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("rest-poll connector bridge", () => {
  it("emits events when HTTP payload changes", async () => {
    let payload = { value: 1 };
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/`;

    const events: Array<{ type: string }> = [];
    const manager = new ConnectorManager({
      onEvent: async (ev) => {
        events.push({ type: ev.type });
      },
    });

    const preset = getConnectorPreset("rest-poll", root)!;
    await manager.start("poll", {
      ...preset,
      command: process.execPath,
      args: [bridgePath],
    });

    for (let i = 0; i < 20; i++) {
      if (manager.list()[0]?.ready) {
        break;
      }
      await sleep(50);
    }

    await manager.invoke("poll", "start", { url, interval_ms: 1000, event_type: "sensor.reading" });
    payload = { value: 2 };
    await manager.invoke("poll", "poll_once");

    for (let i = 0; i < 20; i++) {
      if (events.length > 0) {
        break;
      }
      await sleep(100);
    }

    await manager.stopAll();
    server.close();

    expect(events[0]?.type).toBe("sensor.reading");
  }, 15_000);
});
