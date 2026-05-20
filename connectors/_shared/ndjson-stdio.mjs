/**
 * Shared NDJSON stdio helpers for ClaWorks connector child processes.
 */
import { createInterface } from "node:readline";

export function createNdjsonBridge() {
  const connectorId = process.env.CLAWORKS_CONNECTOR_ID ?? "connector";

  function send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  function emitEvent({ event_type, source, payload, correlation_id }) {
    send({
      type: "event",
      event_type,
      source: source ?? `connector://${connectorId}`,
      payload: payload ?? {},
      ...(correlation_id ? { correlation_id } : {}),
    });
  }

  function log(message, level = "info") {
    send({ type: "log", level, message });
  }

  function result(id, ok, result, error) {
    send({
      type: "result",
      id,
      ok,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
    });
  }

  function onReady(extra = {}) {
    send({ type: "ready", connectorId, ...extra });
  }

  function listen(onInvoke) {
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
      if (msg.type === "invoke") {
        void Promise.resolve(onInvoke(msg)).catch((err) => {
          result(msg.id, false, undefined, err instanceof Error ? err.message : String(err));
        });
      }
    });
  }

  return { connectorId, send, emitEvent, log, result, onReady, listen };
}
