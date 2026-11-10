import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayRequest } from "./gateway-request.js";
import { createOperations } from "./operations.js";
import { createStateFixture, grantFixture } from "./relay.test-helpers.js";

// Materialize the production error classifier before assertion timers start.
await import("openclaw/plugin-sdk/gateway-runtime");

const newer = {
  key: "agent:main:new",
  sessionId: "new-session",
  agentId: "main",
  derivedTitle: "New conversation",
  lastMessagePreview: "Latest preview",
  lastActivityAt: 1_000,
};
const deadline = { signal: expect.any(AbortSignal) };
const accepted = (runId: string) => ({
  key: newer.key,
  sessionId: newer.sessionId,
  runId,
  runStarted: true,
});
const completed = (reply: string) => ({
  status: "ok",
  terminalReply: { disposition: "visible", text: reply },
});
const runResult = (runId: string, status: string, extra = {}) => ({
  conversationId: newer.key,
  runId,
  status,
  ...extra,
});

async function fixture(agentId?: string) {
  const request = vi.fn<GatewayRequest>();
  const describeSession = vi.fn<GatewayRequest>().mockResolvedValue({ session: newer });
  const listSessions = vi.fn<GatewayRequest>().mockResolvedValue({ sessions: [newer] });
  const agents = vi.fn<GatewayRequest>().mockResolvedValue({
    defaultId: "main",
    agents: [
      { id: "main", name: "Main agent" },
      { id: "research", name: "Research" },
    ],
  });
  // These are RPC response fixtures, not implementations of Gateway authorization.
  const boundRequest = vi.fn<GatewayRequest>(async (method, params, options) => {
    const handler =
      method === "sessions.describe"
        ? describeSession
        : method === "sessions.list"
          ? listSessions
          : method === "agents.list"
            ? agents
            : request;
    return handler(method, params, options);
  });
  const logger = { error: vi.fn() };
  const dispatch = createOperations({
    logger,
    agentId,
    gateway: { name: "Synthetic Gateway", version: "1.0.0" },
  });
  const state = createStateFixture().open();
  await state.initialize();
  await state.approveGrant(grantFixture(), () => {});
  const operations = (op: string, params: unknown) =>
    dispatch(op, params, () => state.assertGrantCurrent("gr_one"), boundRequest);
  return {
    state,
    operations,
    request,
    describeSession,
    listSessions,
    logger,
    read: (params = {}) =>
      operations("conversation.read", { conversationId: newer.key, limit: 1, ...params }),
    send: (params = {}) => operations("message.send", { message: "hello", waitMs: 0, ...params }),
    reply: (params = {}) =>
      operations("reply.get", { conversationId: newer.key, runId: "run", waitMs: 0, ...params }),
  };
}

function message(id: string, role: string, text: string) {
  return { role, content: [{ type: "text", text }], timestamp: 1_000, __openclaw: { id } };
}

function useDeadlineClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // Native AbortSignal.timeout does not use Vitest's clock.
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  onTestFinished(() => {
    timeout.mockRestore();
    vi.useRealTimers();
  });
}

