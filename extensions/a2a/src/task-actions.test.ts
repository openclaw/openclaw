import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeMessageTool } from "./message-actions.js";
import { clearA2aTaskReadReceipts, handleA2aTaskAction } from "./task-actions.js";
import type { A2aCoreConfig } from "./types.js";

function requestBodyText(body: unknown): string {
  if (typeof body !== "string") {
    throw new Error("expected the request body to be a JSON string");
  }
  return body;
}

type FixtureTask = {
  id: string;
  contextId: string;
  status: { state: string; message?: { parts: { text: string }[] } };
  artifacts: { parts: { text: string }[] }[];
};

function fixture() {
  mockPinnedHostnameResolution();
  const cfg: A2aCoreConfig = {
    channels: {
      a2a: {
        enabled: true,
        peers: {
          alpha: {
            token: "fixture-inbound-alpha",
            outboundToken: "fixture-outbound-alpha",
            url: "https://peer.example.test/a2a/v1",
          },
          beta: {
            token: "fixture-inbound-beta",
            outboundToken: "fixture-outbound-beta",
            url: "https://other.example.test/a2a/v1",
          },
        },
      },
    },
  };
  const context: ChannelMessageActionContext = {
    cfg,
    channel: "a2a",
    action: "send",
    params: { to: "alpha", message: "Synthetic task" },
    agentId: "main",
    sessionKey: "agent:main:telegram:group:fixture",
    sessionId: "incarnation-1",
    accountId: "default",
    conversationReadOrigin: "delegated",
  };
  let current = true;
  const assertCurrent = vi.fn(() => {
    if (!current) {
      throw new Error("fixture authority revoked");
    }
  });
  vi.spyOn(fetchRuntime, "captureChannelReadAuthority").mockReturnValue(assertCurrent);
  const tasks = new Map<string, FixtureTask>();
  const methods: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const rpc = JSON.parse(requestBodyText(init?.body)) as {
      id: string;
      method: string;
      params: { message?: { contextId: string }; id?: string };
    };
    methods.push(rpc.method);
    if (rpc.method === "SendMessage") {
      const task: FixtureTask = {
        id: `task-${tasks.size + 1}`,
        contextId: rpc.params.message!.contextId,
        status: { state: "TASK_STATE_WORKING" },
        artifacts: [],
      };
      tasks.set(task.id, task);
      return reply(rpc.id, { task });
    }
    return reply(rpc.id, tasks.get(rpc.params.id!));
  });
  const read = (messageId = "task-1", overrides: Partial<ChannelMessageActionContext> = {}) =>
    handleA2aTaskAction({
      ...context,
      ...overrides,
      action: "read",
      params: { to: "alpha", messageId, ...overrides.params },
    });
  return {
    cfg,
    context,
    tasks,
    methods,
    fetchMock,
    assertCurrent,
    read,
    revoke: () => {
      current = false;
    },
  };
}

function reply(id: string, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  clearA2aTaskReadReceipts();
  vi.restoreAllMocks();
});

