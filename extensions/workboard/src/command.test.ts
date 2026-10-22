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
  return { store, api, command };
}

async function expectReply(
  result: ReturnType<OpenClawPluginCommandDefinition["handler"]>,
  text: string,
  isError?: boolean,
) {
  expect(await result).toMatchObject({
    text: expect.stringContaining(text),
    ...(isError === undefined ? {} : { isError }),
  });
}

describe("handleWorkboardCommand", () => {
  it("requires an explicit agent workspace for multi-agent local commands", () => {
    const config = {
      tools: { fs: { workspaceOnly: true } },
      agents: {
        entries: {
          first: {
            workspace: "/first",
            tools: { fs: { workspaceOnly: false } },
          },
          chosen: { workspace: "/chosen" },
        },
      },
    };

    expect(() => resolveCommandWorkboardWorkspaceAccess({ config })).toThrow(
      "Multiple agents are configured",
    );
    expect(
      resolveCommandWorkboardWorkspaceAccess({
        config,
        agentId: "chosen",
      }),
    ).toEqual({ unrestricted: false, roots: ["/chosen"], writable: true });
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
    const run = vi.fn().mockResolvedValue({ runId: "run-assigned-agent" });
    const { store, api, command } = createCommandFixture(run);
    await store.create({
      title: "Assigned slash card",
      status: "ready",
      agentId: "main",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    api.runtime.sandbox = createSandboxRuntime(true);
    const prepareWorkspaceAuthority = vi.mocked(api.runtime.sandbox.prepareWorkspaceAuthority);
    await command("dispatch", {
      senderIsOwner: true,
      config: {
        agents: {
          defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } },
          entries: {
            main: { workspace: "/workspace" },
            secondary: { workspace: "/workspace" },
          },
        },
      },
      agentId: "secondary",
      sessionKey: "agent:secondary:main",
    });

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
    const { store, api, command } = createCommandFixture();
    await expectReply(command("create Ship CLI", { senderIsOwner: true }), "Ship CLI");
    const card = expectDefined((await store.list())[0], "created workboard card");
    expect(card).toMatchObject({
      title: "Ship CLI",
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    await expectReply(command("list"), "Ship CLI");
    await store.update(card.id, { status: "ready" });
    await expectReply(command("dispatch", { senderIsOwner: true }), "started=1");
    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
  });

  it("requires write access for slash mutations", async () => {
    const { store, api, command } = createCommandFixture();
    const card = await store.create({ title: "Ready worker", status: "ready" });

    await expectReply(command("list"), "Ready worker");
    await expectReply(command("create Blocked"), "operator.write", true);
    await expectReply(command("dispatch"), "operator.write", true);
    await expectReply(command(`move ${card.id} --status running`), "operator.write", true);
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("shows when an archived card is excluded from dispatch", async () => {
    const { store, command } = createCommandFixture();
    const card = await store.create({ title: "Archived slash card", status: "ready" });
    await store.archive(card.id, true);

    await expectReply(command(`show ${card.id}`), "archived: yes (excluded from dispatch)");
  });

  it("moves claimed cards for operators on slash-command surfaces", async () => {
    const { store, command } = createCommandFixture();
    const card = await store.create({ title: "Claimed slash card", status: "todo" });
    await store.claim(card.id, { ownerId: "worker", token: "secret-token" });

    await expectReply(
      command(`move ${card.id.slice(0, 8)} --status review`, {
        gatewayClientScopes: ["operator.write"],
        assertOwnerCurrent: () => {
          throw new Error("not a chat owner");
        },
      }),
      "review",
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { claim: { ownerId: "worker", token: "secret-token" } },
    });
  });

  it("rechecks owner authority after create and move preparation without gating reads", async () => {
    let ownerCurrent = true;
    let revokeBeforeWrite = false;
    const { store, command } = createCommandFixture(undefined, {
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
    await expect(command("list", context)).resolves.toEqual({
      text: expect.stringContaining("Keep original"),
    });
  });

  it("settles an accepted dispatch but refuses another worker after owner revocation", async () => {
    let ownerCurrent = true;
    const run = vi.fn(async () => {
      ownerCurrent = false;
      return { runId: "accepted-before-revocation" };
    });
    const { store, command } = createCommandFixture(run);
    const first = await store.create({ title: "First", status: "ready", agentId: "first" });
    const second = await store.create({ title: "Second", status: "ready", agentId: "second" });
    const result = await command(
      "dispatch",
      ownerContext(() => ownerCurrent),
    );
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
    const { store, api, command } = createCommandFixture();
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
    const { store, command } = createCommandFixture();
    const card = await store.create({ title: "Invalid slash move" });

    await expectReply(
      command(`move ${card.id} --status later`, { senderIsOwner: true }),
      "status must be",
      true,
    );
  });

  it.each([
    ["operator.write", "main", "/repo-denied"],
    [undefined, "restricted", "/workspace"],
    ["operator.admin", "admin", "/repo-allowed"],
  ] as const)(
    "uses slash caller scope=%s for %s worktree materialization",
    async (scope, agentId, path) => {
      const admin = scope === "operator.admin";
      const run = vi.fn(async (input: { idempotencyKey: string }) => ({
        runId: `accepted:${input.idempotencyKey}`,
      }));
      const { store, api, command } = createCommandFixture(run);
      const createWorktree = vi.mocked(api.runtime.worktrees.create).mockResolvedValue({
        id: "managed-id",
        path: "/state/worktrees/fingerprint/wb-card",
        branch: "openclaw/wb-card",
      });
      const card = await store.create({
        title: "Checkout",
        status: "ready",
        agentId,
        workspace: { kind: "worktree", path },
        ...(admin ? { workspaceAccess: { unrestricted: true } } : {}),
      });
      api.runtime.sandbox = createSandboxRuntime(!admin);
      const result = command("dispatch", {
        ...(scope ? { gatewayClientScopes: [scope] } : { senderIsOwner: true }),
        agentId: admin ? "admin" : "main",
        config: admin
          ? { agents: { entries: { admin: { workspace: path } } } }
          : {
              tools: { fs: { workspaceOnly: true } },
              agents: {
                entries: {
                  main: { workspace: "/workspace" },
                  restricted: { workspace: "/workspace" },
                },
              },
            },
      });
      if (path === "/repo-denied") {
        await expectReply(result, "outside the caller");
        expect(createWorktree).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
        return;
      }
      await expectReply(result, "started=1");
      if (admin) {
        expect(createWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ repoRoot: path, ownerId: card.id }),
        );
      } else {
        expect(createWorktree).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
      }
      expect(run).toHaveBeenCalledOnce();
      const runId = `accepted:${run.mock.calls[0]?.[0].idempotencyKey}`;
      await expect(store.get(card.id)).resolves.toMatchObject({
        status: "running",
        runId,
        execution: { runId },
        ...(!admin
          ? { metadata: { automation: { workspace: { kind: "dir", path: "/workspace" } } } }
          : {}),
      });
    },
  );

  it("rejects ambiguous card id prefixes", async () => {
    const { store, command } = createCommandFixture();
    const prefix = await createAmbiguousPrefix(store);

    await expectReply(command(`show ${prefix}`), "Ambiguous card id prefix", true);
  });
});
