import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDashboardCli } from "./cli.js";
import { registerDashboardGatewayMethods } from "./gateway.js";
import { DashboardStore } from "./store.js";
import { createDashboardTools } from "./tools.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
}));
const pluginRuntime = vi.hoisted(() => ({
  scope: undefined as
    | { context?: { broadcast?: (event: string, payload: unknown) => void } }
    | undefined,
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/gateway-runtime")>(
    "openclaw/plugin-sdk/gateway-runtime",
  );
  return {
    ...actual,
    callGatewayFromCli: gatewayRuntime.callGatewayFromCli,
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-runtime")>(
    "openclaw/plugin-sdk/plugin-runtime",
  );
  return {
    ...actual,
    getPluginRuntimeGatewayRequestScope: () => pluginRuntime.scope,
  };
});

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dashboard-tools-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function toolsByName(store: DashboardStore, broadcast?: (event: string, payload: unknown) => void) {
  const api = {} as unknown as OpenClawPluginApi;
  return new Map(
    createDashboardTools({
      api,
      store,
      ...(broadcast ? { broadcast } : {}),
      context: { agentId: "main", sessionKey: "session-1" } as never,
    }).map((tool) => [tool.name, tool]),
  );
}

describe("dashboard tools", () => {
  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
    pluginRuntime.scope = undefined;
  });

  it("defines strict schemas for every dashboard tool", () => {
    const tools = toolsByName(new DashboardStore({ stateDir: "/tmp/unused" }));
    expect([...tools.keys()]).toEqual([
      "dashboard_workspace_get",
      "dashboard_tab_create",
      "dashboard_tab_update",
      "dashboard_tab_delete",
      "dashboard_tabs_reorder",
      "dashboard_widget_add",
      "dashboard_widget_update",
      "dashboard_widget_move",
      "dashboard_widget_remove",
      "dashboard_layout_set",
      "dashboard_workspace_replace",
      "dashboard_widget_scaffold",
      "dashboard_undo",
      "dashboard_data_read",
    ]);
    const validSamples: Record<string, unknown> = {
      dashboard_workspace_get: {},
      dashboard_tab_create: { title: "Finance" },
      dashboard_tab_update: { slug: "main", hidden: true },
      dashboard_tab_delete: { slug: "old" },
      dashboard_tabs_reorder: { order: ["main"] },
      dashboard_widget_add: {
        tab: "main",
        kind: "builtin:markdown",
        grid: { x: 0, y: 0, w: 4, h: 2 },
      },
      dashboard_widget_update: { tab: "main", id: "cost-today", collapsed: true },
      dashboard_widget_move: { tab: "main", id: "cost-today", grid: { x: 4, y: 0, w: 4, h: 2 } },
      dashboard_widget_remove: { tab: "main", id: "cost-today" },
      dashboard_layout_set: {
        tab: "main",
        layout: [{ id: "cost-today", grid: { x: 0, y: 0, w: 4, h: 2 } }],
      },
      dashboard_workspace_replace: {
        doc: {
          schemaVersion: 1,
          workspaceVersion: 1,
          tabs: [
            {
              slug: "main",
              title: "Main",
              hidden: false,
              createdBy: "system",
              widgets: [],
            },
          ],
          widgetsRegistry: {},
          prefs: { tabOrder: ["main"] },
        },
      },
      dashboard_widget_scaffold: { name: "custom-card" },
      dashboard_undo: {},
      dashboard_data_read: { binding: { source: "static", value: { ok: true } } },
    };
    for (const [name, tool] of tools) {
      expect(Value.Check(tool.parameters, validSamples[name])).toBe(true);
      expect(Value.Check(tool.parameters, { ...(validSamples[name] as object), extra: true })).toBe(
        false,
      );
    }
  });

  it("stamps tool provenance from context and rejects createdBy override params", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const broadcast = vi.fn();
      const tools = toolsByName(store, broadcast);

      await expect(
        tools.get("dashboard_tab_create")?.execute("call-1", {
          title: "Bad",
          createdBy: "user",
        }),
      ).rejects.toThrow("unexpected param");
      await tools.get("dashboard_tab_create")?.execute("call-2", {
        title: "Finance",
        slug: "finance",
      });

      expect((await store.read()).tabs.find((tab) => tab.slug === "finance")).toMatchObject({
        createdBy: "agent:main",
      });
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith("plugin.dashboard.changed", {
        workspaceVersion: 2,
        changedTabSlug: "finance",
        actor: "agent:main",
      });
    });
  });

  it("broadcasts through the active runtime gateway request scope", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const broadcast = vi.fn();
      pluginRuntime.scope = { context: { broadcast } };
      const tools = toolsByName(store);

      await tools.get("dashboard_tab_create")?.execute("call-1", {
        title: "Runtime Scope",
        slug: "runtime-scope",
      });

      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith("plugin.dashboard.changed", {
        workspaceVersion: 2,
        changedTabSlug: "runtime-scope",
        actor: "agent:main",
      });
    });
  });

  it("sanitizes agent workspace replacement provenance and approvals", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const seed = await store.read();
      seed.tabs[0]!.createdBy = "user";
      seed.widgetsRegistry["approved-card"] = {
        status: "approved",
        createdBy: "user",
        approvedBy: "user",
        approvedAt: "2026-01-01T00:00:00.000Z",
      };
      await store.replace(seed, { actor: "user" });

      const tools = toolsByName(store);
      const replacement = structuredClone(await store.read());
      replacement.tabs[0]!.createdBy = "agent:forged";
      replacement.tabs.push({
        slug: "agent-tab",
        title: "Agent Tab",
        hidden: false,
        createdBy: "user",
        widgets: [],
      });
      replacement.prefs.tabOrder.push("agent-tab");
      replacement.widgetsRegistry["approved-card"] = {
        status: "pending",
        createdBy: "agent:forged",
      };
      replacement.widgetsRegistry["new-card"] = {
        status: "approved",
        createdBy: "user",
        approvedBy: "user",
        approvedAt: "2026-01-02T00:00:00.000Z",
      };

      await tools.get("dashboard_workspace_replace")?.execute("call-1", { doc: replacement });

      const next = await store.read();
      expect(next.tabs.find((tab) => tab.slug === "main")?.createdBy).toBe("user");
      expect(next.tabs.find((tab) => tab.slug === "agent-tab")?.createdBy).toBe("agent:main");
      expect(next.widgetsRegistry["approved-card"]).toEqual({
        status: "approved",
        createdBy: "user",
        approvedBy: "user",
        approvedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(next.widgetsRegistry["new-card"]).toEqual({
        status: "pending",
        createdBy: "agent:main",
      });
    });
  });

  it("mutates widgets, reads data, and broadcasts one change per write", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const broadcast = vi.fn();
      const tools = toolsByName(store, broadcast);

      await tools.get("dashboard_tab_create")?.execute("call-1", {
        title: "Ops",
        slug: "ops",
      });
      const addResult = details(
        await tools.get("dashboard_widget_add")?.execute("call-2", {
          tab: "ops",
          id: "notes",
          kind: "builtin:markdown",
          title: "Notes",
          grid: { x: 0, y: 0, w: 4, h: 2 },
          bindings: { value: { source: "static", value: "hello" } },
        }),
      );
      expect(addResult.doc).toMatchObject({
        tabs: [
          expect.any(Object),
          expect.objectContaining({
            slug: "ops",
            widgets: [expect.objectContaining({ id: "notes", title: "Notes" })],
          }),
        ],
      });
      await tools.get("dashboard_widget_move")?.execute("call-3", {
        tab: "ops",
        id: "notes",
        grid: { x: 4, y: 0, w: 4, h: 2 },
      });
      const data = details(
        await tools.get("dashboard_data_read")?.execute("call-4", {
          binding: { source: "static", value: { ok: true } },
        }),
      );
      expect(data).toEqual({ data: { ok: true } });
      expect(broadcast).toHaveBeenCalledTimes(3);
    });
  });

  it("scaffolds agent-authored widgets as pending with a standalone bridge template", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const tools = toolsByName(store);

      await tools.get("dashboard_widget_scaffold")?.execute("call-1", {
        name: "agent-chart",
        title: "Agent Chart",
      });

      const widgetDir = path.join(stateDir, "dashboard", "widgets", "agent-chart");
      const htmlPath = path.join(widgetDir, "index.html");
      const html = await fs.readFile(htmlPath, "utf8");
      expect(html).toContain("dashboard:ready");
      expect(html).toContain("dashboard:getData");
      expect(html).toContain("function onData");
      expect(html).not.toMatch(/https?:\/\//);
      expect((await store.read()).widgetsRegistry["agent-chart"]).toMatchObject({
        status: "pending",
        createdBy: "agent:main",
      });

      await fs.writeFile(htmlPath, "custom implementation", "utf8");
      await expect(
        tools.get("dashboard_widget_scaffold")?.execute("call-2", {
          name: "agent-chart",
          title: "Replacement",
        }),
      ).rejects.toThrow("widget already exists");
      expect(await fs.readFile(htmlPath, "utf8")).toBe("custom implementation");
      expect((await store.read()).widgetsRegistry["agent-chart"]).toMatchObject({
        status: "pending",
        createdBy: "agent:main",
      });
    });
  });

  it("rejects scaffold names that would escape the widgets directory", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const tools = toolsByName(store);

      await expect(
        tools.get("dashboard_widget_scaffold")?.execute("call-1", { name: ".." }),
      ).rejects.toThrow("widget name is invalid");
      await expect(fs.stat(path.join(stateDir, "dashboard", "widget.json"))).rejects.toThrow();
    });
  });

  it("shares one store between tool writes and CLI reads", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
      registerDashboardGatewayMethods({
        api: {
          registerGatewayMethod: vi.fn((method: string, handler) => methods.set(method, handler)),
        } as unknown as OpenClawPluginApi,
        store,
      });
      gatewayRuntime.callGatewayFromCli.mockImplementation(
        async (method: string, _opts: unknown, params: unknown) => {
          const respond = vi.fn();
          await methods.get(method)?.({
            params: params ?? {},
            respond,
            context: { broadcast: vi.fn() },
          } as never);
          const [ok, result, error] = respond.mock.calls[0] ?? [];
          if (ok) {
            return result;
          }
          throw new Error(error?.message ?? "gateway error");
        },
      );
      const tools = toolsByName(store);
      await tools.get("dashboard_tab_create")?.execute("call-1", {
        title: "Tool Tab",
        slug: "tool-tab",
      });

      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
      registerDashboardCli({ program, stateDir });
      const chunks: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
        chunks.push(String(chunk));
        return true;
      });
      try {
        await program.parseAsync(["dashboard", "tabs", "list", "--json"], { from: "user" });
      } finally {
        write.mockRestore();
      }
      expect(JSON.parse(chunks.join(""))).toMatchObject({
        tabs: [expect.any(Object), expect.objectContaining({ slug: "tool-tab" })],
      });
    });
  });
});
