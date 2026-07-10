import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { dashboardBroadcast, resetDashboardBroadcastForTest } from "./broadcast.js";
import { registerDashboardGatewayMethods } from "./gateway.js";
import { DashboardStore } from "./store.js";

type RegisteredMethod = {
  handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
  opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
};

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dashboard-gateway-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createApi() {
  const methods = new Map<string, RegisteredMethod>();
  const api = {
    registerGatewayMethod: vi.fn(
      (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
        methods.set(method, { handler, opts });
      },
    ),
  } as unknown as OpenClawPluginApi;
  return { api, methods };
}

async function callMethod(
  method: RegisteredMethod,
  params: Record<string, unknown>,
  broadcast = vi.fn(),
) {
  const respond = vi.fn();
  await method.handler({
    params,
    respond,
    context: { broadcast },
  } as never);
  return { broadcast, respond, response: respond.mock.calls[0] };
}

describe("dashboard gateway methods", () => {
  it("registers all L1 methods with read/write scopes", () => {
    const { api, methods } = createApi();
    registerDashboardGatewayMethods({
      api,
      store: new DashboardStore({ stateDir: "/tmp/unused" }),
    });

    expect([...methods.keys()]).toEqual([
      "dashboard.workspace.get",
      "dashboard.tab.create",
      "dashboard.tab.update",
      "dashboard.tab.delete",
      "dashboard.tab.reorder",
      "dashboard.widget.add",
      "dashboard.widget.update",
      "dashboard.widget.move",
      "dashboard.widget.remove",
      "dashboard.widget.setLayout",
      "dashboard.widget.scaffold",
      "dashboard.widget.approve",
      "dashboard.workspace.replace",
      "dashboard.workspace.undo",
      "dashboard.data.read",
    ]);
    expect(methods.get("dashboard.workspace.get")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("dashboard.data.read")?.opts).toEqual({ scope: "operator.read" });
    // Approving agent-authored code is an approvals decision: operator.write alone
    // must not be enough to mount an untrusted widget.
    expect(methods.get("dashboard.widget.approve")?.opts).toEqual({
      scope: "operator.approvals",
    });
    const readOnly = new Set(["dashboard.workspace.get", "dashboard.data.read"]);
    for (const [name, method] of methods) {
      if (readOnly.has(name) || name === "dashboard.widget.approve") {
        continue;
      }
      expect(method.opts).toEqual({ scope: "operator.write" });
    }
  });

  it("returns the workspace without broadcasting and broadcasts successful writes", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerDashboardGatewayMethods({ api, store: new DashboardStore({ stateDir }) });
      const broadcast = vi.fn();

      const read = await callMethod(methods.get("dashboard.workspace.get")!, {}, broadcast);
      expect(read.response?.[0]).toBe(true);
      expect(read.response?.[1]).toMatchObject({ workspaceVersion: 1 });
      expect(broadcast).not.toHaveBeenCalled();

      // Provenance is derived from the caller. An RPC client must not be able to
      // stamp `agent:<id>` on work a human did (or the reverse).
      const forged = await callMethod(
        methods.get("dashboard.tab.create")!,
        { title: "Finance Ops", actor: "agent:main" },
        broadcast,
      );
      expect(forged.response?.[0]).toBe(false);
      expect(forged.response?.[2]?.message).toContain("unexpected param: actor");
      expect(broadcast).not.toHaveBeenCalled();

      const created = await callMethod(
        methods.get("dashboard.tab.create")!,
        { title: "Finance Ops" },
        broadcast,
      );

      expect(created.response?.[0]).toBe(true);
      expect(created.response?.[1]).toMatchObject({
        doc: {
          workspaceVersion: 2,
          tabs: expect.arrayContaining([expect.objectContaining({ slug: "finance-ops" })]),
        },
        workspaceVersion: 2,
      });
      expect(broadcast).toHaveBeenCalledWith("plugin.dashboard.changed", {
        workspaceVersion: 2,
        changedTabSlug: "finance-ops",
        actor: "user",
      });
    });
  });

  it("rejects unknown params and bad shapes without broadcasting", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerDashboardGatewayMethods({ api, store: new DashboardStore({ stateDir }) });
      const broadcast = vi.fn();

      const response = await callMethod(
        methods.get("dashboard.tab.create")!,
        { title: "Bad", unexpected: true },
        broadcast,
      );

      expect(response.response?.[0]).toBe(false);
      expect(response.response?.[2]?.message).toContain("unexpected param");
      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  it("applies widget, workspace replace, undo, and data read methods", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerDashboardGatewayMethods({
        api,
        store: new DashboardStore({ stateDir }),
      });
      const broadcast = vi.fn();

      await callMethod(
        methods.get("dashboard.tab.create")!,
        { slug: "ops", title: "Ops" },
        broadcast,
      );
      await callMethod(
        methods.get("dashboard.widget.add")!,
        {
          tab: "ops",
          widget: {
            kind: "builtin:markdown",
            title: "Notes",
            grid: { x: 0, y: 0, w: 4, h: 2 },
          },
        },
        broadcast,
      );
      const updated = await callMethod(
        methods.get("dashboard.widget.update")!,
        { tab: "ops", id: "notes", patch: { collapsed: true } },
        broadcast,
      );
      expect(
        updated.response?.[1]?.doc.tabs.find((tab: { slug: string }) => tab.slug === "ops"),
      ).toMatchObject({
        widgets: [expect.objectContaining({ id: "notes", collapsed: true })],
      });

      await callMethod(
        methods.get("dashboard.widget.move")!,
        { tab: "ops", id: "notes", grid: { x: 4, y: 0, w: 4, h: 2 } },
        broadcast,
      );
      const ambiguousMove = await callMethod(
        methods.get("dashboard.widget.move")!,
        { tab: "ops", id: "notes", grid: { x: 0, y: 0, w: 4, h: 2 }, toTab: "main" },
        broadcast,
      );
      expect(ambiguousMove.response?.[0]).toBe(false);
      expect(ambiguousMove.response?.[2]?.message).toContain("not both");
      await callMethod(
        methods.get("dashboard.widget.setLayout")!,
        { tab: "ops", layout: [{ id: "notes", grid: { x: 0, y: 3, w: 6, h: 3 } }] },
        broadcast,
      );
      // Approval decides on a scaffolded widget; it cannot mint a registry entry.
      const orphanApprove = await callMethod(
        methods.get("dashboard.widget.approve")!,
        { name: "custom-chart", decision: "approved" },
        broadcast,
      );
      expect(orphanApprove.response?.[0]).toBe(false);
      expect(orphanApprove.response?.[2]?.message).toContain("not found");

      const scaffolded = await callMethod(
        methods.get("dashboard.widget.scaffold")!,
        { name: "custom-chart" },
        broadcast,
      );
      expect(scaffolded.response?.[1]?.registry).toEqual({
        status: "pending",
        createdBy: "user",
      });
      const approved = await callMethod(
        methods.get("dashboard.widget.approve")!,
        { name: "custom-chart", decision: "approved" },
        broadcast,
      );
      // Approvals-only callers get the registry entry, never the whole document.
      expect(approved.response?.[1]).toMatchObject({
        name: "custom-chart",
        registry: { status: "approved", approvedBy: "user" },
      });
      expect(approved.response?.[1]?.doc).toBeUndefined();
      const data = await callMethod(
        methods.get("dashboard.data.read")!,
        { binding: { source: "static", value: { ok: true } } },
        broadcast,
      );
      expect(data.response?.[1]).toEqual({ data: { ok: true } });
      const rpcData = await callMethod(
        methods.get("dashboard.data.read")!,
        { binding: { source: "rpc", method: "sessions.list" } },
        broadcast,
      );
      expect(rpcData.response?.[0]).toBe(false);
      expect(rpcData.response?.[2]).toMatchObject({ code: "binding_client_resolved" });

      const beforeReplace = await callMethod(
        methods.get("dashboard.workspace.get")!,
        {},
        broadcast,
      );
      const replacement = structuredClone(beforeReplace.response?.[1]?.doc);
      replacement.tabs = [replacement.tabs.find((tab: { slug: string }) => tab.slug === "ops")];
      replacement.prefs.tabOrder = ["ops"];
      await callMethod(
        methods.get("dashboard.workspace.replace")!,
        { doc: replacement },
        broadcast,
      );

      const undo = await callMethod(methods.get("dashboard.workspace.undo")!, {}, broadcast);
      expect(undo.response?.[0]).toBe(true);
      expect(
        undo.response?.[1]?.doc.tabs.some((tab: { slug: string }) => tab.slug === "main"),
      ).toBe(true);
      // create + add + update + move + setLayout + scaffold + approve + replace + undo
      expect(broadcast).toHaveBeenCalledTimes(9);
    });
  });
});

describe("dashboard broadcast handle", () => {
  it("remembers the server broadcast so agent tools can announce changes off-request", async () => {
    resetDashboardBroadcastForTest();
    expect(dashboardBroadcast()).toBeUndefined();

    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerDashboardGatewayMethods({ api, store: new DashboardStore({ stateDir }) });
      const broadcast = vi.fn();

      // A read populates the slot; agent turns started from a channel or cron have
      // no gateway request scope and rely on it.
      await callMethod(methods.get("dashboard.workspace.get")!, {}, broadcast);

      expect(dashboardBroadcast()).toBe(broadcast);
    });
  });
});
