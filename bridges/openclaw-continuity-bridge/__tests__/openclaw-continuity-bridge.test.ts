import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCallerInstanceCache } from "../proxy.js";

const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const MEMORY_ID_2 = "22222222-2222-4222-8222-222222222222";
const EXPECTED_TOOLS = [
  "continuity_linkage_read",
  "continuity_receipt_read",
  "continuity_write",
  "engine_get_foreman_state",
  "engine_get_run",
  "engine_list_runs",
  "hq_health",
  "linked_session_observe",
  "memory_context",
  "memory_list",
  "memory_read",
  "memory_search",
  "workstream_check_in",
  "workstream_message_poll",
  "workstream_message_send",
] as const;
const STEERING_CASES = ["direct_steerable", "self_loop_only", "human_relay_only"] as const;

type BridgeModule = {
  createContinuityBridgeApp: (options?: {
    allowedTools?: readonly string[];
    memoryReadToolOptions?: {
      db: Database.Database;
    };
    engineToolOptions?: {
      db: Database.Database;
      homeDir: string;
    };
    logger?: (line: string) => void;
    requestIdFactory?: () => string;
  }) => {
    handle(request: Request): Promise<Response>;
  };
  createContinuityBridgeServer: (options?: {
    host?: string;
    port?: number;
    bodySizeLimitBytes?: number;
    memoryReadToolOptions?: {
      db: Database.Database;
    };
    engineToolOptions?: {
      db: Database.Database;
      homeDir: string;
    };
    logger?: (line: string) => void;
    requestIdFactory?: () => string;
  }) => Server;
};

type BridgeApp = ReturnType<BridgeModule["createContinuityBridgeApp"]>;

let db: Database.Database;
let homeDir: string;

async function loadBridgeModule(): Promise<BridgeModule> {
  const loaded = await import("../openclaw-continuity-bridge.js").catch((error: unknown) => ({
    error,
  }));
  expect((loaded as { error?: unknown }).error).toBeUndefined();
  expect(typeof (loaded as Partial<BridgeModule>).createContinuityBridgeApp).toBe("function");
  return loaded as BridgeModule;
}

async function requestJson(request: Request): Promise<{ status: number; body: unknown }> {
  return requestJsonWithOptions(request, {});
}

async function createTestBridge(
  options: {
    fetchFn?: typeof fetch;
    logger?: (line: string) => void;
    requestIdFactory?: () => string;
  } = {},
): Promise<BridgeApp> {
  const bridge = await loadBridgeModule();
  return bridge.createContinuityBridgeApp({
    memoryReadToolOptions: { db },
    engineToolOptions: { db, homeDir },
    logger: options.logger,
    requestIdFactory: options.requestIdFactory,
    proxyConfig: options.fetchFn
      ? {
          hqBaseUrl: "http://localhost:3000",
          apiSecret: "test-secret",
          workspaceId: DEFAULT_WORKSPACE_ID,
          fetchFn: options.fetchFn,
          retryDelayMs: 0,
        }
      : undefined,
  });
}

