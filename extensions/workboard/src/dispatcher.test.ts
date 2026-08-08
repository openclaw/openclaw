// Workboard tests cover dispatcher plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { cleanupWorkboardRunWorktree } from "./dispatcher-workspace.js";
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

describe("dispatchAndStartWorkboardCards", () => {
  it("persists the resolved subagent runtime on new executions", async () => {
    const store = new WorkboardStore(createMemoryStore());
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
      options: {
        resolveDefaultAgentId: () => "main",
        now: 10,
        maxStarts: 1,
      },
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

  it("omits unresolved runtime metadata instead of labeling it codex", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Unknown runtime worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-unknown" }) },
      options: {
        resolveDefaultAgentId: () => "main",
        now: 10,
        maxStarts: 1,
      },
    });

    const execution = (await store.get(card.id))?.execution;
    expect(execution).toMatchObject({
      id: `${card.id}:agent-session`,
      runId: "run-unknown",
    });
    expect(execution).not.toHaveProperty("engine");
    expect(execution).not.toHaveProperty("model");
  });

  it("materializes managed worktrees, supplies cwd, persists them, and cleans up on run end", async () => {
    const store = new WorkboardStore(createMemoryStore());
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
        resolveDefaultAgentId: () => "main",
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

    await cleanupWorkboardRunWorktree({ store, worktrees, runId: "run-worktree" });
    expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
      path: "/state/worktrees/fingerprint/wb-card",
      ownerKind: "workboard",
      ownerId: card.id,
    });
  });

  it("requires explicit reauthorization for legacy cards under full-host dispatch", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Legacy worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
    });
    const run = vi.fn();
    const create = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo"),
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

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error:
          "card workspace authority is unknown; re-save its workspace with current permissions before dispatch.",
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.metadata?.automation?.workspaceAccess).toBeUndefined();
  });

  it("adopts current authority for a legacy card without a host workspace path", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Legacy scratch worker", status: "ready" });
    const run = vi.fn().mockResolvedValue({ runId: "run-legacy-scratch" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
      },
    });

    expect(result.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
    expect((await store.get(card.id))?.metadata?.automation?.workspaceAccess).toEqual({
      unrestricted: true,
    });
  });

  it("does not claim a card whose workspace authority changed after preflight", async () => {
    const store = new WorkboardStore(createMemoryStore());
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
      options: {
        resolveDefaultAgentId: () => "main",
        maxStarts: 1,
        workspaceAccess: { unrestricted: true },
      },
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

  it("claims ready cards and starts bounded subagent worker runs", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({
      title: "First worker",
      status: "ready",
      priority: "urgent",
      agentId: "codex-main",
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Second worker",
      status: "ready",
      priority: "normal",
      agentId: "codex-main",
      workspaceAccess: { unrestricted: true },
    });
    const otherAgent = await store.create({
      title: "Other worker",
      status: "ready",
      priority: "high",
      agentId: "codex-side",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-first" })
      .mockResolvedValueOnce({ runId: "run-other" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        now: 10,
        maxStarts: 3,
      },
    });

    expect(result.started.map((entry) => entry.cardId).toSorted()).toEqual(
      [first.id, otherAgent.id].toSorted(),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `agent:codex-main:subagent:workboard-default-${first.id}`,
      lane: `workboard:default:${first.id}`,
      deliver: false,
    });
    expect(run.mock.calls[0]?.[0]?.message).toContain("Claim token:");
    expect(run.mock.calls[0]?.[0]?.message).toContain("workboard_complete with the card id");
    expect(run.mock.calls[0]?.[0]?.message).toContain("returned proofId");
    expect(run.mock.calls[0]?.[0]?.message).not.toContain("ownerId and token");
    await expect(store.get(first.id)).resolves.toMatchObject({
      status: "running",
      sessionKey: `agent:codex-main:subagent:workboard-default-${first.id}`,
      runId: "run-first",
      execution: { status: "running", runId: "run-first" },
      metadata: {
        claim: { ownerId: "codex-main" },
        workerLogs: [expect.objectContaining({ message: expect.stringContaining("run-first") })],
      },
    });
    expect(run.mock.calls[0]?.[0]?.toolsAlsoAllow).toEqual([
      "workboard_heartbeat",
      "workboard_complete",
      "workboard_block",
    ]);
    await expect(store.get(second.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { dispatchCount: 1 } },
    });
  });

  it("shares one worker slot across cards dispatched with the same explicit owner", async () => {
    const store = new WorkboardStore(createMemoryStore());
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
      options: {
        resolveDefaultAgentId: () => "main",
        now: 10,
        maxStarts: 3,
        ownerId: " shared-worker ",
      },
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

  it("counts the active claim owner when checking worker capacity", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const running = await store.create({
      title: "Already claimed worker",
      status: "running",
      agentId: "alpha",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(running.id, { ownerId: "shared-worker", token: "shared-token" });
    const ready = await store.create({
      title: "Waiting for the shared owner",
      status: "ready",
      agentId: "beta",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        now: 10,
        maxStarts: 3,
        ownerId: "shared-worker",
      },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(ready.id)).resolves.toMatchObject({ status: "ready" });
  });

  it.each(["worker", "other-worker"])(
    "starts recoverable work after a higher-priority worker fails (next owner: %s)",
    async (nextOwner) => {
      const store = new WorkboardStore(createMemoryStore());
      const failed = await store.create({
        title: "Unavailable urgent worker",
        status: "ready",
        priority: "urgent",
        agentId: "worker",
        workspaceAccess: { unrestricted: true },
      });
      const recovered = await store.create({
        title: "Recoverable queued worker",
        status: "ready",
        agentId: nextOwner,
        workspaceAccess: { unrestricted: true },
      });
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("model unavailable"))
        .mockResolvedValueOnce({ runId: "run-recovered" });

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: {
          resolveDefaultAgentId: () => "main",
          now: 10,
          maxStarts: 1,
        },
      });

      expect(run).toHaveBeenCalledTimes(2);
      expect(result.started).toEqual([
        expect.objectContaining({ cardId: recovered.id, runId: "run-recovered" }),
      ]);
      expect(result.startFailures).toEqual([
        expect.objectContaining({ cardId: failed.id, error: "model unavailable" }),
      ]);
      await expect(store.get(failed.id)).resolves.toMatchObject({ status: "blocked" });
      await expect(store.get(recovered.id)).resolves.toMatchObject({ status: "running" });
    },
  );

  it("does not let review cards consume an agent running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Waiting for operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    const ready = await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        now: 10,
        maxStarts: 3,
      },
    });

    expect(result.started).toEqual([
      expect.objectContaining({
        cardId: ready.id,
        runId: "run-next",
      }),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  // Regression: an unscoped `subagent:workboard-...` key has no per-agent SQLite
  // store to resolve, so every worker start failed with "Cannot resolve SQLite
  // session scope without an agent id".
  it("scopes an unassigned card's worker session to the default agent", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Unassigned worker",
      status: "ready",
      priority: "urgent",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-unassigned" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { resolveDefaultAgentId: () => "researcher", now: 10, maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({
        cardId: card.id,
        sessionKey: `agent:researcher:subagent:workboard-default-${card.id}`,
      }),
    ]);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `agent:researcher:subagent:workboard-default-${card.id}`,
    });
  });

  it("fails an unassigned card closed when no owning agent resolves", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Ownerless worker",
      status: "ready",
      priority: "urgent",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-ownerless" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "card has no agentId and no default agent was resolved for this dispatch",
      }),
    ]);
    // A card that never reached a worker stays dispatchable.
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("starts workers only for the selected board", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops worker",
      status: "ready",
      priority: "urgent",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    const product = await store.create({
      title: "Product worker",
      status: "ready",
      priority: "urgent",
      boardId: "product",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-ops" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        now: 10,
        maxStarts: 3,
        boardId: "ops",
      },
    });

    expect(result.started).toEqual([expect.objectContaining({ cardId: ops.id })]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `agent:main:subagent:workboard-ops-${ops.id}`,
      lane: `workboard:ops:${ops.id}`,
    });
    await expect(store.get(product.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { boardId: "product" } },
    });
  });

  it("keeps claimed review cards in the owner running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const review = await store.create({
      title: "Claimed operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    await store.claim(review.id, { ownerId: "codex-main", token: "review-token" });
    await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        now: 10,
        maxStarts: 3,
      },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("blocks a card when worker start fails after claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Fail worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockRejectedValue(new Error("model unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        resolveDefaultAgentId: () => "main",
        now: 10,
        maxStarts: 1,
      },
    });

    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({ cardId: card.id, error: "model unavailable" }),
    ]);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `agent:main:subagent:workboard-default-${card.id}`,
      }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: {
        comments: [
          expect.objectContaining({
            body: expect.stringContaining("Dispatcher could not start worker"),
          }),
        ],
      },
    });
    expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();
  });
});
