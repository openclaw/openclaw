import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { GatewaySessionRow } from "../gateway/session-utils.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import {
  createLoadSessionRequest,
  createNewSessionRequest,
  createPromptRequest,
} from "./translator.bridge-test-helpers.js";
import { createTranslatorScenario } from "./translator.scenario.test-support.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

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
const { parentSessionKey, ...lineageFields } = lineage;
const lineageMeta = { parentSessionId: parentSessionKey, ...lineageFields };
function row(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, kind: "direct", updatedAt: 1_710_000_000_000, ...fields };
}
function meta(key: string, fields: Record<string, unknown> = {}) {
  return { sessionKey: key, kind: "direct", ...fields };
}
function sessions(rows: GatewaySessionRow[]) {
  return { sessions: rows, hasMore: false };
}
function fixture(rows: GatewaySessionRow[] = [], handler?: RequestHandler) {
  const request = vi.fn(
    handler ?? (async (method) => (method === "sessions.list" ? sessions(rows) : { ok: true })),
  );
  return { ...createTranslatorScenario(request, { sessions: [] }), request };
}

it.each([
  {
    name: "prefers an explicit label over a key and resets the resolved session",
    metadata: { sessionLabel: "support", sessionKey: "agent:main:main", resetSession: true },
    opts: {},
    expected: "agent:main:label",
    lookup: { label: "support" },
    reset: true,
  },
  {
    name: "lets metadata sessionKey override the default label",
    metadata: { sessionKey: "agent:main:override" },
    opts: { defaultSessionLabel: "default-label" },
    expected: "agent:main:override",
  },
  {
    name: "resolves the default label ahead of the default key",
    metadata: {},
    opts: { defaultSessionLabel: "default-label", defaultSessionKey: "default-key" },
    expected: "agent:main:label",
    lookup: { label: "default-label" },
  },
  {
    name: "uses the default key without a lookup",
    metadata: {},
    opts: { defaultSessionKey: "default-key" },
    expected: "default-key",
  },
  {
    name: "resolves an existing default key",
    metadata: {},
    opts: { defaultSessionKey: "default-key", requireExistingSession: true },
    expected: "default-key",
    lookup: { key: "default-key" },
  },
  {
    name: "resolves an explicit existing key ahead of the default label",
    metadata: { sessionKey: "explicit-key", requireExisting: true },
    opts: { defaultSessionLabel: "default-label" },
    expected: "explicit-key",
    lookup: { key: "explicit-key" },
  },
  {
    name: "lets false metadata disable the default existing-key requirement",
    metadata: { requireExisting: false },
    opts: { defaultSessionKey: "default-key", requireExistingSession: true },
    expected: "default-key",
  },
  {
    name: "creates the generated bridge key without a lookup when routing is unset",
    metadata: {},
    opts: { requireExistingSession: true },
    create: true,
  },
  {
    name: "lets false reset metadata override the server reset default",
    metadata: { sessionKey: "explicit-key", resetSession: false },
    opts: { resetSession: true },
    expected: "explicit-key",
  },
  {
    name: "applies the server reset default to the selected key",
    metadata: { sessionKey: "explicit-key" },
    opts: { resetSession: true },
    expected: "explicit-key",
    reset: true,
  },
])("newSession $name", async ({ metadata, opts, expected, lookup, reset, create }) => {
  const gateway = createAcpGateway();
  const request = vi.spyOn(gateway, "request").mockResolvedValue(sessions([]));
  if (lookup) {
    request.mockResolvedValueOnce({ ok: true, key: expected });
  }
  if (reset) {
    request.mockResolvedValueOnce({ ok: true });
  }
  const sessionStore = createInMemorySessionStore();
  const agent = createAcpGatewayAgent(createAcpConnection(), gateway, {
    ...opts,
    sessionStore,
  });
  const result = await agent.newSession({ ...createNewSessionRequest(cwd), _meta: metadata });
  const selectedKey = expected ?? `acp-bridge:${result.sessionId}`;
  expect(sessionStore.getSession(result.sessionId)?.sessionKey).toBe(selectedKey);
  expect(request.mock.calls).toEqual([
    ...(lookup ? [["sessions.resolve", lookup]] : []),
    ...(reset ? [["sessions.reset", { key: selectedKey }]] : []),
    ...(create ? [["sessions.create", { key: selectedKey, cwd }]] : []),
    ["sessions.list", { limit: 200, search: selectedKey, includeDerivedTitles: true }],
  ]);
});

