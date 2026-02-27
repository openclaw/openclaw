import { describe, expect, it, vi } from "vitest";
import type { DashboardConfig } from "../src/config.js";
import { handleApiRoutes } from "../src/routes-api.js";
import type { SupabaseClient } from "../src/supabase.js";
import { createMockReq, createMockRes } from "./test-helpers.js";

vi.mock("../src/tasks-service.js", () => ({
  serviceListTasks: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  serviceFetchTask: vi.fn().mockResolvedValue(null),
  serviceCreateTask: vi.fn(),
  serviceUpdateTask: vi.fn().mockResolvedValue(null),
  serviceSoftDeleteTask: vi.fn().mockResolvedValue(null),
  serviceRestoreTask: vi.fn().mockResolvedValue(null),
}));

import * as svc from "../src/tasks-service.js";

const config: DashboardConfig = {
  supabaseUrl: "https://test.supabase.co",
  supabaseServiceKey: "service_key",
  dashboardApiKey: "test_api_key",
  webhookSecret: "test_webhook_secret",
  heartbeatOutputFile: "memory/HEARTBEAT.md",
};

const client = {} as SupabaseClient;

describe("handleApiRoutes", () => {
  it("returns false for non-api paths", async () => {
    const req = createMockReq("GET", "/iris-dashboard/health");
    const res = createMockRes();
    const handled = await handleApiRoutes(req, res, config, client);
    expect(handled).toBe(false);
  });

  it("GET /api/tasks returns list", async () => {
    vi.mocked(svc.serviceListTasks).mockResolvedValueOnce({ items: [], total: 0 });
    const req = createMockReq("GET", "/iris-dashboard/api/tasks");
    const res = createMockRes();
    const handled = await handleApiRoutes(req, res, config, client);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res._body);
    expect(json.ok).toBe(true);
    expect(json.data.items).toEqual([]);
  });

  it("POST /api/tasks without auth returns 401", async () => {
    const req = createMockReq(
      "POST",
      "/iris-dashboard/api/tasks",
      {},
      JSON.stringify({ titulo: "X" }),
    );
    const res = createMockRes();
    await handleApiRoutes(req, res, config, client);
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/tasks with auth and valid body creates task", async () => {
    const task = { id: "abc", titulo: "Test", status: "pendente" };
    vi.mocked(svc.serviceCreateTask).mockResolvedValueOnce(task as never);
    const req = createMockReq(
      "POST",
      "/iris-dashboard/api/tasks",
      { "x-iris-dashboard-key": "test_api_key" },
      JSON.stringify({ titulo: "Test" }),
    );
    const res = createMockRes();
    await handleApiRoutes(req, res, config, client);
    expect(res.statusCode).toBe(201);
    const json = JSON.parse(res._body);
    expect(json.ok).toBe(true);
    expect(json.data.task.titulo).toBe("Test");
  });

  it("POST /api/tasks with missing titulo returns 400", async () => {
    const req = createMockReq(
      "POST",
      "/iris-dashboard/api/tasks",
      { "x-iris-dashboard-key": "test_api_key" },
      JSON.stringify({ descricao: "no title" }),
    );
    const res = createMockRes();
    await handleApiRoutes(req, res, config, client);
    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res._body);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /api/tasks/:id returns 404 when not found", async () => {
    vi.mocked(svc.serviceFetchTask).mockResolvedValueOnce(null);
    const req = createMockReq("GET", "/iris-dashboard/api/tasks/nonexistent-id");
    const res = createMockRes();
    await handleApiRoutes(req, res, config, client);
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /api/tasks/:id without auth returns 401", async () => {
    const req = createMockReq("DELETE", "/iris-dashboard/api/tasks/some-id");
    const res = createMockRes();
    await handleApiRoutes(req, res, config, client);
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /api/tasks/:id with auth soft-deletes", async () => {
    vi.mocked(svc.serviceSoftDeleteTask).mockResolvedValueOnce({
      id: "abc",
      deleted_at: "2026-02-27T00:00:00Z",
    });
    const req = createMockReq("DELETE", "/iris-dashboard/api/tasks/abc", {
      "x-iris-dashboard-key": "test_api_key",
    });
    const res = createMockRes();
    await handleApiRoutes(req, res, config, client);
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res._body);
    expect(json.data.id).toBe("abc");
    expect(json.data.deleted_at).toBeTruthy();
  });

  it("POST /api/tasks/:id/restore with auth restores task", async () => {
    const task = { id: "abc", titulo: "Test", deleted_at: null };
    vi.mocked(svc.serviceRestoreTask).mockResolvedValueOnce(task as never);
    const req = createMockReq("POST", "/iris-dashboard/api/tasks/abc/restore", {
      "x-iris-dashboard-key": "test_api_key",
    });
    const res = createMockRes();
    await handleApiRoutes(req, res, config, client);
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res._body);
    expect(json.data.task.deleted_at).toBeNull();
  });
});
