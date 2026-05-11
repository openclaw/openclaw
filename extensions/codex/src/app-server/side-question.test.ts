import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexServerNotification, RpcRequest } from "./protocol.js";

const readCodexAppServerBindingMock = vi.fn();
const isCodexAppServerNativeAuthProfileMock = vi.fn();
const getSharedCodexAppServerClientMock = vi.fn();
const refreshCodexAppServerAuthTokensMock = vi.fn();
const createOpenClawCodingToolsMock = vi.fn();
const toolExecuteMock = vi.fn();

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

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  createOpenClawCodingTools: (...args: unknown[]) => createOpenClawCodingToolsMock(...args),
}));

const { __testing, runCodexAppServerSideQuestion } = await import("./side-question.js");

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
  handleRequest: (request: ServerRequest) => Promise<unknown>;
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
    handleRequest: async (request) => {
      for (const handler of requests) {
        const result = await handler(request);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
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
    approvalPolicy: "on-request",
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
    createOpenClawCodingToolsMock.mockReset();
    toolExecuteMock.mockReset();

    toolExecuteMock.mockResolvedValue({
      content: [{ type: "text", text: "tool output" }],
    });
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "wiki_status",
        description: "Check wiki status",
        parameters: { type: "object", properties: {} },
        execute: toolExecuteMock,
      },
    ]);

    readCodexAppServerBindingMock.mockResolvedValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai-codex:work",
      model: "gpt-5.5",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
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
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        ephemeral: true,
        threadSource: "user",
      }),
      expect.any(Object),
    );
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("dynamicTools");
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
    const injectedItem = (
      client.request.mock.calls.find(([method]) => method === "thread/inject_items")?.[1] as {
        items?: Array<{ content?: Array<{ text?: string }> }>;
      }
    )?.items?.[0];
    const injectedText = injectedItem?.content?.[0]?.text;
    expect(injectedText).toContain(
      "External tools may be available according to this thread's current permissions",
    );
    expect(injectedText).toContain(
      "unless the user explicitly asks for that mutation after this boundary",
    );
    expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "side-thread",
        input: [{ type: "text", text: "What changed?", text_elements: [] }],
        model: "gpt-5.5",
      }),
      expect.any(Object),
    );
    const turnStartParams = client.request.mock.calls.find(
      ([method]) => method === "turn/start",
    )?.[1] as Record<string, unknown> | undefined;
    expect(turnStartParams).not.toHaveProperty("approvalPolicy");
    expect(turnStartParams).not.toHaveProperty("sandboxPolicy");
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
    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        sessionId: "session-1",
        modelProvider: "openai",
        modelId: "gpt-5.5",
        requireExplicitMessageTarget: true,
      }),
    );
  });

  it("bridges side-thread dynamic tool requests to OpenClaw tools", async () => {
    const client = createFakeClient();
    let toolResponse: unknown;
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(async () => {
          toolResponse = await client.handleRequest({
            id: 42,
            method: "item/tool/call",
            params: {
              threadId: "side-thread",
              turnId: "turn-1",
              callId: "tool-1",
              tool: "wiki_status",
              arguments: { topic: "AGENTS.md" },
            },
          });
          client.emit(agentDelta("side-thread", "turn-1", "Tool answer."));
          client.emit(turnCompleted("side-thread", "turn-1", "Tool answer."));
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const result = await runCodexAppServerSideQuestion(sideParams());

    expect(result).toEqual({ text: "Tool answer." });
    expect(toolExecuteMock).toHaveBeenCalledWith(
      "tool-1",
      { topic: "AGENTS.md" },
      expect.any(AbortSignal),
      undefined,
    );
    expect(toolResponse).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "tool output" }],
    });
  });

  it("returns an empty response for side-thread user input requests", async () => {
    const client = createFakeClient();
    let unrelatedUserInputResponse: unknown;
    let userInputResponse: unknown;
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        setTimeout(async () => {
          unrelatedUserInputResponse = await client.handleRequest({
            id: 42,
            method: "item/tool/requestUserInput",
            params: {
              threadId: "parent-thread",
              turnId: "parent-turn",
              itemId: "input-parent",
              questions: [],
            },
          });
          userInputResponse = await client.handleRequest({
            id: 43,
            method: "item/tool/requestUserInput",
            params: {
              threadId: "side-thread",
              turnId: "turn-1",
              itemId: "input-1",
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: "Pick one",
                  options: [{ label: "A", description: "" }],
                },
              ],
            },
          });
          client.emit(turnCompleted("side-thread", "turn-1", "No input needed."));
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const result = await runCodexAppServerSideQuestion(sideParams());

    expect(result).toEqual({ text: "No input needed." });
    expect(unrelatedUserInputResponse).toBeUndefined();
    expect(userInputResponse).toEqual({ answers: {} });
  });

  it("uses configured image generation timeout for side-thread image_generate calls", () => {
    const timeoutMs = __testing.resolveSideDynamicToolCallTimeoutMs({
      call: {
        threadId: "side-thread",
        turnId: "turn-1",
        callId: "tool-1",
        tool: "image_generate",
      },
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              timeoutMs: 123_456,
            },
          },
        },
      } as never,
    });

    expect(timeoutMs).toBe(123_456);
  });

  it("cleans up notification handlers when side tool setup fails", async () => {
    const client = createFakeClient();
    createOpenClawCodingToolsMock.mockImplementation(() => {
      throw new Error("tool setup failed");
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(runCodexAppServerSideQuestion(sideParams())).rejects.toThrow("tool setup failed");

    expect(client.notifications).toHaveLength(0);
    expect(client.requests).toHaveLength(0);
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
