// Workboard tests cover dispatcher workspace and sandbox authority boundaries.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

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

describe("workboard dispatcher workspace authority", () => {
  it("rejects worktree sources outside the dispatcher's workspace boundary", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Protected checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
    });
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    };

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      worktrees,
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path is outside the caller's allowed workspaces.",
      }),
    ]);
    expect(worktrees.create).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
    expect((await store.get(card.id))?.metadata?.automation?.workspaceAccess).toBeUndefined();
  });

  it("leaves inaccessible directory workspaces ready and unclaimed", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Protected directory",
      status: "ready",
      workspace: { kind: "dir", path: "/outside" },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        materializeWorktree: false,
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path is outside the caller's allowed workspaces.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { workspace: { kind: "dir", path: "/outside" } } },
    });
  });

  it("does not launch a mutable nested directory for a workspace-bound caller", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Mutable nested directory",
      status: "ready",
      workspace: { kind: "dir", path: "/workspace/repo" },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path must equal one of the caller's allowed workspace roots.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("does not let an implicit target agent workspace widen caller access", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Other agent scratch",
      status: "ready",
      agentId: "other",
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        resolveAgentWorkspace: (agentId) =>
          agentId === "other" ? "/workspace-other" : "/workspace",
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path must equal one of the caller's allowed workspace roots.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("pins an allowed implicit worker to the caller's workspace root", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Workspace scratch",
      status: "ready",
      agentId: "main",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-scratch" });
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    };

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        }),
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      },
    });

    expect(result.started).toHaveLength(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
  });

  it("rejects a restricted card when the target agent is not sandboxed", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Restricted worker",
      status: "ready",
      agentId: "broad",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: false,
          workspaceAccess: { unrestricted: true },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "target agent is not sandboxed for this restricted Workboard card.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a restricted card when the target workspace is read-only", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Read-only worker",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "target agent does not have writable workspace-only access.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps read-only card authority after a later full-host dispatch", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Persisted read-only worker",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        workspaceAccess: { unrestricted: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: expect.stringContaining("manual movement is allowed"),
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects a target sandbox root broader than the card authority", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Broader target worker",
      status: "ready",
      workspace: { kind: "dir", path: "/workspace/project" },
      workspaceAccess: {
        unrestricted: false,
        roots: ["/workspace/project"],
        writable: true,
      },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace path must equal one of the caller's allowed workspace roots.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a restricted card when the target sandbox has an escape path", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Escaping worker",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
          confinementError: "target sandbox routes shell execution outside the sandbox.",
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "target sandbox routes shell execution outside the sandbox.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a restricted workspace nested inside a broader Git checkout", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Nested checkout worker",
      status: "ready",
      workspace: { kind: "dir", path: "/repo/workspace" },
      workspaceAccess: { unrestricted: false, roots: ["/repo/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo"),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        resolveAgentWorkspace: () => "/repo/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: {
            unrestricted: false,
            roots: ["/repo/workspace"],
            writable: true,
          },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "workspace root is nested inside a broader Git checkout.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a card's persisted workspace ceiling during a later admin dispatch", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Persisted restricted worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/workspace" },
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const create = vi.fn();
    const run = vi.fn().mockResolvedValue({ runId: "run-persisted" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/workspace"),
        hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(true),
        create,
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        materializeWorktree: true,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        }),
        workspaceAccess: { unrestricted: true },
      },
    });

    expect(result.started).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
  });

  it("runs an authorized worktree request directly in a workspace-bound caller's root", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Workspace-bound worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-workspace" });
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo"),
      hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(true),
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    };

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        materializeWorktree: true,
        resolveAgentWorkspace: () => "/repo",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/repo"], writable: true },
        }),
        workspaceAccess: { unrestricted: false, roots: ["/repo"], writable: true },
      },
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
    expect(worktrees.create).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { automation: { workspace: { kind: "dir", path: "/repo" } } },
    });
  });

  it("rejects linked-worktree metadata outside a restricted workspace mount", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Linked worktree worker",
      status: "ready",
      workspace: { kind: "dir", path: "/workspace" },
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/workspace"),
        hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(false),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        resolveAgentWorkspace: () => "/workspace",
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        }),
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "restricted workspace Git metadata must be contained inside its root.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not reuse a generated branch as an omitted source base", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Branchless retry",
      status: "ready",
      workspace: {
        kind: "worktree",
        path: "/state/worktrees/fingerprint/wb-card",
        branch: "openclaw/wb-card",
        sourcePath: "/repo",
      },
      workspaceAccess: { unrestricted: true },
    });
    const create = vi.fn().mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-retry" }) },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create,
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        materializeWorktree: true,
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo", ownerId: card.id }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("baseRef");
  });
});