async function requestJsonWithOptions(
  request: Request,
  options: {
    fetchFn?: typeof fetch;
    logger?: (line: string) => void;
    requestIdFactory?: () => string;
  },
): Promise<{ status: number; body: unknown }> {
  const app = await createTestBridge(options);
  const response = await app.handle(request);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function startTestServer(
  options: {
    logger?: (line: string) => void;
    requestIdFactory?: () => string;
    bodySizeLimitBytes?: number;
  } = {},
): Promise<{ server: Server; baseUrl: string }> {
  const bridge = await loadBridgeModule();
  const server = bridge.createContinuityBridgeServer({
    host: "127.0.0.1",
    port: 0,
    bodySizeLimitBytes: options.bodySizeLimitBytes,
    memoryReadToolOptions: { db },
    engineToolOptions: { db, homeDir },
    logger: options.logger,
    requestIdFactory: options.requestIdFactory,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  expect(address).not.toBeNull();
  expect(address).not.toBeInstanceOf(String);

  return {
    server,
    baseUrl: `http://127.0.0.1:${(address as { port: number }).port}`,
  };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("openclaw continuity bridge contract", () => {
  beforeEach(() => {
    resetCallerInstanceCache();
    db = new Database(":memory:");
    createSchema(db);
    seedData(db);
    homeDir = mkdtempSync(join(tmpdir(), "openclaw-continuity-"));
    seedForemanFiles(homeDir);
  });

  afterEach(() => {
    db.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns health with bound workspace and allowlist", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/health", { method: "GET" }),
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "ok",
      workspace_id: DEFAULT_WORKSPACE_ID,
    });
    expect(body.tools).toEqual(EXPECTED_TOOLS);
  });

  it("treats allowedTools as a narrowing subset and never widens beyond the parity pack", async () => {
    const bridge = await loadBridgeModule();
    const app = bridge.createContinuityBridgeApp({
      allowedTools: ["memory_context", "engine_create_task"],
      memoryReadToolOptions: { db },
      engineToolOptions: { db, homeDir },
    });

    const healthResponse = await app.handle(
      new Request("http://openclaw.local/health", { method: "GET" }),
    );
    const healthBody = await healthResponse.json();

    expect(healthResponse.status).toBe(200);
    expect(healthBody.tools).toEqual(["memory_context"]);

    const blockedResponse = await app.handle(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "engine_create_task",
          input: {
            title: "Should stay blocked",
          },
        }),
      }),
    );
    const blockedBody = await blockedResponse.json();

    expect(blockedResponse.status).toBe(403);
    expect(blockedBody).toMatchObject({
      ok: false,
      code: "TOOL_NOT_ALLOWED",
      tool: "engine_create_task",
    });
  });

  it("rejects tool calls with a missing caller", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "memory_context",
          input: {},
        }),
      }),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      code: "MISSING_CALLER",
    });
  });

  it("rejects callers outside the fixed bridge identity", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "spoofed-openclaw",
          tool: "memory_context",
          input: {},
        }),
      }),
    );

    expect(status).toBe(403);
    expect(body).toMatchObject({
      ok: false,
      code: "CALLER_NOT_ALLOWED",
      caller: "spoofed-openclaw",
      allowed_caller: "vairys-openclaw",
    });
  });

  it("rejects disallowed tools", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "spawn_session",
          input: {},
        }),
      }),
    );

    expect(status).toBe(403);
    expect(body).toMatchObject({
      ok: false,
      code: "TOOL_NOT_ALLOWED",
      tool: "spawn_session",
    });
  });

  it("proxies workstream_message_send through the HQ tool path with the bound workspace", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 404,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>404</body></html>",
        };
      }

      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-1", agent_name: "codex" },
          }),
        };
      }

      if (body.tool === "workstream_message_send") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              selector_source: "receipt",
              linkage: {
                card_id: "card-123",
                workflow_run_id: "run-123",
              },
              sent_message: {
                message_id: "msg-123",
                message_type: "query",
              },
            },
          }),
        };
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "workstream_message_send",
          input: {
            receipt_id: "receipt-123",
            message_type: "query",
            content: "Please confirm the next proof point.",
          },
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      selector_source: "receipt",
      linkage: {
        card_id: "card-123",
        workflow_run_id: "run-123",
      },
      sent_message: {
        message_id: "msg-123",
        message_type: "query",
      },
    });

    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ({ url: call[0], init: call[1] }))
      .find((call) => {
        const bodyText = typeof call.init?.body === "string" ? call.init.body : "";
        return bodyText.includes('"tool":"workstream_message_send"');
      });

    expect(toolCall).toBeDefined();

    const proxiedBody = JSON.parse(toolCall!.init!.body as string) as {
      tool: string;
      input: Record<string, unknown>;
      workspace_id: string;
    };
    expect(proxiedBody.tool).toBe("workstream_message_send");
    expect(proxiedBody.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.receipt_id).toBe("receipt-123");
    expect(proxiedBody.input.message_type).toBe("query");
    expect(proxiedBody.input.content).toBe("Please confirm the next proof point.");
    expect(proxiedBody.input).not.toHaveProperty("to");
    expect(proxiedBody.input).not.toHaveProperty("caller");
  });

  it("proxies workstream_message_poll through the HQ tool path with ack default false", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 404,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>404</body></html>",
        };
      }

      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-1", agent_name: "codex" },
          }),
        };
      }

      if (body.tool === "workstream_message_poll") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              selector_source: "receipt",
              poll: {
                ack: false,
                returned: 1,
                acknowledged_count: 0,
              },
              messages: [{ message_id: "msg-123", message_type: "response" }],
            },
          }),
        };
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "workstream_message_poll",
          input: {
            receipt_id: "receipt-123",
            limit: 5,
          },
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      selector_source: "receipt",
      poll: {
        ack: false,
        returned: 1,
        acknowledged_count: 0,
      },
      messages: [{ message_id: "msg-123", message_type: "response" }],
    });

    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ({ url: call[0], init: call[1] }))
      .find((call) => {
        const bodyText = typeof call.init?.body === "string" ? call.init.body : "";
        return bodyText.includes('"tool":"workstream_message_poll"');
      });

    expect(toolCall).toBeDefined();

    const proxiedBody = JSON.parse(toolCall!.init!.body as string) as {
      tool: string;
      input: Record<string, unknown>;
      workspace_id: string;
    };
    expect(proxiedBody.tool).toBe("workstream_message_poll");
    expect(proxiedBody.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.receipt_id).toBe("receipt-123");
    expect(proxiedBody.input.ack).toBe(false);
    expect(proxiedBody.input.limit).toBe(5);
  });

  it("rejects tunneled raw routing fields inside the approved L4 wrappers", async () => {
    const fetchFn = vi.fn();

    const sendAttempt = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "workstream_message_send",
          input: {
            receipt_id: "receipt-123",
            message_type: "query",
            content: "Please confirm the next proof point.",
            to: "ghost",
          },
        }),
      }),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(sendAttempt.status).toBe(400);
    expect(sendAttempt.body).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
      tool: "workstream_message_send",
    });

    const pollAttempt = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "workstream_message_poll",
          input: {
            receipt_id: "receipt-123",
            instance_id: "raw-instance-id",
          },
        }),
      }),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(pollAttempt.status).toBe(400);
    expect(pollAttempt.body).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
      tool: "workstream_message_poll",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects omitted input for parity steering wrappers before any proxy call", async () => {
    const fetchFn = vi.fn();

    const sendAttempt = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "workstream_message_send",
        }),
      }),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(sendAttempt.status).toBe(400);
    expect(sendAttempt.body).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
      tool: "workstream_message_send",
    });

    const pollAttempt = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "workstream_message_poll",
        }),
      }),
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(pollAttempt.status).toBe(400);
    expect(pollAttempt.body).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
      tool: "workstream_message_poll",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects raw HQ messaging tools outside the approved L4 wrapper pack", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "send_message",
          input: {},
        }),
      }),
    );

    expect(status).toBe(403);
    expect(body).toMatchObject({
      ok: false,
      code: "TOOL_NOT_ALLOWED",
      tool: "send_message",
    });
  });

  it("rejects workspace overrides outside the default workspace", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "memory_context",
          input: {
            workspace_id: "11111111-1111-1111-1111-111111111111",
          },
        }),
      }),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      code: "WORKSPACE_OVERRIDE_NOT_ALLOWED",
    });
  });

  it("serves memory_context through the shared read handlers", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "memory_context",
          input: {},
        }),
      }),
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      workspace_id: DEFAULT_WORKSPACE_ID,
    });
    expect(Array.isArray(body.memories)).toBe(true);
    expect(body.memories[0].memory_key).toBe("decision_lock/model_role_routing_2026_03_19");
  });

  it("serves memory_search through the shared read handlers", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "memory_search",
          input: {
            query: "role routing",
            limit: 3,
          },
        }),
      }),
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      query: "role routing",
      workspace_id: DEFAULT_WORKSPACE_ID,
    });
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results[0].id).toBe(MEMORY_ID);
  });

  it("rejects telemetry persistence because Phase 1 is read-only", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "memory_context",
          input: {
            persist_telemetry: true,
          },
        }),
      }),
    );

    expect(status).toBe(403);
    expect(body).toMatchObject({
      ok: false,
      code: "WRITE_OPTION_NOT_ALLOWED",
      field: "persist_telemetry",
    });
  });

  it("serves engine_get_foreman_state through the local engine tool path", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "engine_get_foreman_state",
          input: {},
        }),
      }),
    );

    expect(status).toBe(200);
    expect(body.next_action).toContain("Use the active SQLite state as the source of truth");
    expect(body.source_paths.task_checkpoint).toBeNull();
    expect(body.source_paths.board_snapshot).toBeNull();
    expect(body.state.task_checkpoint).toBeNull();
    expect(body.state.board_snapshot).toBeNull();
    expect(body.state.sqlite.active_runs).toHaveLength(1);
    expect(body.state.sqlite.pending_jobs).toEqual([]);
    expect(body.warnings).toEqual(
      expect.arrayContaining([
        "Global recovery checkpoints are suppressed for workspace-scoped bridge access.",
        "Pending local jobs are suppressed for workspace-scoped bridge access.",
      ]),
    );
  });

  it("keeps engine_get_foreman_state scoped to the bound workspace", async () => {
    db.prepare(`
      INSERT INTO workflow_runs (
        id, workspace_id, workflow_definition_id, workflow_type, execution_snapshot,
        status, input, output, total_cost_usd, created_by, card_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "run-77777777-7777-4777-8777-777777777777",
      "77777777-7777-4777-8777-777777777777",
      "wf-other",
      "other-workflow",
      JSON.stringify({ workflow_definition: { id: "wf-other" } }),
      "queued",
      JSON.stringify({}),
      null,
      0,
      "airya",
      null,
      "2026-03-19T20:00:00.000Z",
      "2026-03-19T20:00:00.000Z",
    );
    db.prepare(`
      INSERT INTO work_items (
        id, workspace_id, title, description, status, priority, card_type,
        parent_card_id, created_by, origin, current_stage, flow_template, governance_tier,
        active_workflow_run_id, blocked_reason, readiness_check, tags, card_activity,
        card_documents, card_criteria, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "card-77777777-7777-4777-8777-777777777777",
      "77777777-7777-4777-8777-777777777777",
      "Foreign workspace card",
      "Should not appear in parity foreman state",
      "todo",
      50,
      "feature",
      null,
      "airya",
      "airya",
      "planning",
      "feature-full",
      2,
      null,
      null,
      "{}",
      "[]",
      "[]",
      "[]",
      "[]",
      null,
      "2026-03-19T20:00:00.000Z",
      "2026-03-19T20:00:00.000Z",
    );

    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "engine_get_foreman_state",
          input: {},
        }),
      }),
    );

    expect(status).toBe(200);
    expect(body.source_paths.task_checkpoint).toBeNull();
    expect(body.source_paths.board_snapshot).toBeNull();
    expect(body.state.sqlite.active_runs.map((run: { id: string }) => run.id)).toEqual(
      expect.not.arrayContaining(["run-77777777-7777-4777-8777-777777777777"]),
    );
    expect(body.state.sqlite.active_work_items.map((item: { id: string }) => item.id)).toEqual(
      expect.not.arrayContaining(["card-77777777-7777-4777-8777-777777777777"]),
    );
    expect(body.state.sqlite.pending_jobs).toEqual([]);
  });

  it.each(STEERING_CASES)(
    "surfaces %s through the engine_get_foreman_state bridge response",
    async (classification) => {
      const scenario = seedLaneProjectionScenario(db, classification);

      const { status, body } = await requestJson(
        new Request("http://openclaw.local/tool", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            caller: "vairys-openclaw",
            tool: "engine_get_foreman_state",
            input: {},
          }),
        }),
      );

      const lane = body.state.sqlite.lane_projections?.find(
        (candidate: { card_id: string }) => candidate.card_id === scenario.cardId,
      );

      expect(status).toBe(200);
      expect(Array.isArray(body.state.sqlite.lane_projections)).toBe(true);
      expect(lane).toBeDefined();
      expect(lane.steering_surface.classification).toBe(classification);
    },
  );

  it("serves engine_list_runs through the local engine tool path", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "engine_list_runs",
          input: {},
        }),
      }),
    );

    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.runs[0]).toMatchObject({
      id: "run-11111111-1111-4111-8111-111111111111",
      status: "queued",
    });
  });

  it("serves engine_get_run through the local engine tool path", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "engine_get_run",
          input: {
            run_id: "run-11111111-1111-4111-8111-111111111111",
          },
        }),
      }),
    );

    expect(status).toBe(200);
    expect(body.run.id).toBe("run-11111111-1111-4111-8111-111111111111");
    expect(body.nodes).toHaveLength(1);
    expect(body.node_summary.pending).toBe(1);
  });

  it("fails closed on engine_get_run when the run belongs to another workspace", async () => {
    db.prepare(`
      INSERT INTO workflow_runs (
        id, workspace_id, workflow_definition_id, workflow_type, execution_snapshot,
        status, input, output, total_cost_usd, created_by, card_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "run-77777777-7777-4777-8777-777777777777",
      "77777777-7777-4777-8777-777777777777",
      "wf-other",
      "other-workflow",
      JSON.stringify({ workflow_definition: { id: "wf-other" } }),
      "queued",
      JSON.stringify({}),
      null,
      0,
      "airya",
      null,
      "2026-03-19T20:00:00.000Z",
      "2026-03-19T20:00:00.000Z",
    );

    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "engine_get_run",
          input: {
            run_id: "run-77777777-7777-4777-8777-777777777777",
          },
        }),
      }),
    );

    expect(status).toBe(404);
    expect(body).toMatchObject({
      ok: false,
      error: "Workflow run not found: run-77777777-7777-4777-8777-777777777777",
    });
  });

  it("fails closed on invalid local engine tool input with a validation envelope", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "engine_list_runs",
          input: {
            limit: "not-a-number",
          },
        }),
      }),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues[0]).toMatchObject({
      path: ["limit"],
    });
  });

  it("fails closed when input is not a JSON object", async () => {
    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "engine_list_runs",
          input: "oops",
        }),
      }),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
      tool: "engine_list_runs",
    });
    expect(body.issues[0]).toMatchObject({
      path: ["input"],
    });
  });

  it("serves hq_health through the no-bootstrap proxy path", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ count: 35 }),
    }) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "hq_health",
          input: {},
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      hq_url: "http://localhost:3000",
      tools_available: 35,
      caller: "vairys-openclaw",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:3000/api/airya/tool",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-secret",
          "x-openclaw-caller": "vairys-openclaw",
        }),
      }),
    );
  });

  it("proxies continuity_write through the HQ tool path with the bound workspace", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 404,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>404</body></html>",
        };
      }

      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-1", agent_name: "codex" },
          }),
        };
      }

      if (body.tool === "continuity_write") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              accepted: true,
              receipt_kind: "created",
              conversation_id: "conv-123",
            },
          }),
        };
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "continuity_write",
          input: {
            workspace_id: DEFAULT_WORKSPACE_ID,
            semantic_key: "thread-state",
          },
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      accepted: true,
      receipt_kind: "created",
      conversation_id: "conv-123",
    });
    expect(fetchFn).toHaveBeenCalled();

    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ({ url: call[0], init: call[1] }))
      .find((call) => {
        const bodyText = typeof call.init?.body === "string" ? call.init.body : "";
        return bodyText.includes('"tool":"continuity_write"');
      });

    expect(toolCall).toBeDefined();
    expect(toolCall?.url).toBe("http://localhost:3000/api/airya/tool");
    expect(toolCall?.init?.headers).toMatchObject({
      Authorization: "Bearer test-secret",
      "x-agent-instance-id": "inst-openclaw-1",
      "x-openclaw-caller": "vairys-openclaw",
    });

    const proxiedBody = JSON.parse(toolCall!.init!.body as string) as {
      tool: string;
      input: Record<string, unknown>;
      workspace_id: string;
    };
    expect(proxiedBody.tool).toBe("continuity_write");
    expect(proxiedBody.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.semantic_key).toBe("thread-state");

    const bootstrapCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ({ url: call[0], init: call[1] }))
      .find((call) => {
        const bodyText = typeof call.init?.body === "string" ? call.init.body : "";
        return bodyText.includes('"tool":"register_agent_session"');
      });

    expect(bootstrapCall).toBeDefined();
    const bootstrapBody = JSON.parse(bootstrapCall!.init!.body as string) as {
      input: { mcp_allowed_tools?: string[] };
    };
    expect(bootstrapBody.input.mcp_allowed_tools).toEqual(EXPECTED_TOOLS);
  });

  it("proxies continuity_receipt_read through the HQ tool path with the bound workspace", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 404,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>404</body></html>",
        };
      }

      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-1", agent_name: "codex" },
          }),
        };
      }

      if (body.tool === "continuity_receipt_read") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              receipt_kind: "created",
              read_after_write_refs: ["memory:mem-1"],
            },
          }),
        };
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "continuity_receipt_read",
          input: {
            receipt_id: "receipt-123",
          },
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      receipt_kind: "created",
      read_after_write_refs: ["memory:mem-1"],
    });

    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ({ url: call[0], init: call[1] }))
      .find((call) => {
        const bodyText = typeof call.init?.body === "string" ? call.init.body : "";
        return bodyText.includes('"tool":"continuity_receipt_read"');
      });

    expect(toolCall).toBeDefined();

    const proxiedBody = JSON.parse(toolCall!.init!.body as string) as {
      tool: string;
      input: Record<string, unknown>;
      workspace_id: string;
    };
    expect(proxiedBody.tool).toBe("continuity_receipt_read");
    expect(proxiedBody.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.receipt_id).toBe("receipt-123");
  });

  it("preserves downstream receipt-not-found errors as 404 instead of collapsing them to 500", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 404,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>404</body></html>",
        };
      }

      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-1", agent_name: "codex" },
          }),
        };
      }

      if (body.tool === "continuity_receipt_read") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: false,
            error: "Receipt receipt-missing was not found",
            code: "RECEIPT_NOT_FOUND",
          }),
        };
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "continuity_receipt_read",
          input: {
            receipt_id: "receipt-missing",
          },
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(404);
    expect(body).toMatchObject({
      error: "Receipt receipt-missing was not found",
      code: "RECEIPT_NOT_FOUND",
    });
  });

  it("proxies continuity_linkage_read through the HQ tool path with the bound workspace", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 404,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>404</body></html>",
        };
      }

      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-1", agent_name: "codex" },
          }),
        };
      }

      if (body.tool === "continuity_linkage_read") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              receipt_id: "receipt-123",
              current: {
                resulting_mode: "explicit",
              },
            },
          }),
        };
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "continuity_linkage_read",
          input: {
            receipt_id: "receipt-123",
          },
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      receipt_id: "receipt-123",
      current: {
        resulting_mode: "explicit",
      },
    });

    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ({ url: call[0], init: call[1] }))
      .find((call) => {
        const bodyText = typeof call.init?.body === "string" ? call.init.body : "";
        return bodyText.includes('"tool":"continuity_linkage_read"');
      });

    expect(toolCall).toBeDefined();

    const proxiedBody = JSON.parse(toolCall!.init!.body as string) as {
      tool: string;
      input: Record<string, unknown>;
      workspace_id: string;
    };
    expect(proxiedBody.tool).toBe("continuity_linkage_read");
    expect(proxiedBody.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.receipt_id).toBe("receipt-123");
  });

  it("proxies workstream_check_in through the HQ tool path with the bound workspace", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 404,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>404</body></html>",
        };
      }

      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-1", agent_name: "codex" },
          }),
        };
      }

      if (body.tool === "workstream_check_in") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              selector_source: "receipt",
              workflow_run_id: "run-123",
              linked_session: {
                source: "session_event",
                session_id: "session-123",
              },
            },
          }),
        };
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "workstream_check_in",
          input: {
            receipt_id: "receipt-123",
          },
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      selector_source: "receipt",
      workflow_run_id: "run-123",
      linked_session: {
        source: "session_event",
        session_id: "session-123",
      },
    });

    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ({ url: call[0], init: call[1] }))
      .find((call) => {
        const bodyText = typeof call.init?.body === "string" ? call.init.body : "";
        return bodyText.includes('"tool":"workstream_check_in"');
      });

    expect(toolCall).toBeDefined();

    const proxiedBody = JSON.parse(toolCall!.init!.body as string) as {
      tool: string;
      input: Record<string, unknown>;
      workspace_id: string;
    };
    expect(proxiedBody.tool).toBe("workstream_check_in");
    expect(proxiedBody.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.receipt_id).toBe("receipt-123");
  });

  it("proxies linked_session_observe through the HQ tool path with the bound workspace", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 404,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>404</body></html>",
        };
      }

      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-1", agent_name: "codex" },
          }),
        };
      }

      if (body.tool === "linked_session_observe") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              selector_source: "card",
              workflow_run_id: "run-123",
              observation: {
                source: "output_summary",
                session_id: "session-123",
              },
            },
          }),
        };
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "linked_session_observe",
          input: {
            card_id: "card-123",
            excerpt_lines: 12,
          },
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      selector_source: "card",
      workflow_run_id: "run-123",
      observation: {
        source: "output_summary",
        session_id: "session-123",
      },
    });

    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ({ url: call[0], init: call[1] }))
      .find((call) => {
        const bodyText = typeof call.init?.body === "string" ? call.init.body : "";
        return bodyText.includes('"tool":"linked_session_observe"');
      });

    expect(toolCall).toBeDefined();

    const proxiedBody = JSON.parse(toolCall!.init!.body as string) as {
      tool: string;
      input: Record<string, unknown>;
      workspace_id: string;
    };
    expect(proxiedBody.tool).toBe("linked_session_observe");
    expect(proxiedBody.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    expect(proxiedBody.input.card_id).toBe("card-123");
    expect(proxiedBody.input.excerpt_lines).toBe(12);
  });

  it("forwards the caller tag on every proxied parity tool", async () => {
    const cases = [
      { tool: "continuity_write", input: { semantic_key: "thread-state" } },
      { tool: "continuity_receipt_read", input: { receipt_id: "receipt-123" } },
      { tool: "continuity_linkage_read", input: { receipt_id: "receipt-123" } },
      { tool: "workstream_check_in", input: { card_id: "card-123" } },
      { tool: "linked_session_observe", input: { card_id: "card-123" } },
      {
        tool: "workstream_message_send",
        input: {
          receipt_id: "receipt-123",
          message_type: "query",
          content: "Please confirm the next proof point.",
        },
      },
      { tool: "workstream_message_poll", input: { card_id: "card-123" } },
    ] as const;

    for (const testCase of cases) {
      const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "http://localhost:3000/api/airya/workspace-context") {
          return {
            ok: false,
            status: 404,
            headers: { get: () => "text/html; charset=utf-8" },
            text: async () => "<!DOCTYPE html><html><body>404</body></html>",
          };
        }

        const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
        if (body.tool === "register_agent_session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              result: { instance_id: "inst-openclaw-1", agent_name: "codex" },
            }),
          };
        }

        if (body.tool === testCase.tool) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              result: {
                echoed_tool: testCase.tool,
              },
            }),
          };
        }

        throw new Error(`Unexpected fetch call: ${url}`);
      }) as unknown as typeof fetch;

      const { status } = await requestJsonWithOptions(
        new Request("http://openclaw.local/tool", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            caller: "vairys-openclaw",
            tool: testCase.tool,
            input: testCase.input,
          }),
        }),
        { fetchFn },
      );

      expect(status).toBe(200);

      const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => ({ url: call[0], init: call[1] }))
        .find((call) => {
          const bodyText = typeof call.init?.body === "string" ? call.init.body : "";
          return bodyText.includes(`"tool":"${testCase.tool}"`);
        });

      expect(toolCall?.url).toBe("http://localhost:3000/api/airya/tool");
      expect(toolCall?.init?.headers).toMatchObject({
        Authorization: "Bearer test-secret",
        "x-openclaw-caller": "vairys-openclaw",
      });
    }
  });

  it("logs successful tool requests with caller, tool, outcome, latency, and request id", async () => {
    const logLines: string[] = [];

    const { status } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "memory_context",
          input: {},
        }),
      }),
      {
        logger: (line) => logLines.push(line),
        requestIdFactory: () => "req-success-1",
      },
    );

    expect(status).toBe(200);
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0])).toMatchObject({
      caller: "vairys-openclaw",
      tool: "memory_context",
      outcome: "ok",
      request_id: "req-success-1",
    });
    expect(JSON.parse(logLines[0]).latency_ms).toEqual(expect.any(Number));
    expect(JSON.parse(logLines[0]).timestamp).toEqual(expect.any(String));
  });

  it("logs rejection codes for disallowed tools", async () => {
    const logLines: string[] = [];

    const { status } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "spawn_session",
          input: {},
        }),
      }),
      {
        logger: (line) => logLines.push(line),
        requestIdFactory: () => "req-reject-1",
      },
    );

    expect(status).toBe(403);
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0])).toMatchObject({
      caller: "vairys-openclaw",
      tool: "spawn_session",
      outcome: "TOOL_NOT_ALLOWED",
      request_id: "req-reject-1",
    });
  });

  it("logs malformed json with a stable invalid-json outcome", async () => {
    const logLines: string[] = [];

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      {
        logger: (line) => logLines.push(line),
        requestIdFactory: () => "req-invalid-1",
      },
    );

    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_JSON");
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0])).toMatchObject({
      outcome: "INVALID_JSON",
      request_id: "req-invalid-1",
    });
  });

  it("rejects oversized request bodies with PAYLOAD_TOO_LARGE", async () => {
    const oversizedPayload = JSON.stringify({
      caller: "vairys-openclaw",
      tool: "memory_context",
      input: {
        blob: "x".repeat(40_000),
      },
    });

    const { status, body } = await requestJson(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversizedPayload,
      }),
    );

    expect(status).toBe(413);
    expect(body).toMatchObject({
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("returns a 413 JSON envelope for oversized bodies over the live server path and stays healthy", async () => {
    const oversizedPayload = JSON.stringify({
      caller: "vairys-openclaw",
      tool: "memory_context",
      input: {
        blob: "x".repeat(40_000),
      },
    });

    const { server, baseUrl } = await startTestServer();

    try {
      const oversizedResponse = await fetch(`${baseUrl}/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversizedPayload,
      });

      expect(oversizedResponse.status).toBe(413);
      await expect(oversizedResponse.json()).resolves.toMatchObject({
        ok: false,
        code: "PAYLOAD_TOO_LARGE",
      });

      const healthResponse = await fetch(`${baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      await expect(healthResponse.json()).resolves.toMatchObject({
        ok: true,
        status: "ok",
        workspace_id: DEFAULT_WORKSPACE_ID,
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it("logs PAYLOAD_TOO_LARGE for oversized bodies over the live server path", async () => {
    const logLines: string[] = [];
    const oversizedPayload = JSON.stringify({
      caller: "vairys-openclaw",
      tool: "memory_context",
      input: {
        blob: "x".repeat(40_000),
      },
    });

    const { server, baseUrl } = await startTestServer({
      logger: (line) => logLines.push(line),
      requestIdFactory: () => "req-live-oversize-1",
    });

    try {
      const response = await fetch(`${baseUrl}/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversizedPayload,
      });

      expect(response.status).toBe(413);
      expect(logLines).toHaveLength(1);
      expect(JSON.parse(logLines[0])).toMatchObject({
        method: "POST",
        path: "/tool",
        caller: null,
        tool: null,
        outcome: "PAYLOAD_TOO_LARGE",
        request_id: "req-live-oversize-1",
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it("maps upstream timeout errors to a 504 TIMEOUT envelope", async () => {
    const timeoutErr = new Error("timeout");
    timeoutErr.name = "TimeoutError";
    const fetchFn = vi.fn().mockRejectedValue(timeoutErr) as unknown as typeof fetch;

    const { status, body } = await requestJsonWithOptions(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "hq_health",
          input: {},
        }),
      }),
      { fetchFn },
    );

    expect(status).toBe(504);
    expect(body).toMatchObject({
      error: expect.stringContaining("timed out"),
      code: "TIMEOUT",
    });
  });

  it("exposes in-memory request stats at /stats", async () => {
    const app = await createTestBridge();

    await app.handle(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "memory_context",
          input: {},
        }),
      }),
    );

    await app.handle(
      new Request("http://openclaw.local/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caller: "vairys-openclaw",
          tool: "spawn_session",
          input: {},
        }),
      }),
    );

    const response = await app.handle(
      new Request("http://openclaw.local/stats", { method: "GET" }),
    );
    const status = response.status;
    const body = await response.json();

    expect(status).toBe(200);
    expect(body.start_time).toEqual(expect.any(String));
    expect(body.uptime_ms).toEqual(expect.any(Number));
    expect(body.total_requests).toBeGreaterThanOrEqual(2);
    expect(body.by_tool.memory_context.count).toBe(1);
    expect(body.by_tool.memory_context.avg_latency_ms).toEqual(expect.any(Number));
    expect(body.errors_by_tool.spawn_session).toBe(1);
  });
});

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE airya_memory_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      memory_class TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      confidence REAL NOT NULL,
      priority INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      review_state TEXT NOT NULL,
      status TEXT NOT NULL,
      memory_tier TEXT,
      scope_kind TEXT,
      scope_id TEXT,
      project_id TEXT,
      work_item_id TEXT,
      conversation_id TEXT,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE airya_memory_chunks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      memory_item_id TEXT NOT NULL,
      embedding_provider TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dimension INTEGER NOT NULL,
      embedding TEXT,
      chunk_text TEXT
    );

    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workflow_definition_id TEXT,
      workflow_type TEXT,
      execution_snapshot TEXT,
      status TEXT NOT NULL,
      input TEXT,
      output TEXT,
      total_cost_usd REAL DEFAULT 0,
      created_by TEXT,
      card_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE workflow_run_nodes (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      node_key TEXT NOT NULL,
      node_type TEXT NOT NULL,
      step_definition TEXT,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      input TEXT,
      output TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      card_type TEXT,
      parent_card_id TEXT,
      created_by TEXT,
      origin TEXT,
      current_stage TEXT,
      flow_template TEXT,
      governance_tier INTEGER,
      active_workflow_run_id TEXT,
      blocked_reason TEXT,
      readiness_check TEXT,
      tags TEXT,
      card_activity TEXT,
      card_documents TEXT,
      card_criteria TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE agent_instances (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL
    );

    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_instance_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      agent_definition_id TEXT,
      skill_names TEXT NOT NULL DEFAULT '[]',
      command TEXT NOT NULL,
      prompt TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'autonomous',
      status TEXT NOT NULL,
      pid INTEGER,
      exit_code INTEGER,
      owner_worker_id TEXT,
      heartbeat_at TEXT,
      last_read_offset INTEGER DEFAULT 0,
      reconciled_at TEXT,
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      allowed_paths TEXT,
      forbidden_paths TEXT,
      timeout_seconds INTEGER NOT NULL DEFAULT 3600,
      max_tool_calls INTEGER NOT NULL DEFAULT 200,
      max_elapsed_seconds INTEGER NOT NULL DEFAULT 7200,
      budget_cap_usd REAL NOT NULL DEFAULT 5.0,
      cost_usd REAL DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      governance_tier INTEGER NOT NULL DEFAULT 0,
      deliberation_id TEXT,
      workflow_run_id TEXT,
      node_key TEXT,
      airya_turn_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      output_summary TEXT,
      artifacts TEXT DEFAULT '[]',
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      from_instance_id TEXT NOT NULL,
      to_instance_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT DEFAULT '{}',
      session_id TEXT,
      workflow_run_id TEXT,
      airya_turn_id TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE local_jobs (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      status TEXT NOT NULL,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
  `);
}

function seedData(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT INTO airya_memory_items (
      id, workspace_id, memory_class, memory_key, value_json, summary_text,
      confidence, priority, provenance, review_state, status, memory_tier,
      scope_kind, scope_id, project_id, work_item_id, conversation_id,
      valid_from, valid_to, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  const insertChunk = db.prepare(`
    INSERT INTO airya_memory_chunks (
      id, workspace_id, memory_item_id, embedding_provider, embedding_model,
      embedding_dimension, embedding, chunk_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRun = db.prepare(`
    INSERT INTO workflow_runs (
      id, workspace_id, workflow_definition_id, workflow_type, execution_snapshot,
      status, input, output, total_cost_usd, created_by, card_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertNode = db.prepare(`
    INSERT INTO workflow_run_nodes (
      id, run_id, workspace_id, node_key, node_type, step_definition, status,
      idempotency_key, retry_count, max_retries, input, output, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWorkItem = db.prepare(`
    INSERT INTO work_items (
      id, workspace_id, title, description, status, priority, card_type,
      parent_card_id, created_by, origin, current_stage, flow_template, governance_tier,
      active_workflow_run_id, blocked_reason, readiness_check, tags, card_activity,
      card_documents, card_criteria, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLocalJob = db.prepare(`
    INSERT INTO local_jobs (
      id, queue, status, retry_count, max_retries, created_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const zeroEmbedding = JSON.stringify(Array.from({ length: 768 }, () => 0));

  insert.run(
    MEMORY_ID,
    DEFAULT_WORKSPACE_ID,
    "decision_log",
    "decision_lock/model_role_routing_2026_03_19",
    JSON.stringify({
      owner: "codex",
      lane: "execution",
      _provenance: {
        source_channel: "cli",
      },
    }),
    "Locked role routing: Opus handles strategy and writing; Codex handles orchestration and verification.",
    0.99,
    95,
    "founder_confirmed",
    "not_required",
    "active",
    "durable_memory",
    "project",
    "airya",
    "airya",
    null,
    null,
    "2026-03-19T18:00:00.000Z",
    null,
    "2026-03-19T18:00:00.000Z",
    "2026-03-19T19:00:00.000Z",
  );

  insert.run(
    MEMORY_ID_2,
    DEFAULT_WORKSPACE_ID,
    "project_context",
    "project_context/engine_operator_dogfood",
    JSON.stringify({
      owner: "codex",
      lane: "engine",
    }),
    "Engine operator dogfood run created a real work item, queued a real run, and verified the local engine path.",
    0.92,
    82,
    "system_derived",
    "not_required",
    "active",
    "project_memory",
    "project",
    "engine",
    "engine",
    null,
    null,
    "2026-03-19T17:00:00.000Z",
    null,
    "2026-03-19T17:00:00.000Z",
    "2026-03-19T19:30:00.000Z",
  );

  insertChunk.run(
    "chunk-1",
    DEFAULT_WORKSPACE_ID,
    MEMORY_ID,
    "local",
    "deterministic-768-v1",
    768,
    zeroEmbedding,
    "role routing execution lane",
  );

  insertChunk.run(
    "chunk-2",
    DEFAULT_WORKSPACE_ID,
    MEMORY_ID_2,
    "local",
    "deterministic-768-v1",
    768,
    zeroEmbedding,
    "engine operator dogfood",
  );

  insertRun.run(
    "run-11111111-1111-4111-8111-111111111111",
    DEFAULT_WORKSPACE_ID,
    "definition-11111111-1111-4111-8111-111111111111",
    "document_summarize",
    JSON.stringify({
      workflow_definition: { id: "definition-11111111-1111-4111-8111-111111111111" },
    }),
    "queued",
    JSON.stringify({ target: "hq" }),
    null,
    0,
    "airya",
    "work-item-11111111-1111-4111-8111-111111111111",
    "2026-03-19T19:40:00.000Z",
    "2026-03-19T19:40:00.000Z",
  );

  insertNode.run(
    "node-11111111-1111-4111-8111-111111111111",
    "run-11111111-1111-4111-8111-111111111111",
    DEFAULT_WORKSPACE_ID,
    "collect",
    "tool",
    JSON.stringify({ key: "collect", type: "tool" }),
    "pending",
    "run-11111111-1111-4111-8111-111111111111:collect:0",
    0,
    3,
    null,
    null,
    "2026-03-19T19:40:00.000Z",
    "2026-03-19T19:40:00.000Z",
  );

  insertWorkItem.run(
    "work-item-11111111-1111-4111-8111-111111111111",
    DEFAULT_WORKSPACE_ID,
    "Dogfood engine continuity path",
    "Bridge should surface local engine state.",
    "todo",
    80,
    "feature",
    null,
    "airya",
    "airya",
    "verify",
    "feature-delivery",
    2,
    "run-11111111-1111-4111-8111-111111111111",
    null,
    null,
    JSON.stringify(["bridge", "engine"]),
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify([]),
    null,
    "2026-03-19T19:35:00.000Z",
    "2026-03-19T19:45:00.000Z",
  );

  insertLocalJob.run(
    "job-11111111-1111-4111-8111-111111111111",
    "workflow-tick",
    "pending",
    0,
    3,
    "2026-03-19T19:45:00.000Z",
    null,
    null,
  );
}

function seedForemanFiles(homeDir: string): void {
  const taskDir = join(homeDir, ".airya", "state", "tasks");
  const boardDir = join(homeDir, ".claude", "tasks", "continuity");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(boardDir, { recursive: true });

  writeFileSync(
    join(taskDir, "2026-03-19-openclaw-checkpoint.json"),
    JSON.stringify(
      {
        title: "OpenClaw continuity bridge",
        status: "in_progress",
        next_action: "Wire engine read tools after memory extraction.",
        checkpoint: "TASK-003",
        updated_at: "2026-03-19T19:50:00.000Z",
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(boardDir, "13.json"),
    JSON.stringify(
      {
        title: "LA Engine MCP Server",
        status: "todo",
        next_action: "Execute continuity bridge plan.",
        updated_at: "2026-03-19T19:49:00.000Z",
      },
      null,
      2,
    ),
  );
}

function seedLaneProjectionScenario(
  db: Database.Database,
  classification: (typeof STEERING_CASES)[number],
): { cardId: string } {
  const suffix = classification.replace(/_/g, "-");
  const cardId = `bridge-card-${suffix}`;
  const runId = `bridge-run-${suffix}`;
  const sessionId = `bridge-session-${suffix}`;
  const ownerInstanceId = `bridge-owner-${suffix}`;
  const observerInstanceId = `bridge-airya-${suffix}`;
  const controllerInstanceId = `bridge-controller-${suffix}`;

  const insertInstance = db.prepare("INSERT INTO agent_instances (id, workspace_id) VALUES (?, ?)");
  for (const instanceId of [ownerInstanceId, observerInstanceId, controllerInstanceId]) {
    insertInstance.run(instanceId, DEFAULT_WORKSPACE_ID);
  }

  db.prepare(`
    INSERT INTO work_items (
      id, workspace_id, title, description, status, priority, card_type,
      parent_card_id, created_by, origin, current_stage, flow_template, governance_tier,
      active_workflow_run_id, blocked_reason, readiness_check, tags, card_activity,
      card_documents, card_criteria, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cardId,
    DEFAULT_WORKSPACE_ID,
    `Bridge lane ${classification}`,
    `Bridge lane projection scenario for ${classification}`,
    "todo",
    90,
    "bug",
    null,
    "codex",
    "codex",
    "planning",
    "bug-fast",
    2,
    runId,
    null,
    JSON.stringify({}),
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify([]),
    null,
    "2026-03-27T23:00:00.000Z",
    "2026-03-27T23:03:00.000Z",
  );

  db.prepare(`
    INSERT INTO workflow_runs (
      id, workspace_id, workflow_definition_id, workflow_type, execution_snapshot,
      status, input, output, total_cost_usd, created_by, card_id, created_at, updated_at, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    DEFAULT_WORKSPACE_ID,
    "definition-bridge-lane",
    "execution-planning",
    JSON.stringify({
      frozen_at: "2026-03-27T23:00:00.000Z",
      workflow_definition: {
        id: "definition-bridge-lane",
        name: "bridge-lane",
        version: 1,
        input_schema: {},
        output_schema: {},
        steps: [],
      },
    }),
    "running",
    JSON.stringify({}),
    null,
    0,
    "airya",
    cardId,
    "2026-03-27T23:00:00.000Z",
    "2026-03-27T23:03:00.000Z",
    "2026-03-27T23:00:00.000Z",
  );

  db.prepare(`
    INSERT INTO agent_sessions (
      id, workspace_id, parent_instance_id, runtime, agent_definition_id, skill_names, command,
      prompt, mode, status, pid, exit_code, owner_worker_id, heartbeat_at, last_read_offset,
      reconciled_at, allowed_tools, allowed_paths, forbidden_paths, timeout_seconds,
      max_tool_calls, max_elapsed_seconds, budget_cap_usd, cost_usd, input_tokens, output_tokens,
      tool_call_count, governance_tier, deliberation_id, workflow_run_id, node_key, airya_turn_id,
      idempotency_key, output_summary, artifacts, started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    DEFAULT_WORKSPACE_ID,
    ownerInstanceId,
    "codex",
    null,
    JSON.stringify([]),
    "codex exec",
    "Implement the lane",
    "autonomous",
    "running",
    1234,
    null,
    null,
    "2026-03-27T23:03:00.000Z",
    0,
    null,
    JSON.stringify([]),
    null,
    null,
    3600,
    100,
    3600,
    5,
    0,
    0,
    0,
    0,
    2,
    null,
    runId,
    null,
    null,
    `${sessionId}:key`,
    null,
    JSON.stringify([]),
    "2026-03-27T23:00:00.000Z",
    null,
    "2026-03-27T23:00:00.000Z",
    "2026-03-27T23:03:00.000Z",
  );

  db.prepare(`
    INSERT INTO agent_messages (
      id, workspace_id, from_instance_id, to_instance_id, message_type, content, context,
      session_id, workflow_run_id, airya_turn_id, read_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `bridge-status-${suffix}`,
    DEFAULT_WORKSPACE_ID,
    ownerInstanceId,
    observerInstanceId,
    "status",
    `Status proof for ${classification}`,
    JSON.stringify({
      navigator_event_kind: "proof",
      card_id: cardId,
      workflow_run_id: runId,
      session_id: sessionId,
      summary: `Status proof for ${classification}`,
      execution_state: "active",
      navigator_health: "green",
      current_risks: [],
      current_blockers: [],
    }),
    sessionId,
    runId,
    null,
    null,
    "2026-03-27T23:02:00.000Z",
  );

  if (classification !== "human_relay_only") {
    db.prepare(`
      INSERT INTO agent_messages (
        id, workspace_id, from_instance_id, to_instance_id, message_type, content, context,
        session_id, workflow_run_id, airya_turn_id, read_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `bridge-control-${suffix}`,
      DEFAULT_WORKSPACE_ID,
      classification === "self_loop_only" ? ownerInstanceId : controllerInstanceId,
      ownerInstanceId,
      "query",
      `Control message for ${classification}`,
      JSON.stringify({}),
      sessionId,
      runId,
      null,
      null,
      "2026-03-27T23:03:00.000Z",
    );
  }

  return { cardId };
}
