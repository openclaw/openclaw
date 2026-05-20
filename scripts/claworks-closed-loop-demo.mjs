#!/usr/bin/env node
/**
 * Live business closed-loop demo against a running Gateway (default 18800).
 * Exercises REST: health → event → workorders → optional connector invoke.
 */
const port = process.env.CLAWORKS_GATEWAY_PORT || "18800";
const base = `http://127.0.0.1:${port}`;
const apiKey = process.env.CLAWORKS_API_KEY?.trim();

function headers() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) {
    h.Authorization = `Bearer ${apiKey}`;
  }
  return h;
}

async function jfetch(path, init) {
  let res;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers: headers() });
  } catch (err) {
    const cause = err && typeof err === "object" && "cause" in err ? err.cause : err;
    if (cause && typeof cause === "object" && cause.code === "ECONNREFUSED") {
      console.error(
        `[closed-loop] Gateway not reachable at ${base}. Start it first:\n` +
          "  pnpm claworks:init && pnpm claworks:gateway",
      );
      process.exit(2);
    }
    throw err;
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return body;
}

function log(msg) {
  console.log(`[closed-loop] ${msg}`);
}

log(`gateway ${base}`);
const health = await jfetch("/v1/health");
log(`health status=${health.status} robot=${health.robot}`);

// ── 新端点：GET /v1/identity ─────────────────────────────────────────────
try {
  const identity = await jfetch("/v1/identity");
  log(
    `identity name=${identity.name} role=${identity.role} rules=${(identity.rules ?? []).length}`,
  );
} catch (err) {
  log(`identity skip: ${err instanceof Error ? err.message : String(err)}`);
}

// ── 新端点：POST /v1/bridge/im ───────────────────────────────────────────
try {
  const bridge = await jfetch("/v1/bridge/im", {
    method: "POST",
    body: JSON.stringify({
      channel: "feishu",
      message_id: `demo-msg-${Date.now()}`,
      user_id: "demo-user-001",
      text: "泵 pump-001 今天振动有点大，需要检查一下吗？",
      group_id: "g-ops-team",
    }),
  });
  if (bridge.action === "intent_routed") {
    log(
      `im-bridge intent_routed playbook=${bridge.playbook_id} run=${bridge.run_id} status=${bridge.status}`,
    );
  } else if (bridge.action === "published") {
    log(
      `im-bridge published event=${bridge.event_type ?? bridge.eventType ?? "-"} matched=${(bridge.matched_playbooks ?? bridge.matchedPlaybooks ?? []).join(",") || "(none)"}`,
    );
  } else {
    log(`im-bridge action=${bridge.action}`);
  }
} catch (err) {
  log(`im-bridge skip: ${err instanceof Error ? err.message : String(err)}`);
}

// ── A2A peer（需 config.a2a.peers 含 demo-peer）────────────────────────────
try {
  const a2aTask = await jfetch("/a2a/tasks/send", {
    method: "POST",
    headers: { "X-ClaWorks-Peer": "demo-peer" },
    body: JSON.stringify({
      message: { role: "user", parts: [{ type: "text", text: "closed-loop a2a probe" }] },
      metadata: {
        peer_id: "demo-peer",
        event_type: "alarm.created",
        payload: { mro_alarm_to_wo: true, alarm_id: "demo-a2a-1", equipment_id: "eq-demo" },
      },
    }),
  });
  log(`a2a task submitted id=${a2aTask.id} status=${a2aTask.status}`);
} catch (err) {
  log(`a2a skip: ${err instanceof Error ? err.message : String(err)}`);
}

const ev = await jfetch("/v1/events", {
  method: "POST",
  body: JSON.stringify({
    type: "alarm.created",
    source: "closed-loop-demo",
    payload: {
      priority: "P1",
      alarm_id: "demo-al-1",
      equipment_id: "demo-pump",
      reading_values: { vibration: 3.1 },
    },
  }),
});
log(`alarm.created matched: ${(ev.matched_playbooks ?? []).join(", ") || "(none)"}`);

const wo = await jfetch("/v1/objects/WorkOrder?limit=5");
log(`WorkOrders: ${(wo.items ?? []).length}`);

try {
  const connectors = await jfetch("/v1/connectors");
  const echo = (connectors.connectors ?? []).find((c) => c.id === "echo");
  if (echo) {
    await jfetch("/v1/connectors/echo/invoke", {
      method: "POST",
      body: JSON.stringify({ method: "emit_test_alarm", params: {} }),
    });
    log("echo connector emit_test_alarm OK");
  }
} catch (err) {
  log(`connector skip: ${err instanceof Error ? err.message : String(err)}`);
}

const reload = await jfetch("/v1/playbooks/reload_packs_and_notify/runs", {
  method: "POST",
  body: JSON.stringify({ input: { tenant_id: "closed-loop" } }),
});
log(`reload_packs run status=${reload.status ?? reload.run_id ?? "ok"}`);
log("DONE — see Studio /v1/playbooks/*/runs for details");
