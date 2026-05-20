import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createClaworksRuntime,
  startClaworksRuntime,
  stopClaworksRuntime,
} from "../../claworks/runtime.js";
import { createA2aHttpHandler } from "./task-handler.js";
import { A2aTaskStore } from "./task-store.js";

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) {
        yield Buffer.from(JSON.stringify(body));
      }
    },
  } as IncomingMessage;
}

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 200,
    body: "",
    setHeader() {},
    end(chunk: string) {
      this.body = chunk;
    },
  } as ServerResponse & { statusCode: number; body: string };
  return res;
}

describe("createA2aHttpHandler", () => {
  it("publishes event from A2A task send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claworks-a2a-"));
    const runtime = await createClaworksRuntime({
      data: { database_url: `sqlite://${join(dir, "test.db")}` },
      a2a: {
        peers: [{ name: "test-peer", url: "http://127.0.0.1:8001" }],
      },
      packs: {
        paths: [join(process.cwd(), "../claworks-packs")],
        installed: ["base", "process-industry"],
      },
    });
    await startClaworksRuntime(runtime);

    const store = new A2aTaskStore();
    const handler = createA2aHttpHandler({ runtime, store });

    const req = mockReq("POST", "/a2a/tasks/send", {
      message: { role: "user", parts: [{ type: "text", text: "test alarm" }] },
      metadata: {
        peer_id: "test-peer",
        event_type: "alarm.created",
        payload: { mro_alarm_to_wo: true, alarm_id: "a2a-1" },
      },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(202);

    const taskId = (JSON.parse(res.body) as { id: string }).id;
    for (let i = 0; i < 30; i++) {
      const task = store.get(taskId);
      if (task?.status === "completed" || task?.status === "failed") {
        expect(task.status).toBe("completed");
        expect(task.result?.matched_playbooks).toEqual(
          expect.arrayContaining(["mro_alarm_to_workorder"]),
        );
        await stopClaworksRuntime(runtime);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("A2A task did not complete");
  });
});
