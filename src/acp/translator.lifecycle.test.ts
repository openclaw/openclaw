import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { GatewaySessionRow } from "../gateway/session-utils.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import {
  createLoadSessionRequest,
  createNewSessionRequest,
  createPromptRequest,
  expectConfigOption,
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
const parentSessionKey = "agent:main:main";
function row(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, kind: "direct", updatedAt: 1_710_000_000_000, ...fields };
}
function sessions(rows: GatewaySessionRow[]) {
  return { sessions: rows, hasMore: false };
}
function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function fixture(
  rows: GatewaySessionRow[] = [],
  handler?: RequestHandler,
  options: AcpServerOptions = {},
) {
  const request = vi.fn(
    handler ?? (async (method) => (method === "sessions.list" ? sessions(rows) : { ok: true })),
  );
  return { ...createTranslatorScenario(request, { ...options, sessions: [] }), request };
}
function pagedFixture(rows: GatewaySessionRow[]) {
  return fixture([], async (method, params) => {
    if (method !== "sessions.list") {
      return { ok: true };
    }
    const limit = typeof params?.limit === "number" ? params.limit : rows.length;
    return { ...sessions(rows.slice(0, limit)), hasMore: limit < rows.length };
  });
}

const defaultKey = { defaultSessionKey: "default" };
const defaultLabel = { defaultSessionLabel: "label" };
const explicitKey = { sessionKey: "explicit" };
const existing = { ...defaultKey, requireExistingSession: true };
type Route = [
  metadata: Record<string, unknown>,
  opts: AcpServerOptions,
  expected: string | undefined,
  lookup?: { key: string } | { label: string },
  reset?: boolean,
];
it.each<Route>([
  [
    { ...explicitKey, sessionLabel: "label", resetSession: true },
    {},
    "resolved",
    { label: "label" },
    true,
  ],
  [explicitKey, defaultLabel, "explicit"],
  [{}, { ...defaultKey, ...defaultLabel }, "resolved", { label: "label" }],
  [{}, defaultKey, "default"],
  [{}, existing, "default", { key: "default" }],
  [{ ...explicitKey, requireExisting: true }, defaultLabel, "explicit", { key: "explicit" }],
  [{ requireExisting: false }, existing, "default"],
  [{}, { requireExistingSession: true }, undefined],
  [{ ...explicitKey, resetSession: false }, { resetSession: true }, "explicit"],
  [explicitKey, { resetSession: true }, "explicit", undefined, true],
])(
  "routes newSession metadata %j with defaults %j to %s",
  async (metadata, opts, expected, lookup, reset) => {
    const { agent, request, sessionStore } = fixture([], undefined, opts);
    if (lookup) {
      request.mockResolvedValueOnce({ ok: true, key: expected });
    }
    const { newSession } = agent;
    const result = await newSession({ ...createNewSessionRequest(cwd), _meta: metadata });
    const selectedKey = expected ?? `acp-bridge:${result.sessionId}`;
    expect(sessionStore.getSession(result.sessionId)?.sessionKey).toBe(selectedKey);
    expect(request.mock.calls).toEqual([
      ...(lookup ? [["sessions.resolve", lookup]] : []),
      ...(reset ? [["sessions.reset", { key: selectedKey }]] : []),
      ...(expected === undefined ? [["sessions.create", { key: selectedKey, cwd }]] : []),
      ["sessions.list", { limit: 200, search: selectedKey, includeDerivedTitles: true }],
    ]);
  },
);

