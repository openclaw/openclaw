import { describe, expect, it, vi } from "vitest";
import type { DashboardConfig } from "../src/config.js";
import { handleWebhookRoute } from "../src/routes-webhook.js";
import { createMockReq, createMockRes } from "./test-helpers.js";

const config: DashboardConfig = {
  supabaseUrl: "https://test.supabase.co",
  supabaseServiceKey: "service_key",
  dashboardApiKey: "test_api_key",
  webhookSecret: "test_webhook_secret",
  heartbeatOutputFile: "memory/HEARTBEAT.md",
};

describe("handleWebhookRoute", () => {
  it("returns false for non-webhook paths", async () => {
    const req = createMockReq("POST", "/iris-dashboard/api/tasks");
    const res = createMockRes();
    const handled = await handleWebhookRoute(req, res, config);
    expect(handled).toBe(false);
  });

  it("returns 405 for non-POST", async () => {
    const req = createMockReq("GET", "/iris-dashboard/webhook/tasks", {
      "x-iris-webhook-secret": "test_webhook_secret",
    });
    const res = createMockRes();
    await handleWebhookRoute(req, res, config);
    expect(res.statusCode).toBe(405);
  });

  it("returns 401 for missing secret", async () => {
    const body = JSON.stringify({ type: "UPDATE", table: "tasks", record: {}, old_record: {} });
    const req = createMockReq("POST", "/iris-dashboard/webhook/tasks", {}, body);
    const res = createMockRes();
    await handleWebhookRoute(req, res, config);
    expect(res.statusCode).toBe(401);
  });

  it("ignores non-tasks tables", async () => {
    const body = JSON.stringify({ type: "UPDATE", table: "other", record: {}, old_record: {} });
    const req = createMockReq(
      "POST",
      "/iris-dashboard/webhook/tasks",
      {
        "x-iris-webhook-secret": "test_webhook_secret",
      },
      body,
    );
    const res = createMockRes();
    await handleWebhookRoute(req, res, config);
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res._body);
    expect(json.data.ignored).toBe(true);
  });

  it("ignores non-completion transitions", async () => {
    const body = JSON.stringify({
      type: "UPDATE",
      table: "tasks",
      record: { id: "abc", status: "em_andamento" },
      old_record: { id: "abc", status: "pendente" },
    });
    const req = createMockReq(
      "POST",
      "/iris-dashboard/webhook/tasks",
      {
        "x-iris-webhook-secret": "test_webhook_secret",
      },
      body,
    );
    const res = createMockRes();
    await handleWebhookRoute(req, res, config);
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res._body);
    expect(json.data.ignored).toBe(true);
  });

  it("fires callback and returns 202 on completion transition", async () => {
    const body = JSON.stringify({
      type: "UPDATE",
      table: "tasks",
      record: { id: "abc", status: "concluido" },
      old_record: { id: "abc", status: "em_andamento" },
    });
    const req = createMockReq(
      "POST",
      "/iris-dashboard/webhook/tasks",
      {
        "x-iris-webhook-secret": "test_webhook_secret",
      },
      body,
    );
    const res = createMockRes();
    const onCompleted = vi.fn().mockResolvedValue(undefined);
    await handleWebhookRoute(req, res, config, onCompleted);
    expect(res.statusCode).toBe(202);
    const json = JSON.parse(res._body);
    expect(json.data.accepted).toBe(true);
    // Allow async callback to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(onCompleted).toHaveBeenCalledWith("abc");
  });

  it("ignores already-done tasks (was concluido, still concluido)", async () => {
    const body = JSON.stringify({
      type: "UPDATE",
      table: "tasks",
      record: { id: "abc", status: "concluido" },
      old_record: { id: "abc", status: "concluido" },
    });
    const req = createMockReq(
      "POST",
      "/iris-dashboard/webhook/tasks",
      {
        "x-iris-webhook-secret": "test_webhook_secret",
      },
      body,
    );
    const res = createMockRes();
    await handleWebhookRoute(req, res, config);
    const json = JSON.parse(res._body);
    expect(json.data.ignored).toBe(true);
  });
});
