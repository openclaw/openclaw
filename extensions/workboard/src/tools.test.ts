import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { isToolResultError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import plugin from "../index.js";
import { WorkboardStore } from "./store.js";
import { toolsByName } from "./test/interaction-fixtures.js";
import { startEmptySessionsBoardService } from "./test/sessions-board.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { guardWorkboardToolsForWorkspaceAccess } from "./workspace-access.js";

function toolSet(store: WorkboardStore, agentId = "main") {
  return toolsByName(createWorkboardTools({ store, context: { agentId } }));
}

function executeTool(
  tools: ReturnType<typeof toolsByName>,
  name: string,
  params: Record<string, unknown>,
) {
  return expectDefined(tools.get(`workboard_${name}`), name).execute(name, params);
}

async function runTool(
  tools: ReturnType<typeof toolsByName>,
  name: string,
  params: Record<string, unknown>,
) {
  return readPayload(await executeTool(tools, name, params));
}

function registeredSessionsFactory(name: string) {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  plugin.register(
    createTestPluginApi({
      runtimeSource: fileURLToPath(new URL("../index.ts", import.meta.url)),
      registerTool,
    }),
  );
  return expectDefined(
    registerTool.mock.calls.find(([, registration]) => registration?.names?.includes(name)),
    "Sessions board factory",
  );
}

function workspaceTools(
  store: WorkboardStore,
  context: NonNullable<Parameters<typeof guardWorkboardToolsForWorkspaceAccess>[1]>,
) {
  return toolsByName(
    guardWorkboardToolsForWorkspaceAccess(createWorkboardTools({ store, context }), context),
  );
}

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("workboard tools", () => {
  it("reuses Sessions board schemas while binding each run's live invocation authority", async () => {
    const store = createWorkboardSqliteTestStore();
    await startEmptySessionsBoardService(store);
    const board = await store.upsertBoard({ id: "sessions", kind: "sessions" });
    using openStore = vi.spyOn(WorkboardStore, "openSqlite");
    openStore.mockReturnValue(store);
    const [factory, options] = registeredSessionsFactory("workboard_sessions_board_update");
    expect(options?.optional).not.toBe(true);
    const context = {
      assertInvocationCurrent() {
        throw new Error("Caller authority is no longer active.");
      },
    };
    if (typeof factory === "function" || !("create" in factory)) {
      throw new Error("Expected the registered version-2 Sessions board factory.");
    }
    const tools = factory.create(context);
    const nextTools = factory.create({ assertInvocationCurrent() {} });
    if (!Array.isArray(tools) || !Array.isArray(nextTools)) {
      throw new Error("Expected Sessions board tools from the registered factory.");
    }
    for (const [index, tool] of tools.entries()) {
      expect(tool.parameters, tool.name).toBe(nextTools[index]?.parameters);
    }
    for (const [name, input] of [
      ["update", { scope: { includeArchived: true } }],
      ["move", { sessionKey: "agent:main:one", columnId: "working" }],
    ] as const) {
      const tool = expectDefined(
        tools.find((entry) => entry.name === `workboard_sessions_board_${name}`),
        name,
      );
      await expect(tool.execute(`revoked-${name}`, input)).rejects.toThrow(
        "Caller authority is no longer active.",
      );
    }
    expect(factory).toMatchObject({ contextVersion: 2 });
    expect(await store.getSessionsBoard("sessions")).toEqual(board);
    expect(await store.listSessionPlacements("sessions")).toEqual([]);
    await expect(
      expectDefined(nextTools[0], "Current Sessions board read").execute("live", {}),
    ).resolves.toMatchObject({ details: { board: { id: "sessions" } } });
  });

  it("defaults Sessions board tools only when one Sessions board exists", async () => {
    vi.useFakeTimers();
    const store = createWorkboardSqliteTestStore();
    const sessionsBoard = await startEmptySessionsBoardService(store);
    try {
      using openStore = vi.spyOn(WorkboardStore, "openSqlite");
      openStore.mockReturnValue(store);
      const [factory] = registeredSessionsFactory("workboard_sessions_board_read");
      if (typeof factory === "function" || !("create" in factory)) {
        throw new Error("Expected the registered version-2 Sessions board factory.");
      }
      const sessionsTools = factory.create({ assertInvocationCurrent() {} });
      if (!Array.isArray(sessionsTools)) {
        throw new Error("Expected Sessions board tools from the registered factory.");
      }
      const tools = toolsByName([...createWorkboardTools({ store }), ...sessionsTools]);
      const read = expectDefined(tools.get("workboard_sessions_board_read"), "Sessions board read");
      const update = expectDefined(
        tools.get("workboard_sessions_board_update"),
        "Sessions board update",
      );
      const move = expectDefined(tools.get("workboard_sessions_board_move"), "Sessions board move");
      await expect(read.execute("none", {})).rejects.toThrow("No Sessions board exists");
      const create = expectDefined(tools.get("workboard_board_create"), "Board create");
      expect(Value.Check(create.parameters, { id: "sessions", kind: "sessions" })).toBe(true);
      await create.execute("create", { id: "sessions", name: "My sessions", kind: "sessions" });
      expect(readPayload(await read.execute("one", {}))).toMatchObject({
        board: { id: "sessions", kind: "sessions" },
        sessions: [],
      });
      const scope = { includeArchived: true, includeAutomation: true, includeHome: true };
      expect(Value.Check(update.parameters, { scope })).toBe(true);
      for (const field of ["includeAutomation", "includeHome"]) {
        expect(Value.Check(update.parameters, { scope: { [field]: false } })).toBe(true);
        expect(Value.Check(update.parameters, { scope: { [field]: "true" } })).toBe(false);
      }
      await update.execute("update-one", { scope });
      await expect(store.getSessionsBoard("sessions")).resolves.toMatchObject({
        sessions: { scope },
      });
      const columns = [
        {
          id: "stuck",
          label: "Stuck",
          description: "Observer health is stuck, or the run failed.",
          match: [{ health: ["stuck"] }, { run: ["failed"] }],
        },
        { id: "done", label: "Done", description: "Fallback.", fallback: true },
      ];
      expect(Value.Check(update.parameters, { columns })).toBe(true);
      expect(
        Value.Check(update.parameters, {
          columns: [{ ...columns[0], match: [] }, columns[1]],
        }),
      ).toBe(false);
      await update.execute("update-any-of", { columns });
      await expect(store.getSessionsBoard("sessions")).resolves.toMatchObject({
        sessions: { columns, scope },
      });
      await store.upsertBoard({ id: "another", kind: "sessions" });
      for (const [tool, input] of [
        [read, {}],
        [update, { scope: { includeArchived: false } }],
        [move, { sessionKey: "agent:main:example", columnId: "working" }],
      ] as const) {
        await expect(tool.execute("ambiguous", input)).rejects.toThrow(
          "boardId is required when more than one Sessions board exists",
        );
      }
      expect(readPayload(await read.execute("explicit", { boardId: "another" }))).toMatchObject({
        board: { id: "another", kind: "sessions" },
      });
      await create.execute("create-cards", { id: "cards", kind: "cards" });
      await expect(read.execute("cards", { boardId: "cards" })).rejects.toThrow(
        "This board is not a Sessions board.",
      );
      await expect(read.execute("invalid", { boardId: 42 })).rejects.toThrow();
      await expect(store.getSessionsBoard("sessions")).resolves.toMatchObject({
        sessions: { scope },
      });
    } finally {
      await sessionsBoard.stop();
      vi.useRealTimers();
    }
  });

  it.each([
    ["workspace-only", true, false],
    ["unrestricted", false, false],
    ["sandboxed", false, true],
  ] as const)(
    "inherits %s filesystem authority for workspace metadata",
    async (_name, workspaceOnly, sandboxed) => {
      const store = createWorkboardSqliteTestStore();
      const confined = workspaceOnly || sandboxed;
      const tools = workspaceTools(store, {
        agentId: "main",
        workspaceDir: "/workspace",
        fsPolicy: { workspaceOnly },
        sandboxed,
      });
      if (confined) {
        await expect(
          executeTool(tools, "create", {
            title: "Outside",
            workspace: { kind: "worktree", path: "/outside/repo" },
          }),
        ).rejects.toThrow(/outside the caller/);
      }
      await expect(
        executeTool(tools, "create", {
          title: "Allowed",
          workspace: { kind: "worktree", path: confined ? "/workspace/repo" : "/outside/repo" },
          workspaceAccess: { unrestricted: true },
        }),
      ).resolves.toBeDefined();
      expect((await store.list())[0]?.metadata?.automation?.workspaceAccess).toMatchObject(
        confined
          ? { unrestricted: false, roots: ["/workspace"], writable: !sandboxed }
          : { unrestricted: true },
      );
    },
  );

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
          entries: { main: { workspace: "/workspace" } },
        },
      },
    };
    const tools = workspaceTools(store, context);

    const created = (
      await runTool(tools, "create", {
        title: "Read-only card",
      })
    ).card as { id: string };
    await expect(
      executeTool(tools, "promote", { id: created.id, force: true }),
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

  it("lists archived cards only when requested", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = toolSet(store);
    const active = await store.create({ title: "Active" });
    const closed = await store.create({ title: "Closed", status: "done" });
    const archived = await store.archive(closed.id, true);
    expect((await runTool(tools, "list", {})).cards).toEqual([
      expect.objectContaining({ id: active.id }),
    ]);
    expect((await runTool(tools, "list", { includeArchived: true })).cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: closed.id, archivedAt: archived.metadata?.archivedAt }),
      ]),
    );
  });

  it("keeps the read card and context together and reads committed edits on the next call", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Before edit", notes: "Original instructions" });
    const read = expectDefined(
      createWorkboardTools({ store }).find((tool) => tool.name === "workboard_read"),
      "Workboard read",
    );
    const lookup = stores.cards.lookup.bind(stores.cards);
    using concurrentEdit = vi.spyOn(stores.cards, "lookup");
    concurrentEdit.mockImplementationOnce(async (id) => {
      const captured = await lookup(id);
      await store.update(card.id, { title: "After edit", notes: "Revised instructions" });
      return captured;
    });

    const captured = readPayload(await read.execute("captured", { id: card.id }));
    expect(captured.card).toMatchObject({
      title: "Before edit",
      notes: "Original instructions",
    });
    expect(captured.workerContext).toContain("Title: Before edit");
    expect(captured.workerContext).toContain("Original instructions");
    expect(captured.workerContext).not.toContain("Revised instructions");

    const updated = readPayload(await read.execute("updated", { id: card.id }));
    expect(updated.card).toMatchObject({ title: "After edit", notes: "Revised instructions" });
    expect(updated.workerContext).toContain("Title: After edit");
    expect(updated.workerContext).toContain("Revised instructions");
    await expect(read.execute("missing", { id: "missing-card" })).rejects.toThrow(
      "card not found: missing-card",
    );
  });

  it("returns an actionable tool input error when claiming a blocked dependent card", async () => {
    const store = createWorkboardSqliteTestStore();
    const parent = await store.create({ title: "Completed parent", status: "done" });
    const child = await store.create({ title: "Blocked child", parents: [parent.id] });
    const tools = toolSet(store);
    const claim = expectDefined(tools.get("workboard_claim"), "Workboard claim");
    const claimed = readPayload(await claim.execute("claim", { id: child.id }));
    await expectDefined(tools.get("workboard_block"), "Workboard block").execute("block", {
      id: child.id,
      token: claimed.token,
      reason: "Waiting for review",
    });

    await expect(claim.execute("blocked-claim", { id: child.id })).rejects.toMatchObject({
      name: "ToolInputError",
      message: "card is blocked; use workboard_unblock before claiming.",
    });
  });

  it("keeps blocked-card mutations out of the host tool failure contract", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const byName = toolSet(store);
    const token = "claim-token-1";
    const card = await store.create({ title: "Blocked work", status: "blocked" });
    await stores.cards.register(card.id, {
      version: 1,
      card: {
        ...card,
        metadata: { claim: { ownerId: "main", token, claimedAt: 1, lastHeartbeatAt: 1 } },
      },
    });
    const id = card.id;

    const calls = [
      ["workboard_comment", { id, token, body: "still waiting on review" }],
      ["workboard_heartbeat", { id, token, note: "still blocked" }],
      ["workboard_release", { id, token }],
    ] as const;
    for (const [name, params] of calls) {
      const result = await expectDefined(byName.get(name), name).execute(name, params);
      expect(isToolResultError(result), name).toBe(false);
      expect(readPayload(result).card, name).toMatchObject({ id, status: "blocked" });
    }
    expect((await stores.cards.lookup(id))?.card).toMatchObject({
      status: "blocked",
      metadata: {
        comments: [
          expect.objectContaining({ body: "still waiting on review" }),
          expect.objectContaining({ body: "still blocked" }),
        ],
      },
    });
    expect((await stores.cards.lookup(id))?.card.metadata?.claim).toBeUndefined();
  });

  it("requires claim scope before creating or linking dependencies against claimed cards", async () => {
    const store = createWorkboardSqliteTestStore();
    const mainTools = toolSet(store);
    const otherTools = toolSet(store, "other");
    const parent = await store.create({ title: "Claimed parent" });
    const claimed = await store.claim(parent.id, { ownerId: "main", token: "parent-token" });

    await expect(
      executeTool(otherTools, "create", {
        title: "Blocked child",
        parents: [parent.id],
      }),
    ).rejects.toThrow(/claimed by main/);
    await expect(
      executeTool(otherTools, "create", {
        title: "Blocked child",
        parents: parent.id,
      }),
    ).rejects.toThrow(/claimed by main/);
    expect(await store.list()).toHaveLength(1);

    await expect(
      executeTool(otherTools, "create", {
        title: "Wrong token child",
        parents: [parent.id],
        token: "test-token-placeholder",
      }),
    ).rejects.toThrow(/claimed by main/);
    await executeTool(otherTools, "create", {
      title: "Scoped child",
      parents: [parent.id],
      token: claimed.token,
    });
    const child = await store.create({ title: "Claimed child" });
    await store.claim(child.id, { ownerId: "child-worker", token: "child-token" });
    await expect(
      executeTool(otherTools, "link", {
        parentId: parent.id,
        childId: child.id,
      }),
    ).rejects.toThrow(/claimed by main/);

    const linked = await runTool(otherTools, "link", {
      parentId: parent.id,
      childId: (await store.create({ title: "Idle child" })).id,
      token: claimed.token,
    });
    expect(linked.card).toMatchObject({ status: "todo" });

    await expect(
      executeTool(mainTools, "link", {
        parentId: parent.id,
        childId: child.id,
        token: "child-token",
      }),
    ).rejects.toThrow(/active child/);
  });

  it("creates dependent cards and completes claimed work through tools", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = toolSet(store);

    const parentPayload = await runTool(tools, "create", {
      title: "Parent",
      status: "running",
    });
    const parent = parentPayload.card as { id: string };
    const childPayload = await runTool(tools, "create", {
      title: "Child",
      parents: [parent.id],
      tenant: "qa",
      skills: ["testing"],
    });
    const child = childPayload.card as { id: string; status: string };
    expect(child.status).toBe("todo");

    await expect(
      executeTool(tools, "complete", {
        id: parent.id,
        summary: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      executeTool(tools, "block", {
        id: child.id,
        reason: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      executeTool(tools, "protocol_violation", {
        id: child.id,
        detail: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);

    const claimed = await runTool(tools, "claim", { id: parent.id });
    expect(claimed.card).toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "main", token: "[redacted]" } },
    });
    const read = await runTool(tools, "read", { id: parent.id });
    expect(read.workerContext).toContain("Parent");
    expect(read.card).toMatchObject({ metadata: { claim: { token: "[redacted]" } } });
    const released = await runTool(tools, "release", {
      id: parent.id,
      token: claimed.token,
      status: "review",
    });
    expect(released.card).toMatchObject({ status: "review" });
    expect((released.card as { metadata?: { claim?: unknown } }).metadata?.claim).toBeUndefined();
    const token = (await runTool(tools, "claim", { id: parent.id })).token as string;
    const pendingProof = await runTool(tools, "proof", {
      id: parent.id,
      token,
      status: "passed",
      command: "pnpm test extensions/workboard",
    });
    expect(pendingProof.proofId).toEqual(expect.any(String));
    const completed = await runTool(tools, "complete", {
      id: parent.id,
      token,
      summary: "Done.",
      createdCardIds: [child.id],
      proofId: pendingProof.proofId,
    });
    expect(completed.card).toMatchObject({
      status: "done",
      metadata: { proof: [{ id: pendingProof.proofId, status: "passed" }] },
    });

    const dispatch = await runTool(tools, "dispatch", {});
    expect(dispatch.promoted).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
  });

  it("redacts claim tokens from dispatch tool results", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = toolSet(store);
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

    const dispatch = await runTool(tools, "dispatch", {});

    const promoted = dispatch.promoted as Array<{
      metadata?: { claim?: { token?: string } };
    }>;
    expect(promoted).toEqual([expect.objectContaining({ id: card.id })]);
    expect(promoted[0]?.metadata?.claim?.token).toBe("[redacted]");
  });

  it("exposes board lifecycle, decomposition, runs, and notification tools", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = toolsByName(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }),
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

  it("reuses schemas across turns with current store and claim scope", async () => {
    const previousStore = createWorkboardSqliteTestStore();
    const previous = toolSet(previousStore, "agent-a");
    for (const ownerId of ["agent-b", "agent-b", "agent-c"]) {
      const store = createWorkboardSqliteTestStore();
      const tools = toolSet(store, ownerId);
      for (const [name, tool] of tools) {
        expect(tool.parameters, name).toBe(previous.get(name)?.parameters);
      }
      const card = await store.create({ title: "Move tool card", status: "todo" });
      const unclaimed = await runTool(tools, "move", { id: card.id, status: "ready" });
      expect(unclaimed.card).toMatchObject({ status: "ready" });
      const claim = await runTool(tools, "claim", { id: card.id });
      const other = toolSet(store, "agent-a");
      await expect(executeTool(other, "move", { id: card.id, status: "review" })).rejects.toThrow(
        `card is claimed by ${ownerId}`,
      );
      const claimed = await runTool(other, "move", {
        id: card.id,
        status: "review",
        token: claim.token,
      });
      // Review is not terminal: the claim stays with its owner.
      expect(claimed.card).toMatchObject({
        status: "review",
        metadata: { claim: { ownerId } },
      });
    }
    expect(await previousStore.list()).toEqual([]);
  });
});

