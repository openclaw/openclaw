import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createA2aHttpHandler,
  createClaworksRestHandler,
  createClaworksRuntime,
  startClaworksRuntime,
  stopClaworksRuntime,
} from "../../index.js";

describe("ClaWorks HTTP integration", () => {
  let server: Server | null = null;
  let baseUrl = "";
  let runtime: Awaited<ReturnType<typeof createClaworksRuntime>> | null = null;

  afterEach(async () => {
    if (runtime) {
      await stopClaworksRuntime(runtime);
      runtime = null;
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("serves health, IM bridge intent_route, events, and A2A", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claworks-http-it-"));
    runtime = await createClaworksRuntime(
      {
        robot: { name: "http-it", role: "monolith" },
        data: { database_url: `sqlite://${join(dir, "test.db")}` },
        a2a: { peers: [{ name: "peer-a", url: "http://127.0.0.1:9001" }] },
        packs: {
          paths: [join(process.cwd(), "../claworks-packs")],
          installed: ["base", "process-industry"],
        },
      },
      {
        llmComplete: async () => ({
          text: JSON.stringify({ intent: "none", confidence: 0.1, extracted: {} }),
        }),
      },
    );
    await startClaworksRuntime(runtime);

    const rest = createClaworksRestHandler(runtime);
    const a2a = createA2aHttpHandler({ runtime });

    server = createServer(async (req, res) => {
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
      res.end("{}");
    });

    await new Promise<void>((resolve, reject) => {
      server!.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });
    const addr = server!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    const health = await fetch(`${baseUrl}/v1/health`).then((r) => r.json());
    expect(health.status).toMatch(/ok|degraded/);

    const bridge = await fetch(`${baseUrl}/v1/bridge/im`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ClaWorks-Channel-User": "feishu:u1",
      },
      body: JSON.stringify({
        channel: "feishu",
        message_id: "it-1",
        user_id: "u1",
        text: "测试",
      }),
    }).then((r) => r.json());
    expect(bridge.action).toBe("intent_routed");

    const ev = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "alarm.created",
        payload: { mro_alarm_to_wo: true, alarm_id: "it-al-1", equipment_id: "eq-1" },
      }),
    }).then((r) => r.json());
    expect(ev.matched_playbooks).toContain("mro_alarm_to_workorder");

    const task = await fetch(`${baseUrl}/a2a/tasks/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ClaWorks-Peer": "peer-a" },
      body: JSON.stringify({
        message: { role: "user", parts: [{ type: "text", text: "probe" }] },
        metadata: {
          peer_id: "peer-a",
          event_type: "alarm.created",
          payload: { mro_alarm_to_wo: true, alarm_id: "it-a2a-1", equipment_id: "eq-a2a" },
        },
      }),
    }).then((r) => r.json());

    let status = task.status;
    for (let i = 0; i < 40 && status !== "completed" && status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const row = await fetch(`${baseUrl}/a2a/tasks/${task.id}`).then((r) => r.json());
      status = row.status;
    }
    expect(status).toBe("completed");
  });
});
