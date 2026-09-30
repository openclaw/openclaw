// Workboard tests cover gateway plugin behavior.
import { DatabaseSync } from "node:sqlite";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { startEmptySessionsBoardService } from "./test/sessions-board.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function createGatewayMethodCapture() {
  type RegisteredMethod = {
    handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
    opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
  };
  const methods = new Map<string, RegisteredMethod>();
  const api = {
    runtime: {
      state: {
        openKeyedStore: vi.fn(),
      },
    },
    registerGatewayMethod: vi.fn(
      (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
        methods.set(method, { handler, opts });
      },
    ),
  } as unknown as OpenClawPluginApi;
  return { api, methods, registerGatewayMethod: api.registerGatewayMethod };
}

describe("workboard gateway methods", () => {
  it("refuses a Sessions board edit after the Gateway caller loses authority", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionsBoard = await startEmptySessionsBoardService(store);
    const board = await store.upsertBoard({ id: "sessions", kind: "sessions" });
    const { api, methods } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store, sessionsBoard });
    const respond = vi.fn();
    await methods.get("workboard.sessionsBoard.update")!.handler({
      params: { boardId: "sessions", patch: { instructions: "Revoked edit" } },
      hasCurrentClientAuthority: () => false,
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "workboard_error",
      message: "Caller authority is no longer active.",
    });
    expect(await store.getSessionsBoard("sessions")).toEqual(board);
    // Role/scope/profile authorization is rechecked too, not just transport currentness.
    const revokedRole = vi.fn();
    await methods.get("workboard.sessionsBoard.update")!.handler({
      params: { boardId: "sessions", patch: { instructions: "Scope revoked" } },
      hasCurrentClientAuthority: () => true,
      sessionMutationAuthorization: {
        assertCurrent: () => {
          throw new Error("operator scope revoked");
        },
      },
      respond: revokedRole,
    } as never);
    expect(revokedRole).toHaveBeenCalledWith(false, undefined, {
      code: "workboard_error",
      message: "operator scope revoked",
    });
    expect(await store.getSessionsBoard("sessions")).toEqual(board);
  });

  it("rejects new client attachment bytes after disabling uploads without blocking agent output or reads", async () => {
    const { api, methods } = createGatewayMethodCapture();
    let config: OpenClawPluginApi["config"] = {};
    api.runtime.config = { current: () => config } as OpenClawPluginApi["runtime"]["config"];
    const store = createWorkboardSqliteTestStore();
    registerWorkboardGatewayMethods({ api, store });
    const card = await store.create({ title: "Upload policy" });
    const add = methods.get("workboard.cards.attachments.add")!.handler;
    const input = { id: card.id, fileName: "proof.txt", contentBase64: "cHJvb2Y=" };
    const enabled = vi.fn();
    await add({ params: input, respond: enabled } as never);
    expect(enabled.mock.calls[0]?.[0]).toBe(true);
    const initial = await store.listAttachments(card.id);
    expect(initial.attachments).toHaveLength(1);

    config = { gateway: { uploads: { enabled: false } } };
    const disabled = vi.fn();
    await add({
      params: { ...input, internal: { syntheticClient: true } },
      respond: disabled,
    } as never);
    expect(disabled).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        details: { code: "UPLOADS_DISABLED" },
      }),
    );
    expect((await store.listAttachments(card.id)).attachments).toHaveLength(1);

    const synthetic = vi.fn();
    await add({
      params: { ...input, fileName: "internal.txt" },
      respond: synthetic,
      client: { internal: { syntheticClient: true } },
    } as never);
    expect(synthetic.mock.calls[0]?.[0]).toBe(true);

    const tool = createWorkboardTools({ store }).find(
      (candidate) => candidate.name === "workboard_attachment_add",
    )!;
    await tool.execute("generated-output", { ...input, fileName: "generated.txt" });
    const read = vi.fn();
    await methods
      .get("workboard.cards.attachments.list")!
      .handler({ params: { id: card.id }, respond: read } as never);
    expect(read.mock.calls[0]?.[1]?.attachments).toHaveLength(3);

    config = { gateway: { uploads: { enabled: true } } };
    const reenabled = vi.fn();
    await add({ params: { ...input, fileName: "reenabled.txt" }, respond: reenabled } as never);
    expect(reenabled.mock.calls[0]?.[0]).toBe(true);
  });

  it.each(["card-read", "attachment-write", "attachment-committed", "metadata-write"] as const)(
    "rejects attachment bytes when %s observes hot disable",
    async (phase) => {
      const { api, methods } = createGatewayMethodCapture();
      let disabled = false;
      let pauseRead = false;
      api.runtime.config = {
        current: () => ({ gateway: { uploads: { enabled: !disabled } } }),
      } as OpenClawPluginApi["runtime"]["config"];
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
      registerWorkboardGatewayMethods({ api, store });
      const card = await store.create({ title: "Late upload policy" });
      using db = new DatabaseSync(dbPath, { readOnly: true });
      pauseRead = true;
      const respond = vi.fn();
      await methods.get("workboard.cards.attachments.add")!.handler({
        params: { id: card.id, fileName: "late.txt", contentBase64: "bGF0ZQ==" },
        respond,
      } as never);
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
      type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      const methods = new Map<string, Handler>();
      const store = createWorkboardSqliteTestStore();
      const api = createTestPluginApi({
        registerGatewayMethod: (name, handler) => {
          methods.set(name, handler);
        },
      });
      registerWorkboardGatewayMethods({ api, store });
      const base = await store.create({ title: "Shared card" });
      const claimed = await store.claim(base.id, { ownerId: "main" });
      const handler = methods.get(`workboard.cards.${action}`)!;
      const respond = vi.fn();
      await handler({
        params: {
          id: base.id,
          status: "blocked",
          position: 2000,
          archived: true,
          expectedUpdatedAt: base.updatedAt,
        },
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "workboard_conflict",
          details: {
            type: "workboard_card_conflict",
            card: expect.objectContaining({
              id: base.id,
              metadata: expect.objectContaining({
                claim: expect.objectContaining({ token: "[redacted]" }),
              }),
            }),
          },
        }),
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain(claimed.token);
      await expect(store.get(base.id)).resolves.toEqual(claimed.card);
      const invalid = vi.fn();
      await handler({
        params: { id: base.id, expectedUpdatedAt: "stale" },
        respond: invalid,
      } as never);
      expect(invalid.mock.calls[0]?.[2]?.message).toBe(
        "expectedUpdatedAt must be a finite number.",
      );
      await expect(store.get(base.id)).resolves.toEqual(claimed.card);
    },
  );

  it("registers CRUD methods with read/write scopes", async () => {
    const { api, methods } = createGatewayMethodCapture();

    const store = createWorkboardSqliteTestStore();
    registerWorkboardGatewayMethods({ api, store });

    expect([...methods.keys()]).toEqual([
      "workboard.cards.list",
      "workboard.cards.create",
      "workboard.cards.captureSession",
      "workboard.cards.update",
      "workboard.cards.start",
      "workboard.cards.move",
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
      "workboard.cards.dispatchWithOptions",
      "workboard.boards.list",
      "workboard.boards.upsert",
      "workboard.sessionsBoard.read",
      "workboard.sessionsBoard.update",
      "workboard.sessionsBoard.move",
      "workboard.sessionsBoard.refresh",
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
    ]);
    expect(methods.get("workboard.cards.list")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics.refresh")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.cards.export")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.create")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.cards.runs")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.attachments.get")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.cards.attachments.add")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.boards.upsert")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.notifications.list")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.events")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.advance")?.opts).toEqual({
      scope: "operator.write",
    });

    const boardRespond = vi.fn();
    await methods.get("workboard.boards.upsert")?.handler({
      params: { id: "planning", automationJobId: "job-categorize-planning" },
      respond: boardRespond,
    } as never);
    expect(boardRespond.mock.calls[0]?.[0]).toBe(true);
    await expect(store.listBoards()).resolves.toMatchObject({
      boards: [
        expect.objectContaining({ id: "default" }),
        expect.objectContaining({
          id: "planning",
          automationJobId: "job-categorize-planning",
        }),
      ],
    });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const listHandler = methods.get("workboard.cards.list")?.handler;
    const createRespond = vi.fn();
    await createHandler?.({
      params: { title: "Investigate queue drift", priority: "urgent" },
      respond: createRespond,
    } as never);
    expect(createRespond.mock.calls[0]?.[0]).toBe(true);
    expect(createRespond.mock.calls[0]?.[1]?.card).toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
    const createdCard = createRespond.mock.calls[0]?.[1]?.card;
    await store.move(createdCard.id, "blocked", 2000);
    const conflictRespond = vi.fn();
    await methods.get("workboard.cards.update")?.handler({
      params: {
        id: createdCard.id,
        expectedUpdatedAt: createdCard.updatedAt,
        patch: { title: "Stale edit" },
      },
      respond: conflictRespond,
    } as never);
    expect(conflictRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "workboard_conflict",
        details: {
          type: "workboard_card_conflict",
          card: expect.objectContaining({ status: "blocked", position: 2000 }),
        },
      }),
    );

    const listRespond = vi.fn();
    await listHandler?.({ params: {}, respond: listRespond } as never);
    expect(listRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ title: "Investigate queue drift" })],
      boards: expect.arrayContaining([
        expect.objectContaining({ id: "default", total: 1, active: 1 }),
      ]),
    });

    const eventsRespond = vi.fn();
    await methods.get("workboard.notifications.events")?.handler({
      params: { advance: true },
      respond: eventsRespond,
    } as never);
    expect(eventsRespond.mock.calls[0]?.[0]).toBe(false);
    expect(eventsRespond.mock.calls[0]?.[2]?.message).toContain("workboard.notifications.advance");
  });

  it("validates Sessions board RPC input and keeps card writes out of Sessions boards", async () => {
    vi.useFakeTimers();
    const store = createWorkboardSqliteTestStore();
    const sessionsBoard = await startEmptySessionsBoardService(store);
    try {
      const { api, methods } = createGatewayMethodCapture();
      registerWorkboardGatewayMethods({ api, store, sessionsBoard });
      const invoke = async (name: string, params: Record<string, unknown>) => {
        const method = methods.get(name);
        if (!method) {
          throw new Error(`Missing Gateway method: ${name}`);
        }
        const respond = vi.fn();
        await method.handler({ params, respond } as never);
        return respond;
      };
      const created = await invoke("workboard.boards.upsert", {
        id: "sessions",
        kind: "sessions",
      });
      expect(created.mock.calls[0]?.[1]).toMatchObject({
        board: { id: "sessions", kind: "sessions", sessions: { columns: expect.any(Array) } },
      });
      for (const action of ["read", "update", "move", "refresh"]) {
        expect(methods.get(`workboard.sessionsBoard.${action}`)?.opts).toEqual({
          scope: action === "read" ? "operator.read" : "operator.write",
        });
      }
      const read = await invoke("workboard.sessionsBoard.read", { boardId: "sessions" });
      expect(read.mock.calls[0]?.[1]).toMatchObject({
        board: { id: "sessions", kind: "sessions" },
        columns: expect.any(Array),
        sessions: [],
      });
      const updated = await invoke("workboard.sessionsBoard.update", {
        boardId: "sessions",
        patch: { instructions: "Keep approval requests in Needs input." },
      });
      expect(updated.mock.calls[0]?.[1]).toMatchObject({
        board: { sessions: { instructions: "Keep approval requests in Needs input." } },
      });
      const beforeInvalid = await store.getSessionsBoard("sessions");
      const invalidRequests = [
        ["workboard.sessionsBoard.read", {}, /boardId required/],
        [
          "workboard.sessionsBoard.update",
          { boardId: "sessions", patch: [] },
          /patch must be an object/,
        ],
        [
          "workboard.sessionsBoard.update",
          { boardId: "sessions", patch: { columns: [] } },
          /2\.\.12 columns/,
        ],
        [
          "workboard.sessionsBoard.update",
          { boardId: "sessions", patch: { scope: { maxAgeHours: -1 } } },
          /maxAgeHours must be a positive finite number/,
        ],
        [
          "workboard.sessionsBoard.update",
          { boardId: "sessions", patch: { kind: "cards" } },
          /Unknown.*field: kind/,
        ],
        [
          "workboard.sessionsBoard.move",
          { boardId: "sessions", columnId: "working" },
          /sessionKey required/,
        ],
        [
          "workboard.sessionsBoard.move",
          { boardId: "sessions", sessionKey: "agent:main:a", columnId: 2 },
          /columnId required/,
        ],
        ["workboard.sessionsBoard.refresh", { boardId: "" }, /boardId required/],
        ["workboard.boards.upsert", { id: "sessions", kind: "cards" }, /kind cannot be changed/],
      ] as const;
      for (const [name, input, message] of invalidRequests) {
        const response = await invoke(name, input);
        expect(response.mock.calls[0]?.[0], name).toBe(false);
        expect(response.mock.calls[0]?.[2]?.code, name).toBe("workboard_error");
        expect(response.mock.calls[0]?.[2]?.message, name).toMatch(message);
      }
      await expect(store.getSessionsBoard("sessions")).resolves.toEqual(beforeInvalid);
      const rejectedCard = await invoke("workboard.cards.create", {
        title: "Wrong destination",
        boardId: "sessions",
      });
      expect(rejectedCard.mock.calls[0]?.[2]?.message).toBe("Sessions boards do not hold cards");
      await expect(store.list()).resolves.toEqual([]);
    } finally {
      await sessionsBoard.stop();
      vi.useRealTimers();
    }
  });

  it("applies connected client workspace access when accepting card paths", async () => {
    const { methods, registerGatewayMethod } = createGatewayMethodCapture();
    const store = createWorkboardSqliteTestStore();
    const api = {
      runtime: {
        agent: {
          listAgentIds: vi.fn(() => ["main"]),
          resolveAgentWorkspaceDir: vi.fn(() => "/workspace"),
        },
      },
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;
    registerWorkboardGatewayMethods({ api, store });
    const create = methods.get("workboard.cards.create")?.handler;
    const context = {
      getRuntimeConfig: () => ({ agents: { defaults: { workspace: "/workspace" } } }),
    };

    const deniedRespond = vi.fn();
    await create?.({
      params: {
        title: "Outside",
        workspace: { kind: "worktree", sourcePath: "/outside/repo" },
      },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: deniedRespond,
    } as never);
    expect(deniedRespond.mock.calls[0]?.[0]).toBe(false);
    expect(deniedRespond.mock.calls[0]?.[2]?.message).toContain("outside the caller");

    const insideRespond = vi.fn();
    await create?.({
      params: {
        title: "Inside",
        workspace: { kind: "worktree", sourcePath: "/workspace/repo" },
        workspaceAccess: { unrestricted: true },
        metadata: { automation: { workspaceAccess: { unrestricted: true } } },
      },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: insideRespond,
    } as never);
    expect(insideRespond.mock.calls[0]?.[0]).toBe(true);
    expect(insideRespond.mock.calls[0]?.[1]?.card).toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
    const insideId = insideRespond.mock.calls[0]?.[1]?.card.id as string;
    const forgedUpdateRespond = vi.fn();
    await methods.get("workboard.cards.update")?.handler({
      params: { id: insideId, patch: { workspaceAccess: { unrestricted: true } } },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: forgedUpdateRespond,
    } as never);
    expect(forgedUpdateRespond.mock.calls[0]?.[0]).toBe(true);
    const forgedBulkRespond = vi.fn();
    await methods.get("workboard.cards.bulk")?.handler({
      params: { ids: [insideId], patch: { workspaceAccess: { unrestricted: true } } },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: forgedBulkRespond,
    } as never);
    expect(forgedBulkRespond.mock.calls[0]?.[0]).toBe(true);
    await expect(store.get(insideId)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });

    const adminRespond = vi.fn();
    await create?.({
      params: {
        title: "Admin outside",
        workspace: { kind: "worktree", sourcePath: "/outside/repo" },
      },
      client: { connect: { scopes: ["operator.admin"] } },
      respond: adminRespond,
    } as never);
    expect(adminRespond.mock.calls[0]?.[0]).toBe(true);
    expect(adminRespond.mock.calls[0]?.[1]?.card).toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    await methods.get("workboard.boards.upsert")?.handler({
      params: {
        id: "outside-default",
        defaultWorkspace: { kind: "worktree", sourcePath: "/outside/repo" },
      },
      client: { connect: { scopes: ["operator.admin"] } },
      respond: vi.fn(),
    } as never);
    const inheritedRespond = vi.fn();
    await create?.({
      params: { title: "No implicit workspace", boardId: "outside-default" },
      client: { connect: { scopes: ["operator.write"] } },
      context,
      respond: inheritedRespond,
    } as never);
    expect(inheritedRespond.mock.calls[0]?.[0]).toBe(true);
    expect(
      inheritedRespond.mock.calls[0]?.[1]?.card.metadata?.automation?.workspace,
    ).toBeUndefined();
  });

  it("stores metadata updates through dedicated card methods", async () => {
    const { api, methods } = createGatewayMethodCapture();

    registerWorkboardGatewayMethods({ api, store: createWorkboardSqliteTestStore() });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Carry metadata" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const commentRespond = vi.fn();
    await methods.get("workboard.cards.comment")?.handler({
      params: { id: cardId, body: "Waiting on CI" },
      respond: commentRespond,
    } as never);

    expect(commentRespond.mock.calls[0]?.[0]).toBe(true);
    expect(commentRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        metadata: {
          comments: [expect.objectContaining({ body: "Waiting on CI" })],
        },
        events: expect.arrayContaining([expect.objectContaining({ kind: "comment_added" })]),
      },
    });

    const oversizedRespond = vi.fn();
    await methods.get("workboard.cards.comment")?.handler({
      params: { id: cardId, body: "x".repeat(2001) },
      respond: oversizedRespond,
    } as never);

    expect(oversizedRespond.mock.calls[0]?.[0]).toBe(false);
    expect(oversizedRespond.mock.calls[0]?.[2]).toMatchObject({
      message: "comment body must be 2000 characters or fewer (got 2001).",
    });
  });

  it("validates labels from comma-separated gateway input", async () => {
    const { api, methods } = createGatewayMethodCapture();

    registerWorkboardGatewayMethods({ api, store: createWorkboardSqliteTestStore() });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const respond = vi.fn();
    await createHandler?.({
      params: { title: "Check labels", labels: `valid, ${"x".repeat(41)}` },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      message: "labels must be 40 characters or fewer.",
    });
  });

  it("dispatches workboard cards when gateway params are omitted", async () => {
    const { methods, registerGatewayMethod } = createGatewayMethodCapture();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(),
        },
        subagent: { run },
      },
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Ready worker",
      status: "ready",
      priority: "urgent",
      workspaceAccess: { unrestricted: true },
    });

    registerWorkboardGatewayMethods({ api, store });

    const respond = vi.fn();
    await methods.get("workboard.cards.dispatch")?.handler({ respond } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ cardId: card.id, runId: "run-card" })],
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `subagent:workboard-default-${card.id}`,
      }),
    );
  });

  it("returns an actionable exact-card admission failure", async () => {
    const { methods, registerGatewayMethod } = createGatewayMethodCapture();
    const run = vi.fn();
    const api = {
      runtime: {
        state: { openKeyedStore: vi.fn() },
        subagent: { run },
      },
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Blocked exact start",
      status: "blocked",
      workspaceAccess: { unrestricted: true },
    });
    registerWorkboardGatewayMethods({ api, store });
    const respond = vi.fn();

    await methods.get("workboard.cards.start")?.handler({
      params: { id: card.id },
      context: { getRuntimeConfig: () => ({}) },
      respond,
    } as never);

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

  it("threads maxStarts while the legacy method keeps its default cap", async () => {
    const { methods, registerGatewayMethod } = createGatewayMethodCapture();
    const run = vi.fn(async (input: { idempotencyKey: string }) => ({
      runId: `accepted:${input.idempotencyKey}`,
    }));
    const api = {
      runtime: {
        state: { openKeyedStore: vi.fn() },
        subagent: { run },
      },
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;
    const store = createWorkboardSqliteTestStore();
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.create({
          title: `Capped ${index}`,
          status: "ready",
          priority: "urgent",
          agentId: `capped-${index}`,
          boardId: "capped",
          workspaceAccess: { unrestricted: true },
        }),
      ),
    );
    registerWorkboardGatewayMethods({ api, store });
    const handler = methods.get("workboard.cards.dispatchWithOptions")?.handler;

    const respond = vi.fn();
    await handler?.({ params: { boardId: "capped", maxStarts: 4 }, respond } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]?.started).toHaveLength(4);
    expect(run).toHaveBeenCalledTimes(4);

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.create({
          title: `Legacy ${index}`,
          status: "ready",
          priority: "urgent",
          agentId: `legacy-${index}`,
          boardId: "legacy",
          workspaceAccess: { unrestricted: true },
        }),
      ),
    );
    const defaultRespond = vi.fn();
    await methods
      .get("workboard.cards.dispatch")
      ?.handler({ params: { boardId: "legacy" }, respond: defaultRespond } as never);
    expect(defaultRespond.mock.calls[0]?.[1]?.started).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(7);
    const startedCards = (await store.list()).filter((card) => card.status === "running");
    expect(startedCards).toHaveLength(7);
    const expectedRunIds = run.mock.calls.map(([input]) => `accepted:${input.idempotencyKey}`);
    expect(startedCards.map((card) => card.runId)).toEqual(expect.arrayContaining(expectedRunIds));
    for (const card of startedCards) {
      const runId = card.runId;
      expect(card).toMatchObject({
        runId,
        execution: { runId },
        metadata: {
          automation: { launch: { phase: "accepted", acceptedRunId: runId } },
          attempts: [expect.objectContaining({ id: runId, runId })],
        },
      });
    }

    const legacyRespond = vi.fn();
    await methods
      .get("workboard.cards.dispatch")
      ?.handler({ params: { maxStarts: 1 }, respond: legacyRespond } as never);
    expect(legacyRespond.mock.calls[0]?.[0]).toBe(false);
    expect(legacyRespond.mock.calls[0]?.[2]?.message).toBe(
      "maxStarts requires workboard.cards.dispatchWithOptions.",
    );

    for (const value of [0, -1, 1.5, "2"]) {
      const invalidRespond = vi.fn();
      await handler?.({ params: { maxStarts: value }, respond: invalidRespond } as never);
      expect(invalidRespond.mock.calls[0]?.[0]).toBe(false);
      expect(invalidRespond.mock.calls[0]?.[2]?.message).toBe(
        "maxStarts must be a positive integer.",
      );
    }
  });

  it("keeps write-scope worktree dispatch within configured agent workspaces", async () => {
    const { methods, registerGatewayMethod } = createGatewayMethodCapture();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const createWorktree = vi.fn().mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    const api = {
      runtime: {
        agent: {
          listAgentIds: vi.fn(() => ["main"]),
          resolveAgentWorkspaceDir: vi.fn(() => "/workspace"),
        },
        sandbox: {
          resolveWorkspaceAuthority: vi.fn(() => ({
            sandboxed: true,
            workspaceAccess: "rw",
          })),
          prepareWorkspaceAuthority: vi.fn(async () => ({
            sandboxed: true,
            workspaceAccess: "rw",
          })),
        },
        subagent: { run },
        worktrees: {
          resolveCheckoutRoot: vi.fn().mockResolvedValue("/workspace"),
          hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(true),
          create: createWorktree,
          release: vi.fn(),
          removeIfLossless: vi.fn(),
        },
      },
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;
    const store = createWorkboardSqliteTestStore();
    const denied = await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
    });
    registerWorkboardGatewayMethods({ api, store });
    const handler = methods.get("workboard.cards.dispatch")?.handler;

    const deniedRespond = vi.fn();
    await handler?.({
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
      respond: deniedRespond,
    } as never);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(deniedRespond.mock.calls[0]?.[1]).toMatchObject({
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
    const allowedRespond = vi.fn();
    await handler?.({
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
      respond: allowedRespond,
    } as never);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(allowedRespond.mock.calls[0]?.[1]).toMatchObject({ startFailures: [], started: [{}] });
    expect(api.runtime.sandbox.prepareWorkspaceAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace",
        confinedToolNames: expect.arrayContaining(["workboard_complete"]),
      }),
    );
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(allowed.id)).resolves.toMatchObject({
      metadata: { automation: { workspace: { kind: "dir", path: "/workspace" } } },
    });
  });

  it("claims, heartbeats, and bulk-updates cards through gateway methods", async () => {
    const { api, methods } = createGatewayMethodCapture();

    registerWorkboardGatewayMethods({ api, store: createWorkboardSqliteTestStore() });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Claim me" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const claimRespond = vi.fn();
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: cardId, ownerId: "main" },
      respond: claimRespond,
    } as never);
    expect(claimRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "running", metadata: { claim: { ownerId: "main" } } },
      token: expect.any(String),
    });

    const heartbeatRespond = vi.fn();
    await methods.get("workboard.cards.heartbeat")?.handler({
      params: { id: cardId, ownerId: "main", note: "alive" },
      respond: heartbeatRespond,
    } as never);
    expect(heartbeatRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { metadata: { comments: [expect.objectContaining({ body: "alive" })] } },
    });

    const bulkRespond = vi.fn();
    await methods.get("workboard.cards.bulk")?.handler({
      params: { ids: [cardId], patch: { priority: "urgent" } },
      respond: bulkRespond,
    } as never);
    expect(bulkRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ priority: "urgent" })],
    });

    const completeRespond = vi.fn();
    await methods.get("workboard.cards.complete")?.handler({
      params: { id: cardId, summary: "Operator closed it." },
      respond: completeRespond,
    } as never);
    expect(completeRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        status: "done",
        metadata: {
          comments: expect.arrayContaining([
            expect.objectContaining({ body: "Operator closed it." }),
          ]),
        },
      },
    });

    const blockedCreateRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Block me" },
      respond: blockedCreateRespond,
    } as never);
    const blockedCardId = blockedCreateRespond.mock.calls[0]?.[1]?.card.id;
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: blockedCardId, ownerId: "main" },
      respond: vi.fn(),
    } as never);
    const blockRespond = vi.fn();
    await methods.get("workboard.cards.block")?.handler({
      params: { id: blockedCardId, reason: "Operator blocked it." },
      respond: blockRespond,
    } as never);
    expect(blockRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "blocked" },
    });
  });
});
