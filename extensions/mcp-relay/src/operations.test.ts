import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock-isolation: Exercise the plugin adapter without loading host config/storage owners.
vi.mock("openclaw/plugin-sdk/agent-scope-runtime", () => ({
  listAgentIds: () => ["main", "research"],
  tryResolveDefaultAgentId: () => "main",
}));

import { createOperations } from "./operations.js";

const newer = {
  key: "agent:main:new",
  sessionId: "new-session",
  agentId: "main",
  derivedTitle: "New conversation",
  lastMessagePreview: "Latest preview",
  run: "idle" as const,
  archived: false,
  pullRequests: [],
  lastActivityAt: 1_000,
};
const older = {
  ...newer,
  key: "agent:main:old",
  sessionId: "old-session",
  derivedTitle: "Older conversation",
  lastActivityAt: 500,
};

function fixture(agentId?: string, now = () => 0, controlUiUrl?: string) {
  const request = vi.fn<Parameters<typeof createOperations>[0]["runtime"]["gateway"]["request"]>();
  const readSessionFacts = vi
    .fn<PluginRuntime["gateway"]["readSessionFacts"]>()
    .mockResolvedValue({ sessions: [newer] });
  const withSessionFacts =
    vi.fn<(selection: Parameters<PluginRuntime["gateway"]["withSessionFacts"]>[0]) => void>();
  const selectSessionFacts: PluginRuntime["gateway"]["withSessionFacts"] = async (
    selection,
    run,
  ) => {
    withSessionFacts(selection);
    return run({
      scope: undefined,
      revision: "1",
      redactionRevision: "1",
      sessions: [older, newer],
    });
  };
  const logger = { error: vi.fn() };
  const dispatch = createOperations({
    logger,
    agentId,
    controlUiUrl,
    now,
    gateway: { name: "Synthetic Gateway", version: "1.0.0" },
    runtime: {
      config: {
        current: () => ({
          agents: { entries: { main: { name: "Main agent" }, research: { name: "Research" } } },
        }),
      },
      gateway: {
        request: async (method, params, options) => {
          if (method === "sessions.create" && params?.idempotencyKey) {
            throw Object.assign(
              new Error(
                "idempotent session creation requires an authenticated principal or device identity",
              ),
              { code: "INVALID_REQUEST" },
            );
          }
          return request(method, params, options);
        },
        readSessionFacts,
        withSessionFacts: selectSessionFacts,
      },
    },
  });
  const operations = (op: string, params: unknown, assertAuthority = async () => {}) =>
    dispatch(op, params, assertAuthority);
  return { operations, request, readSessionFacts, withSessionFacts, logger };
}

function message(id: string, role: string, text: string) {
  return { role, content: [{ type: "text", text }], timestamp: 1_000, __openclaw: { id } };
}

