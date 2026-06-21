// Codex tests cover request plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";

const sharedClientMocks = vi.hoisted(() => ({
  abandon: vi.fn(async () => undefined),
  createIsolatedCodexAppServerClient: vi.fn(),
  getSharedCodexAppServerClient: vi.fn(),
  release: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  ...sharedClientMocks,
  leaseSharedCodexAppServerClient: async (...args: unknown[]) => {
    let settled = false;
    return {
      client: await sharedClientMocks.getSharedCodexAppServerClient(...args),
      release: () => {
        if (!settled) {
          settled = true;
          sharedClientMocks.release();
        }
      },
      abandon: async () => {
        if (!settled) {
          settled = true;
          await sharedClientMocks.abandon();
        }
      },
    };
  },
}));

const { requestCodexAppServerJson } = await import("./request.js");

function resumeResponse(threadId: string) {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/repo",
      cliVersion: "0.139.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.5-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/repo",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

describe("requestCodexAppServerJson sandbox guard", () => {
  beforeEach(() => {
    sharedClientMocks.createIsolatedCodexAppServerClient.mockReset();
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    sharedClientMocks.release.mockClear();
    sharedClientMocks.abandon.mockClear();
  });

  it("fails closed before raw app-server bypass methods in sandboxed sessions", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "command/exec",
        requestParams: { command: ["sh", "-lc", "id"] },
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `command/exec` is unavailable because OpenClaw sandboxing is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("uses the explicit agent sandbox for globally scoped session keys", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "command/exec",
        requestParams: { command: ["sh", "-lc", "id"] },
        config: {
          agents: {
            list: [
              { id: "main", default: true, sandbox: { mode: "off" } },
              { id: "work", sandbox: { mode: "all" } },
            ],
          },
        },
        agentId: "work",
        sessionKey: "global-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `command/exec` is unavailable because OpenClaw sandboxing is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("fails closed before raw app-server bypass methods when exec host=node is active", async () => {
    for (const method of ["command/exec", "process/spawn"]) {
      await expect(
        requestCodexAppServerJson({
          method,
          requestParams: { command: ["sh", "-lc", "id"] },
          config: { tools: { exec: { host: "node", node: "worker-1" } } },
          sessionKey: "node-session",
        }),
      ).rejects.toThrow(
        `Codex-native app-server method \`${method}\` is unavailable because OpenClaw exec host=node is active for this session.`,
      );
    }

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("allows metadata methods in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      requestCodexAppServerJson({
        method: "thread/list",
        requestParams: { limit: 10 },
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith(
      "thread/list",
      { limit: 10 },
      expect.objectContaining({
        timeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("records full rate-limit reads on the physical control client", async () => {
    const snapshot = { rateLimits: { limitId: "codex", primary: { usedPercent: 12 } } };
    const client = {
      request: vi.fn(async () => snapshot),
    } as unknown as CodexAppServerClient;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    await expect(
      requestCodexAppServerJson({
        method: "account/rateLimits/read",
        requestParams: undefined,
      }),
    ).resolves.toEqual(snapshot);

    expect(readRecentCodexRateLimits(client)).toEqual(snapshot);
  });

  it("fails closed for config-level exec host=node even without a session key", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "command/exec",
        requestParams: { command: ["sh", "-lc", "id"] },
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `command/exec` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("fails closed for MCP reload when config-level exec host=node is active", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "config/mcpServer/reload",
        requestParams: {},
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `config/mcpServer/reload` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("allows metadata methods when exec host=node is active", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      requestCodexAppServerJson({
        method: "thread/list",
        requestParams: { limit: 10 },
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
        sessionKey: "node-session",
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith(
      "thread/list",
      { limit: 10 },
      expect.objectContaining({
        timeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("unsubscribes owned resumes but abandons a mismatched response", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(resumeResponse("thread-1"))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("resume response lost"))
      .mockResolvedValueOnce(resumeResponse("wrong-thread"));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
    });

    await expect(
      requestCodexAppServerJson({
        method: "thread/resume",
        requestParams: { threadId: "thread-1" },
      }),
    ).resolves.toMatchObject({ thread: { id: "thread-1" } });
    await expect(
      requestCodexAppServerJson({
        method: "thread/resume",
        requestParams: { threadId: "thread-2" },
      }),
    ).rejects.toThrow("resume response lost");
    await expect(
      requestCodexAppServerJson({
        method: "thread/resume",
        requestParams: { threadId: "thread-3" },
      }),
    ).rejects.toThrow("Codex thread/resume returned wrong-thread for thread-3");

    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["thread/resume", { threadId: "thread-1" }],
      ["thread/unsubscribe", { threadId: "thread-1" }],
      ["thread/resume", { threadId: "thread-2" }],
      ["thread/resume", { threadId: "thread-3" }],
    ]);
    expect(sharedClientMocks.abandon).toHaveBeenCalledTimes(2);
  });

  it("does not release a thread owner when the request deadline expires before resume", async () => {
    const request = vi.fn();
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10);

    await expect(
      requestCodexAppServerJson({
        method: "thread/resume",
        requestParams: { threadId: "thread-1" },
        timeoutMs: 1,
      }),
    ).rejects.toThrow("codex app-server thread/resume timed out");

    expect(request).not.toHaveBeenCalled();
    expect(sharedClientMocks.release).toHaveBeenCalledOnce();
    expect(sharedClientMocks.abandon).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("retires an isolated client that resolves after the end-to-end deadline", async () => {
    let resolveClient!: (client: CodexAppServerClient) => void;
    sharedClientMocks.createIsolatedCodexAppServerClient.mockImplementationOnce(
      async () =>
        await new Promise<CodexAppServerClient>((resolve) => {
          resolveClient = resolve;
        }),
    );
    const request = vi.fn();
    const closeAndWait = vi.fn(async () => undefined);
    const response = requestCodexAppServerJson({
      method: "model/list",
      requestParams: { limit: 10 },
      isolated: true,
      timeoutMs: 5,
    });

    await expect(response).rejects.toThrow("codex app-server model/list timed out");
    resolveClient({ request, closeAndWait } as unknown as CodexAppServerClient);
    await vi.waitFor(() => expect(closeAndWait).toHaveBeenCalledOnce());

    expect(request).not.toHaveBeenCalled();
  });

  it("does not let isolated teardown extend the caller deadline", async () => {
    const request = vi.fn(async () => ({ data: [] }));
    const closeAndWait = vi.fn(async () => await new Promise<void>(() => {}));
    sharedClientMocks.createIsolatedCodexAppServerClient.mockResolvedValue({
      request,
      closeAndWait,
    });

    await expect(
      requestCodexAppServerJson({
        method: "model/list",
        requestParams: { limit: 10 },
        isolated: true,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("codex app-server model/list timed out");

    expect(request).toHaveBeenCalledOnce();
    expect(closeAndWait).toHaveBeenCalledOnce();
  });

  it("allows sandbox-pinned thread starts in sandboxed sessions", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ thread: { id: "thread-1" }, model: "gpt-5.5" })
      .mockResolvedValueOnce({});
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const params = {
      cwd: "/workspace",
      environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
    };

    await expect(
      requestCodexAppServerJson({
        method: "thread/start",
        requestParams: params,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ thread: { id: "thread-1" }, model: "gpt-5.5" });

    expect(request.mock.calls).toEqual([
      [
        "thread/start",
        params,
        expect.objectContaining({
          timeoutMs: expect.any(Number),
          signal: expect.any(AbortSignal),
        }),
      ],
      ["thread/unsubscribe", { threadId: "thread-1" }, { timeoutMs: 5_000 }],
    ]);
  });

  it("unsubscribes one-shot shared thread forks", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ thread: { id: "child-thread" } })
      .mockResolvedValueOnce({});
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      requestCodexAppServerJson({
        method: "thread/fork",
        requestParams: { threadId: "parent-thread" },
      }),
    ).resolves.toEqual({ thread: { id: "child-thread" } });

    expect(request.mock.calls).toEqual([
      [
        "thread/fork",
        { threadId: "parent-thread" },
        expect.objectContaining({
          timeoutMs: expect.any(Number),
          signal: expect.any(AbortSignal),
        }),
      ],
      ["thread/unsubscribe", { threadId: "child-thread" }, { timeoutMs: 5_000 }],
    ]);
  });

  it("blocks thread starts with sandbox environments when exec host=node is active", async () => {
    const params = {
      cwd: "/workspace",
      environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
    };

    await expect(
      requestCodexAppServerJson({
        method: "thread/start",
        requestParams: params,
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec: { host: "node", node: "worker-1" } },
        },
        sessionKey: "node-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `thread/start` is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });
});