it.each([
  [{ sessionLabel: "missing" }, { label: "missing" }, "Unable to resolve session label: missing"],
  [
    { sessionKey: "missing", requireExisting: true },
    { key: "missing" },
    "Session key not found: missing",
  ],
] as const)(
  "rejects an unresolved newSession route before resetting: %j",
  async (metadata, lookup, error) => {
    const { agent, request, sessionUpdate } = fixture([], async () => ({ ok: true }), {
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
  ["not-base64-json", "Invalid ACP session list cursor."],
  [encodeCursor({ v: 1, offset: 10_101 }), "Invalid ACP session list cursor offset."],
  [encodeCursor({ v: 2, offset: 0 }), "Unsupported ACP session list cursor."],
  [encodeCursor([]), "Invalid ACP session list cursor."],
])(
  "rejects invalid session/list cursors before querying the Gateway: %s",
  async (cursor, error) => {
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
  const canonical = encodeCursor({ v: 1, offset: 25, cwd: "/tmp/work" });
  const page = await agent.listSessions({
    cwd: "/tmp/work",
    cursor: canonical,
    _meta: { limit: 2 },
  });
  expect(page.sessions.map((session) => session.sessionId)).toEqual(["session-25", "session-26"]);
  expect(page.nextCursor).toBe(encodeCursor({ v: 1, offset: 27, cwd: "/tmp/work" }));
  request.mockClear();
  const extraField = encodeCursor({ v: 1, offset: 25, cwd: "/tmp/work", extra: true });
  for (const invalidCursor of [`${canonical}$`, extraField]) {
    await expect(agent.listSessions({ cwd: "/tmp/work", cursor: invalidCursor })).rejects.toThrow(
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
  const { agent } = pagedFixture(rows);
  const result = await agent.listSessions({ _meta: metadata });
  expect(result.sessions.map((session) => session.sessionId)).toEqual(
    rows.slice(0, expected).map((session) => session.key),
  );
  expect(result.nextCursor).not.toBeNull();
});

it("bounds the Gateway fetch at the maximum accepted session/list offset", async () => {
  const { agent, request } = fixture([], async () => ({ ...sessions([]), hasMore: true }));
  await expect(
    agent.listSessions({ cursor: encodeCursor({ v: 1, offset: 10_000 }) }),
  ).resolves.toEqual({
    sessions: [],
    nextCursor: null,
  });
  expect(request.mock.calls).toEqual([
    ["sessions.list", { limit: 10_101, includeDerivedTitles: true }],
  ]);
});

it("paginates cwd-filtered sessions with lineage, safe timestamps, and filter-bound cursors", async () => {
  const rows = [
    row("child", {
      parentSessionKey,
      derivedTitle: "Child",
      spawnedWorkspaceDir: "/work/a",
      updatedAt: Infinity,
    }),
    row("unknown"),
    row("a2", { displayName: "Main", spawnedWorkspaceDir: "/work/a" }),
    row("b1", { spawnedWorkspaceDir: "/work/b" }),
    row("a3", { spawnedWorkspaceDir: "/work/a" }),
    row("a4", { spawnedWorkspaceDir: "/work/a" }),
  ];
  const { agent } = pagedFixture(rows);
  const first = await agent.listSessions({ cwd: "/work/a", _meta: { limit: 2 } });
  const second = await agent.listSessions({
    cwd: "/work/a",
    cursor: first.nextCursor,
    _meta: { limit: 2 },
  });
  expect(first.sessions.map((session) => session.sessionId)).toEqual(["child", "a2"]);
  expect(first.sessions.map((session) => session.cwd)).toEqual(["/work/a", "/work/a"]);
  expect(first.sessions[0]?.updatedAt).toBeUndefined();
  expect(first.sessions[0]?._meta).toMatchObject({
    sessionKey: "child",
    parentSessionId: parentSessionKey,
  });
  expect(second.sessions.map((session) => session.sessionId)).toEqual(["a3", "a4"]);
  expect(second.sessions.map((session) => session.cwd)).toEqual(["/work/a", "/work/a"]);
  expect(second.nextCursor).toBeNull();
  await expect(
    agent.listSessions({ cwd: "/work/a", cursor: ` ${first.nextCursor} ` }),
  ).rejects.toThrow("Invalid ACP session list cursor.");
  await expect(agent.listSessions({ cursor: first.nextCursor })).rejects.toThrow(
    /cursor does not match the cwd filter/i,
  );
  const unfiltered = await agent.listSessions({ _meta: { limit: 1 } });
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

it.each([
  ["resume", true],
  ["resume", false],
  ["load", true],
  ["load", false],
] as const)(
  "%s keeps a bridge-created session after restart with complete replay=%s",
  async (route, complete) => {
    const ledger = createTestAcpEventLedger();
    const rows: GatewaySessionRow[] = [];
    const request: RequestHandler = async (method, params) => {
      const target = `agent:main:${String(params?.key)}`;
      if (method === "sessions.create") {
        rows.push(row(target, { thinkingLevel: "adaptive" }));
      }
      if (method === "sessions.resolve") {
        return { ok: true, key: rows.find((entry) => entry.key === target)?.key };
      }
      return method === "sessions.list" ? sessions(rows) : { ok: true };
    };
    const first = createTranslatorScenario(request, { eventLedger: ledger, sessions: [] }).agent;
    const created = await first.newSession(createNewSessionRequest(cwd));
    const key = `acp-bridge:${created.sessionId}`;
    await ledger.recordUserPrompt({
      sessionId: created.sessionId,
      sessionKey: key,
      runId: "remember",
      prompt: [{ type: "text", text: "Remember the previous turn." }],
    });
    await first.shutdown();
    if (!complete) {
      await ledger.markIncomplete({ sessionId: created.sessionId, sessionKey: key });
    }
    const second = createTranslatorScenario(request, { eventLedger: ledger, sessions: [] });
    try {
      const response = await second.agent[route === "resume" ? "resumeSession" : "loadSession"](
        createLoadSessionRequest(created.sessionId, cwd),
      );
      if (route === "resume") {
        expect(response.modes?.currentModeId).toBe("adaptive");
        expect(
          second.sessionUpdate.mock.calls.some(([{ update }]) =>
            ["user_message_chunk", "agent_message_chunk"].includes(update.sessionUpdate),
          ),
        ).toBe(false);
      } else {
        expect(second.sessionStore.getSession(created.sessionId)?.sessionKey).toBe(key);
      }
    } finally {
      await second.agent.shutdown();
    }
  },
);
it.each(["resume", "load"] as const)(
  "publishes %s snapshots in the Gateway namespace",
  async (route) => {
    const resume = route === "resume";
    const sessionId = resume ? sessionKey : "client-local-session";
    const title = "Child";
    const spawnedWorkspaceDir = "/workspace/child";
    const { agent, request, sessionUpdate, sessionStore } = fixture([
      row(sessionKey, {
        thinkingLevel: "adaptive",
        parentSessionKey,
        ...(resume ? { derivedTitle: title } : { displayName: title }),
        spawnedWorkspaceDir,
      }),
    ]);
    const result = await (resume
      ? agent.resumeSession({ sessionId, cwd, mcpServers: [] })
      : agent.loadSession({
          ...createLoadSessionRequest(sessionId),
          _meta: { sessionKey },
        }));
    expect(result.modes?.currentModeId).toBe("adaptive");
    expectConfigOption(result.configOptions, "thought_level", { currentValue: "adaptive" });
    expect(sessionStore.getSession(sessionId)?.sessionKey).toBe(sessionKey);
    if (resume) {
      expect(request.mock.calls.map(([method]) => method)).not.toContain("sessions.get");
    }
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: "2024-03-09T16:00:00.000Z",
        _meta: expect.objectContaining({
          sessionKey,
          spawnedWorkspaceDir,
          parentSessionId: parentSessionKey,
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
    const { agent, sessionStore } = fixture([], async (method, params) => {
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
  // Both owners must see the shared store to prove shutdown isolation.
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
