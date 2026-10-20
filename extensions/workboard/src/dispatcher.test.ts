import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { WorkboardStore } from "./store.js";
import { createWorktreeRuntime } from "./test/interaction-fixtures.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import type { WorkboardTargetWorkspaceRuntime } from "./workspace-access.js";

type DispatchParams = Parameters<typeof dispatchAndStartWorkboardCards>[0];
const targetOptions = (runtime: WorkboardTargetWorkspaceRuntime, root = "/workspace") => ({
  maxStarts: 1,
  resolveAgentWorkspace: () => root,
  resolveAgentWorkspaceRuntime: () => runtime,
});

function expectRejected(
  result: Awaited<ReturnType<typeof dispatchAndStartWorkboardCards>>,
  cardId: string,
  error: unknown,
  run: DispatchParams["subagent"]["run"],
) {
  expect(result.startFailures).toEqual([expect.objectContaining({ cardId, error })]);
  expect(run).not.toHaveBeenCalled();
}
const writable = {
  unrestricted: false,
  roots: ["/workspace"],
  writable: true,
} satisfies NonNullable<DispatchParams["options"]>["workspaceAccess"];

describe("dispatchAndStartWorkboardCards", () => {
  let store: WorkboardStore;
  beforeEach(() => {
    store = createWorkboardSqliteTestStore();
  });
  const createCard = (input: Parameters<WorkboardStore["create"]>[0]) =>
    store.create({ status: "ready", ...input });
  const dispatch = (
    run: DispatchParams["subagent"]["run"],
    options: DispatchParams["options"],
    worktrees?: DispatchParams["worktrees"],
  ) => dispatchAndStartWorkboardCards({ store, subagent: { run }, options, worktrees });
  const rejectCard = async (
    input: Parameters<WorkboardStore["create"]>[0],
    error: unknown,
    options: DispatchParams["options"],
    worktrees?: DispatchParams["worktrees"],
  ) => {
    const card = await createCard(input);
    const run = vi.fn();
    expectRejected(await dispatch(run, options, worktrees), card.id, error, run);
    return card;
  };
  it.each(["assigned", "unassigned"] as const)(
    "rejects an archived %s worker before claim without spending retries",
    async (assignment) => {
      const previousConfig = getRuntimeConfigSnapshot();
      setRuntimeConfigSnapshot({ agents: { entries: { worker: {} } } });
      try {
        const card = await createCard({
          title: "Archived worker",
          ...(assignment === "assigned" ? { agentId: "worker" } : {}),
          workspaceAccess: { unrestricted: true },
          maxRetries: 1,
          metadata: { failureCount: 1 },
        });
        const sessionKey = `${assignment === "assigned" ? "agent:worker:" : ""}subagent:workboard-default-${card.id}`;
        using read = vi.spyOn(sessionStore, "getSessionEntryAsync").mockResolvedValue({
          sessionId: "archived-worker",
          updatedAt: 1,
          archivedAt: 1,
        });
        using claim = vi.spyOn(store, "claim");
        const run = vi.fn().mockResolvedValue({ runId: "recovered-worker" });
        const recovery = `openclaw sessions delete ${sessionKey}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await dispatch(run, { maxStarts: 1 });
          expectRejected(result, card.id, expect.stringContaining(recovery), run);
        }
        expect(claim).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledWith(
          expect.objectContaining({ sessionKey, agentId: "worker" }),
        );
        const current = await store.get(card.id);
        expect(current).toMatchObject({ status: "ready", metadata: { failureCount: 1 } });
        expect(current?.metadata?.claim).toBeUndefined();
        expect(current?.metadata?.workerLogs).toContainEqual(
          expect.objectContaining({ level: "warning", message: expect.stringContaining(recovery) }),
        );
        read.mockResolvedValue(
          assignment === "assigned" ? undefined : { sessionId: "restored-worker", updatedAt: 2 },
        );
        expect((await dispatch(run, { maxStarts: 1 })).started).toHaveLength(1);
        expect(run).toHaveBeenCalledOnce();
      } finally {
        if (previousConfig) {
          setRuntimeConfigSnapshot(previousConfig);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
    },
  );

  it("does not let an implicit target agent workspace widen caller access", async () => {
    const card = await rejectCard(
      {
        title: "Other agent scratch",
        agentId: "other",
      },
      "workspace path must equal one of the caller's allowed workspace roots.",
      {
        maxStarts: 1,
        resolveAgentWorkspace: (agentId) =>
          agentId === "other" ? "/workspace-other" : "/workspace",
        workspaceAccess: writable,
      },
    );
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("persists the resolved subagent runtime on new executions", async () => {
    const card = await createCard({
      title: "Claude worker",
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

    await dispatch(run, { now: 10, maxStarts: 1 });

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
    const card = await createCard({
      title: "Isolated worker",
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-worktree" });
    const worktrees = createWorktreeRuntime({
      create: vi.fn().mockResolvedValue({
        id: "managed-id",
        path: "/state/worktrees/fingerprint/wb-card",
        branch: `openclaw/wb-${card.id}`,
      }),
      removeIfLossless: vi.fn().mockResolvedValue(true),
    });

    await dispatch(
      run,
      {
        now: 10,
        maxStarts: 1,
        materializeWorktree: true,
      },
      worktrees,
    );

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
    const card = await createCard({
      title: "Racing authority update",
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

    const result = await dispatch(run, { maxStarts: 1, workspaceAccess: { unrestricted: true } });

    expectRejected(result, card.id, "card workspace authority changed before claim.", run);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects a restricted card when the target agent is not sandboxed", async () => {
    await rejectCard(
      {
        title: "Restricted worker",
        agentId: "broad",
        workspaceAccess: writable,
      },
      "target agent is not sandboxed for this restricted Workboard card.",
      targetOptions({
        sandboxed: false,
        workspaceAccess: { unrestricted: true },
      }),
      createWorktreeRuntime(),
    );
  });

  it("rejects a restricted card when the target workspace is read-only", async () => {
    await rejectCard(
      {
        title: "Read-only worker",
        workspaceAccess: writable,
      },
      "target agent does not have writable workspace-only access.",
      targetOptions({
        sandboxed: true,
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
      }),
      createWorktreeRuntime(),
    );
  });

  it("keeps read-only card authority after a later full-host dispatch", async () => {
    const card = await rejectCard(
      {
        title: "Persisted read-only worker",
        workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
      },
      expect.stringContaining("manual movement is allowed"),
      { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    );
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects a target sandbox root broader than the card authority", async () => {
    await rejectCard(
      {
        title: "Broader target worker",
        workspace: { kind: "dir", path: "/workspace/project" },
        workspaceAccess: {
          unrestricted: false,
          roots: ["/workspace/project"],
          writable: true,
        },
      },
      "workspace path must equal one of the caller's allowed workspace roots.",
      {
        maxStarts: 1,
        resolveAgentWorkspaceRuntime: () => ({
          sandboxed: true,
          workspaceAccess: writable,
        }),
      },
      createWorktreeRuntime(),
    );
  });

  it("rejects a restricted card when the target sandbox has an escape path", async () => {
    await rejectCard(
      {
        title: "Escaping worker",
        workspaceAccess: writable,
      },
      "target sandbox routes shell execution outside the sandbox.",
      targetOptions({
        sandboxed: true,
        workspaceAccess: writable,
        confinementError: "target sandbox routes shell execution outside the sandbox.",
      }),
      createWorktreeRuntime(),
    );
  });

  it("rejects a restricted workspace nested inside a broader Git checkout", async () => {
    await rejectCard(
      {
        title: "Nested checkout worker",
        workspace: { kind: "dir", path: "/repo/workspace" },
        workspaceAccess: { unrestricted: false, roots: ["/repo/workspace"], writable: true },
      },
      "workspace root is nested inside a broader Git checkout.",
      targetOptions(
        {
          sandboxed: true,
          workspaceAccess: {
            unrestricted: false,
            roots: ["/repo/workspace"],
            writable: true,
          },
        },
        "/repo/workspace",
      ),
      createWorktreeRuntime({ resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo") }),
    );
  });

  it("keeps a card's persisted workspace ceiling during a later admin dispatch", async () => {
    const card = await createCard({
      title: "Persisted restricted worker",
      workspace: { kind: "worktree", path: "/workspace" },
      workspaceAccess: writable,
    });
    const create = vi.fn();
    const run = vi.fn().mockResolvedValue({ runId: "run-persisted" });

    const result = await dispatch(
      run,
      {
        ...targetOptions({
          sandboxed: true,
          workspaceAccess: writable,
        }),
        materializeWorktree: true,
        workspaceAccess: { unrestricted: true },
      },
      createWorktreeRuntime({
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/workspace"),
        hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(true),
        create,
      }),
    );

    expect(result.started).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: writable,
        },
      },
    });
  });

  it("rejects linked-worktree metadata outside a restricted workspace mount", async () => {
    await rejectCard(
      {
        title: "Linked worktree worker",
        workspace: { kind: "dir", path: "/workspace" },
        workspaceAccess: writable,
      },
      "restricted workspace Git metadata must be contained inside its root.",
      targetOptions({
        sandboxed: true,
        workspaceAccess: writable,
      }),
      createWorktreeRuntime({
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/workspace"),
        hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(false),
      }),
    );
  });

  it("does not reuse a generated branch as an omitted source base", async () => {
    const card = await createCard({
      title: "Branchless retry",
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

    await dispatch(
      vi.fn().mockResolvedValue({ runId: "run-retry" }),
      { maxStarts: 1, materializeWorktree: true },
      createWorktreeRuntime({ create }),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo", ownerId: card.id }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("baseRef");
  });

  it("preserves ready-card history on idle Gateway dispatch passes", async () => {
    await createCard({ title: "Occupied owner", status: "running", agentId: "main" });
    const cards = await Promise.all(
      [undefined, { dispatchCount: 225, lastDispatchAt: 1 }].map((automation) =>
        createCard({
          title: "Waiting for owner capacity",
          agentId: "main",
          metadata: { automation },
        }),
      ),
    );
    const run = vi.fn();

    for (const now of [10, 20, 30]) {
      const result = await dispatch(run, { now, maxStarts: 1 });
      expect(result.started).toEqual([]);
      expect(result.startFailures).toEqual([]);
      for (const card of cards) {
        await expect(store.get(card.id)).resolves.toEqual(card);
      }
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("shares one worker slot across cards dispatched with the same explicit owner", async () => {
    const first = await createCard({
      title: "First shared worker",
      priority: "urgent",
      agentId: "alpha",
      workspaceAccess: { unrestricted: true },
    });
    const second = await createCard({
      title: "Second shared worker",
      agentId: "beta",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-shared" });

    const result = await dispatch(run, { now: 10, maxStarts: 3, ownerId: " shared-worker " });

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
