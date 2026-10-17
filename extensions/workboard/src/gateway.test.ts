import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import type { WorkboardStore } from "./store.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createSandboxRuntime, createWorktreeRuntime } from "./test/interaction-fixtures.js";
import { startEmptySessionsBoardService } from "./test/sessions-board.js";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

type SubagentRun = OpenClawPluginApi["runtime"]["subagent"]["run"];

function createGateway({
  store = createWorkboardSqliteTestStore(),
  sessionsBoard,
  run,
  workspace = false,
  worktrees,
}: {
  store?: WorkboardStore;
  sessionsBoard?: Parameters<typeof registerWorkboardGatewayMethods>[0]["sessionsBoard"];
  run?: SubagentRun;
  workspace?: boolean;
  worktrees?: OpenClawPluginApi["runtime"]["worktrees"];
} = {}) {
  const { methods, registerGatewayMethod } = createGatewayMethodCapture();
  const api = {
    registerGatewayMethod,
    runtime: {
      ...(workspace
        ? {
            agent: {
              listAgentIds: vi.fn(() => ["main"]),
              resolveAgentWorkspaceDir: vi.fn(() => "/workspace"),
            },
          }
        : { state: { openKeyedStore: vi.fn() } }),
      ...(run ? { subagent: { run } } : {}),
      ...(worktrees ? { sandbox: createSandboxRuntime(true), worktrees } : {}),
    },
  } as unknown as OpenClawPluginApi;
  registerWorkboardGatewayMethods({ api, store, sessionsBoard });
  const invoke = async (
    name: string,
    params?: Record<string, unknown>,
    context: Record<string, unknown> = {},
  ) => {
    const respond = vi.fn();
    await methods.get(`workboard.${name}`)!.handler({ params, respond, ...context } as never);
    const [ok, data, error] = respond.mock.calls[0] ?? [];
    return Object.assign(respond, { ok, data, error });
  };
  return { api, methods, invoke, store };
}

function conflict(card: Record<string, unknown>) {
  return expect.objectContaining({
    code: "workboard_conflict",
    details: { type: "workboard_card_conflict", card: expect.objectContaining(card) },
  });
}

