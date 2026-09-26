// Workboard tests cover tools plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { isToolResultError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { guardWorkboardToolsForWorkspaceAccess } from "./workspace-access.js";

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("workboard tools", () => {
  it("inherits the active tool filesystem boundary for workspace metadata", async () => {
    const store = createWorkboardSqliteTestStore();
    const restrictedContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: true },
    } as const;
    const restricted = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ store, context: restrictedContext }),
        restrictedContext,
      ).map((tool) => [tool.name, tool]),
    );

    await expect(
      restricted.get("workboard_create")?.execute("outside", {
        title: "Outside",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).rejects.toThrow(/outside the caller/);
    await expect(
      restricted.get("workboard_create")?.execute("inside", {
        title: "Inside",
        workspace: { kind: "worktree", path: "/workspace/repo" },
        workspaceAccess: { unrestricted: true },
      }),
    ).resolves.toBeDefined();

    const unrestrictedContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: false },
    } as const;
    const unrestricted = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ store, context: unrestrictedContext }),
        unrestrictedContext,
      ).map((tool) => [tool.name, tool]),
    );
    await expect(
      unrestricted.get("workboard_create")?.execute("unrestricted", {
        title: "Unrestricted",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).resolves.toBeDefined();

    expect((await store.list()).find((card) => card.title === "Inside")).toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
    expect((await store.list()).find((card) => card.title === "Unrestricted")).toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    const sandboxContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: false },
      sandboxed: true,
    } as const;
    const sandboxed = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ store, context: sandboxContext }),
        sandboxContext,
      ).map((tool) => [tool.name, tool]),
    );
    await expect(
      sandboxed.get("workboard_create")?.execute("sandbox-outside", {
        title: "Sandbox outside",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).rejects.toThrow(/outside the caller/);
  });

  it("preserves read-only sandbox authority while allowing manual card movement", async () => {
    const store = createWorkboardSqliteTestStore();
    const context: NonNullable<Parameters<typeof guardWorkboardToolsForWorkspaceAccess>[1]> = {
      agentId: "main",
      sessionKey: "agent:main:subagent:readonly",
      workspaceDir: "/workspace",
      sandboxed: true,
      config: {
        agents: {
          defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } },
          list: [{ id: "main", default: true, workspace: "/workspace" }],
        },
      },
    };
    const tools = new Map(
      guardWorkboardToolsForWorkspaceAccess(createWorkboardTools({ store, context }), context).map(
        (tool) => [tool.name, tool],
      ),
    );

    const created = readPayload(
      await tools.get("workboard_create")?.execute("create-readonly", {
        title: "Read-only card",
      }),
    ).card as { id: string };
    await expect(
      tools.get("workboard_promote")?.execute("move-readonly", { id: created.id, force: true }),
    ).resolves.toBeDefined();
    await expect(store.get(created.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
        },
      },
    });
  });

  it("lists, claims, heartbeats, and reads worker context", async () => {
    const { store: workboardStore, stores } = createWorkboardSqliteTestHarness();
    const keyed = stores.cards;
    const tools = createWorkboardTools({
      store: workboardStore,
      context: { agentId: "main", sessionKey: "session-1" },
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const store = keyed;
    await store.register("card-1", {
      version: 1,
      card: {
        id: "card-1",
        title: "Ship coordination",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await store.register("archived-1", {
      version: 1,
      card: {
        id: "archived-1",
        title: "Closed work",
        status: "done",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { archivedAt: 2 },
      },
    });

    const claimed = readPayload(
      await byName.get("workboard_claim")?.execute("call-1", { id: "card-1" }),
    );
    expect(claimed.card).toMatchObject({
      status: "running",
      // Claim ownership is scoped to the calling session, not the agent, so the owner
      // is the sessionKey ("session-1"), not the agentId ("main").
      metadata: { claim: { ownerId: "session-1", token: "[redacted]" } },
    });
    const token = (claimed.token as string | undefined) ?? "";

    const heartbeat = readPayload(
      await byName
        .get("workboard_heartbeat")
        ?.execute("call-2", { id: "card-1", token, note: "alive" }),
    );
    expect(heartbeat).toMatchObject({
      card: { metadata: { comments: [expect.objectContaining({ body: "alive" })] } },
    });

    const read = readPayload(
      await byName.get("workboard_read")?.execute("call-3", { id: "card-1" }),
    );
    expect(read.workerContext).toContain("Ship coordination");
    expect(read.card).toMatchObject({ metadata: { claim: { token: "[redacted]" } } });

    const released = readPayload(
      await byName
        .get("workboard_release")
        ?.execute("call-4", { id: "card-1", token, status: "review" }),
    );
    expect(released).toMatchObject({ card: { status: "review" } });
    expect((released.card as { metadata?: { claim?: unknown } }).metadata?.claim).toBeUndefined();

    const list = readPayload(await byName.get("workboard_list")?.execute("call-5", {}));
    expect(list.cards).toEqual([expect.objectContaining({ id: "card-1" })]);
    const archivedList = readPayload(
      await byName.get("workboard_list")?.execute("call-6", { includeArchived: true }),
    );
    expect(archivedList.cards).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "archived-1", archivedAt: 2 })]),
    );
  });

  it("keeps blocked-card mutations out of the host tool failure contract", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const keyed = stores.cards;
    const tools = createWorkboardTools({
      store,
      context: { agentId: "main" },
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const token = "claim-token-1";
    await keyed.register("card-1", {
      version: 1,
      card: {
        id: "card-1",
        title: "Blocked work",
        status: "blocked",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { claim: { ownerId: "main", token, claimedAt: 1, lastHeartbeatAt: 1 } },
      },
    });

    const calls = [
      ["workboard_comment", { id: "card-1", token, body: "still waiting on review" }],
      ["workboard_heartbeat", { id: "card-1", token, note: "still blocked" }],
      ["workboard_release", { id: "card-1", token }],
    ] as const;
    const graded: Array<{ tool: string; isError: boolean; card: unknown }> = [];
    for (const [name, params] of calls) {
      const result = await expectDefined(byName.get(name), name).execute(name, params);
      graded.push({
        tool: name,
        isError: isToolResultError(result),
        card: readPayload(result).card,
      });
    }

    const blockedCard = expect.objectContaining({ id: "card-1", status: "blocked" });
    expect(graded).toEqual([
      { tool: "workboard_comment", isError: false, card: blockedCard },
      { tool: "workboard_heartbeat", isError: false, card: blockedCard },
      { tool: "workboard_release", isError: false, card: blockedCard },
    ]);
    expect((await keyed.lookup("card-1"))?.card).toMatchObject({
      status: "blocked",
      metadata: {
        comments: [
          expect.objectContaining({ body: "still waiting on review" }),
          expect.objectContaining({ body: "still blocked" }),
        ],
      },
    });
    expect((await keyed.lookup("card-1"))?.card.metadata?.claim).toBeUndefined();
  });

  it("can share one store across tool instances for claim coordination", async () => {
    const store = createWorkboardSqliteTestStore();
    const mainTools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "other" },
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({ title: "Single owner" });

    await mainTools.get("workboard_claim")?.execute("call-1", { id: card.id });

    await expect(
      otherTools.get("workboard_claim")?.execute("call-2", { id: card.id }),
    ).rejects.toThrow(/already claimed/);
  });

  it("requires claim scope before creating or linking dependencies against claimed cards", async () => {
    const store = createWorkboardSqliteTestStore();
    const mainTools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "other" },
      }).map((tool) => [tool.name, tool]),
    );
    const parent = await store.create({ title: "Claimed parent" });
    const claimed = await store.claim(parent.id, { ownerId: "main", token: "parent-token" });

    await expect(
      otherTools.get("workboard_create")?.execute("call-1", {
        title: "Blocked child",
        parents: [parent.id],
      }),
    ).rejects.toThrow(/claimed by main/);
    await expect(
      otherTools.get("workboard_create")?.execute("call-1b", {
        title: "Blocked child",
        parents: parent.id,
      }),
    ).rejects.toThrow(/claimed by main/);
    expect(await store.list()).toHaveLength(1);

    await expect(
      otherTools.get("workboard_create")?.execute("call-2b", {
        title: "Wrong token child",
        parents: [parent.id],
        token: "test-token-placeholder",
      }),
    ).rejects.toThrow(/claimed by main/);
    await otherTools.get("workboard_create")?.execute("call-2", {
      title: "Scoped child",
      parents: [parent.id],
      token: claimed.token,
    });
    const child = await store.create({ title: "Claimed child" });
    await store.claim(child.id, { ownerId: "child-worker", token: "child-token" });
    await expect(
      otherTools.get("workboard_link")?.execute("call-3", {
        parentId: parent.id,
        childId: child.id,
      }),
    ).rejects.toThrow(/claimed by main/);

    const linked = readPayload(
      await otherTools.get("workboard_link")?.execute("call-4", {
        parentId: parent.id,
        childId: (await store.create({ title: "Idle child" })).id,
        token: claimed.token,
      }),
    );
    expect(linked.card).toMatchObject({ status: "todo" });

    await expect(
      mainTools.get("workboard_link")?.execute("call-5", {
        parentId: parent.id,
        childId: child.id,
        token: "child-token",
      }),
    ).rejects.toThrow(/active child/);
  });

  it("creates dependent cards and completes claimed work through tools", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );

    const parentPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-1", {
        title: "Parent",
        status: "running",
      }),
    );
    const parent = parentPayload.card as { id: string };
    const childPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-2", {
        title: "Child",
        parents: [parent.id],
        tenant: "qa",
        skills: ["testing"],
      }),
    );
    const child = childPayload.card as { id: string; status: string };
    expect(child.status).toBe("todo");

    await expect(
      tools.get("workboard_complete")?.execute("call-unclaimed-complete", {
        id: parent.id,
        summary: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_block")?.execute("call-unclaimed-block", {
        id: child.id,
        reason: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_protocol_violation")?.execute("call-unclaimed-violation", {
        id: child.id,
        detail: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);

    const claimed = readPayload(
      await tools.get("workboard_claim")?.execute("call-3", { id: parent.id }),
    );
    const token = claimed.token as string;
    const pendingProof = readPayload(
      await tools.get("workboard_proof")?.execute("call-proof", {
        id: parent.id,
        token,
        status: "passed",
        command: "pnpm test extensions/workboard",
      }),
    );
    expect(pendingProof.proofId).toEqual(expect.any(String));
    const completed = readPayload(
      await tools.get("workboard_complete")?.execute("call-4", {
        id: parent.id,
        token,
        summary: "Done.",
        createdCardIds: [child.id],
        proofId: pendingProof.proofId,
      }),
    );
    expect(completed.card).toMatchObject({
      status: "done",
      metadata: { proof: [{ id: pendingProof.proofId, status: "passed" }] },
    });

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-5", {}));
    expect(dispatch.promoted).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
  });

  it("redacts claim tokens from dispatch tool results", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({
      title: "Scheduled",
      status: "scheduled",
      scheduledAt: 1,
    });
    await store.update(card.id, {
      metadata: {
        ...card.metadata,
        claim: {
          ownerId: "main",
          token: "secret-token",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-1", {}));

    const promoted = dispatch.promoted as Array<{
      metadata?: { claim?: { token?: string } };
    }>;
    expect(promoted).toEqual([expect.objectContaining({ id: card.id })]);
    expect(promoted[0]?.metadata?.claim?.token).toBe("[redacted]");
  });

  it("exposes board lifecycle, decomposition, runs, and notification tools", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );

    const boardPayload = readPayload(
      await expectDefined(
        tools.get("workboard_board_create"),
        "workboard board create tool",
      ).execute("call-board", {
        id: "planning",
        name: "Planning",
        automationJobId: "job-categorize-planning",
        orchestration: {
          autoDecompose: true,
          autoDecomposePerDispatch: 2,
          orchestratorProfile: "planner",
        },
      }),
    );
    expect(boardPayload.board).toMatchObject({
      id: "planning",
      name: "Planning",
      automationJobId: "job-categorize-planning",
      orchestration: {
        autoDecompose: true,
        autoDecomposePerDispatch: 2,
        orchestratorProfile: "planner",
      },
    });
    const boardCreate = expectDefined(
      tools.get("workboard_board_create"),
      "workboard board create tool",
    );
    expect(
      Value.Check(boardCreate.parameters, {
        id: "planning",
        automationJobId: "job-categorize-planning",
      }),
    ).toBe(true);
    expect(Value.Check(boardCreate.parameters, { id: "planning", automationJobId: "" })).toBe(
      false,
    );

    const parent = await store.create({
      title: "Rough",
      status: "triage",
      boardId: "planning",
      idempotencyKey: "planning:rough",
    });
    const specified = readPayload(
      await tools.get("workboard_specify")?.execute("call-specify", {
        id: parent.id,
        title: "Specified",
        summary: "Ready to split.",
      }),
    );
    expect(specified.card).toMatchObject({ title: "Specified", status: "todo" });

    const decomposed = readPayload(
      await tools.get("workboard_decompose")?.execute("call-decompose", {
        id: parent.id,
        summary: "Split.",
        children: [{ title: "Child A" }, { title: "Child B" }],
      }),
    );
    expect(decomposed.parent).toMatchObject({ status: "done" });
    expect(decomposed.children).toEqual([
      expect.objectContaining({ title: "Child A" }),
      expect.objectContaining({ title: "Child B" }),
    ]);

    const runs = readPayload(
      await tools.get("workboard_runs")?.execute("call-runs", { id: parent.id }),
    );
    expect(runs.attempts).toEqual([]);

    const subscription = readPayload(
      await tools.get("workboard_notify_subscribe")?.execute("call-subscribe", {
        boardId: "planning",
        cardId: parent.id,
        target: "session:operator",
        eventKinds: ["completed"],
      }),
    );
    expect(subscription.subscription).toMatchObject({
      boardId: "planning",
      cardId: parent.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const list = readPayload(
      await tools.get("workboard_notify_list")?.execute("call-notify-list", {
        boardId: "planning",
      }),
    );
    expect(list.subscriptions).toEqual([
      expect.objectContaining({ cardId: parent.id, target: "session:operator" }),
    ]);

    const events = readPayload(
      await tools.get("workboard_notify_advance")?.execute("call-notify-events", {
        subscriptionId: (subscription.subscription as { id: string }).id,
      }),
    );
    expect(events.events).toEqual([expect.objectContaining({ kind: "completed" })]);

    const attached = readPayload(
      await tools.get("workboard_attachment_add")?.execute("call-attach", {
        id: parent.id,
        fileName: "result.txt",
        contentBase64: Buffer.from("done").toString("base64"),
      }),
    );
    expect(attached.card).toMatchObject({
      metadata: { attachments: [expect.objectContaining({ fileName: "result.txt" })] },
    });
    const attachments = (attached.card as { metadata: { attachments: Array<{ id: string }> } })
      .metadata.attachments;
    const attachmentId = expectDefined(attachments[0], "workboard attachment").id;
    const attachment = readPayload(
      await tools.get("workboard_attachment_read")?.execute("call-attachment-read", {
        id: attachmentId,
      }),
    );
    expect(Buffer.from(attachment.contentBase64 as string, "base64").toString("utf8")).toBe("done");
  });

  it("moves cards with agent claim scope", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "agent-b" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const card = await store.create({ title: "Move tool card", status: "todo" });

    const unclaimed = readPayload(
      await tools.get("workboard_move")?.execute("move-unclaimed", {
        id: card.id,
        status: "ready",
      }),
    );
    expect(unclaimed.card).toMatchObject({ status: "ready" });

    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    await expect(
      tools.get("workboard_move")?.execute("move-denied", {
        id: card.id,
        status: "review",
      }),
    ).rejects.toThrow("card is claimed by agent-a");

    const claimed = readPayload(
      await tools.get("workboard_move")?.execute("move-claimed", {
        id: card.id,
        status: "review",
        token: "test-auth-token",
      }),
    );
    expect(claimed.card).toMatchObject({ status: "review" });
  });

  it("claims through the tool with a session-scoped owner and fences a sibling session", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    await stores.cards.register("card-fence", {
      version: 1,
      card: {
        id: "card-fence",
        title: "Fenced work",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const claimTool = (sessionKey: string) =>
      expectDefined(
        new Map(
          createWorkboardTools({ store, context: { agentId: "main", sessionKey } }).map((tool) => [
            tool.name,
            tool,
          ]),
        ).get("workboard_claim"),
        "workboard_claim",
      );
    const mutateTool = (sessionKey: string, name: string) =>
      expectDefined(
        new Map(
          createWorkboardTools({ store, context: { agentId: "main", sessionKey } }).map((tool) => [
            tool.name,
            tool,
          ]),
        ).get(name),
        name,
      );

    // Session 1 claims the card; the persisted owner is the sessionKey, not the agentId.
    const claimed = readPayload(
      await claimTool("session-1").execute("claim-1", { id: "card-fence" }),
    );
    expect(claimed.card).toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "session-1" } },
    });

    // A sibling session of the SAME agent holds no token and no longer matches the
    // session-scoped claim owner, so the claim fence blocks it from completing the card
    // (the pre-fix bug: an agent-scoped owner let any sibling session mutate it).
    await expect(
      mutateTool("session-2", "workboard_complete").execute("complete-2", {
        id: "card-fence",
        summary: "hijacked",
      }),
    ).rejects.toThrow(/claimed/);

    // The owning session (or a caller presenting the token) can still act on it.
    const token = (claimed.token as string | undefined) ?? "";
    const released = readPayload(
      await mutateTool("session-1", "workboard_release").execute("release-1", {
        id: "card-fence",
        token,
        status: "review",
      }),
    );
    expect(released.card).toMatchObject({ status: "review" });
  });

  it("bounds an over-long session key to a stable claim owner within the persisted cap", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    await stores.cards.register("card-long", {
      version: 1,
      card: {
        id: "card-long",
        title: "Long session key",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const longSessionKey = `agent:main:dashboard:${"x".repeat(400)}`;
    const claimTool = expectDefined(
      new Map(
        createWorkboardTools({
          store,
          context: { agentId: "main", sessionKey: longSessionKey },
        }).map((tool) => [tool.name, tool]),
      ).get("workboard_claim"),
      "workboard_claim",
    );

    // A bare agentId always fit the 120-char claim-owner cap; a long sessionKey does
    // not, so it is hashed to a stable, bounded owner instead of throwing on persist.
    const claimed = readPayload(await claimTool.execute("claim-long", { id: "card-long" }));
    const owner = (claimed.card as { metadata?: { claim?: { ownerId?: string } } }).metadata?.claim
      ?.ownerId;
    expect(owner).toBeDefined();
    expect(owner).not.toBe(longSessionKey);
    expect((owner ?? "").length).toBeLessThanOrEqual(120);
    expect(owner).toMatch(/^owner:[0-9a-f]{64}$/);
  });

  it("gives each session of one agent its own worker-capacity slot", async () => {
    // The capacity slot keys on claim.ownerId (workboardCardSlotOwner returns it), so
    // making the owner per-session (the fence fix) makes the slot per-session too. This
    // demonstrates that documented tradeoff and its true, narrow shape: the slot is a
    // per-owner serialization guard ("one active card per owner slot", enforced by the
    // store's claimIfOwnerAvailable owner_busy check), NOT a global concurrency cap. So
    // two sessions of one agent get two independent slots (loosening the per-owner
    // spread), while a single session still serializes onto its own one active card.
    const { store, stores } = createWorkboardSqliteTestHarness();
    for (const id of ["card-a", "card-b", "card-c"]) {
      await stores.cards.register(id, {
        version: 1,
        card: {
          id,
          title: `Work ${id}`,
          status: "todo",
          priority: "normal",
          labels: [],
          agentId: "main",
          position: 1000,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    }
    const claimTool = (sessionKey: string) =>
      expectDefined(
        new Map(
          createWorkboardTools({ store, context: { agentId: "main", sessionKey } }).map((tool) => [
            tool.name,
            tool,
          ]),
        ).get("workboard_claim"),
        "workboard_claim",
      );

    // Session 1 claims card A and now holds an active slot under owner "session-1".
    const claimedA = readPayload(await claimTool("session-1").execute("claim-a", { id: "card-a" }));
    expect(claimedA.card).toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "session-1" } },
    });

    // A sibling session of the SAME agent claims a different card and succeeds: it owns a
    // distinct capacity slot ("session-2"), where a per-agent slot would have collided and
    // blocked it. This is the loosened per-owner throttling the PR documents.
    const claimedB = readPayload(await claimTool("session-2").execute("claim-b", { id: "card-b" }));
    expect(claimedB.card).toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "session-2" } },
    });

    // The guard still serializes within one owner: session 1 already has an active card,
    // so claiming a second card under the same slot is rejected as owner_busy. The slot is
    // a real per-owner limit — the fix only re-keys it from agent to session.
    await expect(claimTool("session-1").execute("claim-c", { id: "card-c" })).rejects.toThrow(
      /already has active Workboard work/,
    );
  });

  it("rejects a token-less legacy agent-owned claim and recovers it through the operator surface", async () => {
    // A claim persisted BEFORE the session-scoped owner change stored a bare agentId as
    // its owner. Session-scoped tool identity no longer matches that, so the token-less
    // owner path is refused — the accepted, documented upgrade cost. This pins that
    // rejection as intended and proves both recovery paths the docs promise.
    const { store, stores } = createWorkboardSqliteTestHarness();
    const registerCard = async (id: string, title: string) => {
      await stores.cards.register(id, {
        version: 1,
        card: {
          id,
          title,
          status: "todo",
          priority: "normal",
          labels: [],
          agentId: "main",
          position: 1000,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    };
    const toolFor = (sessionKey: string, name: string) =>
      expectDefined(
        new Map(
          createWorkboardTools({ store, context: { agentId: "main", sessionKey } }).map((tool) => [
            tool.name,
            tool,
          ]),
        ).get(name),
        name,
      );

    await registerCard("card-legacy", "Legacy claim");
    // Persist the claim the way a pre-upgrade install did: ownerId is the bare agentId.
    const legacy = await store.claim("card-legacy", { ownerId: "main" });
    expect(legacy.card).toMatchObject({ metadata: { claim: { ownerId: "main" } } });

    // A tool session of the SAME agent, holding no token, is fenced out. The tool surface
    // checks first and names the persisted legacy owner.
    await expect(
      toolFor("session-1", "workboard_heartbeat").execute("hb-legacy", { id: "card-legacy" }),
    ).rejects.toThrow("card is claimed by main.");
    // The store guard underneath refuses the same token-less owner mismatch directly.
    await expect(store.heartbeat("card-legacy", { ownerId: "session-1" })).rejects.toThrow(
      "claim owner does not match.",
    );

    // Recovery path 1: the claim token still works on a legacy claim, for heartbeat...
    const token = legacy.token;
    await expect(
      toolFor("session-1", "workboard_heartbeat").execute("hb-token", {
        id: "card-legacy",
        token,
      }),
    ).resolves.toBeDefined();
    // ...and for a terminal completion.
    const completed = readPayload(
      await toolFor("session-1", "workboard_complete").execute("done-token", {
        id: "card-legacy",
        token,
        summary: "recovered with the claim token",
      }),
    );
    expect(completed.card).toMatchObject({ status: "done" });

    // Recovery path 2: the operator surface needs no token. Gateway reclaim/promote/
    // reassign pass `scope === null`, bypassing the owner check; reclaim clears the claim.
    await registerCard("card-legacy-2", "Legacy claim 2");
    await store.claim("card-legacy-2", { ownerId: "main" });
    const reclaimed = await store.reclaim("card-legacy-2", {}, null);
    expect(reclaimed.metadata?.claim).toBeUndefined();
    expect(reclaimed.status).toBe("ready");
    // With the claim cleared, a session-scoped owner claims and acts normally again.
    const reclaimedBySession = readPayload(
      await toolFor("session-1", "workboard_claim").execute("claim-after", {
        id: "card-legacy-2",
      }),
    );
    expect(reclaimedBySession.card).toMatchObject({
      metadata: { claim: { ownerId: "session-1" } },
    });
  });
});
