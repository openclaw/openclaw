// Workboard tests cover command plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardCommand } from "./command.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import {
  resolveAgentWorkboardWorkspaceRuntime,
  resolveCommandWorkboardWorkspaceAccess,
} from "./workspace-access.js";

function createApi(run = vi.fn().mockResolvedValue({ runId: "run-1" })): OpenClawPluginApi {
  return {
    registerCommand: vi.fn(),
    runtime: {
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      sandbox: {
        resolveWorkspaceAuthority: vi.fn(() => ({
          sandboxed: false,
          workspaceAccess: "rw",
        })),
        prepareWorkspaceAuthority: vi.fn(async () => ({
          sandboxed: false,
          workspaceAccess: "rw",
        })),
      },
    },
  } as unknown as OpenClawPluginApi;
}

async function runWorkboardCommand(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
  args?: string;
  context?: {
    senderIsOwner?: boolean;
    assertOwnerCurrent?: () => void;
    gatewayClientScopes?: string[];
    config?: Record<string, unknown>;
    agentId?: string;
    sessionKey?: string;
  };
}) {
  let command: OpenClawPluginCommandDefinition | undefined;
  vi.mocked(params.api.registerCommand).mockImplementationOnce((definition) => {
    command = definition;
  });
  registerWorkboardCommand({ api: params.api, store: params.store });
  return await expectDefined(command, "registered Workboard command").handler({
    channel: "test",
    isAuthorizedSender: true,
    commandBody: "/workboard",
    config: {},
    sessionKey: "agent:main:main",
    args: params.args,
    ...params.context,
  } as never);
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
    const store = createWorkboardSqliteTestStore();
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
    const store = createWorkboardSqliteTestStore();
    const api = createApi();

    await expect(
      runWorkboardCommand({
        api,
        store,
        args: "create Ship CLI",
        context: { senderIsOwner: true },
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("Ship CLI") }));
    const card = expectDefined((await store.list())[0], "created workboard card");
    expect(card).toMatchObject({
      title: "Ship CLI",
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    await expect(runWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ship CLI") }),
    );
    await store.update(card.id, { status: "ready" });
    await expect(
      runWorkboardCommand({
        api,
        store,
        args: "dispatch",
        context: { senderIsOwner: true },
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("started=1") }));
    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
  });

  it("requires write access for slash mutations", async () => {
    const store = createWorkboardSqliteTestStore();
    const api = createApi();
    const card = await store.create({ title: "Ready worker", status: "ready" });

    await expect(runWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ready worker") }),
    );
    await expect(runWorkboardCommand({ api, store, args: "create Blocked" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    await expect(runWorkboardCommand({ api, store, args: "dispatch" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    await expect(
      runWorkboardCommand({ api, store, args: `move ${card.id} --status running` }),
    ).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("shows when an archived card is excluded from dispatch", async () => {
    const store = createWorkboardSqliteTestStore();
    const api = createApi();
    const card = await store.create({ title: "Archived slash card", status: "ready" });
    await store.archive(card.id, true);

    await expect(runWorkboardCommand({ api, store, args: `show ${card.id}` })).resolves.toEqual(
      expect.objectContaining({
        text: expect.stringContaining("archived: yes (excluded from dispatch)"),
      }),
    );
  });

  it("moves claimed cards for operators on slash-command surfaces", async () => {
    const store = createWorkboardSqliteTestStore();
    const api = createApi();
    const card = await store.create({ title: "Claimed slash card", status: "todo" });
    await store.claim(card.id, { ownerId: "worker", token: "secret-token" });

    await expect(
      runWorkboardCommand({
        api,
        store,
        args: `move ${card.id.slice(0, 8)} --status review`,
        context: {
          gatewayClientScopes: ["operator.write"],
          assertOwnerCurrent: () => {
            throw new Error("not a chat owner");
          },
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("review") }));
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { claim: { ownerId: "worker", token: "secret-token" } },
    });
  });

  it("rechecks owner authority after create and move preparation without gating reads", async () => {
    let ownerCurrent = true;
    let revokeBeforeWrite = false;
    const store = createWorkboardSqliteTestStore({
      beforeCardWrite: () => {
        if (revokeBeforeWrite) {
          ownerCurrent = false;
        }
      },
    });
    const api = createApi();
    const card = await store.create({ title: "Keep original", status: "ready" });
    const context = {
      senderIsOwner: true,
      assertOwnerCurrent: () => {
        if (!ownerCurrent) {
          throw new Error("owner revoked");
        }
      },
    };
    const list = store.list.bind(store);
    vi.spyOn(store, "list").mockImplementationOnce(async (...args) => {
      const cards = await list(...args);
      ownerCurrent = false;
      return cards;
    });
    await expect(
      runWorkboardCommand({ api, store, args: "create Denied", context }),
    ).rejects.toThrow("owner revoked");
    expect(await store.list()).toEqual([card]);

    ownerCurrent = true;
    revokeBeforeWrite = true;
    await expect(
      runWorkboardCommand({ api, store, args: "create Denied at persistence", context }),
    ).rejects.toThrow("owner revoked");
    expect(await store.list()).toEqual([card]);
    revokeBeforeWrite = false;

    ownerCurrent = true;
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async (id) => {
      const result = await get(id);
      ownerCurrent = false;
      return result;
    });
    await expect(
      runWorkboardCommand({ api, store, args: `move ${card.id} --status done`, context }),
    ).rejects.toThrow("owner revoked");
    expect(await store.get(card.id)).toEqual(card);
    await expect(runWorkboardCommand({ api, store, args: "list", context })).resolves.toEqual({
      text: expect.stringContaining("Keep original"),
    });
  });

  it("settles an accepted dispatch but refuses another worker after owner revocation", async () => {
    const store = createWorkboardSqliteTestStore();
    const first = await store.create({ title: "First", status: "ready", agentId: "first" });
    const second = await store.create({ title: "Second", status: "ready", agentId: "second" });
    let ownerCurrent = true;
    const run = vi.fn(async () => {
      ownerCurrent = false;
      return { runId: "accepted-before-revocation" };
    });
    const result = await runWorkboardCommand({
      api: createApi(run),
      store,
      args: "dispatch",
      context: {
        senderIsOwner: true,
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("owner revoked");
          }
        },
      },
    });
    expect(result).toEqual({ text: expect.stringContaining("started=1 failures=1") });
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(first.id)).resolves.toMatchObject({
      status: "running",
      runId: "accepted-before-revocation",
      metadata: { automation: { launch: { phase: "accepted" } } },
    });
    await expect(store.get(second.id)).resolves.toEqual(second);
  });

  it("requires fresh owner authority for each card in a serialized dispatch batch", async () => {
    const store = createWorkboardSqliteTestStore();
    const first = await store.create({
      title: "Promote before revocation",
      status: "scheduled",
      scheduledAt: 1,
      position: 0,
    });
    const second = await store.create({
      title: "Preserve after revocation",
      status: "scheduled",
      scheduledAt: 1,
      position: 1,
    });
    let secondReadEntered!: () => void;
    const secondRead = new Promise<void>((resolve) => {
      secondReadEntered = resolve;
    });
    let resumeSecondRead!: () => void;
    const readResumed = new Promise<void>((resolve) => {
      resumeSecondRead = resolve;
    });
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementation(async (id) => {
      const card = await get(id);
      if (id === second.id) {
        secondReadEntered();
        await readResumed;
      }
      return card;
    });
    let ownerCurrent = true;
    const api = createApi();
    const dispatch = runWorkboardCommand({
      api,
      store,
      args: "dispatch",
      context: {
        senderIsOwner: true,
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("owner revoked");
          }
        },
      },
    });
    const rejected = expect(dispatch).rejects.toThrow("owner revoked");
    try {
      await secondRead;
      await expect(get(first.id)).resolves.toMatchObject({ status: "ready" });
      await expect(get(second.id)).resolves.toEqual(second);
      ownerCurrent = false;
    } finally {
      resumeSecondRead();
      await rejected;
    }
    await expect(get(first.id)).resolves.toMatchObject({ status: "ready" });
    await expect(get(second.id)).resolves.toEqual(second);
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
  });

  it("rejects invalid slash-command move statuses", async () => {
    const store = createWorkboardSqliteTestStore();
    const api = createApi();
    const card = await store.create({ title: "Invalid slash move" });

    await expect(
      runWorkboardCommand({
        api,
        store,
        args: `move ${card.id} --status later`,
        context: { senderIsOwner: true },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ isError: true, text: expect.stringContaining("status must be") }),
    );
  });

  it("uses the slash caller's workspace access for worktree materialization", async () => {
    const store = createWorkboardSqliteTestStore();
    const run = vi.fn(async (input: { idempotencyKey: string }) => ({
      runId: `accepted:${input.idempotencyKey}`,
    }));
    const api = createApi(run);
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

    const restrictedConfig = {
      tools: { fs: { workspaceOnly: true } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/workspace" },
          { id: "restricted", workspace: "/workspace" },
        ],
      },
    };
    vi.mocked(api.runtime.sandbox.resolveWorkspaceAuthority).mockReturnValue({
      sandboxed: true,
      workspaceAccess: "rw",
    });
    vi.mocked(api.runtime.sandbox.prepareWorkspaceAuthority).mockResolvedValue({
      sandboxed: true,
      workspaceAccess: "rw",
    });
    await expect(
      runWorkboardCommand({
        api,
        store,
        args: "dispatch",
        context: {
          gatewayClientScopes: ["operator.write"],
          config: restrictedConfig,
          agentId: "main",
        },
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
    await runWorkboardCommand({
      api,
      store,
      args: "dispatch",
      context: {
        senderIsOwner: true,
        config: restrictedConfig,
        agentId: "main",
      },
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
    vi.mocked(api.runtime.sandbox.resolveWorkspaceAuthority).mockReturnValue({
      sandboxed: false,
      workspaceAccess: "rw",
    });
    vi.mocked(api.runtime.sandbox.prepareWorkspaceAuthority).mockResolvedValue({
      sandboxed: false,
      workspaceAccess: "rw",
    });
    await runWorkboardCommand({
      api,
      store,
      args: "dispatch",
      context: {
        gatewayClientScopes: ["operator.admin"],
        config: { agents: { list: [{ id: "admin", default: true, workspace: "/repo-allowed" }] } },
        agentId: "admin",
      },
    });

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo-allowed",
        ownerId: allowed.id,
      }),
    );
    expect(run).toHaveBeenCalledTimes(2);
    for (const [index, id] of [restricted.id, allowed.id].entries()) {
      const runId = `accepted:${run.mock.calls[index]?.[0].idempotencyKey}`;
      await expect(store.get(id)).resolves.toMatchObject({
        status: "running",
        runId,
        execution: { runId },
        metadata: {
          automation: { launch: { phase: "accepted", acceptedRunId: runId } },
          attempts: [expect.objectContaining({ id: runId, runId })],
        },
      });
    }
  });

  it("rejects ambiguous card id prefixes", async () => {
    const store = createWorkboardSqliteTestStore();
    const api = createApi();
    const prefix = await createAmbiguousPrefix(store);

    await expect(runWorkboardCommand({ api, store, args: `show ${prefix}` })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("Ambiguous card id prefix"),
      }),
    );
  });
});
