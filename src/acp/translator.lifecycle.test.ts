/** Tests ACP session lifecycle, pagination, lineage, and terminal acknowledgements. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { GatewaySessionRow } from "../gateway/session-utils.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import {
  createLoadSessionRequest,
  createNewSessionRequest,
  createPromptRequest,
} from "./translator.bridge-test-helpers.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

type RequestHandler = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
const sessionKey = "agent:main:work";
const cwd = "/tmp/openclaw";
const lineage = {
  parentSessionKey: "agent:main:main",
  spawnedBy: "agent:main:main",
  spawnDepth: 1,
  subagentRole: "leaf",
  subagentControlScope: "none",
} as const;
const lineageMeta = {
  parentSessionId: "agent:main:main",
  spawnedBy: "agent:main:main",
  spawnDepth: 1,
  subagentRole: "leaf",
  subagentControlScope: "none",
};
function row(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    updatedAt: 1_710_000_000_000,
    thinkingLevel: "adaptive",
    ...fields,
  };
}
function sessions(rows: GatewaySessionRow[]) {
  return {
    ts: 1,
    path: "/tmp/sessions.json",
    count: rows.length,
    totalCount: rows.length,
    limitApplied: rows.length,
    hasMore: false,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
  };
}
function fixture(rows: GatewaySessionRow[] = [], handler?: RequestHandler) {
  const request = vi.fn(
    handler ?? (async (method) => (method === "sessions.list" ? sessions(rows) : { ok: true })),
  );
  const connection = createAcpConnection();
  const sessionStore = createInMemorySessionStore();
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    { sessionStore },
  );
  return { agent, request, connection, sessionStore };
}

describe("acp translator stable lifecycle handlers", () => {
  it("paginates cwd-filtered sessions with lineage, safe timestamps, and filter-bound cursors", async () => {
    const rows = [
      row("child", {
        ...lineage,
        channel: "telegram",
        derivedTitle: "Child",
        spawnedWorkspaceDir: "/work/a",
        updatedAt: Infinity,
      }),
      row("unknown"),
      row("a2", { channel: "telegram", displayName: "Main", spawnedWorkspaceDir: "/work/a" }),
      row("b1", { spawnedWorkspaceDir: "/work/b" }),
      row("a3", { spawnedWorkspaceDir: "/work/a" }),
      row("a4", { spawnedWorkspaceDir: "/work/a" }),
    ];
    const { agent, request } = fixture([], async (method, params) => {
      if (method !== "sessions.list") {
        return { ok: true };
      }
      const limit = typeof params?.limit === "number" ? params.limit : rows.length;
      return {
        ...sessions(rows.slice(0, limit)),
        totalCount: rows.length,
        hasMore: limit < rows.length,
      };
    });
    const first = await agent.listSessions({ cwd: "/work/a", _meta: { limit: 2 } });
    const second = await agent.listSessions({
      cwd: "/work/a",
      cursor: first.nextCursor,
      _meta: { limit: 2 },
    });
    expect(first.sessions.map((session) => session.sessionId)).toEqual(["child", "a2"]);
    expect(first.sessions.map((session) => session.cwd)).toEqual(["/work/a", "/work/a"]);
    expect(first.sessions[0]?.updatedAt).toBeUndefined();
    expect(first.sessions[0]?._meta).toEqual({
      sessionKey: "child",
      kind: "direct",
      channel: "telegram",
      ...lineageMeta,
      spawnedWorkspaceDir: "/work/a",
    });
    expect(first.sessions[1]?._meta).toEqual({
      sessionKey: "a2",
      kind: "direct",
      channel: "telegram",
      spawnedWorkspaceDir: "/work/a",
    });
    expect(first.nextCursor).toBeTypeOf("string");
    expect(first.nextCursor).not.toBe("");
    expect(second.sessions.map((session) => session.sessionId)).toEqual(["a3", "a4"]);
    expect(second.sessions.map((session) => session.cwd)).toEqual(["/work/a", "/work/a"]);
    expect(second.nextCursor).toBeNull();
    expect(request.mock.calls).toEqual(
      [3, 6, 5, 10].map((limit) => ["sessions.list", { limit, includeDerivedTitles: true }]),
    );
    await expect(
      agent.listSessions({ cwd: "/work/a", cursor: ` ${first.nextCursor} ` }),
    ).rejects.toThrow("Invalid ACP session list cursor.");
    await expect(agent.listSessions({ cursor: first.nextCursor })).rejects.toThrow(
      /cursor does not match the cwd filter/i,
    );
    const unfiltered = await agent.listSessions({ _meta: { limit: 1 } });
    expect(unfiltered.nextCursor).toBeTypeOf("string");
    expect(unfiltered.nextCursor).not.toBe("");
    await expect(
      agent.listSessions({ cwd: "/work/a", cursor: unfiltered.nextCursor }),
    ).rejects.toThrow(/cursor does not match the cwd filter/i);
  });

  it("rejects relative cwd filters for session/list", async () => {
    await expect(fixture().agent.listSessions({ cwd: "relative/path" })).rejects.toThrow(
      /requires an absolute cwd/i,
    );
  });

  it("resumes an existing Gateway session without replaying transcript history", async () => {
    const { agent, request, connection, sessionStore } = fixture([
      row(sessionKey, { spawnedWorkspaceDir: cwd, derivedTitle: "Work session" }),
    ]);
    const result = await agent.resumeSession({ sessionId: sessionKey, cwd, mcpServers: [] });
    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(
      result.configOptions?.find((option) => option.id === "thought_level")?.currentValue,
    ).toBe("adaptive");
    expect(sessionStore.getSession(sessionKey)?.sessionKey).toBe(sessionKey);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("sessions.get");
    expect(connection["__sessionUpdateMock"]).toHaveBeenCalledWith({
      sessionId: sessionKey,
      update: {
        sessionUpdate: "session_info_update",
        title: "Work session",
        updatedAt: "2024-03-09T16:00:00.000Z",
        _meta: { sessionKey, kind: "direct", spawnedWorkspaceDir: cwd },
      },
    });
  });

  it("rejects resume for a missing Gateway session without creating bridge state", async () => {
    const { agent, sessionStore } = fixture();
    await expect(
      agent.resumeSession({ sessionId: "missing", cwd, mcpServers: [] }),
    ).rejects.toThrow(/Session missing not found/i);
    expect(sessionStore.hasSession("missing")).toBe(false);
  });

  it("keeps snapshot lineage in the Gateway session key namespace", async () => {
    const { agent, connection } = fixture([
      row(sessionKey, {
        ...lineage,
        channel: "discord",
        displayName: "Child",
        spawnedWorkspaceDir: "/workspace/child",
        updatedAt: 1_710_000_020_000,
      }),
    ]);
    await agent.loadSession({
      ...createLoadSessionRequest("client-local-session"),
      _meta: { sessionKey },
    });
    expect(connection["__sessionUpdateMock"]).toHaveBeenCalledWith({
      sessionId: "client-local-session",
      update: {
        sessionUpdate: "session_info_update",
        title: "Child",
        updatedAt: "2024-03-09T16:00:20.000Z",
        _meta: {
          sessionKey,
          kind: "direct",
          channel: "discord",
          ...lineageMeta,
          spawnedWorkspaceDir: "/workspace/child",
        },
      },
    });
  });

  it.each([
    { status: "timeout", stopReason: "cancelled" },
    { status: "ok", stopReason: "end_turn" },
    { status: "error", stopReason: undefined },
  ] as const)(
    "settles prompts on a terminal $status acknowledgement",
    async ({ status, stopReason }) => {
      const { agent, request, sessionStore } = fixture([], async (method, params) => {
        if (method === "chat.send") {
          return { runId: params?.idempotencyKey, status };
        }
        return method === "sessions.list" ? sessions([row(sessionKey)]) : { ok: true };
      });
      sessionStore.createSession({ sessionId: "session-1", sessionKey, cwd });
      const prompt = agent.prompt(createPromptRequest("session-1", "hello"));
      if (status === "error") {
        await expect(prompt).rejects.toThrow("Chat failed before the run started; try again.");
      } else {
        await expect(prompt).resolves.toEqual({ stopReason });
      }
      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    },
  );

  it("drains only its own pending work and sessions during shutdown", async () => {
    const ledger = createTestAcpEventLedger();
    const recorded = createDeferredCore();
    const recordUserPrompt = ledger.recordUserPrompt.bind(ledger);
    vi.spyOn(ledger, "recordUserPrompt").mockImplementation(async (params) => {
      await recordUserPrompt(params);
      recorded.resolve();
    });
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "chat.send") {
        return { runId: params?.idempotencyKey, status: "started" };
      }
      return method === "sessions.list" ? sessions([]) : { ok: true };
    });
    const agentA = createAcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(request as GatewayClient["request"]),
      { eventLedger: ledger },
    );
    const agentB = createAcpGatewayAgent(
      createAcpConnection(),
      createAcpGateway(request as GatewayClient["request"]),
    );
    const sessionA = await agentA.newSession(createNewSessionRequest(cwd));
    const sessionB = await agentB.newSession(createNewSessionRequest(cwd));
    const pending = agentA.prompt(createPromptRequest(sessionA.sessionId, "hello"));
    await recorded.promise;
    const send = request.mock.calls.find(([method]) => method === "chat.send");
    expect(send?.[1]?.idempotencyKey).toBeTypeOf("string");
    await agentA.shutdown();
    await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
    expect(request.mock.calls.find(([method]) => method === "chat.abort")?.[1]).toEqual({
      sessionKey: `acp-bridge:${sessionA.sessionId}`,
      runId: send?.[1]?.idempotencyKey,
    });
    await expect(agentA.closeSession({ sessionId: sessionA.sessionId })).rejects.toThrow(
      `Session ${sessionA.sessionId} not found`,
    );
    await expect(agentB.closeSession({ sessionId: sessionA.sessionId })).rejects.toThrow(
      `Session ${sessionA.sessionId} not found`,
    );
    await expect(agentB.closeSession({ sessionId: sessionB.sessionId })).resolves.toEqual({});
  });
});
