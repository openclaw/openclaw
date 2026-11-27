import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardCommand } from "./command.js";
import {
  createAmbiguousPrefix,
  createSandboxRuntime,
  createWorktreeRuntime,
} from "./test/interaction-fixtures.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { resolveCommandWorkboardWorkspaceAccess } from "./workspace-access.js";

function ownerContext(isCurrent: () => boolean) {
  return {
    senderIsOwner: true,
    assertOwnerCurrent: () => {
      if (!isCurrent()) {
        throw new Error("owner revoked");
      }
    },
  };
}

type CommandContext = {
  senderIsOwner?: boolean;
  assertOwnerCurrent?: () => void;
  gatewayClientScopes?: string[];
  config?: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
};

const workspaceAccess = { unrestricted: false, roots: ["/workspace"], writable: true };
function workspaceConfig(...agents: string[]) {
  return {
    tools: { fs: { workspaceOnly: true } },
    agents: {
      entries: Object.fromEntries(agents.map((agent) => [agent, { workspace: "/workspace" }])),
    },
  };
}

function createCommandFixture(
  run = vi.fn().mockResolvedValue({ runId: "run-1" }),
  options: Parameters<typeof createWorkboardSqliteTestStore>[0] = {},
) {
  const store = createWorkboardSqliteTestStore(options);
  const registerCommand = vi.fn<(definition: OpenClawPluginCommandDefinition) => void>();
  const api = {
    registerCommand,
    runtime: {
      subagent: { run },
      worktrees: createWorktreeRuntime(),
      sandbox: createSandboxRuntime(false),
    },
  } as unknown as OpenClawPluginApi;
  registerWorkboardCommand({ api, store });
  const command = (args: string, context?: CommandContext) =>
    expectDefined(registerCommand.mock.calls[0]?.[0], "registered Workboard command").handler({
      config: {},
      sessionKey: "agent:main:main",
      args,
      ...context,
    } as never);
  const ready = (title: string, extra: Omit<Parameters<typeof store.create>[0], "title"> = {}) =>
    store.create({ status: "ready", ...extra, title });
  const reply = async (args: string, text: string, context?: CommandContext, isError?: boolean) =>
    expect(await command(args, context)).toMatchObject({
      text: expect.stringContaining(text),
      ...(isError === undefined ? {} : { isError }),
    });
  return { store, api, command, ready, reply };
}

