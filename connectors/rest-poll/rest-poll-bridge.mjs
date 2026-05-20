#!/usr/bin/env node
/**
 * HTTP REST polling connector — emits events when polled JSON body changes.
 *
 * Env: CLAWORKS_REST_POLL_URL, CLAWORKS_REST_POLL_INTERVAL_MS, CLAWORKS_REST_POLL_EVENT_TYPE
 * Invoke: start { url?, interval_ms?, event_type? }, stop, poll_once
 */
import { createHash } from "node:crypto";
import { createNdjsonBridge } from "../_shared/ndjson-stdio.mjs";

const bridge = createNdjsonBridge();
const state = {
  timer: null,
  lastHash: null,
  url: null,
  intervalMs: 5000,
  eventType: "sensor.reading",
};

async function pollOnce(force = false) {
  if (!state.url) {
    throw new Error("poll not configured — invoke start first");
  }
  const res = await fetch(state.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json();
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const changed = force || hash !== state.lastHash;
  if (changed) {
    state.lastHash = hash;
    bridge.emitEvent({
      event_type: state.eventType,
      source: `rest-poll://${state.url}`,
      payload: typeof body === "object" && body !== null ? body : { value: body },
    });
  }
  return { hash, changed };
}

bridge.onReady({ connector: "rest-poll" });

bridge.listen(async (msg) => {
  if (msg.method === "start") {
    state.url = String(msg.params?.url ?? process.env.CLAWORKS_REST_POLL_URL ?? "");
    if (!state.url) {
      bridge.result(msg.id, false, undefined, "url is required");
      return;
    }
    state.intervalMs = Number(
      msg.params?.interval_ms ?? process.env.CLAWORKS_REST_POLL_INTERVAL_MS ?? 5000,
    );
    state.eventType = String(
      msg.params?.event_type ?? process.env.CLAWORKS_REST_POLL_EVENT_TYPE ?? "sensor.reading",
    );
    if (state.timer) {
      clearInterval(state.timer);
    }
    state.timer = setInterval(
      () => {
        void pollOnce().catch((err) => {
          bridge.log(`poll failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
        });
      },
      Math.max(1000, state.intervalMs),
    );
    bridge.result(msg.id, true, { started: true, url: state.url, interval_ms: state.intervalMs });
    return;
  }

  if (msg.method === "stop") {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    bridge.result(msg.id, true, { stopped: true });
    return;
  }

  if (msg.method === "poll_once") {
    const out = await pollOnce(true);
    bridge.result(msg.id, true, out);
    return;
  }

  bridge.result(msg.id, false, undefined, `unknown method: ${msg.method}`);
});

process.on("SIGTERM", () => process.exit(0));
