import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { workspaceBroadcast, resetWorkspaceBroadcastForTest } from "./broadcast.js";
import { registerWorkspaceGatewayMethods } from "./gateway.js";
import { WorkspaceStore } from "./store.js";

type RegisteredMethod = {
  handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
  opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
};

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-gateway-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createApi(
  options: {
    teamsDomainId?: string;
    principalId?: string;
    ownerPrincipalId?: string;
    capabilityMode?: "read" | "request" | "write";
  } = {},
) {
  const methods = new Map<string, RegisteredMethod>();
  const api = {
    teams: {
      context: {
        require: vi.fn(() => {
          if (!options.teamsDomainId) {
            throw new Error("no Teams context");
          }
          return {
            isolationDomainId: options.teamsDomainId,
            principal: { id: options.principalId ?? "principal-member", kind: "human" as const },
            requestId: "request-1",
          };
        }),
      },
      authorization: {
        decide: vi.fn(async ({ permission }: { permission: string }) => {
          const mode = options.capabilityMode ?? "read";
          const allowed =
            permission === "workspaces.tab.read" ||
            (permission === "workspaces.tab.changeRequest.create" && mode !== "read") ||
            (permission === "workspaces.tab.write" && mode === "write");
          return allowed
            ? {
                allowed: true as const,
                context: {
                  isolationDomainId: options.teamsDomainId ?? "domain-1",
                  principal: {
                    id: options.principalId ?? "principal-member",
                    kind: "human" as const,
                  },
                  requestId: "capability-check",
                },
              }
            : { allowed: false as const };
        }),
      },
      resources: {
        listChildren: vi.fn(async () => []),
        prepareRegister: vi.fn(
          async ({ resource }: { resource: { id: string } }) => `operation-${resource.id}`,
        ),
        prepareRetire: vi.fn(
          async ({ resource }: { resource: { id: string } }) => `retire-operation-${resource.id}`,
        ),
        replayPrepared: vi.fn(async () => undefined),
        owner: vi.fn(async () => ({
          principalId: options.ownerPrincipalId ?? options.principalId ?? "principal-member",
        })),
      },
    },
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

describe("workspace gateway methods", () => {
  it("registers all L1 methods with read/write scopes", () => {
    const { api, methods } = createApi();
    registerWorkspaceGatewayMethods({
      api,
      store: new WorkspaceStore({ stateDir: "/tmp/unused" }),
    });

    expect([...methods.keys()]).toEqual([
      "workspaces.get",
      "workspaces.tab.get",
      "workspaces.sharing.sync",
      "workspaces.widget.frame",
      "workspaces.tab.create",
      "workspaces.tab.update",
      "workspaces.changeRequest.create",
      "workspaces.changeRequest.list",
      "workspaces.changeRequest.get",
      "workspaces.changeRequest.cancel",
      "workspaces.changeRequest.decide",
      "workspaces.tab.delete",
      "workspaces.tab.reorder",
      "workspaces.widget.add",
      "workspaces.widget.update",
      "workspaces.widget.move",
      "workspaces.widget.remove",
      "workspaces.widget.setLayout",
      "workspaces.widget.scaffold",
      "workspaces.widget.approve",
      "workspaces.replace",
      "workspaces.undo",
      "workspaces.data.read",
    ]);
    expect(methods.get("workspaces.get")?.opts).toMatchObject({
      scope: "operator.read",
      access: {
        kind: "resource",
        permission: "workspaces.workspace.read",
      },
    });
    expect(methods.get("workspaces.widget.frame")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workspaces.data.read")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workspaces.tab.update")?.opts).toMatchObject({
      scope: "operator.write",
      access: { kind: "resource", permission: "workspaces.tab.write" },
    });
    // Approving agent-authored code is an approvals decision: operator.write alone
    // must not be enough to mount an untrusted widget.
    expect(methods.get("workspaces.widget.approve")?.opts).toEqual({
      scope: "operator.approvals",
    });
    const readOnly = new Set([
      "workspaces.get",
      "workspaces.tab.get",
      "workspaces.widget.frame",
      "workspaces.data.read",
    ]);
    for (const [name, method] of methods) {
      if (method.opts?.access) {
        continue;
      }
      if (
        readOnly.has(name) ||
        name === "workspaces.widget.approve" ||
        name === "workspaces.get" ||
        name === "workspaces.tab.get" ||
        name === "workspaces.tab.update"
      ) {
        continue;
      }
      expect(method.opts).toEqual({ scope: "operator.write" });
    }
  });

  it("lets the domain owner idempotently register the plugin-owned tab inventory", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi({ teamsDomainId: "domain-1" });
      const store = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
      store.mutate(
        (draft) => {
          draft.tabs.push({
            id: "finance",
            revision: 1,
            slug: "finance",
            title: "Finance",
            hidden: false,
            createdBy: "user",
            widgets: [],
          });
          draft.prefs.tabOrder.push("finance");
        },
        { actor: "user" },
      );
      registerWorkspaceGatewayMethods({ api, store, storeForDomain: () => store });

      const method = methods.get("workspaces.sharing.sync")!;
      expect(method.opts).toMatchObject({
        access: {
          kind: "resource",
          member: true,
          permission: "workspaces.workspace.manageSharing",
        },
      });
      const result = await callMethod(method, { workspaceId: "default" });

      expect(result.response).toEqual([
        true,
        {
          workspaceId: "default",
          tabs: expect.arrayContaining([
            expect.objectContaining({ id: "main", title: "Overview" }),
            { id: "finance", revision: 1, slug: "finance", title: "Finance" },
          ]),
        },
      ]);
      expect(api.teams.resources.prepareRegister).toHaveBeenCalledTimes(store.read().tabs.length);
      expect(api.teams.resources.prepareRegister).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: { namespace: "workspaces", type: "tab", id: "finance" },
          parent: { namespace: "workspaces", type: "workspace", id: "default" },
          requiredAction: "workspaces.workspace.manageSharing",
          idempotencyKey: "sharing-sync:default:finance",
        }),
      );
      expect(api.teams.resources.replayPrepared).toHaveBeenCalledTimes(store.read().tabs.length);
      store.close();
    });
  });

  it("retires authorization children that no longer exist in the workspace snapshot", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi({ teamsDomainId: "domain-1" });
      vi.mocked(api.teams.resources.listChildren).mockResolvedValue([
        { namespace: "workspaces", type: "tab", id: "main" },
        { namespace: "workspaces", type: "tab", id: "deleted-tab" },
      ]);
      const store = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
      registerWorkspaceGatewayMethods({ api, store, storeForDomain: () => store });

      const result = await callMethod(methods.get("workspaces.sharing.sync")!, {
        workspaceId: "default",
      });

      expect(result.response?.[0]).toBe(true);
      expect(api.teams.resources.prepareRetire).toHaveBeenCalledWith({
        context: expect.any(Object),
        resource: { namespace: "workspaces", type: "tab", id: "deleted-tab" },
        parent: { namespace: "workspaces", type: "workspace", id: "default" },
        requiredAction: "workspaces.workspace.manageSharing",
        idempotencyKey: "sharing-sync-retire:default:deleted-tab",
      });
      expect(api.teams.resources.replayPrepared).toHaveBeenCalledWith({
        operation: "retire-operation-deleted-tab",
      });
      store.close();
    });
  });

  it("resource-binds exact tab reads and returns no unrelated workspace state", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi({ teamsDomainId: "domain-1" });
      const store = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
      registerWorkspaceGatewayMethods({
        api,
        store,
        storeForDomain: (domainId) =>
          domainId === "domain-1"
            ? store
            : new WorkspaceStore({ stateDir, isolationDomainId: domainId }),
      });
      const method = methods.get("workspaces.tab.get")!;
      expect(method.opts).toMatchObject({
        scope: "operator.read",
        access: {
          kind: "resource",
          permission: "workspaces.tab.read",
        },
      });
      const access = method.opts?.access;
      if (access?.kind !== "resource") {
        throw new Error("expected resource access policy");
      }
      expect(
        await access.resolveResources({
          method: "workspaces.tab.get",
          params: { workspaceId: "default", id: "main" },
          config: {},
        }),
      ).toEqual([{ namespace: "workspaces", type: "tab", id: "main" }]);

      const read = await callMethod(method, { workspaceId: "default", id: "main" });
      expect(read.response).toEqual([
        true,
        {
          workspaceId: "default",
          workspaceVersion: 1,
          capabilityMode: "read",
          presence: [{ id: "principal-member", kind: "human", self: true }],
          tab: expect.objectContaining({ id: "main", revision: 1, slug: "main" }),
        },
      ]);
      expect(read.response?.[1]).not.toHaveProperty("widgetsRegistry");
      expect(read.response?.[1]).not.toHaveProperty("tabs");

      const missing = await callMethod(method, { workspaceId: "default", id: "missing" });
      expect(missing.response?.[0]).toBe(false);
      expect(missing.response?.[2]).toMatchObject({ code: "workspace_not_found" });
      expect(missing.response?.[2]?.message).toBe("workspace tab not found");

      const missingRevision = await callMethod(methods.get("workspaces.tab.update")!, {
        workspaceId: "default",
        id: "main",
        patch: { title: "Unsafe overwrite" },
      });
      expect(missingRevision.response?.[0]).toBe(false);
      expect(missingRevision.response?.[2]?.message).toBe("ifRevision must be a positive integer");
      expect(store.read().tabs[0]?.title).not.toBe("Unsafe overwrite");

      const updated = await callMethod(methods.get("workspaces.tab.update")!, {
        workspaceId: "default",
        id: "main",
        ifRevision: 1,
        patch: { title: "Member edit" },
      });
      expect(updated.response?.[0]).toBe(true);
      expect(updated.response?.[1]).toMatchObject({
        workspaceId: "default",
        tab: expect.objectContaining({ id: "main", revision: 2, title: "Member edit" }),
      });
      expect(updated.response?.[1]).not.toHaveProperty("doc");
      expect(updated.broadcast).not.toHaveBeenCalled();
      const stale = await callMethod(methods.get("workspaces.tab.update")!, {
        workspaceId: "default",
        id: "main",
        ifRevision: 1,
        patch: { title: "Stale edit" },
      });
      expect(stale.response?.[0]).toBe(false);
      expect(stale.response?.[2]).toMatchObject({ code: "workspace_conflict" });
      expect(store.read().tabs[0]?.title).toBe("Member edit");

      const current = store.read().tabs[0]!;
      const proposal = {
        slug: current.slug,
        title: "Requested edit",
        ...(current.icon ? { icon: current.icon } : {}),
        hidden: current.hidden,
        widgets: current.widgets.map(({ createdBy: _createdBy, ...widget }) => widget),
      };
      const createdRequest = await callMethod(methods.get("workspaces.changeRequest.create")!, {
        workspaceId: "default",
        tabId: "main",
        baseRevision: 2,
        proposal,
        idempotencyKey: "request-1",
      });
      expect(createdRequest.response?.[0]).toBe(true);
      const requestId = createdRequest.response?.[1]?.request.id as string;
      const listed = await callMethod(methods.get("workspaces.changeRequest.list")!, {
        workspaceId: "default",
        tabId: "main",
        state: "pending",
      });
      expect(listed.response?.[1]?.requests).toEqual([
        expect.objectContaining({ id: requestId, state: "pending", tabId: "main" }),
      ]);
      const decided = await callMethod(methods.get("workspaces.changeRequest.decide")!, {
        workspaceId: "default",
        tabId: "main",
        requestId,
        decision: "approved",
      });
      expect(decided.response?.[0]).toBe(true);
      expect(decided.response?.[1]).toMatchObject({
        applied: true,
        request: { id: requestId, state: "approved" },
        tab: { id: "main", revision: 3, title: "Requested edit" },
      });
      expect(decided.response?.[1]).not.toHaveProperty("doc");
      store.close();
    });
  });

  it("reports only fresh participants authorized for the exact tab", async () => {
    await withTempStateDir(async (stateDir) => {
      const identity = {
        teamsDomainId: "domain-1",
        principalId: "alice",
      };
      const { api, methods } = createApi(identity);
      const store = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
      store.mutate(
        (draft) => {
          draft.tabs.push({
            id: "private-review",
            revision: 1,
            slug: "private-review",
            title: "Private review",
            hidden: false,
            createdBy: "agent:reviewer",
            widgets: [],
          });
          draft.prefs.tabOrder.push("private-review");
        },
        { actor: "user" },
      );
      let now = 1_000;
      registerWorkspaceGatewayMethods({
        api,
        store,
        storeForDomain: () => store,
        presenceNow: () => now,
      });
      const method = methods.get("workspaces.tab.get")!;

      await callMethod(method, { workspaceId: "default", id: "main" });
      identity.principalId = "bob";
      now = 2_000;
      const together = await callMethod(method, { workspaceId: "default", id: "main" });
      expect(together.response?.[1]?.presence).toEqual([
        { id: "bob", kind: "human", self: true },
        { id: "alice", kind: "human", self: false },
      ]);

      identity.principalId = "charlie";
      now = 3_000;
      const otherTab = await callMethod(method, {
        workspaceId: "default",
        id: "private-review",
      });
      expect(otherTab.response?.[1]?.presence).toEqual([
        { id: "charlie", kind: "human", self: true },
      ]);

      identity.teamsDomainId = "domain-2";
      identity.principalId = "domain-two-member";
      now = 4_000;
      const otherDomain = await callMethod(method, { workspaceId: "default", id: "main" });
      expect(otherDomain.response?.[1]?.presence).toEqual([
        { id: "domain-two-member", kind: "human", self: true },
      ]);

      identity.teamsDomainId = "domain-1";
      identity.principalId = "bob";
      now = 33_001;
      const expired = await callMethod(method, { workspaceId: "default", id: "main" });
      expect(expired.response?.[1]?.presence).toEqual([{ id: "bob", kind: "human", self: true }]);
      store.close();
    });
  });

  it("refreshes an existing participant without evicting another entry at capacity", async () => {
    await withTempStateDir(async (stateDir) => {
      const identity = {
        teamsDomainId: "domain-1",
        principalId: "principal-0",
      };
      const { api, methods } = createApi(identity);
      const store = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
      registerWorkspaceGatewayMethods({
        api,
        store,
        storeForDomain: () => store,
        presenceNow: () => 1_000,
      });
      const method = methods.get("workspaces.tab.get")!;

      let response: Awaited<ReturnType<typeof callMethod>> | undefined;
      for (let index = 0; index < 1_024; index += 1) {
        identity.principalId = `principal-${index}`;
        response = await callMethod(method, { workspaceId: "default", id: "main" });
      }
      expect(response?.response?.[1]?.presence).toHaveLength(1_024);

      identity.principalId = "principal-500";
      const refreshed = await callMethod(method, { workspaceId: "default", id: "main" });
      expect(refreshed.response?.[1]?.presence).toHaveLength(1_024);
      expect(refreshed.response?.[1]?.presence).toContainEqual({
        id: "principal-0",
        kind: "human",
        self: false,
      });
      store.close();
    });
  });

  it("projects member-safe widgets and the strongest exact-tab capability", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi({
        teamsDomainId: "domain-1",
        capabilityMode: "request",
      });
      const store = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
      store.mutate(
        (draft) => {
          draft.tabs[0]!.widgets = [
            {
              id: "safe",
              kind: "builtin:markdown",
              title: "Safe",
              grid: { x: 0, y: 0, w: 6, h: 4 },
              collapsed: false,
              hidden: false,
              createdBy: "user",
              bindings: { copy: { source: "static", value: "hello" } },
              props: { markdown: "hello" },
            },
            {
              id: "file-backed",
              kind: "builtin:table",
              title: "Private file",
              grid: { x: 6, y: 0, w: 6, h: 4 },
              collapsed: false,
              hidden: false,
              createdBy: "user",
              bindings: { rows: { source: "file", path: "private.json" } },
            },
            {
              id: "custom",
              kind: "custom:private-dashboard",
              title: "Private custom",
              grid: { x: 0, y: 4, w: 12, h: 4 },
              collapsed: false,
              hidden: false,
              createdBy: "user",
              props: { secret: "do-not-project" },
            },
          ];
        },
        { actor: "user" },
      );
      registerWorkspaceGatewayMethods({ api, store, storeForDomain: () => store });

      const read = await callMethod(methods.get("workspaces.tab.get")!, {
        workspaceId: "default",
        id: "main",
      });

      expect(read.response?.[0]).toBe(true);
      expect(read.response?.[1]?.capabilityMode).toBe("request");
      expect(read.response?.[1]?.tab.widgets[0]).toMatchObject({
        id: "safe",
        kind: "builtin:markdown",
        bindings: { copy: { source: "static", value: "hello" } },
      });
      const projected = JSON.stringify(read.response?.[1]?.tab.widgets);
      expect(projected).not.toContain("private.json");
      expect(projected).not.toContain("custom:private-dashboard");
      expect(projected).not.toContain("do-not-project");
      expect(read.response?.[1]?.tab.widgets[1]).toMatchObject({
        id: "file-backed",
        kind: "builtin:markdown",
      });
      expect(read.response?.[1]?.tab.widgets[2]).toMatchObject({
        id: "custom",
        kind: "builtin:markdown",
      });
      store.close();
    });
  });

  it("expands a limited portal proposal without replacing hidden widget state", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi({
        teamsDomainId: "domain-1",
        capabilityMode: "request",
        ownerPrincipalId: "principal-owner",
      });
      const store = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
      store.mutate(
        (draft) => {
          draft.tabs[0]!.widgets.push({
            id: "private-custom",
            kind: "custom:private-dashboard",
            title: "Private",
            grid: { x: 0, y: 0, w: 12, h: 4 },
            collapsed: false,
            hidden: false,
            createdBy: "user",
            props: { secret: "preserve-me" },
          });
        },
        { actor: "user" },
      );
      registerWorkspaceGatewayMethods({ api, store, storeForDomain: () => store });

      const created = await callMethod(methods.get("workspaces.changeRequest.create")!, {
        workspaceId: "default",
        tabId: "main",
        baseRevision: 2,
        proposal: { title: "Requested title" },
        idempotencyKey: "limited-proposal-1",
      });
      expect(created.response?.[0]).toBe(true);
      const requestId = created.response?.[1]?.request.id as string;
      expect(JSON.stringify(created.response?.[1]?.request)).not.toContain("preserve-me");
      expect(created.response?.[1]?.request).not.toHaveProperty("proposalSha256");
      expect(created.response?.[1]?.request.proposal.widgets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "private-custom",
            kind: "builtin:markdown",
          }),
        ]),
      );
      expect(store.readChangeRequest(requestId)?.proposal).toMatchObject({
        title: "Requested title",
        widgets: expect.arrayContaining([
          expect.objectContaining({
            id: "private-custom",
            kind: "custom:private-dashboard",
            props: { secret: "preserve-me" },
          }),
        ]),
      });

      const listed = await callMethod(methods.get("workspaces.changeRequest.list")!, {
        workspaceId: "default",
        tabId: "main",
        state: "pending",
      });
      expect(JSON.stringify(listed.response?.[1]?.requests)).not.toContain("preserve-me");

      const { api: ownerApi, methods: ownerMethods } = createApi({
        teamsDomainId: "domain-1",
        principalId: "principal-owner",
        ownerPrincipalId: "principal-owner",
      });
      registerWorkspaceGatewayMethods({ api: ownerApi, store, storeForDomain: () => store });
      const ownerListed = await callMethod(ownerMethods.get("workspaces.changeRequest.list")!, {
        workspaceId: "default",
        tabId: "main",
        state: "pending",
      });
      expect(JSON.stringify(ownerListed.response?.[1]?.requests)).toContain("preserve-me");

      const decided = await callMethod(ownerMethods.get("workspaces.changeRequest.decide")!, {
        workspaceId: "default",
        tabId: "main",
        requestId,
        decision: "approved",
      });
      expect(decided.response?.[0]).toBe(true);
      expect(store.read().tabs[0]).toMatchObject({
        title: "Requested title",
        widgets: expect.arrayContaining([
          expect.objectContaining({
            id: "private-custom",
            kind: "custom:private-dashboard",
            props: { secret: "preserve-me" },
          }),
        ]),
      });
      store.close();
    });
  });

  it("does not let a different human owner approve the canonical owner's tab request", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi({
        teamsDomainId: "domain-1",
        principalId: "principal-domain-owner",
        ownerPrincipalId: "principal-tab-owner",
      });
      const store = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
      const tab = store.read().tabs[0]!;
      const proposal = {
        slug: tab.slug,
        title: "Proposal",
        ...(tab.icon ? { icon: tab.icon } : {}),
        hidden: tab.hidden,
        widgets: tab.widgets.map(({ createdBy: _createdBy, ...widget }) => widget),
      };
      const request = store.createChangeRequest({
        id: "request-1",
        tabId: tab.id,
        requester: { principalId: "principal-member", kind: "human" },
        baseTabRevision: tab.revision,
        idempotencyKey: "request-1",
        proposal,
      });
      registerWorkspaceGatewayMethods({ api, store, storeForDomain: () => store });

      const denied = await callMethod(methods.get("workspaces.changeRequest.decide")!, {
        workspaceId: "default",
        tabId: tab.id,
        requestId: request.id,
        decision: "approved",
      });
      expect(denied.response?.[0]).toBe(false);
      expect(denied.response?.[2]?.message).toMatch(/canonical human owner/i);
      expect(store.readChangeRequest(request.id)?.state).toBe("pending");
      store.close();
    });
  });

  it("returns the workspace without broadcasting and broadcasts successful writes", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerWorkspaceGatewayMethods({ api, store: new WorkspaceStore({ stateDir }) });
      const broadcast = vi.fn();

      const read = await callMethod(methods.get("workspaces.get")!, {}, broadcast);
      expect(read.response?.[0]).toBe(true);
      expect(read.response?.[1]).toMatchObject({ workspaceVersion: 1 });
      expect(broadcast).not.toHaveBeenCalled();

      // Provenance is derived from the caller. An RPC client must not be able to
      // stamp `agent:<id>` on work a human did (or the reverse).
      const forged = await callMethod(
        methods.get("workspaces.tab.create")!,
        { title: "Finance Ops", actor: "agent:main" },
        broadcast,
      );
      expect(forged.response?.[0]).toBe(false);
      expect(forged.response?.[2]?.message).toContain("unexpected param: actor");
      expect(broadcast).not.toHaveBeenCalled();

      const created = await callMethod(
        methods.get("workspaces.tab.create")!,
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
      expect(broadcast).toHaveBeenCalledWith("plugin.workspaces.changed", {
        workspaceVersion: 2,
        changedTabSlug: "finance-ops",
        actor: "user",
      });
    });
  });

  it("rejects unknown params and bad shapes without broadcasting", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerWorkspaceGatewayMethods({ api, store: new WorkspaceStore({ stateDir }) });
      const broadcast = vi.fn();

      const response = await callMethod(
        methods.get("workspaces.tab.create")!,
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
      registerWorkspaceGatewayMethods({
        api,
        store: new WorkspaceStore({ stateDir }),
      });
      const broadcast = vi.fn();

      await callMethod(
        methods.get("workspaces.tab.create")!,
        { slug: "ops", title: "Ops" },
        broadcast,
      );
      await callMethod(
        methods.get("workspaces.widget.add")!,
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
        methods.get("workspaces.widget.update")!,
        { tab: "ops", id: "notes", patch: { collapsed: true } },
        broadcast,
      );
      expect(
        updated.response?.[1]?.doc.tabs.find((tab: { slug: string }) => tab.slug === "ops"),
      ).toMatchObject({
        widgets: [expect.objectContaining({ id: "notes", collapsed: true })],
      });

      await callMethod(
        methods.get("workspaces.widget.move")!,
        { tab: "ops", id: "notes", grid: { x: 4, y: 0, w: 4, h: 2 } },
        broadcast,
      );
      const ambiguousMove = await callMethod(
        methods.get("workspaces.widget.move")!,
        { tab: "ops", id: "notes", grid: { x: 0, y: 0, w: 4, h: 2 }, toTab: "main" },
        broadcast,
      );
      expect(ambiguousMove.response?.[0]).toBe(false);
      expect(ambiguousMove.response?.[2]?.message).toContain("not both");
      await callMethod(
        methods.get("workspaces.widget.setLayout")!,
        { tab: "ops", layout: [{ id: "notes", grid: { x: 0, y: 3, w: 6, h: 3 } }] },
        broadcast,
      );
      // Approval decides on a scaffolded widget; it cannot mint a registry entry.
      const orphanApprove = await callMethod(
        methods.get("workspaces.widget.approve")!,
        { name: "custom-chart", decision: "approved" },
        broadcast,
      );
      expect(orphanApprove.response?.[0]).toBe(false);
      expect(orphanApprove.response?.[2]?.message).toContain("not found");

      const scaffolded = await callMethod(
        methods.get("workspaces.widget.scaffold")!,
        { name: "custom-chart" },
        broadcast,
      );
      expect(scaffolded.response?.[1]?.registry).toEqual({
        status: "pending",
        createdBy: "user",
      });
      const approved = await callMethod(
        methods.get("workspaces.widget.approve")!,
        { name: "custom-chart", decision: "approved" },
        broadcast,
      );
      // Approvals-only callers get the registry entry, never the whole document.
      expect(approved.response?.[1]).toMatchObject({
        name: "custom-chart",
        registry: { status: "approved", approvedBy: "user" },
      });
      expect(approved.response?.[1]?.doc).toBeUndefined();
      const frame = await callMethod(
        methods.get("workspaces.widget.frame")!,
        { name: "custom-chart" },
        broadcast,
      );
      expect(frame.response?.[0]).toBe(true);
      expect(frame.response?.[1]).toMatchObject({
        manifest: { name: "custom-chart", entrypoint: "index.html" },
        frameToken: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/),
        frameExpiresAt: expect.any(Number),
      });
      const data = await callMethod(
        methods.get("workspaces.data.read")!,
        { binding: { source: "static", value: { ok: true } } },
        broadcast,
      );
      expect(data.response?.[1]).toEqual({ data: { ok: true } });
      const rpcData = await callMethod(
        methods.get("workspaces.data.read")!,
        { binding: { source: "rpc", method: "sessions.list" } },
        broadcast,
      );
      expect(rpcData.response?.[0]).toBe(false);
      expect(rpcData.response?.[2]).toMatchObject({ code: "binding_client_resolved" });

      const beforeReplace = await callMethod(methods.get("workspaces.get")!, {}, broadcast);
      const replacement = structuredClone(beforeReplace.response?.[1]?.doc);
      replacement.tabs = [replacement.tabs.find((tab: { slug: string }) => tab.slug === "ops")];
      replacement.prefs.tabOrder = ["ops"];
      await callMethod(methods.get("workspaces.replace")!, { doc: replacement }, broadcast);

      const undo = await callMethod(methods.get("workspaces.undo")!, {}, broadcast);
      expect(undo.response?.[0]).toBe(true);
      expect(
        undo.response?.[1]?.doc.tabs.some((tab: { slug: string }) => tab.slug === "main"),
      ).toBe(true);
      // create + add + update + move + setLayout + scaffold + approve + replace + undo
      expect(broadcast).toHaveBeenCalledTimes(9);
    });
  });
});

describe("workspace broadcast handle", () => {
  it("remembers the server broadcast so agent tools can announce changes off-request", async () => {
    resetWorkspaceBroadcastForTest();
    expect(workspaceBroadcast()).toBeUndefined();

    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerWorkspaceGatewayMethods({ api, store: new WorkspaceStore({ stateDir }) });
      const broadcast = vi.fn();

      // A read populates the slot; agent turns started from a channel or cron have
      // no gateway request scope and rely on it.
      await callMethod(methods.get("workspaces.get")!, {}, broadcast);

      expect(workspaceBroadcast()).toBe(broadcast);
    });
  });
});