describe("handleWorkboardCommand", () => {
  it("requires an explicit agent workspace for multi-agent local commands", () => {
    const config = {
      ...workspaceConfig(),
      agents: {
        entries: {
          first: { workspace: "/first", tools: { fs: { workspaceOnly: false } } },
          chosen: { workspace: "/workspace" },
        },
      },
    };

    expect(() => resolveCommandWorkboardWorkspaceAccess({ config })).toThrow(
      "Multiple agents are configured",
    );
    expect(resolveCommandWorkboardWorkspaceAccess({ config, agentId: "chosen" })).toEqual(
      workspaceAccess,
    );
  });

  it("inherits slash-session sandbox roots and write mode", () => {
    const config = {
      agents: {
        defaults: { sandbox: { mode: "all" as const, workspaceAccess: "ro" as const } },
        entries: { main: { workspace: "/workspace" } },
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

  it("attests the card's assigned agent independently of the slash-command caller", async () => {
    const { api, command, ready } = createCommandFixture();
    await ready("Assigned slash card", { agentId: "main", workspaceAccess });
    api.runtime.sandbox = createSandboxRuntime(true);
    const prepareWorkspaceAuthority = vi.mocked(api.runtime.sandbox.prepareWorkspaceAuthority);
    await command("dispatch", {
      senderIsOwner: true,
      config: {
        agents: {
          defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } },
          entries: workspaceConfig("main", "secondary").agents.entries,
        },
      },
      agentId: "secondary",
      sessionKey: "agent:secondary:main",
    });

    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
    expect(prepareWorkspaceAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        requiredToolNames: ["workboard_heartbeat", "workboard_complete", "workboard_block"],
      }),
    );
    expect(prepareWorkspaceAuthority.mock.calls.every(([input]) => input.agentId === "main")).toBe(
      true,
    );
  });

  it("requires write access to create and dispatch cards while leaving reads open", async () => {
    const { store, api, reply } = createCommandFixture();
    await reply("create Ship CLI", "Ship CLI", { senderIsOwner: true });
    const card = expectDefined((await store.list())[0], "created workboard card");
    expect(card).toMatchObject({
      title: "Ship CLI",
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    await reply("list", "Ship CLI");
    await store.update(card.id, { status: "ready" });
    await reply("create Blocked", "operator.write", undefined, true);
    await reply("dispatch", "operator.write", undefined, true);
    await reply(`move ${card.id} --status running`, "operator.write", undefined, true);
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
    await reply("dispatch", "started=1", { senderIsOwner: true });
    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
  });

  it("shows when an archived card is excluded from dispatch", async () => {
    const { store, reply } = createCommandFixture();
    const card = await store.create({ title: "Archived slash card", status: "ready" });
    await store.archive(card.id, true);

    await reply(`show ${card.id}`, "archived: yes (excluded from dispatch)");
  });

  it("moves claimed cards for operators on slash-command surfaces", async () => {
    const { store, reply } = createCommandFixture();
    const card = await store.create({ title: "Claimed slash card", status: "todo" });
    await store.claim(card.id, { ownerId: "worker", token: "secret-token" });

    await reply(`move ${card.id.slice(0, 8)} --status review`, "review", {
      gatewayClientScopes: ["operator.write"],
      assertOwnerCurrent: () => {
        throw new Error("not a chat owner");
      },
    });
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { claim: { ownerId: "worker", token: "secret-token" } },
    });
  });

  it("rechecks owner authority after create and move preparation without gating reads", async () => {
    let ownerCurrent = true;
    let revokeBeforeWrite = false;
    const { store, command, reply } = createCommandFixture(undefined, {
      beforeCardWrite: () => {
        if (revokeBeforeWrite) {
          ownerCurrent = false;
        }
      },
    });
    const card = await store.create({ title: "Keep original", status: "ready" });
    const context = ownerContext(() => ownerCurrent);
    const list = store.list.bind(store);
    vi.spyOn(store, "list").mockImplementationOnce(async (...args) => {
      const cards = await list(...args);
      ownerCurrent = false;
      return cards;
    });
    await expect(command("create Denied", context)).rejects.toThrow("owner revoked");
    expect(await store.list()).toEqual([card]);

    ownerCurrent = true;
    revokeBeforeWrite = true;
    await expect(command("create Denied at persistence", context)).rejects.toThrow("owner revoked");
    expect(await store.list()).toEqual([card]);
    revokeBeforeWrite = false;

    ownerCurrent = true;
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async (id) => {
      const result = await get(id);
      ownerCurrent = false;
      return result;
    });
    await expect(command(`move ${card.id} --status done`, context)).rejects.toThrow(
      "owner revoked",
    );
    expect(await store.get(card.id)).toEqual(card);
    await reply("list", "Keep original", context);
  });

  it("settles an accepted dispatch but refuses another worker after owner revocation", async () => {
    let ownerCurrent = true;
    const run = vi.fn(async () => {
      ownerCurrent = false;
      return { runId: "accepted-before-revocation" };
    });
    const { store, reply, ready } = createCommandFixture(run);
    const first = await ready("First", { agentId: "first" });
    const second = await ready("Second", { agentId: "second" });
    await reply(
      "dispatch",
      "started=1 failures=1",
      ownerContext(() => ownerCurrent),
    );
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(first.id)).resolves.toMatchObject({
      status: "running",
      runId: "accepted-before-revocation",
      metadata: { automation: { launch: { phase: "accepted" } } },
    });
    await expect(store.get(second.id)).resolves.toEqual(second);
  });

  it("requires fresh owner authority for each card in a serialized dispatch batch", async () => {
    const { store, api, command } = createCommandFixture();
    const scheduled = (position: number) =>
      store.create({
        title: `Scheduled ${position}`,
        status: "scheduled",
        scheduledAt: 1,
        position,
      });
    const first = await scheduled(0);
    const second = await scheduled(1);
    const { promise: secondRead, resolve: secondReadEntered } = Promise.withResolvers<void>();
    const { promise: readResumed, resolve: resumeSecondRead } = Promise.withResolvers<void>();
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
    const dispatch = command(
      "dispatch",
      ownerContext(() => ownerCurrent),
    );
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
    const { store, reply } = createCommandFixture();
    const card = await store.create({ title: "Invalid slash move" });

    await reply(`move ${card.id} --status later`, "status must be", { senderIsOwner: true }, true);
  });

  it.each([
    ["operator.write", "main", "/repo-denied"],
    [undefined, "restricted", "/workspace"],
    ["operator.admin", "admin", "/repo-allowed"],
  ] as const)(
    "uses slash caller scope=%s for %s worktree materialization",
    async (scope, agentId, path) => {
      const admin = scope === "operator.admin";
      const { store, api, reply, ready } = createCommandFixture();
      const run = api.runtime.subagent.run;
      const createWorktree = vi.mocked(api.runtime.worktrees.create).mockResolvedValue({
        id: "managed-id",
        path: "/state/worktrees/fingerprint/wb-card",
        branch: "openclaw/wb-card",
      });
      const card = await ready("Checkout", {
        agentId,
        workspace: { kind: "worktree", path },
        ...(admin ? { workspaceAccess: { unrestricted: true } } : {}),
      });
      api.runtime.sandbox = createSandboxRuntime(!admin);
      const result = reply(
        "dispatch",
        path === "/repo-denied" ? "outside the caller" : "started=1",
        {
          ...(scope ? { gatewayClientScopes: [scope] } : { senderIsOwner: true }),
          agentId: admin ? "admin" : "main",
          config: admin
            ? { agents: { entries: { admin: { workspace: path } } } }
            : workspaceConfig("main", "restricted"),
        },
      );
      if (path === "/repo-denied") {
        await result;
        expect(createWorktree).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
        return;
      }
      await result;
      if (admin) {
        expect(createWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ repoRoot: path, ownerId: card.id }),
        );
      } else {
        expect(createWorktree).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
      }
      await expect(store.get(card.id)).resolves.toMatchObject({
        status: "running",
        runId: "run-1",
        execution: { runId: "run-1" },
        ...(!admin
          ? { metadata: { automation: { workspace: { kind: "dir", path: "/workspace" } } } }
          : {}),
      });
    },
  );

  it("rejects ambiguous card id prefixes", async () => {
    const { store, reply } = createCommandFixture();
    const prefix = await createAmbiguousPrefix(store);

    await reply(`show ${prefix}`, "Ambiguous card id prefix", undefined, true);
  });
});