it.each([
  {
    metadata: { sessionLabel: "missing" },
    lookup: { label: "missing" },
    error: "Unable to resolve session label: missing",
  },
  {
    metadata: { sessionKey: "missing", requireExisting: true },
    lookup: { key: "missing" },
    error: "Session key not found: missing",
  },
])(
  "rejects an unresolved newSession route before resetting: $metadata",
  async ({ metadata, lookup, error }) => {
    const gateway = createAcpGateway();
    const request = vi.spyOn(gateway, "request").mockResolvedValue({ ok: true });
    const connection = createAcpConnection();
    const sessionUpdate = vi.spyOn(connection, "sessionUpdate");
    const agent = createAcpGatewayAgent(connection, gateway, {
      resetSession: true,
    });
    await expect(
      agent.newSession({ ...createNewSessionRequest(cwd), _meta: metadata }),
    ).rejects.toThrow(error);
    expect(request.mock.calls).toEqual([["sessions.resolve", lookup]]);
    expect(sessionUpdate).not.toHaveBeenCalled();
  },
);

it.each([
  { cursor: "not-base64-json", error: "Invalid ACP session list cursor." },
  {
    cursor: Buffer.from(JSON.stringify({ v: 1, offset: 10_101 })).toString("base64url"),
    error: "Invalid ACP session list cursor offset.",
  },
  {
    cursor: Buffer.from(JSON.stringify({ v: 2, offset: 0 })).toString("base64url"),
    error: "Unsupported ACP session list cursor.",
  },
  { cursor: Buffer.from("[]").toString("base64url"), error: "Invalid ACP session list cursor." },
])(
  "rejects invalid session/list cursors before querying the Gateway: $cursor",
  async ({ cursor, error }) => {
    const { agent, request } = fixture();
    await expect(agent.listSessions({ cursor })).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
  },
);

it("accepts a canonical session/list cursor and rejects altered spellings", async () => {
  const rows = Array.from({ length: 30 }, (_, index) =>
    row(`session-${index}`, { spawnedCwd: "/tmp/work" }),
  );
  const { agent, request } = fixture(rows);
  const canonical = Buffer.from(JSON.stringify({ v: 1, offset: 25, cwd: "/tmp/work" })).toString(
    "base64url",
  );
  const page = await agent.listSessions({
    cwd: "/tmp/work",
    cursor: canonical,
    _meta: { limit: 2 },
  });
  expect(page.sessions.map((session) => session.sessionId)).toEqual(["session-25", "session-26"]);
  expect(page.nextCursor).toBe(
    Buffer.from(JSON.stringify({ v: 1, offset: 27, cwd: "/tmp/work" })).toString("base64url"),
  );
  request.mockClear();
  const extraField = Buffer.from(
    JSON.stringify({ v: 1, offset: 25, cwd: "/tmp/work", extra: true }),
  ).toString("base64url");
  for (const cursor of [`${canonical}$`, extraField]) {
    await expect(agent.listSessions({ cwd: "/tmp/work", cursor })).rejects.toThrow(
      "Invalid ACP session list cursor.",
    );
  }
  expect(request).not.toHaveBeenCalled();
});

