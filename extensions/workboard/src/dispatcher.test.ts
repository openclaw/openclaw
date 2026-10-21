import path from "node:path";
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
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";
import type {
  WorkboardTargetWorkspaceRuntime,
  WorkboardWorkspaceAccess,
} from "./workspace-access.js";

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
  let managedPath: string;
  beforeEach(() => {
    const fixture = createWorkboardSqliteTestHarness();
    store = fixture.store;
    managedPath = path.dirname(fixture.dbPath);
  });
  const expectStatus = (id: string, status: string) =>
    expect(store.get(id)).resolves.toMatchObject({ status });
  const createCard = (input: Omit<Parameters<WorkboardStore["create"]>[0], "title"> = {}) =>
    store.create({ title: "Worker", status: "ready", ...input });
  const dispatch = (
    run: DispatchParams["subagent"]["run"],
    options: DispatchParams["options"],
    worktrees?: DispatchParams["worktrees"],
  ) => dispatchAndStartWorkboardCards({ store, subagent: { run }, options, worktrees });
  const rejectCard = async (
    input: Omit<Parameters<WorkboardStore["create"]>[0], "title">,
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
      { agentId: "other" },
      "workspace path must equal one of the caller's allowed workspace roots.",
      {
        maxStarts: 1,
        resolveAgentWorkspace: (agentId) =>
          agentId === "other" ? "/workspace-other" : "/workspace",
        workspaceAccess: writable,
      },
    );
    await expectStatus(card.id, "ready");
  });

  it("persists the resolved subagent runtime on new executions", async () => {
    const card = await createCard({ workspaceAccess: { unrestricted: true } });
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
    await expectStatus(card.id, "ready");
  });

  it.each([
    {
      name: "unsandboxed target",
      runtime: { sandboxed: false, workspaceAccess: { unrestricted: true } },
      error: "target agent is not sandboxed for this restricted Workboard card.",
    },
    {
      name: "read-only target",
      runtime: { sandboxed: true, workspaceAccess: { ...writable, writable: false } },
      error: "target agent does not have writable workspace-only access.",
    },
    {
      name: "sandbox escape",
      runtime: {
        sandboxed: true,
        workspaceAccess: writable,
        confinementError: "target sandbox routes shell execution outside the sandbox.",
      },
      error: "target sandbox routes shell execution outside the sandbox.",
    },
  ] satisfies { name: string; runtime: WorkboardTargetWorkspaceRuntime; error: string }[])(
    "rejects a restricted card with $name",
    async ({ runtime, error }) => {
      await rejectCard(
        { workspaceAccess: writable },
        error,
        targetOptions(runtime),
        createWorktreeRuntime(),
      );
    },
  );

  it("keeps read-only card authority after a later full-host dispatch", async () => {
    const card = await rejectCard(
      { workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false } },
      expect.stringContaining("manual movement is allowed"),
      { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    );
    await expectStatus(card.id, "ready");
  });

  it("rejects a target sandbox root broader than the card authority", async () => {
    await rejectCard(
      {
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

  it.each([
    ["/repo/workspace", "/repo", true, "workspace root is nested inside a broader Git checkout."],
    [
      "/workspace",
      "/workspace",
      false,
      "restricted workspace Git metadata must be contained inside its root.",
    ],
  ] as const)(
    "rejects unsafe checkout metadata in %s",
    async (root, checkout, contained, error) => {
      const workspaceAccess = { ...writable, roots: [root] };
      await rejectCard(
        { workspace: { kind: "dir", path: root }, workspaceAccess },
        error,
        targetOptions({ sandboxed: true, workspaceAccess }, root),
        createWorktreeRuntime({
          resolveCheckoutRoot: vi.fn().mockResolvedValue(checkout),
          hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(contained),
        }),
      );
    },
  );

  it("keeps a card's persisted workspace ceiling during a later admin dispatch", async () => {
    const card = await createCard({
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

  it("does not reuse a generated branch as an omitted source base", async () => {
    const card = await createCard({
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
    await createCard({ status: "running", agentId: "main" });
    const cards = await Promise.all(
      [undefined, { dispatchCount: 225, lastDispatchAt: 1 }].map((automation) =>
        createCard({ agentId: "main", metadata: { automation } }),
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
      priority: "urgent",
      agentId: "alpha",
      workspaceAccess: { unrestricted: true },
    });
    const second = await createCard({ agentId: "beta", workspaceAccess: { unrestricted: true } });
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
    await expectStatus(second.id, "ready");
  });
  const createAuthorizedCard = (input: Omit<Parameters<WorkboardStore["create"]>[0], "title">) =>
    createCard({ workspaceAccess: { unrestricted: true }, ...input });
  it.each([
    { name: "archived", archive: true },
    { name: "completed", status: "done" as const },
    { name: "moved to another board", boardId: "product" },
  ])("does not start a card $name during dispatch preflight", async (transition) => {
    const card = await createAuthorizedCard({ boardId: "ops" });
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async (id, input, options) => {
      if ("archive" in transition) {
        await store.archive(id, true);
      } else if ("boardId" in transition) {
        await store.update(id, { boardId: transition.boardId });
      } else {
        await store.update(id, { status: transition.status });
      }
      return await originalClaim(id, input, options);
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, boardId: "ops", workspaceAccess: { unrestricted: true } },
    });

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      started: [],
      startFailures: [{ cardId: card.id, error: expect.stringMatching(/archived|authority/) }],
    });
    const current = await store.get(card.id);
    expect(current?.metadata?.claim).toBeUndefined();
    if ("archive" in transition) {
      expect(current?.metadata?.archivedAt).toBeGreaterThan(0);
    } else if ("boardId" in transition) {
      expect(current?.metadata?.automation?.boardId).toBe("product");
    } else {
      expect(current?.status).toBe(transition.status);
    }
  });

  it("does not spend worker attempts on cards that change before they can be claimed", async () => {
    const first = await createAuthorizedCard({ priority: "urgent", agentId: "first-worker" });
    const second = await createAuthorizedCard({ priority: "high", agentId: "second-worker" });
    const healthy = await createAuthorizedCard({ priority: "normal", agentId: "healthy-worker" });
    const originalClaim = store.claim.bind(store);
    const staleCardIds = new Set([first.id, second.id]);
    vi.spyOn(store, "claim").mockImplementation(async (id, input, options) => {
      if (staleCardIds.delete(id)) {
        await store.archive(id, true);
      }
      return await originalClaim(id, input, options);
    });
    const run = vi.fn().mockResolvedValue({ runId: "healthy-run" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    });

    expect(result.startFailures.map((failure) => failure.cardId)).toEqual([first.id, second.id]);
    expect(result.started).toMatchObject([{ cardId: healthy.id, runId: "healthy-run" }]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(healthy.id)).resolves.toMatchObject({ status: "running" });
    for (const cardId of [first.id, second.id]) {
      const archived = await store.get(cardId);
      expect(archived?.metadata?.archivedAt).toBeGreaterThan(0);
      expect(archived?.metadata?.claim).toBeUndefined();
    }
  });

  it("retains a managed worktree when pre-start lossless cleanup declines", async () => {
    const card = await createAuthorizedCard({
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
    });
    const removeIfLossless = vi.fn().mockResolvedValue(false);
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockRejectedValue(new Error("model unavailable")) },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi
          .fn()
          .mockResolvedValue({ id: "managed-id", path: managedPath, branch: "managed" }),
        release: vi.fn(),
        removeIfLossless,
      },
      options: { now: 10, maxStarts: 1, materializeWorktree: true },
    });

    expect(result.startFailures).toMatchObject([{ cardId: card.id, error: "model unavailable" }]);
    expect(removeIfLossless).toHaveBeenCalledOnce();
    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.automation?.workspace).toMatchObject({
      kind: "worktree",
      path: managedPath,
      sourcePath: "/repo",
    });
    expect([blocked?.execution, blocked?.runId]).toEqual([undefined, undefined]);
  });
  const fullHostAccess: WorkboardWorkspaceAccess = { unrestricted: true };
  const workspaceAccess = writable;
  const readOnlyAccess: WorkboardWorkspaceAccess = { ...workspaceAccess, writable: false };

  async function setupDiagnostics(persisted: WorkboardWorkspaceAccess | undefined) {
    const card = await store.create({
      title: "Outside checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
      workspaceAccess: persisted,
    });
    return { card, run: vi.fn() };
  }

  it.each([
    ["host-authorized card", fullHostAccess, workspaceAccess, true],
    ["unknown card authority", undefined, workspaceAccess, false],
    ["workspace-bound card", workspaceAccess, workspaceAccess, false],
    ["admin caller with restricted card", workspaceAccess, fullHostAccess, false],
    ["read-only caller", fullHostAccess, readOnlyAccess, false],
  ] as const)("offers an admin retry for %s", async (_name, persisted, caller, hint) => {
    const { card, run } = await setupDiagnostics(persisted);
    const create = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees: createWorktreeRuntime({ create }),
      options: { maxStarts: 1, materializeWorktree: true, workspaceAccess: caller },
    });

    expect(result).toMatchObject({ started: [], startFailures: [{ cardId: card.id }] });
    expect(result.startFailures[0]?.error.includes("--admin")).toBe(hint);
    expect(result.startFailures[0]?.error.includes("operator.admin")).toBe(hint);
    expect(run).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toEqual(card);
  });

  it("does not classify arbitrary error prose as an admin-recoverable refusal", async () => {
    const { card, run } = await setupDiagnostics(fullHostAccess);
    const message = "workspace path is outside the caller's allowed workspaces.";

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        maxStarts: 1,
        workspaceAccess,
        resolveAgentWorkspace: () => {
          throw new Error(message);
        },
      },
    });

    expect(result.startFailures).toEqual([{ cardId: card.id, title: card.title, error: message }]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toEqual(card);
  });
});