describe("workboard gateway methods", () => {
  it.each([false, true])(
    "refuses a Sessions board edit with transport current=%s",
    async (current) => {
      const message = current ? "operator scope revoked" : "Caller authority is no longer active.";
      const authority = {
        hasCurrentClientAuthority: () => current,
        ...(current
          ? {
              sessionMutationAuthorization: {
                assertCurrent: () => {
                  throw new Error("operator scope revoked");
                },
              },
            }
          : {}),
      };
      const store = createWorkboardSqliteTestStore();
      const sessionsBoard = await startEmptySessionsBoardService(store);
      const board = await store.upsertBoard({ id: "sessions", kind: "sessions" });
      const { invoke } = createGateway({ store, sessionsBoard });
      const respond = await invoke(
        "sessionsBoard.update",
        { boardId: "sessions", patch: { scope: { includeArchived: true } } },
        authority,
      );
      expect(respond).toHaveBeenCalledWith(false, undefined, { code: "workboard_error", message });
      expect(await store.getSessionsBoard("sessions")).toEqual(board);
    },
  );

  it("rejects new client attachment bytes after disabling uploads without blocking agent output or reads", async () => {
    const { api, invoke, store } = createGateway();
    let config: OpenClawPluginApi["config"] = {};
    api.runtime.config = { current: () => config } as OpenClawPluginApi["runtime"]["config"];
    const card = await store.create({ title: "Upload policy" });
    const input = { id: card.id, fileName: "proof.txt", contentBase64: "cHJvb2Y=" };

    const enabled = await invoke("cards.attachments.add", input);
    expect(enabled.ok).toBe(true);
    const initial = await store.listAttachments(card.id);
    expect(initial.attachments).toHaveLength(1);

    config = { gateway: { uploads: { enabled: false } } };

    const disabled = await invoke("cards.attachments.add", {
      ...input,
      internal: { syntheticClient: true },
    });
    expect(disabled).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        details: { code: "UPLOADS_DISABLED" },
      }),
    );
    expect((await store.listAttachments(card.id)).attachments).toHaveLength(1);

    const synthetic = await invoke(
      "cards.attachments.add",
      { ...input, fileName: "internal.txt" },
      { client: { internal: { syntheticClient: true } } },
    );
    expect(synthetic.ok).toBe(true);

    const tool = createWorkboardTools({ store }).find(
      (candidate) => candidate.name === "workboard_attachment_add",
    )!;
    await tool.execute("generated-output", { ...input, fileName: "generated.txt" });
    const read = await invoke("cards.attachments.list", { id: card.id });
    expect(read.data?.attachments).toHaveLength(3);

    config = { gateway: { uploads: { enabled: true } } };

    const reenabled = await invoke("cards.attachments.add", {
      ...input,
      fileName: "reenabled.txt",
    });
    expect(reenabled.ok).toBe(true);
  });

  test.each(["card-read", "attachment-write", "attachment-committed", "metadata-write"] as const)(
    "rejects attachment bytes when %s observes hot disable",
    async (phase) => {
      let disabled = false;
      let pauseRead = false;
      const { store, stores, dbPath } = createWorkboardSqliteTestHarness({
        beforeCardWrite: async () => {
          if (pauseRead && phase === "metadata-write") {
            disabled = true;
          }
        },
        beforeCardLookup: async () => {
          if (pauseRead && phase === "card-read") {
            disabled = true;
          }
        },
      });
      const { api, invoke } = createGateway({ store });
      api.runtime.config = {
        current: () => ({ gateway: { uploads: { enabled: !disabled } } }),
      } as OpenClawPluginApi["runtime"]["config"];
      const register = stores.attachments.register.bind(stores.attachments);
      using registering = vi
        .spyOn(stores.attachments, "register")
        .mockImplementation(async (key, value) => {
          if (pauseRead && phase === "attachment-write") {
            disabled = true;
          }
          await register(key, value);
          if (pauseRead && (phase === "attachment-committed" || phase === "metadata-write")) {
            // The real worker has committed the blob, but card metadata is not published yet.
            expect(
              db
                .prepare(
                  "SELECT hex(content) AS content FROM workboard_attachment_blobs WHERE attachment_id = ?",
                )
                .get(key),
            ).toEqual({
              content: Buffer.from(value.contentBase64, "base64").toString("hex").toUpperCase(),
            });
            disabled = phase === "attachment-committed";
          }
        });
      const card = await store.create({ title: "Late upload policy" });
      using db = new DatabaseSync(dbPath, { readOnly: true });
      pauseRead = true;

      const respond = await invoke("cards.attachments.add", {
        id: card.id,
        fileName: "late.txt",
        contentBase64: "bGF0ZQ==",
      });
      expect
        .soft(respond)
        .toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } }),
        );
      expect(registering).toHaveBeenCalledOnce();
      expect.soft(await stores.attachments.entries()).toEqual([]);
      expect.soft((await store.listAttachments(card.id)).attachments).toEqual([]);
      // Public attachment reads join the index and would hide an orphaned blob.
      expect
        .soft(db.prepare("SELECT attachment_id FROM workboard_attachment_blobs").all())
        .toEqual([]);
    },
  );

  it.each(["move", "archive", "delete"] as const)(
    "returns a redacted conflict for stale %s requests",
    async (action) => {
      const { store, invoke } = createGateway();
      const base = await store.create({ title: "Shared card" });
      const claimed = await store.claim(base.id, { ownerId: "main" });
      const method = `cards.${action}`;
      const respond = await invoke(method, {
        id: base.id,
        status: "blocked",
        position: 2000,
        archived: true,
        expectedUpdatedAt: base.updatedAt,
      });
      const redacted = {
        id: base.id,
        metadata: expect.objectContaining({
          claim: expect.objectContaining({ token: "[redacted]" }),
        }),
      };
      expect(respond).toHaveBeenCalledWith(false, undefined, conflict(redacted));
      expect(JSON.stringify(respond.mock.calls)).not.toContain(claimed.token);
      await expect(store.get(base.id)).resolves.toEqual(claimed.card);
      const invalid = await invoke(method, { id: base.id, expectedUpdatedAt: "stale" });
      expect(invalid.error?.message).toBe("expectedUpdatedAt must be a finite number.");
      await expect(store.get(base.id)).resolves.toEqual(claimed.card);
    },
  );

  it("registers CRUD methods with read/write scopes", async () => {
    const { methods, invoke, store } = createGateway();
    expect(new Set(methods.keys())).toEqual(
      new Set([
        "workboard.cards.list",
        "workboard.cards.list.owner",
        "workboard.cards.create",
        "workboard.cards.create.owner",
        "workboard.cards.captureSession",
        "workboard.cards.update",
        "workboard.cards.start",
        "workboard.cards.move",
        "workboard.cards.move.owner",
        "workboard.cards.delete",
        "workboard.cards.comment",
        "workboard.cards.link",
        "workboard.cards.linkDependency",
        "workboard.cards.proof",
        "workboard.cards.artifact",
        "workboard.cards.claim",
        "workboard.cards.heartbeat",
        "workboard.cards.release",
        "workboard.cards.promote",
        "workboard.cards.reassign",
        "workboard.cards.reclaim",
        "workboard.cards.complete",
        "workboard.cards.block",
        "workboard.cards.unblock",
        "workboard.cards.bulk",
        "workboard.cards.diagnostics",
        "workboard.cards.diagnostics.refresh",
        "workboard.cards.dispatch",
        "workboard.cards.dispatch.owner",
        "workboard.cards.dispatchWithOptions",
        "workboard.cards.dispatchWithOptions.owner",
        "workboard.boards.list",
        "workboard.boards.upsert",
        "workboard.sessionsBoard.read",
        "workboard.sessionsBoard.update",
        "workboard.sessionsBoard.move",
        "workboard.boards.archive",
        "workboard.boards.delete",
        "workboard.cards.stats",
        "workboard.cards.runs",
        "workboard.cards.specify",
        "workboard.cards.decompose",
        "workboard.notifications.subscribe",
        "workboard.notifications.list",
        "workboard.notifications.delete",
        "workboard.notifications.events",
        "workboard.notifications.advance",
        "workboard.cards.attachments.list",
        "workboard.cards.attachments.get",
        "workboard.cards.attachments.add",
        "workboard.cards.attachments.delete",
        "workboard.cards.workerLog",
        "workboard.cards.protocolViolation",
        "workboard.cards.archive",
        "workboard.cards.export",
      ]),
    );
    for (const [scope, names] of Object.entries({
      "operator.read":
        "cards.list cards.diagnostics cards.export cards.runs cards.attachments.get notifications.list notifications.events",
      "operator.write":
        "cards.diagnostics.refresh cards.create cards.attachments.add boards.upsert notifications.advance",
    })) {
      for (const name of names.split(" ")) {
        expect(methods.get(`workboard.${name}`)?.opts).toEqual({ scope });
      }
    }

    const boardRespond = await invoke("boards.upsert", {
      id: "planning",
      automationJobId: "job-categorize-planning",
    });
    expect(boardRespond.ok).toBe(true);
    expect((await store.listBoards()).boards).toMatchObject([
      { id: "default" },
      {
        id: "planning",
        automationJobId: "job-categorize-planning",
      },
    ]);

    const createRespond = await invoke("cards.create", {
      title: "Investigate queue drift",
      priority: "urgent",
    });
    expect(createRespond.ok).toBe(true);
    expect(createRespond.data?.card.metadata.automation.workspaceAccess).toMatchObject({
      unrestricted: true,
    });
    const createdCard = createRespond.data?.card;
    await store.move(createdCard.id, "blocked", 2000);
    const conflictRespond = await invoke("cards.update", {
      id: createdCard.id,
      expectedUpdatedAt: createdCard.updatedAt,
      patch: { title: "Stale edit" },
    });
    const moved = { status: "blocked", position: 2000 };
    expect(conflictRespond).toHaveBeenCalledWith(false, undefined, conflict(moved));

    const listRespond = await invoke("cards.list", {});
    expect(listRespond.data).toMatchObject({
      cards: [expect.objectContaining({ title: "Investigate queue drift" })],
      boards: expect.arrayContaining([
        expect.objectContaining({ id: "default", total: 1, active: 1 }),
      ]),
    });

    const eventsRespond = await invoke("notifications.events", { advance: true });
    expect(eventsRespond.ok).toBe(false);
    expect(eventsRespond.error?.message).toContain("workboard.notifications.advance");
  });

  it("validates Sessions board RPC input and keeps card writes out of Sessions boards", async () => {
    vi.useFakeTimers();
    const store = createWorkboardSqliteTestStore();
    const sessionsBoard = await startEmptySessionsBoardService(store);
    try {
      const { methods, invoke } = createGateway({ store, sessionsBoard });
      const readBoard = (params: Record<string, unknown> = {}) =>
        invoke("sessionsBoard.read", { boardId: "sessions", ...params });
      const created = await invoke("boards.upsert", {
        id: "sessions",
        kind: "sessions",
      });
      expect(created.data).toMatchObject({
        board: { id: "sessions", kind: "sessions", sessions: { columns: expect.any(Array) } },
      });
      for (const action of ["read", "update", "move"]) {
        expect(methods.get(`workboard.sessionsBoard.${action}`)?.opts).toEqual({
          scope: action === "read" ? "operator.read" : "operator.write",
        });
      }
      const snapshot = (await readBoard()).data;
      expect(snapshot).toMatchObject({
        board: { id: "sessions", kind: "sessions" },
        columns: expect.any(Array),
        sessions: [],
      });
      const unchanged = await readBoard({ sinceRevision: snapshot.revision });
      expect(unchanged.data).toEqual({
        unchanged: true,
        revision: snapshot.revision,
      });
      for (const mismatch of [
        { epoch: "retired" },
        { revision: snapshot.revision.revision - 1 },
        { boardId: "other-board" },
        { scope: "other-view" },
      ]) {
        const response = await readBoard({
          sinceRevision: { ...snapshot.revision, ...mismatch },
        });
        expect(response.data).toEqual(snapshot);
      }
      const otherView = await readBoard({
        view: { involvingMe: true },
        sinceRevision: snapshot.revision,
      });
      expect(otherView.data).toMatchObject({
        sessions: [],
        columns: snapshot.columns,
      });
      expect(otherView.data.revision.scope).not.toBe(snapshot.revision.scope);
      using readSpy = vi.spyOn(sessionsBoard, "read");
      for (const view of [
        {},
        { involvingMe: true, includePeople: true },
        { involvingProfileId: "profile-one", includePeople: true },
        { involvingMe: false, includePeople: false },
      ]) {
        const response = await readBoard({ view });
        expect(response.ok).toBe(true);
        expect(readSpy).toHaveBeenLastCalledWith("sessions", view, {
          assertCurrent: expect.any(Function),
        });
      }
      const updated = await invoke("sessionsBoard.update", {
        boardId: "sessions",
        patch: { scope: { includeArchived: true, includeAutomation: true, includeHome: true } },
      });
      expect(updated.data.board.sessions.scope).toMatchObject({
        includeArchived: true,
        includeAutomation: true,
        includeHome: true,
      });
      const changed = await readBoard({ sinceRevision: snapshot.revision });
      expect(changed.data).toMatchObject({
        board: { sessions: { scope: { includeArchived: true } } },
        sessions: [],
      });
      expect(changed.data.revision.revision).toBeGreaterThan(snapshot.revision.revision);
      const beforeInvalid = await store.getSessionsBoard("sessions");
      const invalid = (action: string, input: Record<string, unknown>, message: RegExp) =>
        [`sessionsBoard.${action}`, { boardId: "sessions", ...input }, message] as const;
      const invalidRequests = [
        invalid("read", { boardId: undefined }, /boardId required/),
        ...["includeAutomation", "includeHome"].map((field) =>
          invalid(
            "update",
            { patch: { scope: { [field]: "true" } } },
            new RegExp(`scope.${field} must be a boolean`),
          ),
        ),
        invalid("read", { junk: true }, /Unknown Sessions board read field: junk/),
        ...[null, [], true, "everyone"].map((view) =>
          invalid("read", { view }, /view must be an object/),
        ),
        ...(
          [
            [{ involvingMe: "true" }, /view.involvingMe must be a boolean/],
            [{ includePeople: 1 }, /view.includePeople must be a boolean/],
            [{ involvingProfileId: false }, /view.involvingProfileId must be a string/],
            [{ junk: true }, /Unknown Sessions board view field: junk/],
          ] as const
        ).map(([view, message]) => invalid("read", { view }, message)),
        invalid("update", { patch: [] }, /patch must be an object/),
        invalid("update", { patch: { columns: [] } }, /2\.\.12 columns/),
        invalid(
          "update",
          { patch: { scope: { maxAgeHours: -1 } } },
          /maxAgeHours must be a positive finite number/,
        ),
        invalid("update", { patch: { kind: "cards" } }, /Unknown.*field: kind/),
        invalid("move", { columnId: "working" }, /sessionKey required/),
        invalid("move", { sessionKey: "agent:main:a", columnId: 2 }, /columnId required/),
        ["boards.upsert", { id: "sessions", kind: "cards" }, /kind cannot be changed/],
      ] as const;
      for (const [name, input, message] of invalidRequests) {
        const response = await invoke(name, input);
        expect(response.ok, name).toBe(false);
        expect(response.error?.code, name).toBe("workboard_error");
        expect(response.error?.message, name).toMatch(message);
      }
      await expect(store.getSessionsBoard("sessions")).resolves.toEqual(beforeInvalid);
      const rejectedCard = await invoke("cards.create", {
        title: "Wrong destination",
        boardId: "sessions",
      });
      expect(rejectedCard.error?.message).toBe("Sessions boards do not hold cards");
      await expect(store.list()).resolves.toEqual([]);
    } finally {
      await sessionsBoard.stop();
      vi.useRealTimers();
    }
  });

  it("applies connected client workspace access when accepting card paths", async () => {
    const { invoke, store } = createGateway({ workspace: true });
    const context = {
      getRuntimeConfig: () => ({ agents: { defaults: { workspace: "/workspace" } } }),
    };

    const write = (name: string, params: Record<string, unknown>) =>
      invoke(name, params, { client: { connect: { scopes: ["operator.write"] } }, context });
    const deniedRespond = await write("cards.create", {
      title: "Outside",
      workspace: { kind: "worktree", sourcePath: "/outside/repo" },
    });
    expect(deniedRespond.ok).toBe(false);
    expect(deniedRespond.error?.message).toContain("outside the caller");

    const insideRespond = await write("cards.create", {
      title: "Inside",
      workspace: { kind: "worktree", sourcePath: "/workspace/repo" },
      workspaceAccess: { unrestricted: true },
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
    expect(insideRespond.ok).toBe(true);
    expect(insideRespond.data?.card.metadata.automation.workspaceAccess).toMatchObject({
      unrestricted: false,
      roots: ["/workspace"],
      writable: true,
    });
    const insideId = insideRespond.data?.card.id as string;

    const forgedUpdateRespond = await write("cards.update", {
      id: insideId,
      patch: { workspaceAccess: { unrestricted: true } },
    });
    expect(forgedUpdateRespond.ok).toBe(true);

    const forgedBulkRespond = await write("cards.bulk", {
      ids: [insideId],
      patch: { workspaceAccess: { unrestricted: true } },
    });
    expect(forgedBulkRespond.ok).toBe(true);
    await expect(
      store.get(insideId).then((card) => card?.metadata?.automation?.workspaceAccess),
    ).resolves.toMatchObject({ unrestricted: false, roots: ["/workspace"], writable: true });

    const adminRespond = await invoke(
      "cards.create",
      {
        title: "Admin outside",
        workspace: { kind: "worktree", sourcePath: "/outside/repo" },
      },
      { client: { connect: { scopes: ["operator.admin"] } } },
    );
    expect(adminRespond.ok).toBe(true);
    expect(adminRespond.data?.card.metadata.automation.workspaceAccess).toMatchObject({
      unrestricted: true,
    });

    await invoke(
      "boards.upsert",
      {
        id: "outside-default",
        defaultWorkspace: { kind: "worktree", sourcePath: "/outside/repo" },
      },
      { client: { connect: { scopes: ["operator.admin"] } } },
    );

    const inheritedRespond = await write("cards.create", {
      title: "No implicit workspace",
      boardId: "outside-default",
    });
    expect(inheritedRespond.ok).toBe(true);
    expect(inheritedRespond.data?.card.metadata?.automation?.workspace).toBeUndefined();
  });

  it("stores metadata updates through dedicated card methods", async () => {
    const { invoke } = createGateway();
    const createRespond = await invoke("cards.create", { title: "Carry metadata" });
    const cardId = createRespond.data?.card.id;

    const commentRespond = await invoke("cards.comment", {
      id: cardId,
      body: "Waiting on CI",
    });
    expect(commentRespond.ok).toBe(true);
    expect(commentRespond.data.card).toMatchObject({
      metadata: {
        comments: [expect.objectContaining({ body: "Waiting on CI" })],
      },
      events: expect.arrayContaining([expect.objectContaining({ kind: "comment_added" })]),
    });

    const oversizedRespond = await invoke("cards.comment", {
      id: cardId,
      body: "x".repeat(2001),
    });
    expect(oversizedRespond.ok).toBe(false);
    expect(oversizedRespond.error).toMatchObject({
      message: "comment body must be 2000 characters or fewer (got 2001).",
    });
  });

  it("validates labels from comma-separated gateway input", async () => {
    const { invoke } = createGateway();
    const respond = await invoke("cards.create", {
      title: "Check labels",
      labels: `valid, ${"x".repeat(41)}`,
    });
    expect(respond.ok).toBe(false);
    expect(respond.error).toMatchObject({
      message: "labels must be 40 characters or fewer.",
    });
  });

  it("returns an actionable exact-card admission failure", async () => {
    const run = vi.fn();
    const { invoke, store } = createGateway({ run });
    const card = await store.create({
      title: "Blocked exact start",
      status: "blocked",
      workspaceAccess: { unrestricted: true },
    });

    const respond = await invoke(
      "cards.start",
      { id: card.id },
      { context: { getRuntimeConfig: () => ({}) } },
    );
    expect(run).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "workboard_error",
        message: expect.stringMatching(/blocked.*backlog.*todo.*ready/i),
      }),
    );
  });

  it("threads maxStarts and dispatches omitted params with the legacy default cap", async () => {
    const run = vi.fn<SubagentRun>(async (input) => {
      expect(input.idempotencyKey).toEqual(expect.any(String));
      return { runId: `accepted:${input.idempotencyKey}` };
    });
    const { invoke, store } = createGateway({ run });
    const seed = (boardId: string, prefix: string, unassignedFirst = false) =>
      Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          store.create({
            title: `${prefix} ${index}`,
            status: "ready",
            priority: "urgent",
            agentId:
              unassignedFirst && index === 0 ? undefined : `${prefix.toLowerCase()}-${index}`,
            boardId,
            workspaceAccess: { unrestricted: true },
          }),
        ),
      );
    await seed("capped", "Capped");
    const respond = await invoke("cards.dispatchWithOptions", { boardId: "capped", maxStarts: 4 });
    expect(respond.ok).toBe(true);
    expect(respond.data?.started).toHaveLength(4);
    expect(run).toHaveBeenCalledTimes(4);

    const defaultCards = await seed("default", "Legacy", true);
    const defaultRespond = await invoke("cards.dispatch", undefined);
    expect(defaultRespond.ok).toBe(true);
    expect(defaultRespond.data?.started).toHaveLength(3);
    await expect(store.get(defaultCards[0]!.id)).resolves.toMatchObject({ status: "running" });
    expect(run).toHaveBeenCalledTimes(7);
    const startedCards = (await store.list()).filter((card) => card.status === "running");
    expect(startedCards).toHaveLength(7);
    const expectedRunIds = run.mock.calls.map(([input]) => `accepted:${input.idempotencyKey}`);
    expect(startedCards.map((card) => card.runId)).toEqual(expect.arrayContaining(expectedRunIds));
    for (const card of startedCards) {
      const runId = card.runId;
      if (defaultCards.some(({ id }) => id === card.id)) {
        expect(defaultRespond.data).toMatchObject({
          started: expect.arrayContaining([expect.objectContaining({ cardId: card.id, runId })]),
        });
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: `${card.agentId ? `agent:${card.agentId}:` : ""}subagent:workboard-default-${card.id}`,
          }),
        );
      }
      expect(card).toMatchObject({
        runId,
        execution: { runId },
        metadata: {
          automation: { launch: { phase: "accepted", acceptedRunId: runId } },
          attempts: [expect.objectContaining({ id: expect.any(String), runId })],
        },
      });
    }

    const legacyRespond = await invoke("cards.dispatch", { maxStarts: 1 });
    expect(legacyRespond.ok).toBe(false);
    expect(legacyRespond.error?.message).toBe(
      "maxStarts requires workboard.cards.dispatchWithOptions.",
    );

    for (const value of [0, -1, 1.5, "2"]) {
      const invalidRespond = await invoke("cards.dispatchWithOptions", { maxStarts: value });
      expect(invalidRespond.ok).toBe(false);
      expect(invalidRespond.error?.message).toBe("maxStarts must be a positive integer.");
    }
  });

  it("keeps write-scope worktree dispatch within configured agent workspaces", async () => {
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const createWorktree = vi.fn().mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    const { api, invoke, store } = createGateway({
      run,
      workspace: true,
      worktrees: createWorktreeRuntime({
        resolveCheckoutRoot: vi.fn().mockResolvedValue("/workspace"),
        hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(true),
        create: createWorktree,
      }),
    });
    const denied = await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
    });
    const dispatch = () =>
      invoke("cards.dispatch", undefined, {
        client: { connect: { scopes: ["operator.write"] } },
        context: {
          getRuntimeConfig: () => ({
            tools: { fs: { workspaceOnly: true } },
            agents: {
              defaults: {
                workspace: "/workspace",
                sandbox: { mode: "non-main", workspaceAccess: "rw" },
              },
            },
          }),
        },
      });

    const deniedRespond = await dispatch();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(deniedRespond.data).toMatchObject({
      startFailures: [
        expect.objectContaining({
          cardId: denied.id,
          error: "workspace path is outside the caller's allowed workspaces.",
        }),
      ],
    });
    await expect(store.get(denied.id)).resolves.toMatchObject({ status: "ready" });
    await store.update(denied.id, { status: "blocked" });

    const allowed = await store.create({
      title: "Allowed checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/workspace" },
    });

    const allowedRespond = await dispatch();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(allowedRespond.data).toMatchObject({ startFailures: [], started: [{}] });
    expect(api.runtime.sandbox.prepareWorkspaceAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace",
        confinedToolNames: expect.arrayContaining(["workboard_complete"]),
      }),
    );
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    expect(run).toHaveBeenCalledOnce();
    expect((await store.get(allowed.id))?.metadata?.automation?.workspace).toMatchObject({
      kind: "dir",
      path: "/workspace",
    });
  });

  it("preserves the actionable claim refusal in the direct RPC error shape", async () => {
    const { store, invoke } = createGateway();
    const parent = await store.create({ title: "Completed parent", status: "done" });
    const child = await store.create({ title: "Blocked child", parents: [parent.id] });
    const claimed = await store.claim(child.id, { ownerId: "main" });
    await store.block(child.id, { token: claimed.token, reason: "Waiting for review" });

    const respond = await invoke("cards.claim", { id: child.id, ownerId: "main" });
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "workboard_error",
      message: "card is blocked; use workboard_unblock before claiming.",
    });
  });

  it("claims, heartbeats, and bulk-updates cards through gateway methods", async () => {
    const { invoke } = createGateway();
    const createRespond = await invoke("cards.create", { title: "Claim me" });
    const cardId = createRespond.data?.card.id;

    const claimRespond = await invoke("cards.claim", { id: cardId, ownerId: "main" });
    expect(claimRespond.data).toMatchObject({
      card: { status: "running", metadata: { claim: { ownerId: "main" } } },
      token: expect.any(String),
    });

    const heartbeatRespond = await invoke("cards.heartbeat", {
      id: cardId,
      ownerId: "main",
      note: "alive",
    });
    expect(heartbeatRespond.data).toMatchObject({
      card: { metadata: { comments: [expect.objectContaining({ body: "alive" })] } },
    });

    const bulkRespond = await invoke("cards.bulk", {
      ids: [cardId],
      patch: { priority: "urgent" },
    });
    expect(bulkRespond.data).toMatchObject({
      cards: [expect.objectContaining({ priority: "urgent" })],
    });

    const completeRespond = await invoke("cards.complete", {
      id: cardId,
      summary: "Operator closed it.",
    });
    expect(completeRespond.data.card).toMatchObject({
      status: "done",
      metadata: {
        comments: expect.arrayContaining([
          expect.objectContaining({ body: "Operator closed it." }),
        ]),
      },
    });

    const blockedCreateRespond = await invoke("cards.create", { title: "Block me" });
    const blockedCardId = blockedCreateRespond.data?.card.id;
    await invoke("cards.claim", { id: blockedCardId, ownerId: "main" });
    const blockRespond = await invoke("cards.block", {
      id: blockedCardId,
      reason: "Operator blocked it.",
    });
    expect(blockRespond.data.card.status).toBe("blocked");
  });
});
