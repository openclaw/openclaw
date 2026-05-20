#!/usr/bin/env node
/**
 * Test connector — emits NDJSON events on stdout for ClaWorks ConnectorManager.
 * Usage: node connectors/echo/echo-bridge.mjs
 */
import { createInterface } from "node:readline";

const connectorId = process.env.CLAWORKS_CONNECTOR_ID ?? "echo";

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

send({ type: "ready", connectorId });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.type === "shutdown") {
    process.exit(0);
  }
  if (msg.type === "invoke" && msg.method === "emit_test_alarm") {
    send({
      type: "event",
      event_type: "alarm.created",
      source: `connector://${connectorId}`,
      payload: {
        alarm_id: `echo-${Date.now()}`,
        mro_alarm_to_wo: true,
        equipment_id: "EQ-ECHO-001",
        priority: "high",
      },
    });
    send({ type: "result", id: msg.id, ok: true });
  }
  if (msg.type === "invoke" && msg.method === "ping") {
    send({ type: "result", id: msg.id, ok: true, result: { pong: true } });
  }
});
