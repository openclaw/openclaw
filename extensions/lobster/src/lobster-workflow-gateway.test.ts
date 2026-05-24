import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { registerLobsterWorkflowGatewayMethods } from "./lobster-workflow-gateway.js";
import type { LobsterWorkflowStore } from "./lobster-workflow-store.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

function fakeApi() {
  const handlers = new Map<string, { handler: Handler; scope?: string }>();
  const api = createTestPluginApi({
    id: "lobster",
    name: "Lobster",
    source: "test",
    runtime: { version: "test" } as never,
    resolvePath: (p) => p,
    registerGatewayMethod(method, handler, opts) {
      handlers.set(method, { handler, scope: opts?.scope });
    },
  });
  return { api, handlers };
}

function fakeStore(): LobsterWorkflowStore {
  const record = {
    workflowId: "daily-support",
    revision: 1,
    name: "Daily Support",
    workflowPath: "/tmp/daily-support.lobster",
    sha256: "a".repeat(64),
    bytes: 12,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  };
  return {
    publish: vi.fn(async () => record),
    list: vi.fn(async () => ({ workflows: [record] })),
    get: vi.fn(async () => ({ ...record, workflowYaml: "steps: []" })),
    delete: vi.fn(async () => ({ deleted: true, workflowId: record.workflowId })),
    materialize: vi.fn(async () => record),
  };
}

function createRespond() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const respond = vi.fn((ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  });
  return { respond, calls };
}

describe("lobster workflow gateway methods", () => {
  it("registers upstream-aligned workflow methods with read/write scopes", () => {
    const { api, handlers } = fakeApi();

    registerLobsterWorkflowGatewayMethods(api, { store: fakeStore() });

    expect([...handlers.entries()].map(([method, entry]) => [method, entry.scope])).toEqual([
      ["lobster.workflow.publish", "operator.write"],
      ["lobster.workflow.list", "operator.read"],
      ["lobster.workflow.get", "operator.read"],
      ["lobster.workflow.delete", "operator.write"],
    ]);
  });

  it("publishes workflow YAML through the store", async () => {
    const { api, handlers } = fakeApi();
    const store = fakeStore();
    registerLobsterWorkflowGatewayMethods(api, { store });
    const { respond, calls } = createRespond();

    await handlers.get("lobster.workflow.publish")?.handler({
      params: {
        workflowYaml: "steps: []",
        id: "daily-support",
        name: "Daily Support",
        cwd: "workflows",
        metadata: { source: "builder" },
      },
      respond,
    } as never);

    expect(store.publish).toHaveBeenCalledWith({
      workflowYaml: "steps: []",
      workflowId: "daily-support",
      slug: undefined,
      name: "Daily Support",
      cwd: "workflows",
      metadata: { source: "builder" },
      overwrite: undefined,
    });
    expect(calls[0]).toMatchObject({
      ok: true,
      payload: { ok: true, workflow: { workflowId: "daily-support" } },
    });
  });

  it("returns invalid request errors for missing workflow ids", async () => {
    const { api, handlers } = fakeApi();
    registerLobsterWorkflowGatewayMethods(api, { store: fakeStore() });
    const { respond, calls } = createRespond();

    await handlers.get("lobster.workflow.get")?.handler({ params: {}, respond } as never);

    expect(calls[0]?.ok).toBe(false);
    expect(calls[0]?.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "workflowId required",
    });
  });
});