it.each([
  { metadata: null, expected: 100 },
  { metadata: { limit: 2.9 }, expected: 2 },
  { metadata: { pageSize: 1_000 }, expected: 100 },
  { metadata: { limit: -1 }, expected: 1 },
])("clamps session/list page metadata: $metadata", async ({ metadata, expected }) => {
  const rows = Array.from({ length: 101 }, (_, index) => row(`session-${index}`));
  const { agent, request } = fixture([], async (_method, params) => {
    const limit = typeof params?.limit === "number" ? params.limit : rows.length;
    return { ...sessions(rows.slice(0, limit)), hasMore: limit < rows.length };
  });
  const result = await agent.listSessions({ _meta: metadata });
  expect(result.sessions.map((session) => session.sessionId)).toEqual(
    rows.slice(0, expected).map((session) => session.key),
  );
  expect(result.nextCursor).not.toBeNull();
  expect(request.mock.calls).toEqual([
    ["sessions.list", { limit: expected + 1, includeDerivedTitles: true }],
  ]);
});

it("bounds the Gateway fetch at the maximum accepted session/list offset", async () => {
  const { agent, request } = fixture([], async () => ({ ...sessions([]), hasMore: true }));
  const cursor = Buffer.from(JSON.stringify({ v: 1, offset: 10_000 })).toString("base64url");
  await expect(agent.listSessions({ cursor })).resolves.toEqual({ sessions: [], nextCursor: null });
  expect(request.mock.calls).toEqual([
    ["sessions.list", { limit: 10_101, includeDerivedTitles: true }],
  ]);
});

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
  expect(first.sessions[0]?._meta).toEqual(
    meta("child", {
      channel: "telegram",
      ...lineageMeta,
      spawnedWorkspaceDir: "/work/a",
    }),
  );
  expect(first.sessions[1]?._meta).toEqual(
    meta("a2", {
      channel: "telegram",
      spawnedWorkspaceDir: "/work/a",
    }),
  );
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

it("rejects resume for a missing Gateway session without creating bridge state", async () => {
  const { agent, sessionStore } = fixture();
  await expect(agent.resumeSession({ sessionId: "missing", cwd, mcpServers: [] })).rejects.toThrow(
    /Session missing not found/i,
  );
  expect(sessionStore.hasSession("missing")).toBe(false);
});

it.each(["resume", "load"] as const)(
  "publishes %s snapshots in the Gateway namespace",
  async (route) => {
    const resume = route === "resume";
    const sessionId = resume ? sessionKey : "client-local-session";
    const title = resume ? "Work session" : "Child";
    const spawnedWorkspaceDir = resume ? cwd : "/workspace/child";
    const { agent, request, sessionUpdate, sessionStore } = fixture([
      row(sessionKey, {
        thinkingLevel: "adaptive",
        ...(resume
          ? { derivedTitle: title }
          : { ...lineage, channel: "discord", displayName: title }),
        spawnedWorkspaceDir,
        updatedAt: resume ? 1_710_000_000_000 : 1_710_000_020_000,
      }),
    ]);
    const result = resume
      ? await agent.resumeSession({ sessionId, cwd, mcpServers: [] })
      : await agent.loadSession({
          ...createLoadSessionRequest(sessionId),
          _meta: { sessionKey },
        });
    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(result.configOptions?.find((option) => option.id === "thought_level")).toMatchObject({
      currentValue: "adaptive",
    });
    expect(sessionStore.getSession(sessionId)?.sessionKey).toBe(sessionKey);
    if (resume) {
      expect(request.mock.calls.map(([method]) => method)).not.toContain("sessions.get");
    }
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: resume ? "2024-03-09T16:00:00.000Z" : "2024-03-09T16:00:20.000Z",
        _meta: meta(sessionKey, {
          spawnedWorkspaceDir,
          ...(!resume ? { channel: "discord", ...lineageMeta } : {}),
        }),
      },
    });
  },
);

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
  for (const agent of [agentA, agentB]) {
    await expect(agent.closeSession({ sessionId: sessionA.sessionId })).rejects.toThrow(
      `Session ${sessionA.sessionId} not found`,
    );
  }
  await expect(agentB.closeSession({ sessionId: sessionB.sessionId })).resolves.toEqual({});
});
