// Workboard tests cover dispatcher plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("dispatchAndStartWorkboardCards", () => {
  it("does not let an implicit target agent workspace widen caller access", async () => {
    const store = createWorkboardSqliteTestStore();
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

  it("persists the resolved subagent runtime on new executions", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Claude worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({
      runId: "run-claude",
      runtime: {
        harness: "claude-cli",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      execution: {
        id: `${card.id}:agent-session`,
        engine: "claude-cli",
        model: "anthropic/claude-sonnet-4-6",
        runId: "run-claude",
      },
    });
  });

  it("materializes managed worktrees, supplies cwd, and persists them", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Isolated worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-worktree" });
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({
        id: "managed-id",
        path: "/state/worktrees/fingerprint/wb-card",
        branch: `openclaw/wb-${card.id}`,
      }),
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(true),
    };

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: {
        now: 10,
        maxStarts: 1,
        materializeWorktree: true,
      },
    });

    expect(worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        baseRef: "main",
        ownerKind: "workboard",
        ownerId: card.id,
      }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/state/worktrees/fingerprint/wb-card" }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspace: {
            kind: "worktree",
            path: "/state/worktrees/fingerprint/wb-card",
            branch: `openclaw/wb-${card.id}`,
            sourcePath: "/repo",
            sourceBranch: "main",
          },
        },
      },
    });

    expect(worktrees.removeIfLossless).not.toHaveBeenCalled();
  });

  it("does not claim a card whose workspace authority changed after preflight", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Racing authority update",
      status: "ready",
      workspace: { kind: "dir", path: "/workspace" },
      workspaceAccess: { unrestricted: true },
    });
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async (id, input, options) => {
      await store.update(id, {
        workspaceAccess: {
          unrestricted: false,
          roots: ["/workspace"],
          writable: true,
        },
      });
      return await originalClaim(id, input, options);
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "card workspace authority changed before claim.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects a restricted card when the target agent is not sandboxed", async () => {
    const store = createWorkboardSqliteTestStore();
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
    const store = createWorkboardSqliteTestStore();
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
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Persisted read-only worker",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
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
    const store = createWorkboardSqliteTestStore();
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
    const store = createWorkboardSqliteTestStore();
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
    const store = createWorkboardSqliteTestStore();
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
    const store = createWorkboardSqliteTestStore();
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

  it("rejects linked-worktree metadata outside a restricted workspace mount", async () => {
    const store = createWorkboardSqliteTestStore();
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
    const store = createWorkboardSqliteTestStore();
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
      options: { maxStarts: 1, materializeWorktree: true },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo", ownerId: card.id }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("baseRef");
  });

  it("preserves ready-card history on idle Gateway dispatch passes", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.create({ title: "Occupied owner", status: "running", agentId: "main" });
    const cards = await Promise.all(
      [undefined, { dispatchCount: 225, lastDispatchAt: 1 }].map((automation) =>
        store.create({
          title: "Waiting for owner capacity",
          status: "ready",
          agentId: "main",
          metadata: { automation },
        }),
      ),
    );
    const run = vi.fn();

    for (const now of [10, 20, 30]) {
      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { now, maxStarts: 1 },
      });
      expect(result.started).toEqual([]);
      expect(result.startFailures).toEqual([]);
      for (const card of cards) {
        await expect(store.get(card.id)).resolves.toEqual(card);
      }
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("shares one worker slot across cards dispatched with the same explicit owner", async () => {
    const store = createWorkboardSqliteTestStore();
    const first = await store.create({
      title: "First shared worker",
      status: "ready",
      priority: "urgent",
      agentId: "alpha",
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Second shared worker",
      status: "ready",
      agentId: "beta",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-shared" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3, ownerId: " shared-worker " },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: first.id, runId: "run-shared" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(first.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "shared-worker" } },
    });
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "ready" });
  });
});
