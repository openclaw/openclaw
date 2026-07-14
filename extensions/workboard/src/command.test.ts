// Workboard tests cover command plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { handleWorkboardCommand, registerWorkboardCommand } from "./command.js";
import type { WorkboardSubagentRuntime, WorkboardWorktreeRuntime } from "./dispatcher.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";
import {
  resolveAgentWorkboardWorkspaceRuntime,
  resolveCommandWorkboardWorkspaceAccess,
} from "./workspace-access.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

function createApi(run = vi.fn().mockResolvedValue({ runId: "run-1" })): {
  runtime: { subagent: WorkboardSubagentRuntime; worktrees: WorkboardWorktreeRuntime };
} {
  return {
    runtime: {
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
    },
  };
}

async function createAmbiguousPrefix(store: WorkboardStore): Promise<string> {
  const seen = new Map<string, string>();
  for (let index = 0; index < 40; index += 1) {
    const card = await store.create({ title: `Card ${index}` });
    const prefix = card.id.slice(0, 1);
    if (seen.has(prefix)) {
      return prefix;
    }
    seen.set(prefix, card.id);
  }
  throw new Error("could not create cards with a shared prefix");
}

describe("handleWorkboardCommand", () => {
  it("uses the configured default agent workspace for unscoped local commands", () => {
    expect(
      resolveCommandWorkboardWorkspaceAccess({
        config: {
          tools: { fs: { workspaceOnly: true } },
          agents: {
            list: [
              {
                id: "first",
                workspace: "/first",
                tools: { fs: { workspaceOnly: false } },
              },
              { id: "chosen", default: true, workspace: "/chosen" },
            ],
          },
        },
      }),
    ).toEqual({ unrestricted: false, roots: ["/chosen"], writable: true });
  });

  it("inherits slash-session sandbox roots and write mode", () => {
    const config = {
      agents: {
        defaults: { sandbox: { mode: "all" as const, workspaceAccess: "ro" as const } },
        list: [{ id: "main", default: true, workspace: "/workspace" }],
      },
    };

    expect(
      resolveCommandWorkboardWorkspaceAccess({
        config,
        agentId: "main",
        sessionKey: "agent:main:main",
        resolveSandboxWorkspaceAuthority: () => ({
          sandboxed: true,
          workspaceAccess: "ro",
        }),
      }),
    ).toEqual({ unrestricted: false, roots: ["/workspace"], writable: false });
  });

  it("projects target sandbox authority into Workboard roots", async () => {
    const safeConfig = {
      agents: {
        defaults: { sandbox: { mode: "all" as const, workspaceAccess: "rw" as const } },
        list: [{ id: "main", default: true, workspace: "/workspace" }],
      },
    };
    await expect(
      resolveAgentWorkboardWorkspaceRuntime({
        config: safeConfig,
        agentId: "main",
        sessionKey: "agent:main:subagent:workboard-card",
        workspaceDir: "/workspace",
        prepareSandboxWorkspaceAuthority: async () => ({
          sandboxed: true,
          workspaceAccess: "rw",
        }),
      }),
    ).resolves.toEqual({
      sandboxed: true,
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
  });

  it("attests the default agent for an unassigned slash-command card", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Unassigned slash card",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-default-agent" });
    const prepareWorkspaceAuthority = vi.fn().mockResolvedValue({
      sandboxed: true,
      workspaceAccess: "rw" as const,
    });
    let command: OpenClawPluginCommandDefinition | undefined;
    const api = {
      registerCommand: vi.fn((definition: OpenClawPluginCommandDefinition) => {
        command = definition;
      }),
      runtime: {
        subagent: { run },
        worktrees: {
          resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
          create: vi.fn(),
          release: vi.fn(),
          removeIfLossless: vi.fn(),
        },
        sandbox: {
          resolveWorkspaceAuthority: vi.fn().mockReturnValue({
            sandboxed: true,
            workspaceAccess: "rw",
          }),
          prepareWorkspaceAuthority,
        },
      },
    } as unknown as OpenClawPluginApi;
    registerWorkboardCommand({ api, store });
    expect(command).toBeDefined();

    await command!.handler({
      args: "dispatch",
      senderIsOwner: true,
      config: {
        agents: {
          defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } },
          list: [
            { id: "main", default: true, workspace: "/workspace" },
            { id: "secondary", workspace: "/workspace" },
          ],
        },
      },
      agentId: "secondary",
      sessionKey: "agent:secondary:main",
    } as never);

    expect(run).toHaveBeenCalledOnce();
    expect(prepareWorkspaceAuthority).toHaveBeenCalled();
    expect(prepareWorkspaceAuthority.mock.calls.every(([input]) => input.agentId === "main")).toBe(
      true,
    );
    expect(prepareWorkspaceAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredToolNames: ["workboard_heartbeat", "workboard_complete", "workboard_block"],
      }),
    );
  });

  it("creates, lists, and dispatches workboard cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();

    await expect(
      handleWorkboardCommand({
        api,
        store,
        args: "create Ship CLI",
        senderIsOwner: true,
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("Ship CLI") }));
    const card = expectDefined((await store.list())[0], "created workboard card");
    expect(card).toMatchObject({
      title: "Ship CLI",
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    await expect(handleWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ship CLI") }),
    );
    await store.update(card.id, { status: "ready" });
    await expect(
      handleWorkboardCommand({
        api,
        store,
        args: "dispatch",
        gatewayClientScopes: ["operator.write"],
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("started=1") }));
    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
  });

  it("requires write access for slash mutations", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const card = await store.create({ title: "Ready worker", status: "ready" });

    await expect(handleWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ready worker") }),
    );
    await expect(handleWorkboardCommand({ api, store, args: "create Blocked" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    await expect(handleWorkboardCommand({ api, store, args: "dispatch" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("uses the slash caller's workspace access for worktree materialization", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const createWorktree = vi.mocked(api.runtime.worktrees.create);
    createWorktree.mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
    });

    await expect(
      handleWorkboardCommand({
        api,
        store,
        args: "dispatch",
        gatewayClientScopes: ["operator.write"],
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("outside the caller") }),
    );
    expect(createWorktree).not.toHaveBeenCalled();
    const denied = (await store.list()).find((card) => card.title === "Denied checkout");
    expect(denied).toMatchObject({ status: "ready" });
    await store.update(denied!.id, { status: "blocked" });

    const restricted = await store.create({
      title: "Workspace checkout",
      status: "ready",
      agentId: "restricted",
      workspace: { kind: "worktree", path: "/workspace" },
    });
    await handleWorkboardCommand({
      api,
      store,
      args: "dispatch",
      senderIsOwner: true,
      resolveAgentWorkspace: () => "/workspace",
      resolveAgentWorkspaceRuntime: () => ({
        sandboxed: true,
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      }),
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    expect(createWorktree).not.toHaveBeenCalled();
    expect(api.runtime.subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace" }),
    );
    await expect(store.get(restricted.id)).resolves.toMatchObject({
      metadata: { automation: { workspace: { kind: "dir", path: "/workspace" } } },
    });

    const allowed = await store.create({
      title: "Allowed checkout",
      status: "ready",
      agentId: "admin",
      workspace: { kind: "worktree", path: "/repo-allowed" },
      workspaceAccess: { unrestricted: true },
    });
    await handleWorkboardCommand({
      api,
      store,
      args: "dispatch",
      gatewayClientScopes: ["operator.admin"],
      workspaceAccess: { unrestricted: true },
    });

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo-allowed",
        ownerId: allowed.id,
      }),
    );
  });

  it("rejects ambiguous card id prefixes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const prefix = await createAmbiguousPrefix(store);

    await expect(handleWorkboardCommand({ api, store, args: `show ${prefix}` })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("Ambiguous card id prefix"),
      }),
    );
  });
});