async function createDispatchedCard(store: ReturnType<typeof createWorkboardSqliteTestStore>) {
  const card = await store.create({ title: "Dispatched card", status: "ready" });
  const claim = await store.claim(card.id, { ownerId: "agent-a" });
  const prepared = await store.prepareExecutionLaunch(card.id, {
    requestedSessionKey: "subagent:workboard-terminal",
    now: claim.card.updatedAt + 1,
    scope: { ownerId: "agent-a", token: claim.token },
  });
  const sessionKey = "agent:main:subagent:workboard-terminal";
  await store.acceptExecutionLaunch(card.id, {
    expectedLaunch: prepared.launch,
    expectedSessionKey: prepared.launch.requestedSessionKey,
    expectedRunId: prepared.launch.provisionalRunId,
    sessionKey,
    runId: "terminal-run",
    execution: { ...prepared.card.execution!, sessionKey, runId: "terminal-run" },
    acceptedAt: prepared.launch.preparedAt + 1,
  });
  return { card, token: claim.token };
}

async function expectRunFinished(
  store: ReturnType<typeof createWorkboardSqliteTestStore>,
  id: string,
  status: "done" | "blocked",
) {
  const card = expectDefined(await store.get(id), "terminal card");
  expect(card).toMatchObject({ status, execution: { status } });
  expect(card.metadata?.claim).toBeUndefined();
  expect(card.metadata?.attempts).toEqual([
    expect.objectContaining({ status: status === "done" ? "succeeded" : "blocked" }),
  ]);
  expect(card.metadata?.failureCount ?? 0).toBe(status === "done" ? 0 : 1);
  expect(card.metadata?.notifications?.map((notification) => notification.kind)).toEqual([
    status === "done" ? "completed" : "failed",
  ]);
  const next = await store.create({ title: "Next card", status: "ready" });
  await expect(store.claim(next.id, { ownerId: "agent-a" })).resolves.toMatchObject({
    card: { status: "running" },
  });
}

