import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexServerNotification, RpcRequest } from "./protocol.js";

const readCodexAppServerBindingMock = vi.fn();
const isCodexAppServerNativeAuthProfileMock = vi.fn();
const getSharedCodexAppServerClientMock = vi.fn();
const refreshCodexAppServerAuthTokensMock = vi.fn();

vi.mock("./session-binding.js", () => ({
  clearCodexAppServerBinding: vi.fn(),
  isCodexAppServerNativeAuthProfile: (...args: unknown[]) =>
    isCodexAppServerNativeAuthProfileMock(...args),
  readCodexAppServerBinding: (...args: unknown[]) => readCodexAppServerBindingMock(...args),
  writeCodexAppServerBinding: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  getSharedCodexAppServerClient: (...args: unknown[]) => getSharedCodexAppServerClientMock(...args),
}));

vi.mock("./auth-bridge.js", () => ({
  refreshCodexAppServerAuthTokens: (...args: unknown[]) =>
    refreshCodexAppServerAuthTokensMock(...args),
}));

const { runCodexAppServerSideQuestion } = await import("./side-question.js");

type ServerRequest = Required<Pick<RpcRequest, "id" | "method">> & {
  params?: RpcRequest["params"];
};

type FakeClient = {
  request: ReturnType<typeof vi.fn>;
  addNotificationHandler: ReturnType<typeof vi.fn>;
  addRequestHandler: ReturnType<typeof vi.fn>;
  notifications: Array<(notification: CodexServerNotification) => void>;
  requests: Array<(request: ServerRequest) => unknown>;
  emit: (notification: CodexServerNotification) => void;
};

function createFakeClient(): FakeClient {
  const notifications: FakeClient["notifications"] = [];
  const requests: FakeClient["requests"] = [];
  const client: FakeClient = {
    notifications,
    requests,
    request: vi.fn(),
    addNotificationHandler: vi.fn((handler: (notification: CodexServerNotification) => void) => {
      notifications.push(handler);
      return () => {
        const index = notifications.indexOf(handler);
        if (index >= 0) {
          notifications.splice(index, 1);
        }
      };
    }),
    addRequestHandler: vi.fn((handler: FakeClient["requests"][number]) => {
      requests.push(handler);
      return () => {
        const index = requests.indexOf(handler);
        if (index >= 0) {
          requests.splice(index, 1);
        }
      };
    }),
    emit: (notification) => {
      for (const handler of notifications) {
        handler(notification);
      }
    },
  };
  client.request.mockImplementation(async (method: string) => {
    if (method === "thread/fork") {
      return threadResult("side-thread");
    }
    if (method === "thread/inject_items") {
      return {};
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
        client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
      });
      return turnStartResult("turn-1");
    }
    if (method === "thread/unsubscribe" || method === "turn/interrupt") {
      return {};
    }
    throw new Error(`unexpected request: ${method}`);
  });
  return client;
}