describe("MCP relay data operations", () => {
  it("maps the RPC roster and session results to the wire", async () => {
    const { operations, listSessions } = await fixture();
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
    await operations("conversations.list", { limit: 50, search: "OLDER", agentId: "main" });
    expect(listSessions).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main", search: "OLDER", limit: 50 }),
      deadline,
    );
  });

  it("anchors the first history page and preserves opaque older cursors with plain user/assistant text", async () => {
    const { read, request } = await fixture();
    request.mockResolvedValueOnce({ messages: [message("latest", "assistant", "answer")] });
    request.mockResolvedValueOnce({
      messages: [
        message("user", "user", "question"),
        message("tool", "toolResult", "secret tool output"),
        message("latest", "assistant", "answer"),
      ],
      olderCursor: "host-page-cursor",
    });
    expect(await read({ limit: 3 })).toEqual({
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
      deadline,
    );
    request.mockResolvedValueOnce({ messages: [message("prior", "user", "earlier")] });
    await read({ limit: 3, before: "host-page-cursor" });
    expect(request).toHaveBeenLastCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "host-page-cursor", limit: 3 }),
      deadline,
    );
  });

  it.each(["missing", "FORBIDDEN", "INVALID_REQUEST"])(
    "reports a %s session lookup without disclosing whether it exists",
    async (response) => {
      const missing = await fixture();
      if (response === "missing") {
        missing.describeSession.mockResolvedValue({ session: null });
      } else {
        missing.describeSession.mockRejectedValue(
          Object.assign(new Error("Hidden session"), {
            name: "GatewayClientRequestError",
            code: response,
            gatewayCode: response,
            retryable: false,
          }),
        );
      }
      await expect(missing.read({ conversationId: "unknown" })).rejects.toMatchObject({
        code: "not_found",
        message: "Conversation not found. List conversations and select an existing conversation.",
      });
      expect(missing.request).not.toHaveBeenCalled();
    },
  );

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
    const { operations, request, describeSession, listSessions } = await fixture();
    await expect(operations(op, params)).rejects.toMatchObject({ code: "invalid_params" });
    expect(request).not.toHaveBeenCalled();
    expect(describeSession).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("submits a new conversation with agent precedence and returns its accepted run without waiting", async () => {
    const { send, request } = await fixture("research");
    request.mockResolvedValueOnce(accepted("created-run"));
    expect(await send({ message: "new question", agentId: "main" })).toEqual(
      runResult("created-run", "running"),
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.create",
      { agentId: "main", message: "new question" },
      deadline,
    );

    const configured = await fixture("research");
    configured.request.mockResolvedValueOnce(accepted("configured-run"));
    await configured.send({ message: "configured" });
    expect(configured.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ agentId: "research" }),
      expect.any(Object),
    );
  });

  it("continues an existing conversation and reads its exact completed reply", async () => {
    const { send, request } = await fixture();
    request.mockResolvedValueOnce({ runId: "accepted-run", status: "started" });
    request.mockResolvedValueOnce(completed("snapshot text"));
    expect(await send({ message: "continue", conversationId: newer.key, waitMs: 50_000 })).toEqual(
      runResult("accepted-run", "completed", { reply: "snapshot text" }),
    );
    expect(request.mock.calls).toEqual([
      [
        "chat.send",
        {
          sessionKey: newer.key,
          sessionId: newer.sessionId,
          agentId: "main",
          message: "continue",
          idempotencyKey: expect.any(String),
        },
        deadline,
      ],
      ["agent.wait", { runId: "accepted-run", timeoutMs: 50_000 }, undefined],
    ]);
  });

  it.each([
    [
      "truncated",
      { disposition: "visible", text: "x".repeat(20_000) },
      { reply: `${"x".repeat(15_999)}…` },
    ],
    ["silent", { disposition: "silent" }, {}],
    [
      "expired",
      undefined,
      { error: "The reply is no longer available from the run. Use read_conversation to see it." },
    ],
  ] as const)(
    "returns the run owner's %s reply without transcript reads",
    async (_name, terminalReply, content) => {
      const { reply, request } = await fixture();
      request.mockResolvedValueOnce({ status: "ok", terminalReply });
      expect(await reply()).toEqual(runResult("run", "completed", content));
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "agent.wait",
        { runId: "run", timeoutMs: 0 },
        undefined,
      );
    },
  );

  it.each(["message.send", "reply.get"])("refuses a missing conversation for %s", async (op) => {
    const { operations, request, describeSession } = await fixture();
    describeSession.mockResolvedValue({ session: null });
    await expect(
      operations(op, {
        conversationId: "missing",
        ...(op === "message.send" ? { message: "hello" } : { runId: "run" }),
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["observation timeout", { status: "timeout" }, "running"],
    ["queued pending", { status: "pending", timeoutPhase: "queue" }, "running"],
    ["retry grace", { status: "timeout", endedAt: 100, pendingError: true }, "running"],
    ["terminal timestamp", { status: "timeout", endedAt: 100 }, "failed"],
    ["terminal reason", { status: "timeout", stopReason: "restart" }, "failed"],
    ["terminal liveness", { status: "timeout", livenessState: "blocked" }, "failed"],
    ["provider timeout", { status: "timeout", timeoutPhase: "provider" }, "failed"],
    ["provider started", { status: "timeout", providerStarted: true }, "failed"],
    ["terminal failure", { status: "error" }, "failed"],
  ] as const)("maps %s without exposing host errors", async (_name, payload, expected) => {
    const { reply, request } = await fixture();
    request.mockResolvedValueOnce({ ...payload, error: "sensitive internal failure" });
    const result = await reply({ waitMs: 100 });
    expect(result).toMatchObject({ status: expected });
    expect(JSON.stringify(result)).not.toMatch(/sensitive|waiting_for_approval/);
  });

  it("rechecks grant authority after session preparation and before submission", async () => {
    const { send, request, describeSession, state } = await fixture();
    describeSession.mockImplementationOnce(async () => {
      await state.revoke("gr_one");
      return { session: newer };
    });
    await expect(send({ conversationId: newer.key })).rejects.toMatchObject({
      code: "grant_revoked",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a created conversation whose initial message failed without inventing a run", async () => {
    const { send, request } = await fixture();
    request.mockResolvedValueOnce({
      key: newer.key,
      sessionId: newer.sessionId,
      runStarted: false,
      runError: { message: "private host error" },
    });
    await expect(send()).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("was created, but the message did not start"),
    });
  });
  it.each(["CLIENT_TIMEOUT", "AGENT_TIMEOUT", "INVALID_REQUEST"])(
    "preserves an accepted run after SDK %s",
    async (code) => {
      const { send, request } = await fixture();
      request
        .mockResolvedValueOnce({ runId: "run", status: "started" })
        .mockRejectedValueOnce(Object.assign(new Error("request rejected"), { code }));
      const result = send({ conversationId: newer.key, waitMs: 100 });
      if (code === "INVALID_REQUEST") {
        await expect(result).rejects.toMatchObject({ code });
      } else {
        await expect(result).resolves.toEqual(runResult("run", "running"));
      }
    },
  );

  it.each([false, true])(
    "keeps an accepted run alive beyond the submission deadline (existing conversation: %s)",
    async (existing) => {
      const { send, reply, request } = await fixture();
      useDeadlineClock();
      let submissionSignal: AbortSignal | undefined;
      request.mockImplementationOnce(async (_method, _params, options) => {
        submissionSignal = options?.signal;
        return { key: newer.key, runId: "slow-run", status: "started" };
      });
      expect(
        await send({
          ...(existing ? { conversationId: newer.key } : {}),
          message: "A slow question",
        }),
      ).toEqual(runResult("slow-run", "running"));
      expect(submissionSignal).toBeDefined();
      await vi.advanceTimersByTimeAsync(16_000);
      // The SDK retains this signal as the accepted run's upstream authority.
      expect(submissionSignal?.aborted).toBe(false);
      request.mockResolvedValueOnce(completed("Finished the slow question"));
      expect(await reply({ runId: "slow-run" })).toMatchObject({
        status: "completed",
        reply: "Finished the slow question",
      });
    },
  );

  it("still times out a submission that never returns acceptance", async () => {
    const { send, request } = await fixture();
    useDeadlineClock();
    request.mockImplementationOnce(
      async (_method, _params, options) =>
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("Submission aborted", { cause: options.signal?.reason })),
            { once: true },
          );
        }),
    );
    const result = expect(send({ message: "A stalled submission" })).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
  });

  it.each(["message.send", "conversation.read"])(
    "logs a %s Gateway failure once without request content",
    async (op) => {
      const { operations, request, logger } = await fixture();
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
        `mcp-relay: op=${op} method=${op === "message.send" ? "sessions.create" : "chat.history"} failed`,
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /DISTINCTIVE|PRIVATE|ABCDE-FGHIJ/,
      );
    },
  );
});
