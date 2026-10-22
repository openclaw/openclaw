import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dispatcherWorkspace from "./dispatcher-workspace.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { fakeClock } from "./store-family.test-support.js";
import type { WorkboardStore } from "./store.js";
import { createWorktreeRuntime } from "./test/interaction-fixtures.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";
import type {
  WorkboardTargetWorkspaceRuntime,
  WorkboardWorkspaceAccess,
} from "./workspace-access.js";

type DispatchParams = Parameters<typeof dispatchAndStartWorkboardCards>[0];
const fullHostAccess = { unrestricted: true } as const;
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
  let run = vi.fn();
  let managedPath: string;
  beforeEach(() => {
    const fixture = createWorkboardSqliteTestHarness();
    store = fixture.store;
    run = vi.fn();
    managedPath = path.dirname(fixture.dbPath);
  });
  const expectStored = (id: string, shape: object) =>
    expect(store.get(id)).resolves.toMatchObject(shape);
  const expectStatus = (id: string, status: string) => expectStored(id, { status });
  const expectStarted = (
    result: Awaited<ReturnType<typeof dispatch>>,
    cardId: string,
    runId: string,
  ) => expect(result.started).toEqual([expect.objectContaining({ cardId, runId })]);
  const createCard = (
    input: Omit<Parameters<WorkboardStore["create"]>[0], "title"> & { title?: string } = {},
  ) => store.create({ title: "Worker", status: "ready", ...input });
  const dispatch = (
    options: DispatchParams["options"] = {},
    worktrees?: DispatchParams["worktrees"],
  ) =>
    dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, ...options },
      worktrees,
    });
  const rejectCard = async (
    input: Omit<Parameters<WorkboardStore["create"]>[0], "title">,
    error: unknown,
    options: DispatchParams["options"],
    worktrees?: DispatchParams["worktrees"],
  ) => {
    const card = await createCard(input);
    expectRejected(await dispatch(options, worktrees), card.id, error, run);
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
          workspaceAccess: fullHostAccess,
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
        run = vi.fn().mockResolvedValue({ runId: "recovered-worker" });
        const recovery = `openclaw sessions delete ${sessionKey}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await dispatch();
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
        expect((await dispatch()).started).toHaveLength(1);
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
        resolveAgentWorkspace: (agentId) =>
          agentId === "other" ? "/workspace-other" : "/workspace",
        workspaceAccess: writable,
      },
    );
    await expectStatus(card.id, "ready");
  });

  it("persists the resolved subagent runtime on new executions", async () => {
    const card = await createCard({ workspaceAccess: fullHostAccess });
    run = vi.fn().mockResolvedValue({
      runId: "run-claude",
      runtime: {
        harness: "claude-cli",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });

    await dispatch({ now: 10 });

    await expectStored(card.id, {
      execution: {
        id: `${card.id}:agent-session`,
        engine: "claude-cli",
        model: "anthropic/claude-sonnet-4-6",
        runId: "run-claude",
      },
    });
  });

  it.each(["main", undefined])(
    "materializes and persists a workspace with source base %s",
    async (sourceBranch) => {
      const managed = "/state/worktrees/fingerprint/wb-card";
      const card = await createCard({
        workspace: sourceBranch
          ? { kind: "worktree", path: "/repo", branch: sourceBranch }
          : { kind: "worktree", path: managed, branch: "openclaw/wb-card", sourcePath: "/repo" },
        workspaceAccess: fullHostAccess,
      });
      const branch = sourceBranch ? `openclaw/wb-${card.id}` : "openclaw/wb-card";
      run = vi.fn().mockResolvedValue({ runId: "run-worktree" });
      const worktrees = createWorktreeRuntime({
        create: vi.fn().mockResolvedValue({ id: "managed-id", path: managed, branch }),
        ...(sourceBranch ? { removeIfLossless: vi.fn().mockResolvedValue(true) } : {}),
      });
      await dispatch({ now: 10, materializeWorktree: true }, worktrees);
      expect(worktrees.create).toHaveBeenCalledWith(
        expect.objectContaining({
          repoRoot: "/repo",
          ownerKind: "workboard",
          ownerId: card.id,
          ...(sourceBranch ? { baseRef: sourceBranch } : {}),
        }),
      );
      if (!sourceBranch) {
        expect(vi.mocked(worktrees.create).mock.calls[0]?.[0]).not.toHaveProperty("baseRef");
      }
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: managed }));
      await expectStored(card.id, {
        metadata: {
          automation: {
            workspace: {
              kind: "worktree",
              path: managed,
              branch,
              sourcePath: "/repo",
              ...(sourceBranch ? { sourceBranch } : {}),
            },
          },
        },
      });
      expect(worktrees.removeIfLossless).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "unsandboxed target",
      runtime: { sandboxed: false, workspaceAccess: fullHostAccess },
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
      { workspaceAccess: fullHostAccess },
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
    run = vi.fn().mockResolvedValue({ runId: "run-persisted" });

    const result = await dispatch(
      {
        ...targetOptions({
          sandboxed: true,
          workspaceAccess: writable,
        }),
        materializeWorktree: true,
        workspaceAccess: fullHostAccess,
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
    await expectStored(card.id, {
      metadata: {
        automation: {
          workspaceAccess: writable,
        },
      },
    });
  });

  it("preserves ready-card history on idle Gateway dispatch passes", async () => {
    await createCard({ status: "running", agentId: "main" });
    const cards = await Promise.all(
      [undefined, { dispatchCount: 225, lastDispatchAt: 1 }].map((automation) =>
        createCard({ agentId: "main", metadata: { automation } }),
      ),
    );

    for (const now of [10, 20, 30]) {
      const result = await dispatch({ now });
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
      workspaceAccess: fullHostAccess,
    });
    const second = await createCard({ agentId: "beta", workspaceAccess: fullHostAccess });
    run = vi.fn().mockResolvedValue({ runId: "run-shared" });

    const result = await dispatch({ now: 10, maxStarts: 3, ownerId: " shared-worker " });

    expectStarted(result, first.id, "run-shared");
    expect(run).toHaveBeenCalledOnce();
    await expectStored(first.id, {
      status: "running",
      metadata: { claim: { ownerId: "shared-worker" } },
    });
    await expectStatus(second.id, "ready");
  });
  const createAuthorizedCard = (
    input: Omit<Parameters<WorkboardStore["create"]>[0], "title"> & { title?: string } = {},
  ) => createCard({ workspaceAccess: fullHostAccess, ...input });
  it.each([
    { name: "archived", archive: true },
    { name: "completed", status: "done" as const },
    { name: "moved to another board", boardId: "product" },
    { name: "given different workspace authority", workspaceAccess: writable },
  ])("does not start a card $name during dispatch preflight", async (transition) => {
    const card = await createAuthorizedCard({
      boardId: "ops",
      ...("workspaceAccess" in transition
        ? { workspace: { kind: "dir", path: "/workspace" } as const }
        : {}),
    });
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async (id, input, options) => {
      if ("archive" in transition) {
        await store.archive(id, true);
      } else if ("boardId" in transition) {
        await store.update(id, { boardId: transition.boardId });
      } else if ("workspaceAccess" in transition) {
        await store.update(id, { workspaceAccess: transition.workspaceAccess });
      } else {
        await store.update(id, { status: transition.status });
      }
      return await originalClaim(id, input, options);
    });

    const result = await dispatch({ boardId: "ops", workspaceAccess: fullHostAccess });

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      started: [],
      startFailures: [
        {
          cardId: card.id,
          error:
            "workspaceAccess" in transition
              ? "card workspace authority changed before claim."
              : expect.stringMatching(/archived|authority/),
        },
      ],
    });
    const current = await store.get(card.id);
    expect(current?.metadata?.claim).toBeUndefined();
    if ("archive" in transition) {
      expect(current?.metadata?.archivedAt).toBeGreaterThan(0);
    } else if ("boardId" in transition) {
      expect(current?.metadata?.automation?.boardId).toBe("product");
    } else if ("workspaceAccess" in transition) {
      expect(current?.status).toBe("ready");
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
    run = vi.fn().mockResolvedValue({ runId: "healthy-run" });

    const result = await dispatch({ workspaceAccess: fullHostAccess });

    expect(result.startFailures.map((failure) => failure.cardId)).toEqual([first.id, second.id]);
    expect(result.started).toMatchObject([{ cardId: healthy.id, runId: "healthy-run" }]);
    expect(run).toHaveBeenCalledOnce();
    await expectStored(healthy.id, { status: "running" });
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
    run = vi.fn().mockRejectedValue(new Error("model unavailable"));
    const result = await dispatch(
      { now: 10, materializeWorktree: true },
      createWorktreeRuntime({
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi
          .fn()
          .mockResolvedValue({ id: "managed-id", path: managedPath, branch: "managed" }),
        removeIfLossless,
      }),
    );

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
  const workspaceAccess = writable;
  const readOnlyAccess: WorkboardWorkspaceAccess = { ...workspaceAccess, writable: false };

  async function setupDiagnostics(persisted: WorkboardWorkspaceAccess | undefined) {
    const card = await store.create({
      title: "Outside checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
      workspaceAccess: persisted,
    });
    return card;
  }

  it.each([
    ["host-authorized card", fullHostAccess, workspaceAccess, true],
    ["unknown card authority", undefined, workspaceAccess, false],
    ["workspace-bound card", workspaceAccess, workspaceAccess, false],
    ["admin caller with restricted card", workspaceAccess, fullHostAccess, false],
    ["read-only caller", fullHostAccess, readOnlyAccess, false],
  ] as const)("offers an admin retry for %s", async (_name, persisted, caller, hint) => {
    const card = await setupDiagnostics(persisted);
    const create = vi.fn();

    const result = await dispatch(
      { materializeWorktree: true, workspaceAccess: caller },
      createWorktreeRuntime({ create }),
    );

    expect(result).toMatchObject({ started: [], startFailures: [{ cardId: card.id }] });
    expect(result.startFailures[0]?.error.includes("--admin")).toBe(hint);
    expect(result.startFailures[0]?.error.includes("operator.admin")).toBe(hint);
    expect(run).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toEqual(card);
  });

  it("does not classify arbitrary error prose as an admin-recoverable refusal", async () => {
    const card = await setupDiagnostics(fullHostAccess);
    const message = "workspace path is outside the caller's allowed workspaces.";

    const result = await dispatch({
      workspaceAccess,
      resolveAgentWorkspace: () => {
        throw new Error(message);
      },
    });

    expect(result.startFailures).toEqual([{ cardId: card.id, title: card.title, error: message }]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toEqual(card);
  });
  it("bounds failed worker attempts without draining the ready queue", async () => {
    const cards = [];
    for (let index = 0; index < 5; index += 1) {
      cards.push(
        await createAuthorizedCard({
          title: `Queued worker ${index + 1}`,
          agentId: `worker-${index + 1}`,
        }),
      );
    }
    run = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    const result = await dispatch({ now: 10 });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.started).toEqual([]);
    expect(result.startFailures.map((failure) => failure.cardId)).toEqual([
      cards[0]?.id,
      cards[1]?.id,
    ]);
    const persisted = await Promise.all(cards.map((card) => store.get(card.id)));
    const statuses = persisted.map((card) => card?.status);
    expect(statuses).toEqual(["blocked", "blocked", "ready", "ready", "ready"]);
    for (const rejected of persisted.slice(0, 2)) {
      expect(rejected).not.toHaveProperty("metadata.claim");
      expect(rejected).not.toHaveProperty("sessionKey");
      expect(rejected).not.toHaveProperty("runId");
      expect(rejected).not.toHaveProperty("execution");
    }
  });

  it.each(["unknown-authority", "missing-target"] as const)(
    "keeps %s preflight failures unclaimed and continues to a healthy card",
    async (stage) => {
      const rejected = [];
      for (const [index, priority] of (["urgent", "high"] as const).entries()) {
        rejected.push(
          await store.create({
            title: `Inaccessible worker ${index + 1}`,
            status: "ready",
            priority,
            agentId: `inaccessible-worker-${index + 1}`,
            ...(stage === "missing-target"
              ? { workspaceAccess: fullHostAccess }
              : { workspace: { kind: "worktree" as const, path: "/repo" } }),
          }),
        );
      }
      const healthy = await createAuthorizedCard({ agentId: "healthy-worker" });
      const rejectedIds = new Set(rejected.map((card) => card.id));
      const before = await Promise.all(rejected.map((card) => store.get(card.id)));
      const resolveAccess = dispatcherWorkspace.resolveDispatchWorkspaceAccess;
      using _ = vi
        .spyOn(dispatcherWorkspace, "resolveDispatchWorkspaceAccess")
        .mockImplementation(async (params) =>
          stage !== "missing-target" || !rejectedIds.has(params.card.id)
            ? resolveAccess(params)
            : {
                workspaceAccess: {
                  unrestricted: false,
                  roots: ["/workspace/denied"],
                  writable: true,
                },
                persistWorkspaceAccess: false,
              },
        );
      using claim = vi.spyOn(store, "claim");
      using prepare = vi.spyOn(store, "prepareExecutionLaunch");
      using block = vi.spyOn(store, "block");
      using fail = vi.spyOn(store, "failPreparedLaunch");
      run = vi.fn().mockResolvedValue({ runId: "run-healthy-worker" });
      const result = await dispatch({ now: 10 });
      const error =
        stage === "missing-target"
          ? "target agent workspace is unavailable for restricted dispatch"
          : "card workspace authority is unknown; re-save its workspace with current permissions before dispatch.";
      expect(result.startFailures).toEqual(
        rejected.map((card) => ({ cardId: card.id, title: card.title, error })),
      );
      expect(result.started).toEqual([
        {
          cardId: healthy.id,
          title: healthy.title,
          sessionKey: expect.any(String),
          runId: "run-healthy-worker",
        },
      ]);
      for (const spy of [claim, prepare]) {
        expect(spy.mock.calls.map(([cardId]) => cardId)).toEqual([healthy.id]);
      }
      expect(run).toHaveBeenCalledOnce();
      expect(block).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      expect(await Promise.all(rejected.map((card) => store.get(card.id)))).toEqual(before);
      await expectStored(healthy.id, {
        status: "running",
        execution: { runId: "run-healthy-worker" },
      });
    },
  );

  it("tries a healthy owner before retrying a failed owner's queued cards", async () => {
    const failed = await createAuthorizedCard({
      priority: "urgent",
      agentId: "unavailable-worker",
    });
    const deferred = await createAuthorizedCard({
      priority: "high",
      agentId: "unavailable-worker",
    });
    const healthy = await createAuthorizedCard({ agentId: "healthy-worker" });
    run = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ runId: "run-healthy-owner" });

    const result = await dispatch({ now: 10 });

    expect(run).toHaveBeenCalledTimes(2);
    expectStarted(result, healthy.id, "run-healthy-owner");
    expect(result.startFailures).toEqual([
      expect.objectContaining({ cardId: failed.id, error: "provider unavailable" }),
    ]);
    await expectStatus(failed.id, "blocked");
    await expectStatus(deferred.id, "ready");
    await expectStatus(healthy.id, "running");
  });

  it("keeps a cross-board running worker slot for a different assigned agent until its heartbeat grace expires", async () => {
    const agentId = "assigned-worker";

    using clock = fakeClock();
    clock.set(10_000);
    const stale = await store.create({
      title: "Abandoned product worker",
      status: "running",
      agentId,
      boardId: "product",
      execution: {
        id: "stale-execution",
        kind: "agent-session",
        mode: "autonomous",
        status: "running",
        startedAt: 1,
        updatedAt: 1,
      },
    });
    const claimed = await store.claim(stale.id, {
      ownerId: "shared-worker",
      token: "stale-token",
      ttlSeconds: 1,
    });
    const ready = await createAuthorizedCard({ agentId: "shared-worker", boardId: "ops" });
    run = vi.fn().mockResolvedValue({ runId: "run-after-grace" });
    const expiresAt = claimed.card.metadata?.claim?.expiresAt;
    expect(expiresAt).toBeDefined();
    const occupied = {
      status: "running",
      execution: { status: "running" },
      metadata: { claim: { ownerId: "shared-worker" } },
    };

    clock.set(expiresAt! + 5 * 60 * 1000);
    const withinGrace = await dispatch({
      boardId: "ops",
    });

    expect(withinGrace.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await expectStored(stale.id, occupied);

    clock.set(expiresAt! + 5 * 60 * 1000 + 1);
    const reclaimed = await dispatch({
      boardId: "ops",
    });

    expectStarted(reclaimed, ready.id, "run-after-grace");
    expect(run).toHaveBeenCalledOnce();
    await expectStored(stale.id, occupied);
  });

  it("selects at the dispatch snapshot while claiming at current time (10000, 50000)", async () => {
    const wallClock = 10_000;
    const dispatchNow = 50_000;

    using clock = fakeClock();
    clock.set(wallClock);
    const review = await store.create({
      title: "Review claim with a deterministic expiry",
      status: "review",
      agentId: "shared-worker",
      metadata: {
        claim: {
          ownerId: "shared-worker",
          token: "timed-token",
          claimedAt: 1_000,
          lastHeartbeatAt: 1_000,
          expiresAt: 20_000,
        },
      },
    });
    const ready = await createAuthorizedCard({ agentId: "shared-worker" });
    run = vi.fn().mockResolvedValue({ runId: "run-at-dispatch-time" });
    const claim = vi.spyOn(store, "claim");

    const result = await dispatch({ now: dispatchNow });

    expect(claim.mock.calls.map(([id]) => id)).toEqual([ready.id]);
    expect(run).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: ready.id,
        error: "Owner shared-worker already has active Workboard work.",
      }),
    ]);
    const unchangedReady = await store.get(ready.id);
    expect(unchangedReady?.status).toBe("ready");
    expect(unchangedReady?.metadata?.claim).toBeUndefined();
    await expectStored(review.id, {
      status: "review",
      metadata: { claim: review.metadata?.claim },
    });
  });

  it("replaces an expired ready-card claim with the workboard-dispatcher slot", async () => {
    const now = Date.now();
    const card = await createAuthorizedCard({
      metadata: {
        claim: {
          ownerId: "retired-worker",
          token: "expired-token",
          claimedAt: now - 60_000,
          lastHeartbeatAt: now - 60_000,
          expiresAt: now - 1_000,
        },
      },
    });
    run = vi.fn().mockResolvedValue({ runId: "run-reclaimed" });

    const result = await dispatch();

    expectStarted(result, card.id, "run-reclaimed");
    expect(run).toHaveBeenCalledOnce();
    await expectStored(card.id, {
      status: "running",
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });
    expect((await store.get(card.id))?.agentId).toBeUndefined();
    expect((await store.get(card.id))?.metadata?.claim?.token).not.toBe("expired-token");
  });

  it("serializes concurrent board dispatches for the same worker", async () => {
    const ops = await createAuthorizedCard({ boardId: "ops", agentId: "shared-worker" });
    const product = await createAuthorizedCard({ boardId: "product", agentId: "shared-worker" });
    const originalList = store.list.bind(store);
    let snapshotCount = 0;
    const { promise: snapshotsReleased, resolve: releaseSnapshots } = Promise.withResolvers<void>();
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const cards = await originalList(options);
      if (options === undefined && snapshotCount < 2) {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          releaseTimer = setTimeout(() => releaseSnapshots(), 0);
        } else {
          if (releaseTimer !== undefined) {
            clearTimeout(releaseTimer);
          }
          releaseSnapshots();
        }
        await snapshotsReleased;
      }
      return cards;
    });
    run = vi.fn().mockResolvedValue({ runId: "run-shared-board" });

    const results = await Promise.all([
      dispatch({ boardId: "ops" }),
      dispatch({ boardId: "product" }),
    ]);

    expect(run).toHaveBeenCalledOnce();
    expect(results.flatMap((result) => result.started)).toEqual([
      expect.objectContaining({ cardId: ops.id, runId: "run-shared-board" }),
    ]);
    await expectStored(ops.id, {
      status: "running",
      metadata: { claim: { ownerId: "shared-worker" } },
    });
    await expectStatus(product.id, "ready");
  });

  it.each(["execution", "logging"] as const)(
    "keeps accepted workers visible when %s persistence fails",
    async (fault) => {
      const card = await createAuthorizedCard();
      if (fault === "execution") {
        vi.spyOn(store, "acceptExecutionLaunch").mockRejectedValueOnce(
          new Error("enrichment unavailable"),
        );
      } else {
        vi.spyOn(store, "addWorkerLog").mockRejectedValueOnce(new Error("logger unavailable"));
      }
      let provisionalRunId = "";
      const sessionKey = `agent:worker:subagent:workboard-default-${card.id}`;
      run.mockImplementation(async (input) => {
        provisionalRunId = input.idempotencyKey;
        const association = { sessionKey: input.sessionKey, runId: provisionalRunId };
        await expectStored(card.id, {
          status: "running",
          ...association,
          execution: { status: "running", ...association },
          metadata: {
            automation: {
              launch: {
                phase: "prepared",
                requestedSessionKey: input.sessionKey,
                provisionalRunId,
              },
            },
          },
        });
        return { sessionKey, runId: "accepted-run" };
      });
      const result = await dispatch(fault === "execution" ? { cardId: card.id } : {});
      const accepted = { sessionKey, runId: "accepted-run" };
      expect(result.started).toEqual([
        expect.objectContaining({
          cardId: card.id,
          ...accepted,
          ...(fault === "execution" ? { card: expect.objectContaining(accepted) } : {}),
        }),
      ]);
      expect(result.startFailures).toEqual([]);
      const runId = fault === "execution" ? provisionalRunId : "accepted-run";
      const occupied = {
        status: "running",
        metadata: { claim: { ownerId: "workboard-dispatcher" } },
      };
      await expectStored(card.id, {
        ...occupied,
        runId,
        execution: { status: "running", runId },
      });
      if (fault === "execution") {
        await expectStored(card.id, {
          metadata: {
            automation: { launch: { phase: "prepared", provisionalRunId } },
            workerLogs: [expect.objectContaining({ runId: "accepted-run" })],
          },
        });
        await expect(
          store.heartbeat(card.id, { ownerId: "workboard-dispatcher" }),
        ).resolves.toMatchObject(occupied);
        expect(await dispatch()).toMatchObject({ started: [], startFailures: [] });
      }
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("handles a future scheduled exact dashboard card", async () => {
    const now = Date.now();
    const card = await store.create({
      title: "Scheduled exact",
      status: "scheduled",
      scheduledAt: now + 60_000,
      agentId: "scheduled-worker",
      workspaceAccess: fullHostAccess,
    });
    run = vi.fn().mockResolvedValue({ runId: "scheduled-run" });

    const result = await dispatch({ cardId: card.id, now });

    expect(run).toHaveBeenCalledTimes(0);
    expect(result.started).toHaveLength(0);
    expect(result.startFailures).toHaveLength(1);
    await expectStored(card.id, {
      status: "scheduled",
    });
  });

  it("starts the exact lower-priority card without selecting a sibling", async () => {
    const urgent = await createAuthorizedCard({ priority: "urgent", agentId: "urgent-owner" });
    const target = await store.create({
      title: "Exact low priority",
      status: "todo",
      priority: "low",
      agentId: "target-owner",
      workspaceAccess: fullHostAccess,
    });
    run = vi.fn().mockResolvedValue({ runId: "target-run" });

    const result = await dispatch({ cardId: target.id });

    expect(result.started).toEqual([expect.objectContaining({ cardId: target.id })]);
    await expectStatus(urgent.id, "ready");
  });
});