function threadResult(threadId: string) {
  return {
    thread: {
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp/workspace",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.5",
    modelProvider: "openai",
    cwd: "/tmp/workspace",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
  };
}

function turnStartResult(turnId: string) {
  return {
    turn: {
      id: turnId,
      threadId: "side-thread",
      status: "inProgress",
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function agentDelta(threadId: string, turnId: string, delta: string): CodexServerNotification {
  return {
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "agent-1", delta },
  };
}

function turnCompleted(threadId: string, turnId: string, text: string): CodexServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        threadId,
        status: "completed",
        items: [{ id: "agent-1", type: "agentMessage", text }],
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  };
}

function sideParams(overrides: Partial<Parameters<typeof runCodexAppServerSideQuestion>[0]> = {}) {
  return {
    cfg: {} as never,
    agentDir: "/tmp/agent",
    provider: "openai",
    model: "gpt-5.5",
    question: "What changed?",
    sessionEntry: {
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      updatedAt: 1,
    },
    resolvedReasoningLevel: "off",
    opts: {},
    isNewSession: false,
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    authProfileId: "openai-codex:work",
    authProfileIdSource: "user",
    ...overrides,
  } satisfies Parameters<typeof runCodexAppServerSideQuestion>[0];
}

describe("runCodexAppServerSideQuestion", () => {
  beforeEach(() => {
    readCodexAppServerBindingMock.mockReset();
    isCodexAppServerNativeAuthProfileMock.mockReset();
    getSharedCodexAppServerClientMock.mockReset();
    refreshCodexAppServerAuthTokensMock.mockReset();

    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai-codex:work",
      model: "gpt-5.5",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    isCodexAppServerNativeAuthProfileMock.mockReturnValue(true);
    getSharedCodexAppServerClientMock.mockResolvedValue(createFakeClient());
    refreshCodexAppServerAuthTokensMock.mockResolvedValue({
      accessToken: "access-token",
      chatgptAccountId: "account-1",
      chatgptPlanType: "plus",
    });
  });

  it("forks an ephemeral side thread and returns the completed assistant text", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const result = await runCodexAppServerSideQuestion(sideParams());

    expect(result).toEqual({ text: "Side answer." });
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "thread/fork",
      expect.objectContaining({
        threadId: "parent-thread",
        model: "gpt-5.5",
        approvalPolicy: "never",
        sandbox: "read-only",
        dynamicTools: [],
        ephemeral: true,
        threadSource: "user",
        persistExtendedHistory: false,
      }),
      expect.any(Object),
    );
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("modelProvider");
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "thread/inject_items",
      expect.objectContaining({
        threadId: "side-thread",
        items: [expect.objectContaining({ type: "message", role: "user" })],
      }),
      expect.any(Object),
    );
    expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "side-thread",
        input: [{ type: "text", text: "What changed?", text_elements: [] }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: "gpt-5.5",
      }),
      expect.any(Object),
    );
    expect(client.request).toHaveBeenLastCalledWith(
      "thread/unsubscribe",
      { threadId: "side-thread" },
      expect.any(Object),
    );
    expect(client.request).not.toHaveBeenCalledWith(
      "turn/interrupt",
      expect.anything(),
      expect.anything(),
    );
  });

  it("uses the app-server auth refresh request handler while the side thread is active", async () => {
    const client = createFakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        await client.requests[0]?.({
          id: 1,
          method: "account/chatgptAuthTokens/refresh",
        });
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => client.emit(turnCompleted("side-thread", "turn-1", "Done.")));
        return turnStartResult("turn-1");
      }
      return {};
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await runCodexAppServerSideQuestion(sideParams());

    expect(refreshCodexAppServerAuthTokensMock).toHaveBeenCalledWith({
      agentDir: "/tmp/agent",
      authProfileId: "openai-codex:work",
      config: {},
    });
  });

  it("returns a clear setup error when there is no Codex parent thread", async () => {
    readCodexAppServerBindingMock.mockResolvedValue(undefined);

    await expect(runCodexAppServerSideQuestion(sideParams())).rejects.toThrow(
      "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
    );
    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it("returns the same setup error when the persisted parent binding is stale", async () => {
    const client = createFakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        throw new Error("thread/fork failed: no rollout found for thread id parent-thread");
      }
      return {};
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(runCodexAppServerSideQuestion(sideParams())).rejects.toThrow(
      "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
    );
  });

  it("interrupts and unsubscribes the ephemeral thread on abort", async () => {
    const controller = new AbortController();
    const client = createFakeClient();
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => controller.abort());
        return turnStartResult("turn-1");
      }
      if (method === "turn/interrupt" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          opts: { abortSignal: controller.signal },
        }),
      ),
    ).rejects.toThrow("Codex /btw was aborted.");
    expect(client.request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "side-thread", turnId: "turn-1" },
      expect.any(Object),
    );
    expect(client.request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "side-thread" },
      expect.any(Object),
    );
  });
});
