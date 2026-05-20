#!/usr/bin/env node
/**
 * MQTT subscribe connector — forwards broker messages to ClaWorks events.
 *
 * Env: CLAWORKS_MQTT_URL, CLAWORKS_MQTT_TOPIC, CLAWORKS_MQTT_EVENT_TYPE, CLAWORKS_MQTT_SIMULATE=1
 * Optional: install `mqtt` package for live broker mode.
 * Invoke: start { url?, topic?, event_type? }, stop, simulate_message { payload? }
 */
import { createNdjsonBridge } from "../_shared/ndjson-stdio.mjs";

const bridge = createNdjsonBridge();
const state = {
  client: null,
  simulateTimer: null,
  topic: "claworks/alarms/#",
  eventType: "alarm.created",
  url: "mqtt://127.0.0.1:1883",
};

function parseMqttPayload(raw) {
  const text = raw.toString("utf8");
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
  } catch {
    return { raw: text };
  }
}

function forwardMessage(topic, payloadBuf) {
  const payload = parseMqttPayload(payloadBuf);
  bridge.emitEvent({
    event_type: state.eventType,
    source: `mqtt://${state.url}/${topic}`,
    payload: {
      topic,
      ...payload,
    },
  });
}

async function loadMqttClient() {
  try {
    const mod = await import("mqtt");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function startLive(msg) {
  const mqtt = await loadMqttClient();
  if (!mqtt) {
    bridge.result(
      msg.id,
      false,
      undefined,
      "mqtt package not installed — set CLAWORKS_MQTT_SIMULATE=1 or npm install mqtt",
    );
    return;
  }
  state.url = String(msg.params?.url ?? process.env.CLAWORKS_MQTT_URL ?? state.url);
  state.topic = String(msg.params?.topic ?? process.env.CLAWORKS_MQTT_TOPIC ?? state.topic);
  state.eventType = String(
    msg.params?.event_type ?? process.env.CLAWORKS_MQTT_EVENT_TYPE ?? state.eventType,
  );

  await new Promise((resolve, reject) => {
    state.client = mqtt.connect(state.url);
    state.client.on("connect", () => {
      state.client.subscribe(state.topic, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    state.client.on("message", (topic, payload) => {
      forwardMessage(topic, payload);
    });
    state.client.on("error", reject);
  });

  bridge.result(msg.id, true, { mode: "live", url: state.url, topic: state.topic });
}

function startSimulate(msg) {
  state.topic = String(msg.params?.topic ?? process.env.CLAWORKS_MQTT_TOPIC ?? state.topic);
  state.eventType = String(
    msg.params?.event_type ?? process.env.CLAWORKS_MQTT_EVENT_TYPE ?? state.eventType,
  );
  if (state.simulateTimer) {
    clearInterval(state.simulateTimer);
  }
  state.simulateTimer = setInterval(
    () => {
      forwardMessage(
        state.topic,
        Buffer.from(
          JSON.stringify({
            alarm_id: `mqtt-sim-${Date.now()}`,
            mro_alarm_to_wo: true,
            equipment_id: "EQ-MQTT-SIM",
            priority: "medium",
          }),
        ),
      );
    },
    Number(msg.params?.interval_ms ?? 30_000),
  );
  bridge.result(msg.id, true, { mode: "simulate", topic: state.topic });
}

bridge.onReady({ connector: "mqtt" });

bridge.listen(async (msg) => {
  if (msg.method === "start") {
    const simulate = process.env.CLAWORKS_MQTT_SIMULATE === "1" || msg.params?.simulate === true;
    if (simulate) {
      startSimulate(msg);
    } else {
      await startLive(msg);
    }
    return;
  }

  if (msg.method === "stop") {
    if (state.simulateTimer) {
      clearInterval(state.simulateTimer);
      state.simulateTimer = null;
    }
    if (state.client) {
      state.client.end(true);
      state.client = null;
    }
    bridge.result(msg.id, true, { stopped: true });
    return;
  }

  if (msg.method === "simulate_message") {
    const topic = String(msg.params?.topic ?? state.topic);
    const payload = msg.params?.payload ?? {
      alarm_id: `mqtt-manual-${Date.now()}`,
      mro_alarm_to_wo: true,
    };
    forwardMessage(topic, Buffer.from(JSON.stringify(payload)));
    bridge.result(msg.id, true, { emitted: true });
    return;
  }

  bridge.result(msg.id, false, undefined, `unknown method: ${msg.method}`);
});

process.on("SIGTERM", () => process.exit(0));