describe("workboard terminal status writes", () => {
  it.each([
    ["move", "done"],
    ["move", "blocked"],
    ["update", "done"],
    ["block", "blocked"],
  ] as const)("settles the run when %s writes %s", async (action, status) => {
    const store = createWorkboardSqliteTestStore();
    const { card, token } = await createDispatchedCard(store);
    if (action === "move") {
      const moved = await runTool(toolSet(store, "agent-a"), "move", {
        id: card.id,
        status,
        token,
      });
      expect(moved.card).toMatchObject({ status });
    } else if (action === "update") {
      await store.update(card.id, { status });
    } else {
      await store.block(card.id, { ownerId: "agent-a", token, reason: "Workboard card blocked." });
      await store.move(card.id, "blocked", undefined);
      await store.update(card.id, { status: "blocked" });
    }
    await expectRunFinished(store, card.id, status);
  });

  it.each(["done", "blocked"] as const)(
    "only releases the claim when moving to %s after the run already ended",
    async (status) => {
      const store = createWorkboardSqliteTestStore();
      const { card } = await createDispatchedCard(store);
      const running = expectDefined(await store.get(card.id), "running card");
      const now = running.updatedAt + 1;
      await store.syncLifecycle(card.id, {
        targetStatus: "review",
        executionStatus: "done",
        sourceUpdatedAt: now,
        stale: undefined,
        now,
        association: {
          expectedSessionKey: running.sessionKey,
          expectedRunId: running.runId,
          sessionKey: running.sessionKey!,
          runId: running.runId,
        },
      });

      await store.move(card.id, status, undefined);

      const moved = expectDefined(await store.get(card.id), "moved card");
      expect(moved).toMatchObject({ status, execution: { status: "done" } });
      expect(moved.metadata?.claim).toBeUndefined();
      expect(moved.metadata?.attempts).toEqual([expect.objectContaining({ status: "succeeded" })]);
      expect(moved.metadata?.failureCount ?? 0).toBe(0);
      expect(moved.metadata?.notifications ?? []).toEqual([]);
      const next = await store.create({ title: "Next card", status: "ready" });
      await expect(store.claim(next.id, { ownerId: "agent-a" })).resolves.toMatchObject({
        card: { status: "running" },
      });
    },
  );
});
