import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceCli } from "./cli.js";
import { registerWorkspaceGatewayMethods } from "./gateway.js";
import { WorkspaceStore } from "./store.js";
import { createWorkspaceTools } from "./tools.js";

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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-tools-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function toolsByName(store: WorkspaceStore, broadcast?: (event: string, payload: unknown) => void) {
  const api = {} as unknown as OpenClawPluginApi;
  return new Map(
    createWorkspaceTools({
      api,
      store,
      ...(broadcast ? { broadcast } : {}),
      context: { agentId: "main", sessionKey: "session-1" } as never,
    }).map((tool) => [tool.name, tool]),
  );
}

describe("workspace tools", () => {
  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
    pluginRuntime.scope = undefined;
  });

  it("defines strict schemas for every workspace tool", () => {
    const tools = toolsByName(new WorkspaceStore({ stateDir: "/tmp/unused" }));
    expect([...tools.keys()]).toEqual([
      "workspace_get",
      "workspace_tab_get",
      "workspace_change_request_create",
      "workspace_change_request_list",
      "workspace_change_request_cancel",
      "workspace_tab_create",
      "workspace_tab_update",
      "workspace_tab_delete",
      "workspace_tabs_reorder",
      "workspace_widget_add",
      "workspace_widget_update",
      "workspace_widget_move",
      "workspace_widget_remove",
      "workspace_layout_set",
      "workspace_replace",
      "workspace_widget_scaffold",
      "workspace_undo",
      "workspace_data_read",
    ]);
    const validSamples: Record<string, unknown> = {
      workspace_get: {},
      workspace_tab_get: { id: "main" },
      workspace_change_request_create: {
        tabId: "main",
        baseRevision: 1,
        proposal: {},
        idempotencyKey: "request-1",
      },
      workspace_change_request_list: { tabId: "main" },
      workspace_change_request_cancel: { tabId: "main", requestId: "request-1" },
      workspace_tab_create: { title: "Finance" },
      workspace_tab_update: { slug: "main", hidden: true },
      workspace_tab_delete: { slug: "old" },
      workspace_tabs_reorder: { order: ["main"] },
      workspace_widget_add: {
        tab: "main",
        kind: "builtin:markdown",
        grid: { x: 0, y: 0, w: 4, h: 2 },
      },
      workspace_widget_update: { tab: "main", id: "cost-today", collapsed: true },
      workspace_widget_move: { tab: "main", id: "cost-today", grid: { x: 4, y: 0, w: 4, h: 2 } },
      workspace_widget_remove: { tab: "main", id: "cost-today" },
      workspace_layout_set: {
        tab: "main",
        layout: [{ id: "cost-today", grid: { x: 0, y: 0, w: 4, h: 2 } }],
      },
      workspace_replace: {
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
      workspace_widget_scaffold: { name: "custom-card" },
      workspace_undo: {},
      workspace_data_read: { binding: { source: "static", value: { ok: true } } },
    };
    for (const [name, tool] of tools) {
      expect(Value.Check(tool.parameters, validSamples[name])).toBe(true);
      expect(Value.Check(tool.parameters, { ...(validSamples[name] as object), extra: true })).toBe(
        false,
      );
    }
  });

  it("keeps workspace_get available to ordinary unbound local agent contexts", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const result = await toolsByName(store).get("workspace_get")?.execute("local-read", {});
      expect(details(result).doc).toMatchObject({ workspaceId: "default" });
      store.close();
    });
  });

  it("authorizes and returns only one exact tab for a delegated tool call", async () => {
    await withTempStateDir(async (stateDir) => {
      const legacy = new WorkspaceStore({ stateDir });
      const domainStore = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
      domainStore.mutate(
        (draft) => {
          draft.tabs[0]!.title = "Shared tab";
          draft.tabs[0]!.widgets.push({
            id: "private-widget",
            kind: "custom:private-dashboard",
            title: "Private",
            grid: { x: 0, y: 4, w: 12, h: 4 },
            collapsed: false,
            hidden: false,
            createdBy: "user",
            bindings: { source: { source: "file", path: "private.json" } },
            props: { secret: "do-not-return" },
          });
        },
        { actor: "user" },
      );
      const toolContext = { agentId: "main", sessionKey: "agent:main:main" } as never;
      const callContext = { callId: "call-1" };
      const requireContext = vi.fn(() => callContext);
      const decide = vi.fn(async () => ({
        allowed: true as const,
        context: {
          isolationDomainId: "domain-1",
          principal: { id: "principal-agent", kind: "agent" as const },
          delegatedSession: {
            id: "delegation-1",
            assignmentId: "assignment-1",
            sponsorPrincipalId: "principal-owner",
          },
          requestId: "call-1",
        },
      }));
      const api = {
        teams: {
          context: { isBound: vi.fn(() => true), require: requireContext },
          authorization: { decide },
        },
      };
      const tools = new Map(
        createWorkspaceTools({
          api: api as unknown as OpenClawPluginApi,
          context: toolContext,
          store: legacy,
          storeForDomain: (domainId) => (domainId === "domain-1" ? domainStore : legacy),
        }).map((tool) => [tool.name, tool]),
      );

      const result = await tools.get("workspace_tab_get")?.execute("call-1", { id: "main" });
      expect(requireContext).toHaveBeenCalledWith(toolContext);
      expect(decide).toHaveBeenCalledWith({
        context: callContext,
        permission: "workspaces.tab.read",
        resources: [{ namespace: "workspaces", type: "tab", id: "main" }],
      });
      expect(details(result)).toEqual({
        workspaceId: "default",
        workspaceVersion: 2,
        tab: expect.objectContaining({ id: "main", revision: 2, title: "Shared tab" }),
      });
      expect(JSON.stringify(details(result))).not.toContain("private.json");
      expect(JSON.stringify(details(result))).not.toContain("do-not-return");
      const updated = await tools.get("workspace_tab_update")?.execute("call-2", {
        id: "main",
        ifRevision: 2,
        title: "Delegated edit",
      });
      expect(decide).toHaveBeenLastCalledWith({
        context: callContext,
        permission: "workspaces.tab.write",
        resources: [{ namespace: "workspaces", type: "tab", id: "main" }],
      });
      expect(details(updated)).toMatchObject({
        workspaceId: "default",
        workspaceVersion: 3,
        tab: { id: "main", revision: 3, title: "Delegated edit" },
      });
      expect(details(updated)).not.toHaveProperty("doc");
      expect(JSON.stringify(details(updated))).not.toContain("private.json");
      expect(JSON.stringify(details(updated))).not.toContain("do-not-return");
      const current = domainStore.read().tabs[0]!;
      const proposal = {
        slug: current.slug,
        title: "Agent proposal",
        ...(current.icon ? { icon: current.icon } : {}),
        hidden: current.hidden,
        widgets: current.widgets.map(({ createdBy: _createdBy, ...widget }) => widget),
      };
      const createdRequest = await tools.get("workspace_change_request_create")?.execute("call-3", {
        tabId: "main",
        baseRevision: 3,
        proposal,
        idempotencyKey: "request-1",
      });
      const requestId = (details(createdRequest).request as { id: string }).id;
      expect(details(createdRequest)).toMatchObject({
        request: {
          id: requestId,
          state: "pending",
          requester: {
            principalId: "principal-agent",
            kind: "agent",
            delegationId: "delegation-1",
            sponsorPrincipalId: "principal-owner",
          },
        },
      });
      const listed = await tools.get("workspace_change_request_list")?.execute("call-4", {
        tabId: "main",
        state: "pending",
      });
      expect(details(listed).requests).toEqual([
        expect.objectContaining({ id: requestId, state: "pending" }),
      ]);
      const cancelled = await tools.get("workspace_change_request_cancel")?.execute("call-5", {
        tabId: "main",
        requestId,
      });
      expect(details(cancelled)).toMatchObject({
        request: { id: requestId, state: "cancelled" },
      });
      await expect(
        tools.get("workspace_replace")?.execute("call-admin", { doc: domainStore.read() }),
      ).rejects.toThrow(/admin tool is unavailable/i);
      legacy.close();
      domainStore.close();
    });
  });

  it("fails closed when a bound Teams tool context is no longer active", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const api = {
        teams: {
          context: {
            isBound: vi.fn(() => true),
            require: vi.fn(() => {
              throw new Error("tool invocation is inactive");
            }),
          },
          authorization: { decide: vi.fn() },
        },
      };
      const tools = new Map(
        createWorkspaceTools({
          api: api as unknown as OpenClawPluginApi,
          context: { agentId: "main", sessionKey: "agent:main:main" } as never,
          store,
        }).map((tool) => [tool.name, tool]),
      );

      await expect(tools.get("workspace_get")?.execute("call-read", {})).rejects.toThrow(
        /inactive/i,
      );
      await expect(
        tools.get("workspace_replace")?.execute("call-admin", { doc: store.read() }),
      ).rejects.toThrow(/inactive/i);
      store.close();
    });
  });

  it("stamps tool provenance from context and rejects createdBy override params", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const broadcast = vi.fn();
      const tools = toolsByName(store, broadcast);

      await expect(
        tools.get("workspace_tab_create")?.execute("call-1", {
          title: "Bad",
          createdBy: "user",
        }),
      ).rejects.toThrow("unexpected param");
      await tools.get("workspace_tab_create")?.execute("call-2", {
        title: "Finance",
        slug: "finance",
      });

      expect(store.read().tabs.find((tab) => tab.slug === "finance")).toMatchObject({
        createdBy: "agent:main",
      });
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith("plugin.workspaces.changed", {
        workspaceVersion: 2,
        changedTabSlug: "finance",
        actor: "agent:main",
      });
    });
  });

  it("broadcasts through the active runtime gateway request scope", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const broadcast = vi.fn();
      pluginRuntime.scope = { context: { broadcast } };
      const tools = toolsByName(store);

      await tools.get("workspace_tab_create")?.execute("call-1", {
        title: "Runtime Scope",
        slug: "runtime-scope",
      });

      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith("plugin.workspaces.changed", {
        workspaceVersion: 2,
        changedTabSlug: "runtime-scope",
        actor: "agent:main",
      });
    });
  });

  it("sanitizes agent workspace replacement provenance and approvals", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      // Seed an already-approved widget through the store primitive: `replace` is
      // reconciled and by design cannot mint an approval.
      store.mutate(
        (draft) => {
          draft.widgetsRegistry["approved-card"] = {
            status: "approved",
            createdBy: "user",
            approvedBy: "user",
            approvedAt: "2026-01-01T00:00:00.000Z",
          };
        },
        { actor: "user" },
      );

      const tools = toolsByName(store);
      const replacement = structuredClone(store.read());
      replacement.tabs[0]!.createdBy = "agent:forged";
      replacement.tabs.push({
        id: "agent-tab",
        revision: 1,
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

      await tools.get("workspace_replace")?.execute("call-1", { doc: replacement });

      const next = store.read();
      // Provenance is immutable once stamped: the agent cannot relabel the seeded
      // system tab as its own, nor claim its own new tab was authored by a human.
      expect(next.tabs.find((tab) => tab.slug === "main")?.createdBy).toBe("system");
      expect(next.tabs.find((tab) => tab.slug === "agent-tab")?.createdBy).toBe("agent:main");
      expect(next.widgetsRegistry["approved-card"]).toEqual({
        status: "approved",
        createdBy: "user",
        approvedBy: "user",
        approvedAt: "2026-01-01T00:00:00.000Z",
      });
      // A registry name the agent invented is dropped: only workspace_widget_scaffold
      // mints entries, so an operator can never be asked to approve a name whose code
      // does not exist yet.
      expect(next.widgetsRegistry["new-card"]).toBeUndefined();
    });
  });

  it("mutates widgets, reads data, and broadcasts one change per write", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const broadcast = vi.fn();
      const tools = toolsByName(store, broadcast);

      await tools.get("workspace_tab_create")?.execute("call-1", {
        title: "Ops",
        slug: "ops",
      });
      const addResult = details(
        await tools.get("workspace_widget_add")?.execute("call-2", {
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
      await tools.get("workspace_widget_move")?.execute("call-3", {
        tab: "ops",
        id: "notes",
        grid: { x: 4, y: 0, w: 4, h: 2 },
      });
      const data = details(
        await tools.get("workspace_data_read")?.execute("call-4", {
          binding: { source: "static", value: { ok: true } },
        }),
      );
      expect(data).toEqual({ data: { ok: true } });
      expect(broadcast).toHaveBeenCalledTimes(3);
    });
  });

  it("scaffolds agent-authored widgets as pending with a standalone bridge template", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const tools = toolsByName(store);

      await tools.get("workspace_widget_scaffold")?.execute("call-1", {
        name: "agent-chart",
        title: "Agent Chart",
      });

      const widgetDir = path.join(stateDir, "workspaces", "widgets", "agent-chart");
      const htmlPath = path.join(widgetDir, "index.html");
      const html = await fs.readFile(htmlPath, "utf8");
      expect(html).toContain("workspace:ready");
      expect(html).toContain("workspace:getData");
      expect(html).toContain("function onData");
      expect(html).not.toMatch(/https?:\/\//);
      expect(store.read().widgetsRegistry["agent-chart"]).toMatchObject({
        status: "pending",
        createdBy: "agent:main",
      });

      await fs.writeFile(htmlPath, "custom implementation", "utf8");
      await expect(
        tools.get("workspace_widget_scaffold")?.execute("call-2", {
          name: "agent-chart",
          title: "Replacement",
        }),
      ).rejects.toThrow("widget already exists");
      expect(await fs.readFile(htmlPath, "utf8")).toBe("custom implementation");
      expect(store.read().widgetsRegistry["agent-chart"]).toMatchObject({
        status: "pending",
        createdBy: "agent:main",
      });
    });
  });

  it("workspace_widget_update applies a patch addressed by tab + id", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const tools = toolsByName(store);

      // Regression: the tool passed its whole param record to the patch reader,
      // whose allowlist rejects `tab`/`id` — so no call could ever succeed.
      await tools.get("workspace_widget_update")?.execute("call-1", {
        tab: "main",
        id: "cost-today",
        title: "Spend today",
        collapsed: true,
      });

      const widget = store.read().tabs[0]?.widgets.find((entry) => entry.id === "cost-today");
      expect(widget).toMatchObject({ title: "Spend today", collapsed: true });
    });
  });

  it("workspace_data_read reports rpc bindings as client-resolved, not as a failure", async () => {
    await withTempStateDir(async (stateDir) => {
      const tools = toolsByName(new WorkspaceStore({ stateDir }));

      const result = await tools
        .get("workspace_data_read")
        ?.execute("call-1", { binding: { source: "rpc", method: "usage.cost" } });

      const [entry] = result?.content ?? [];
      expect(entry?.type === "text" && entry.text).toContain("binding_client_resolved");
    });
  });

  it("rejects scaffold names that would escape the widgets directory", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const tools = toolsByName(store);

      await expect(
        tools.get("workspace_widget_scaffold")?.execute("call-1", { name: ".." }),
      ).rejects.toThrow("widget name is invalid");
      await expect(fs.stat(path.join(stateDir, "workspaces", "widget.json"))).rejects.toThrow();
    });
  });

  it("shares one store between tool writes and CLI reads", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
      registerWorkspaceGatewayMethods({
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
      await tools.get("workspace_tab_create")?.execute("call-1", {
        title: "Tool Tab",
        slug: "tool-tab",
      });

      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
      registerWorkspaceCli({ program, stateDir });
      const chunks: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
        chunks.push(String(chunk));
        return true;
      });
      try {
        await program.parseAsync(["workspaces", "tabs", "list", "--json"], { from: "user" });
      } finally {
        write.mockRestore();
      }
      expect(JSON.parse(chunks.join(""))).toMatchObject({
        tabs: [expect.any(Object), expect.objectContaining({ slug: "tool-tab" })],
      });
    });
  });
});
