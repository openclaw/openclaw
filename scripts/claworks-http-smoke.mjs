#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
/**
 * In-process HTTP smoke — REST + A2A + IM bridge without full OpenClaw Gateway.
 *
 * Usage:
 *   node --import tsx scripts/claworks-http-smoke.mjs
 */
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packsDir = process.env.CLAWORKS_PACKS_DIR?.trim() || path.join(root, "..", "claworks-packs");

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function log(msg) {
  console.log(`[http-smoke] ${msg}`);
}

async function main() {
  const {
    createClaworksRuntime,
    startClaworksRuntime,
    stopClaworksRuntime,
    createClaworksRestHandler,
    createA2aHttpHandler,
  } = await import("../packages/claworks-runtime/src/index.ts");

  const stateDir = mkdtempSync(path.join(tmpdir(), "claworks-http-"));
  const runtime = await createClaworksRuntime(
    {
      robot: { name: "http-smoke", role: "monolith", port: 18_801, host: "127.0.0.1" },
      data: { database_url: `sqlite://${path.join(stateDir, "robot.db")}` },
      a2a: { peers: [{ name: "demo-peer", url: "http://127.0.0.1:8001" }] },
      packs: {
        paths: [packsDir],
        installed: ["base", "process-industry"],
      },
    },
    {
      logger: (m) => log(m),
      llmComplete: async () => ({
        text: JSON.stringify({ intent: "none", confidence: 0.2, extracted: {} }),
      }),
    },
  );
  await startClaworksRuntime(runtime);

  const rest = createClaworksRestHandler(runtime);
  const a2a = createA2aHttpHandler({ runtime });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/a2a")) {
        req.url = url.pathname + url.search;
        if (await a2a(req, res)) {
          return;
        }
      }
      if (url.pathname.startsWith("/v1")) {
        req.url = url.pathname + url.search;
        if (await rest(req, res)) {
          return;
        }
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  log(`listening ${base}`);

  async function jfetch(pathname, init) {
    const res = await fetch(`${base}${pathname}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      throw new Error(
        `${init?.method ?? "GET"} ${pathname} → ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    return body;
  }

  const health = await jfetch("/v1/health");
  assert(health.status === "ok" || health.status === "degraded", `health=${health.status}`);
  log(`health OK (${health.status})`);

  const identity = await jfetch("/v1/identity");
  assert(identity.name === "http-smoke", "identity name mismatch");
  log(`identity OK (${identity.name})`);

  const bridge = await jfetch("/v1/bridge/im", {
    method: "POST",
    headers: { "X-ClaWorks-Channel-User": "feishu:demo-user" },
    body: JSON.stringify({
      channel: "feishu",
      message_id: `http-${Date.now()}`,
      user_id: "demo-user",
      text: "测试 IM 意图路由",
    }),
  });
  assert(
    bridge.action === "intent_routed" || bridge.action === "published",
    `im bridge action=${bridge.action}`,
  );
  log(`bridge/im OK action=${bridge.action}`);

  const webhook = await jfetch("/v1/bridge/webhook", {
    method: "POST",
    headers: { "X-ClaWorks-Channel-User": "webhook:mes" },
    body: JSON.stringify({
      source: "mes",
      webhook_id: `wh-${Date.now()}`,
      body: { alarm_code: "HTTP_SMOKE", equipment_id: "eq-wh" },
    }),
  });
  assert(
    webhook.action === "intent_routed" || webhook.action === "published",
    `webhook bridge action=${webhook.action}`,
  );
  log(`bridge/webhook OK action=${webhook.action}`);

  const rbacReload = await jfetch("/v1/rbac/reload", { method: "POST" });
  assert(rbacReload.status === "ok", "rbac reload failed");
  log("POST /v1/rbac/reload OK");

  const ev = await jfetch("/v1/events", {
    method: "POST",
    body: JSON.stringify({
      type: "alarm.created",
      payload: { mro_alarm_to_wo: true, alarm_id: "http-1", equipment_id: "eq-1" },
    }),
  });
  assert(Array.isArray(ev.matched_playbooks), "events response missing matched_playbooks");
  log(`POST /v1/events OK matched=${ev.matched_playbooks.join(",") || "(none)"}`);

  const a2aRes = await jfetch("/a2a/tasks/send", {
    method: "POST",
    headers: { "X-ClaWorks-Peer": "demo-peer" },
    body: JSON.stringify({
      message: { role: "user", parts: [{ type: "text", text: "alarm probe" }] },
      metadata: {
        peer_id: "demo-peer",
        event_type: "alarm.created",
        payload: { mro_alarm_to_wo: true, alarm_id: "a2a-http-1", equipment_id: "eq-a2a" },
      },
    }),
  });
  assert(a2aRes.id, "A2A task missing id");
  for (let i = 0; i < 40; i++) {
    const task = await jfetch(`/a2a/tasks/${a2aRes.id}`);
    if (task.status === "completed" || task.status === "failed") {
      assert(task.status === "completed", `A2A task failed: ${task.error ?? "unknown"}`);
      log(`A2A tasks/send OK task=${task.id}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  await stopClaworksRuntime(runtime);
  server.close();
  log("ALL HTTP SMOKE CHECKS PASSED");
}

main().catch((err) => {
  console.error("[http-smoke] FAILED", err);
  process.exit(1);
});