describe("A2A source-bound task reads", () => {
  it("discovers send/read only with an enabled outbound peer", () => {
    const f = fixture();
    expect(describeMessageTool({ cfg: f.cfg }).actions).toEqual(["send", "read"]);
    expect(describeMessageTool({ cfg: f.cfg, accountId: "other" }).actions).toEqual([]);
    expect(describeMessageTool({ cfg: { channels: { a2a: { enabled: false } } } }).actions).toEqual(
      [],
    );
    expect(
      describeMessageTool({
        cfg: { channels: { a2a: { peers: { alpha: { token: "fixture" } } } } },
      }).actions,
    ).toEqual([]);
  });

  it("does not send or mint a read receipt for a dry run", async () => {
    const f = fixture();
    expect((await handleA2aTaskAction({ ...f.context, dryRun: true })).details).toMatchObject({
      dryRun: true,
      readAvailable: false,
    });
    await expect(f.read()).rejects.toThrow("SendMessage receipt");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["missing", "mismatched"] as const)(
    "preserves an accepted send without granting reads from a %s RPC correlation",
    async (kind) => {
      const f = fixture();
      f.fetchMock.mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              ...(kind === "mismatched" ? { id: "another-request" } : {}),
              result: { task: { id: "uncorrelated-task", contextId: "uncorrelated-context" } },
            }),
          ),
      );
      expect((await handleA2aTaskAction(f.context)).details).toMatchObject({
        messageId: "uncorrelated-task",
        readAvailable: false,
      });
      f.fetchMock.mockClear();
      await expect(f.read("uncorrelated-task")).rejects.toThrow("SendMessage receipt");
      expect(f.fetchMock).not.toHaveBeenCalled();
    },
  );

  it("reads a long task repeatedly without starting work or treating timeout as cancellation", async () => {
    const f = fixture();
    expect((await handleA2aTaskAction(f.context)).details).toMatchObject({
      messageId: "task-1",
      readAvailable: true,
    });
    for (let index = 0; index < 7; index += 1) {
      expect((await f.read()).details).toMatchObject({
        taskId: "task-1",
        state: "working",
        terminal: false,
      });
    }
    f.fetchMock.mockRejectedValueOnce(new DOMException("synthetic read timeout", "TimeoutError"));
    await expect(f.read()).rejects.toThrow("synthetic read timeout");
    const task = f.tasks.get("task-1")!;
    task.status.state = "TASK_STATE_COMPLETED";
    task.artifacts = [{ parts: [{ text: "Synthetic late answer" }] }];
    expect((await f.read()).details).toMatchObject({
      taskId: task.id,
      contextId: task.contextId,
      terminal: true,
      state: "completed",
      text: "Synthetic late answer",
    });
    expect(f.methods).toEqual(["SendMessage", ...Array<string>(8).fill("GetTask")]);
  });

  it("isolates parallel task results within the existing peer conversation", async () => {
    const f = fixture();
    await Promise.all([handleA2aTaskAction(f.context), handleA2aTaskAction(f.context)]);
    expect(f.tasks.get("task-1")!.contextId).toBe(f.tasks.get("task-2")!.contextId);
    for (const task of f.tasks.values()) {
      task.status.state = "completed";
      task.artifacts = [{ parts: [{ text: task.id }] }];
    }
    const [second, first] = await Promise.all([f.read("task-2"), f.read("task-1")]);
    expect(second.details).toMatchObject({ taskId: "task-2", text: "task-2" });
    expect(first.details).toMatchObject({ taskId: "task-1", text: "task-1" });
  });

  it.each([
    { sessionKey: "agent:main:telegram:group:other" },
    { sessionId: "reset-incarnation" },
    { agentId: "tech-docs" },
    { params: { to: "beta" } },
    { accountId: "other" },
  ])("denies a task ID outside the originating runtime scope: %j", async (overrides) => {
    const f = fixture();
    await handleA2aTaskAction(f.context);
    f.fetchMock.mockClear();
    await expect(f.read("task-1", overrides)).rejects.toThrow();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept caller-authored identity or a task ID as read authority", async () => {
    const f = fixture();
    await handleA2aTaskAction(f.context);
    f.fetchMock.mockClear();
    await expect(
      f.read("task-1", {
        sessionId: "different",
        params: {
          sessionId: f.context.sessionId,
          sessionKey: f.context.sessionKey,
          agentId: f.context.agentId,
          conversationReadOrigin: "direct-operator",
        },
      }),
    ).rejects.toThrow("exact agent/session");
    vi.mocked(fetchRuntime.captureChannelReadAuthority).mockReturnValue(undefined);
    await expect(f.read()).rejects.toThrow("exact agent/session");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("invalidates receipts after restart/expiry or endpoint and credential changes", async () => {
    const f = fixture();
    await handleA2aTaskAction(f.context);
    f.fetchMock.mockClear();
    const peer = f.cfg.channels!.a2a!.peers!.alpha!;
    const token = peer.outboundToken;
    peer.outboundToken = "rotated-fixture";
    await expect(f.read()).rejects.toThrow("exact agent/session");
    peer.outboundToken = token;
    const endpoint = peer.url;
    peer.url = "https://changed.example.test/a2a/v1";
    await expect(f.read()).rejects.toThrow("exact agent/session");
    peer.url = endpoint;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 24 * 60 * 60 * 1000);
    await expect(f.read()).rejects.toThrow("exact agent/session");
    clearA2aTaskReadReceipts();
    await expect(f.read()).rejects.toThrow("do not resend");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("retries only the legacy GetTask method with the same request binding", async () => {
    const f = fixture();
    await handleA2aTaskAction(f.context);
    f.fetchMock.mockClear().mockImplementationOnce(async (_url, init) => {
      const rpc = JSON.parse(requestBodyText(init?.body)) as { id: string; method: string };
      expect(rpc.method).toBe("GetTask");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: "Method not found" },
        }),
      );
    });
    await f.read();
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    const requests = f.fetchMock.mock.calls.map(
      ([, init]) =>
        JSON.parse(requestBodyText(init?.body)) as { method: string; params: unknown; id: string },
    );
    expect(requests.map((request) => request.method)).toEqual(["GetTask", "tasks/get"]);
    expect(requests[0]!.id).toBe(requests[1]!.id);
    expect(requests[0]!.params).toEqual({ id: "task-1" });
  });

  it.each(["rpc-id", "task-id", "context-id", "invalid-state"])(
    "rejects mismatched %s without exposing task content",
    async (kind) => {
      const f = fixture();
      await handleA2aTaskAction(f.context);
      f.fetchMock.mockImplementationOnce(async (_url, init) => {
        const rpc = JSON.parse(requestBodyText(init?.body)) as { id: string };
        const task = structuredClone(f.tasks.get("task-1")!);
        if (kind === "task-id") {
          task.id = "other-task";
        }
        if (kind === "context-id") {
          task.contextId = "other-context";
        }
        if (kind === "invalid-state") {
          // A malformed state (not a string) is still rejected; a conforming but
          // unenumerated state is normalized instead, covered separately.
          (task.status as { state?: unknown }).state = 42;
        }
        return reply(kind === "rpc-id" ? "other-request" : rpc.id, task);
      });
      await expect(f.read()).rejects.toThrow(/uncorrelated|mismatched/);
    },
  );

  it("returns bounded text/status, not arbitrary task history or metadata", async () => {
    const f = fixture();
    await handleA2aTaskAction(f.context);
    f.tasks.get("task-1")!.artifacts = [{ parts: [{ text: "😀".repeat(25_000) }] }];
    f.tasks.get("task-1")!.status = {
      state: "TASK_STATE_INPUT_REQUIRED",
      message: { parts: [{ text: "Synthetic clarification?" }] },
    };
    const result = await f.read();
    expect(result.details).toMatchObject({
      state: "input_required",
      inputRequired: true,
      terminal: false,
      statusText: "Synthetic clarification?",
    });
    const data = result.details as { text: string };
    expect(Buffer.byteLength(data.text)).toBeLessThanOrEqual(64 * 1024);
    expect(data.text).toContain("[message truncated");
    f.tasks.get("task-1")!.artifacts = [{ parts: [{ text: "x".repeat(1024 * 1024) }] }];
    await expect(f.read()).rejects.toThrow("exceeds 1048576 bytes");
  });

  it("rechecks live authority before compatibility retry and before publishing a response", async () => {
    const f = fixture();
    await handleA2aTaskAction(f.context);
    f.fetchMock.mockClear().mockImplementationOnce(async (_url, init) => {
      const rpc = JSON.parse(requestBodyText(init?.body)) as { id: string };
      f.revoke();
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: "Method not found" },
        }),
      );
    });
    await expect(f.read()).rejects.toThrow("authority revoked");
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it("does not publish a result after an awaited request loses its authority", async () => {
    const f = fixture();
    await handleA2aTaskAction(f.context);
    const started = createDeferred();
    const response = createDeferred<Response>();
    f.fetchMock.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return await response.promise;
    });
    const read = f.read();
    await started.promise;
    f.revoke();
    const rpc = JSON.parse(requestBodyText(f.fetchMock.mock.calls.at(-1)![1]?.body)) as {
      id: string;
    };
    response.resolve(reply(rpc.id, f.tasks.get("task-1")));
    await expect(read).rejects.toThrow("authority revoked");
  });

  it("preserves an accepted send without reviving a receipt after channel shutdown", async () => {
    const f = fixture();
    const started = createDeferred();
    const release = createDeferred();
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementationOnce(async (...args) => {
      started.resolve(undefined);
      await release.promise;
      return await original(...args);
    });
    const send = handleA2aTaskAction(f.context);
    await started.promise;
    clearA2aTaskReadReceipts();
    release.resolve(undefined);
    expect((await send).details).toMatchObject({ messageId: "task-1", readAvailable: false });
    await expect(f.read()).rejects.toThrow("do not resend");
    expect(f.methods).toEqual(["SendMessage"]);
  });

  it("revokes an earlier receipt when the peer reassigns the task ID to another source", async () => {
    const f = fixture();
    expect((await handleA2aTaskAction(f.context)).details).toMatchObject({
      messageId: "task-1",
      readAvailable: true,
    });
    // The peer restarts and returns the same task ID for a different originating
    // session; every send to a peer shares one remote context, so the stale receipt
    // must not survive the reassignment.
    f.tasks.clear();
    const other = {
      agentId: "yougile",
      sessionKey: "agent:yougile:webchat:fixture",
      sessionId: "incarnation-2",
    };
    expect((await handleA2aTaskAction({ ...f.context, ...other })).details).toMatchObject({
      messageId: "task-1",
      readAvailable: false,
    });
    f.fetchMock.mockClear();
    await expect(f.read()).rejects.toThrow("SendMessage receipt");
    await expect(
      handleA2aTaskAction({
        ...f.context,
        ...other,
        action: "read",
        params: { to: "alpha", messageId: "task-1" },
      }),
    ).rejects.toThrow("SendMessage receipt");
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.methods).toEqual(["SendMessage", "SendMessage"]);
  });

  it("lets an expired receipt be replaced instead of blocking the next send", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      expect((await handleA2aTaskAction(f.context)).details).toMatchObject({ readAvailable: true });
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
      f.tasks.clear();
      const other = {
        agentId: "yougile",
        sessionKey: "agent:yougile:webchat:fixture",
        sessionId: "incarnation-3",
      };
      expect((await handleA2aTaskAction({ ...f.context, ...other })).details).toMatchObject({
        messageId: "task-1",
        readAvailable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores no receipt when the peer reports an unbounded context id", async () => {
    const f = fixture();
    f.fetchMock.mockImplementationOnce(async (_url, init) => {
      const rpc = JSON.parse(requestBodyText(init?.body)) as { id: string };
      return reply(rpc.id, {
        task: {
          id: "task-big",
          contextId: "c".repeat(4096),
          status: { state: "TASK_STATE_WORKING" },
          artifacts: [],
        },
      });
    });
    expect((await handleA2aTaskAction(f.context)).details).toMatchObject({
      messageId: "task-big",
      readAvailable: false,
    });
    await expect(f.read("task-big")).rejects.toThrow("SendMessage receipt");
  });

  it("revokes an earlier receipt when a receipt-less send reports the same task ID", async () => {
    const f = fixture();
    expect((await handleA2aTaskAction(f.context)).details).toMatchObject({
      messageId: "task-1",
      readAvailable: true,
    });
    // The peer restarts and reports the same task ID for a send that carries no session
    // identity at all (a CLI send or the direct channel-adapter surface), so no
    // replacement receipt can be minted. Every send to a peer shares one remote context,
    // so the stale receipt must not survive; the read must fail before provider I/O.
    f.tasks.clear();
    const receiptless = { ...f.context } as ChannelMessageActionContext & {
      agentId?: undefined;
      sessionKey?: undefined;
      sessionId?: undefined;
    };
    delete receiptless.agentId;
    delete receiptless.sessionKey;
    delete receiptless.sessionId;
    expect((await handleA2aTaskAction(receiptless)).details).toMatchObject({
      messageId: "task-1",
      readAvailable: false,
    });
    f.fetchMock.mockClear();
    await expect(f.read()).rejects.toThrow("SendMessage receipt");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("revokes an earlier receipt when the replacement send cannot store its peer context", async () => {
    const f = fixture();
    await handleA2aTaskAction(f.context);
    f.tasks.clear();
    f.fetchMock.mockImplementationOnce(async (_url, init) => {
      const rpc = JSON.parse(requestBodyText(init?.body)) as { id: string };
      return reply(rpc.id, { task: { id: "task-1", contextId: "c".repeat(4096) } });
    });
    const other = {
      agentId: "yougile",
      sessionKey: "agent:yougile:webchat:fixture",
      sessionId: "incarnation-4",
    };
    expect((await handleA2aTaskAction({ ...f.context, ...other })).details).toMatchObject({
      messageId: "task-1",
      readAvailable: false,
    });
    f.fetchMock.mockClear();
    await expect(f.read()).rejects.toThrow("SendMessage receipt");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes a conforming unknown state as nonterminal instead of rejecting the task", async () => {
    const f = fixture();
    await handleA2aTaskAction(f.context);
    f.fetchMock.mockImplementationOnce(async (_url, init) => {
      const rpc = JSON.parse(requestBodyText(init?.body)) as { id: string };
      return reply(rpc.id, {
        id: "task-1",
        contextId: "ctx-oc-alpha",
        status: { state: "TASK_STATE_UNSPECIFIED" },
        artifacts: [],
      });
    });
    expect((await f.read()).details).toMatchObject({
      taskId: "task-1",
      state: "unspecified",
      terminal: false,
    });
  });
});