describe("MCP relay data operations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps agent roster/default and current session facts to the wire results", async () => {
    const { operations, withSessionFacts } = fixture();
    expect(await operations("status", {})).toEqual({
      gateway: { name: "Synthetic Gateway", version: "1.0.0" },
      agents: [
        { id: "main", name: "Main agent", default: true },
        { id: "research", name: "Research", default: false },
      ],
    });
    expect(await operations("conversations.list", { limit: 1 })).toEqual({
      conversations: [
        {
          conversationId: newer.key,
          title: "New conversation",
          agentId: "main",
          updatedAt: "1970-01-01T00:00:01.000Z",
          preview: "Latest preview",
        },
      ],
    });
    expect(
      await operations("conversations.list", { limit: 50, search: "OLDER", agentId: "main" }),
    ).toMatchObject({ conversations: [{ conversationId: older.key }] });
    expect(withSessionFacts).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "main" }));
  });

  it("advertises the configured direct Control UI URL in status", async () => {
    const { operations } = fixture(undefined, undefined, "https://gateway.example:8443/openclaw/");
    expect(await operations("status", {})).toEqual({
      gateway: { name: "Synthetic Gateway", version: "1.0.0" },
      agents: [
        { id: "main", name: "Main agent", default: true },
        { id: "research", name: "Research", default: false },
      ],
      controlUi: { url: "https://gateway.example:8443/openclaw/" },
    });
  });

  it("anchors the first history page and preserves opaque older cursors with plain user/assistant text", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({ messages: [message("latest", "assistant", "answer")] });
    request.mockResolvedValueOnce({
      messages: [
        message("user", "user", "question"),
        message("tool", "toolResult", "secret tool output"),
        message("latest", "assistant", "answer"),
      ],
      olderCursor: "host-page-cursor",
    });
    expect(await operations("conversation.read", { conversationId: newer.key, limit: 3 })).toEqual({
      conversationId: newer.key,
      title: "New conversation",
      messages: [
        { id: "user", role: "user", text: "question", timestamp: "1970-01-01T00:00:01.000Z" },
        { id: "latest", role: "assistant", text: "answer", timestamp: "1970-01-01T00:00:01.000Z" },
      ],
      nextBefore: "host-page-cursor",
    });
    expect(request).toHaveBeenLastCalledWith(
      "chat.history",
      expect.objectContaining({
        sessionKey: newer.key,
        messageId: "latest",
        limit: 3,
        maxChars: 16_000,
      }),
      { timeoutMs: 15_000 },
    );
    request.mockResolvedValueOnce({ messages: [message("prior", "user", "earlier")] });
    await operations("conversation.read", {
      conversationId: newer.key,
      limit: 3,
      before: "host-page-cursor",
    });
    expect(request).toHaveBeenLastCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "host-page-cursor", limit: 3 }),
      { timeoutMs: 15_000 },
    );
  });

  it("truncates plain text and rejects a result exceeding the wire byte cap", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({
      messages: [message("large", "assistant", "x".repeat(20_000))],
    });
    const result = await operations("conversation.read", {
      conversationId: newer.key,
      limit: 1,
      before: "cursor",
    });
    expect(result).toMatchObject({ messages: [{ text: `${"x".repeat(15_999)}…` }] });
    request.mockResolvedValueOnce({
      messages: Array.from({ length: 40 }, (_, i) =>
        message(`large-${i}`, "assistant", "x".repeat(16_000)),
      ),
    });
    await expect(
      operations("conversation.read", { conversationId: newer.key, limit: 40, before: "cursor" }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("refuses unknown or rebound sessions and invalid history cursors", async () => {
    const missing = fixture();
    missing.readSessionFacts.mockResolvedValue({ sessions: [] });
    await expect(
      missing.operations("conversation.read", { conversationId: "unknown", limit: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(missing.request).not.toHaveBeenCalled();

    const rebound = fixture();
    rebound.readSessionFacts
      .mockResolvedValueOnce({ sessions: [newer] })
      .mockResolvedValueOnce({ sessions: [{ ...newer, sessionId: "replacement" }] });
    rebound.request.mockResolvedValueOnce({ messages: [message("old", "user", "old data")] });
    await expect(
      rebound.operations("conversation.read", {
        conversationId: newer.key,
        limit: 1,
        before: "cursor",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });

    const stale = fixture();
    stale.request.mockResolvedValueOnce({ kind: "reset" });
    await expect(
      stale.operations("conversation.read", {
        conversationId: newer.key,
        limit: 1,
        before: "stale",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it.each([
    ["status", { unexpected: true }],
    ["conversations.list", { limit: 0 }],
    ["conversations.list", { limit: 51 }],
    ["conversations.list", { limit: 1, search: "x".repeat(201) }],
    ["conversation.read", { conversationId: newer.key, limit: 101 }],
    ["conversation.read", { conversationId: "", limit: 1 }],
    ["message.send", { message: "x".repeat(8_001), waitMs: 0 }],
    ["message.send", { message: "hello", waitMs: -1 }],
    ["reply.get", { conversationId: newer.key, runId: "run", waitMs: 50_001 }],
  ])("validates %s parameters before reaching the SDK", async (op, params) => {
    const { operations, request, readSessionFacts, withSessionFacts } = fixture();
    await expect(operations(op, params)).rejects.toMatchObject({ code: "invalid_params" });
    expect(request).not.toHaveBeenCalled();
    expect(readSessionFacts).not.toHaveBeenCalled();
    expect(withSessionFacts).not.toHaveBeenCalled();
  });

  it("submits a new conversation with agent precedence and returns its accepted run without waiting", async () => {
    const { operations, request } = fixture("research");
    request.mockResolvedValueOnce({
      key: newer.key,
      sessionId: newer.sessionId,
      runId: "created-run",
      runStarted: true,
    });
    expect(
      await operations("message.send", { message: "new question", agentId: "main", waitMs: 0 }),
    ).toEqual({ conversationId: newer.key, runId: "created-run", status: "running" });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.create",
      { agentId: "main", message: "new question" },
      { timeoutMs: 15_000 },
    );

    const configured = fixture("research");
    configured.request.mockResolvedValueOnce({
      key: newer.key,
      sessionId: newer.sessionId,
      runId: "configured-run",
      runStarted: true,
    });
    await configured.operations("message.send", { message: "configured", waitMs: 0 });
    expect(configured.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ agentId: "research" }),
      expect.any(Object),
    );
  });

  it("continues an existing conversation and reads its exact completed reply", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({ runId: "accepted-run", status: "started" });
    request.mockResolvedValueOnce({
      status: "ok",
      terminalReply: { disposition: "visible", text: "snapshot text" },
    });
    expect(
      await operations("message.send", {
        message: "continue",
        conversationId: newer.key,
        waitMs: 50_000,
      }),
    ).toEqual({
      conversationId: newer.key,
      runId: "accepted-run",
      status: "completed",
      reply: "snapshot text",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "chat.send",
      {
        sessionKey: newer.key,
        sessionId: newer.sessionId,
        agentId: "main",
        message: "continue",
        idempotencyKey: expect.any(String),
      },
      { timeoutMs: 15_000 },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "agent.wait",
      { runId: "accepted-run", timeoutMs: 50_000 },
      { timeoutMs: 55_000 },
    );
  });

  it.each([
    {
      name: "visible reply",
      terminalReply: { disposition: "visible", text: "owner reply" },
      content: { reply: "owner reply" },
    },
    {
      name: "truncated reply",
      terminalReply: { disposition: "visible", text: "x".repeat(20_000) },
      content: { reply: `${"x".repeat(15_999)}…` },
    },
    { name: "silent reply", terminalReply: { disposition: "silent" }, content: {} },
    { name: "empty reply", terminalReply: { disposition: "empty" }, content: {} },
    {
      name: "expired reply",
      terminalReply: undefined,
      content: {
        error: "The reply is no longer available from the run. Use read_conversation to see it.",
      },
    },
  ])(
    "returns the run owner's $name without transcript reads",
    async ({ terminalReply, content }) => {
      const { operations, request } = fixture();
      request.mockResolvedValueOnce({ status: "ok", terminalReply });
      expect(
        await operations("reply.get", { conversationId: newer.key, runId: "run", waitMs: 0 }),
      ).toEqual({ conversationId: newer.key, runId: "run", status: "completed", ...content });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "agent.wait",
        { runId: "run", timeoutMs: 0 },
        { timeoutMs: 5_000 },
      );
    },
  );

  it.each(["message.send", "reply.get"])("refuses a missing conversation for %s", async (op) => {
    const { operations, request, readSessionFacts } = fixture();
    readSessionFacts.mockResolvedValue({ sessions: [] });
    await expect(
      operations(op, {
        conversationId: "missing",
        ...(op === "message.send" ? { message: "hello" } : { runId: "run" }),
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(request).not.toHaveBeenCalled();
  });

  it("withholds a reply if the conversation is deleted while waiting", async () => {
    const { operations, request, readSessionFacts } = fixture();
    request.mockImplementationOnce(async () => {
      readSessionFacts.mockResolvedValue({ sessions: [] });
      return { status: "ok", terminalReply: { disposition: "visible", text: "deleted reply" } };
    });
    await expect(
      operations("reply.get", { conversationId: newer.key, runId: "run", waitMs: 100 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it.each([
    { name: "observation timeout", payload: { status: "timeout" }, expected: "running" },
    {
      name: "queued pending",
      payload: { status: "pending", timeoutPhase: "queue" },
      expected: "running",
    },
    {
      name: "retry-grace timeout",
      payload: { status: "timeout", endedAt: 100, pendingError: true },
      expected: "running",
    },
    {
      name: "terminal timestamp",
      payload: { status: "timeout", endedAt: 100 },
      expected: "failed",
    },
    {
      name: "terminal reason",
      payload: { status: "timeout", stopReason: "restart" },
      expected: "failed",
    },
    {
      name: "terminal liveness",
      payload: { status: "timeout", livenessState: "blocked" },
      expected: "failed",
    },
    {
      name: "hard provider timeout",
      payload: { status: "timeout", timeoutPhase: "provider" },
      expected: "failed",
    },
    {
      name: "provider-started timeout",
      payload: { status: "timeout", providerStarted: true },
      expected: "failed",
    },
    { name: "terminal failure", payload: { status: "error" }, expected: "failed" },
  ])(
    "maps $name without approval inference or exposing host errors",
    async ({ payload, expected }) => {
      const { operations, request } = fixture();
      request.mockResolvedValueOnce({ runId: "run", status: "started" });
      request.mockResolvedValueOnce({ ...payload, error: "sensitive internal failure" });
      const result = await operations("message.send", {
        conversationId: newer.key,
        message: "hello",
        waitMs: 100,
      });
      expect(result).toMatchObject({ status: expected });
      expect(JSON.stringify(result)).not.toContain("sensitive");
      expect(JSON.stringify(result)).not.toContain("waiting_for_approval");
    },
  );

  it("rechecks grant authority after preparation and before submission", async () => {
    const { operations, request } = fixture();
    const assertAuthority = vi.fn().mockRejectedValue(new Error("grant revoked"));
    await expect(
      operations(
        "message.send",
        { conversationId: newer.key, message: "hello", waitMs: 0 },
        assertAuthority,
      ),
    ).rejects.toThrow("grant revoked");
    expect(request).not.toHaveBeenCalled();
  });

  it("withholds the run result if authority is revoked while waiting", async () => {
    const { operations, request } = fixture();
    let authorized = true;
    request
      .mockResolvedValueOnce({ runId: "run", status: "started" })
      .mockImplementationOnce(async () => {
        authorized = false;
        return { status: "ok" };
      });
    const assertAuthority = async () => {
      if (!authorized) {
        throw new Error("grant revoked");
      }
    };
    await expect(
      operations(
        "message.send",
        { conversationId: newer.key, message: "hello", waitMs: 1 },
        assertAuthority,
      ),
    ).rejects.toThrow("grant revoked");
  });

  it("reports a created conversation whose initial message failed without inventing a run", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({
      key: newer.key,
      sessionId: newer.sessionId,
      runStarted: false,
      runError: { message: "private host error" },
    });
    await expect(operations("message.send", { message: "hello", waitMs: 0 })).rejects.toMatchObject(
      {
        code: "unavailable",
        message: expect.stringContaining("was created, but the message did not start"),
      },
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("returns the initial reply of a new conversation", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({
      key: newer.key,
      sessionId: newer.sessionId,
      runId: "created-run",
      runStarted: true,
    });
    request.mockResolvedValueOnce({
      status: "ok",
      terminalReply: { disposition: "visible", text: "created answer" },
    });
    expect(await operations("message.send", { message: "start", waitMs: 100 })).toEqual({
      conversationId: newer.key,
      runId: "created-run",
      status: "completed",
      reply: "created answer",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([20_000, 65_000])(
    "keeps an accepted run when preparation consumes %ims of its request budget",
    async (elapsed) => {
      let now = 0;
      const { operations, request } = fixture(undefined, () => now);
      request
        .mockImplementationOnce(async () => {
          now = elapsed;
          return { runId: "run", status: "started" };
        })
        .mockResolvedValueOnce({ status: "pending" });
      expect(
        await operations("message.send", {
          conversationId: newer.key,
          message: "start",
          waitMs: 50_000,
        }),
      ).toEqual({ conversationId: newer.key, runId: "run", status: "running" });
      if (elapsed < 65_000) {
        expect(request).toHaveBeenNthCalledWith(
          2,
          "agent.wait",
          { runId: "run", timeoutMs: 44_000 },
          { timeoutMs: 45_000 },
        );
      } else {
        expect(request).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each(["CLIENT_TIMEOUT", "AGENT_TIMEOUT", "elapsed"])(
    "preserves accepted run IDs after a %s RPC timeout",
    async (failure) => {
      let now = 0;
      const { operations, request } = fixture(undefined, () => now);
      request
        .mockResolvedValueOnce({ runId: "run", status: "started" })
        .mockImplementationOnce(async () => {
          if (failure === "elapsed") {
            now = 5_100;
            throw new Error("opaque host timeout");
          }
          throw Object.assign(new Error("opaque SDK timeout"), { code: failure });
        });
      expect(
        await operations("message.send", {
          conversationId: newer.key,
          message: "hello",
          waitMs: 100,
        }),
      ).toEqual({ conversationId: newer.key, runId: "run", status: "running" });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves non-timeout SDK failures after run acceptance", async () => {
    const { operations, request } = fixture();
    const failure = Object.assign(new Error("request rejected"), { code: "INVALID_REQUEST" });
    request
      .mockResolvedValueOnce({ runId: "run", status: "started" })
      .mockRejectedValueOnce(failure);
    await expect(
      operations("message.send", { conversationId: newer.key, message: "hello", waitMs: 100 }),
    ).rejects.toBe(failure);
  });

  it.each(["message.send", "conversation.read"])(
    "logs a %s Gateway failure once without request content",
    async (op) => {
      const { operations, request, logger } = fixture();
      const privateText = 'maintain the DISTINCTIVE "private request text"\nfor launch';
      const failure = Object.assign(
        new Error(
          `request rejected: ${privateText}; encoded: ${JSON.stringify(privateText).slice(1, -1)}\ntry again`,
        ),
        {
          code: "INVALID_REQUEST",
          details: {
            transcript: "PRIVATE transcript",
            token: "PRIVATE token",
            pairingCode: "ABCDE-FGHIJ",
          },
        },
      );
      request.mockRejectedValueOnce(failure);
      await expect(
        operations(
          op,
          op === "message.send"
            ? { agentId: "main", message: privateText, waitMs: 0 }
            : { conversationId: newer.key, before: privateText, limit: 1 },
        ),
      ).rejects.toBeDefined();
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        `mcp-relay: op=${op} method=${op === "message.send" ? "sessions.create" : "chat.history"} INVALID_REQUEST: request rejected: [redacted]; encoded: [redacted] try again`,
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /DISTINCTIVE|PRIVATE|ABCDE-FGHIJ/,
      );
    },
  );

  it("logs unexpected non-RPC failures without dumping error details", async () => {
    const { operations, readSessionFacts, logger } = fixture();
    const failure = new Error("session facts unavailable");
    readSessionFacts.mockRejectedValueOnce(failure);
    await expect(
      operations("reply.get", { conversationId: newer.key, runId: "run", waitMs: 0 }),
    ).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "mcp-relay: op=reply.get method=none unknown: session facts unavailable",
    );
  });
});
