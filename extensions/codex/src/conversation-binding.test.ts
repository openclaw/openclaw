import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecApprovalsFile } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

const execApprovalsRuntimeMocks = vi.hoisted(() => ({
  loadExecApprovals: vi.fn<() => ExecApprovalsFile>(() => ({ version: 1, agents: {} })),
}));

const agentRuntimeMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveDefaultAgentDir: vi.fn(() => "/agent"),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(),
  resolveProviderIdForAuth: vi.fn((provider: string, _lookup?: { config?: unknown }) => provider),
  resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  saveAuthProfileStore: vi.fn(),
}));

const codexRequirementsTomlMock = vi.hoisted(() => vi.fn<() => string | undefined>());
const resolveSandboxContextMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ enabled: boolean } | null>>(async () => null),
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync(filePath: string | URL | number, options?: BufferEncoding | object | null) {
      if (filePath === "/etc/codex/requirements.toml") {
        const content = codexRequirementsTomlMock();
        if (content !== undefined) {
          return content;
        }
      }
      return actual.readFileSync(filePath, options);
    },
  };
});

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    resolveSandboxContext: resolveSandboxContextMock,
  };
});

vi.mock("./app-server/shared-client.js", () => ({
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/exec-approvals-runtime")>();
  return {
    ...actual,
    loadExecApprovals: execApprovalsRuntimeMocks.loadExecApprovals,
  };
});
vi.mock("openclaw/plugin-sdk/agent-runtime", () => agentRuntimeMocks);

import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
  startCodexConversationThread,
} from "./conversation-binding.js";
import {
  answerCodexUserInputCallback,
  CODEX_PENDING_CONTROL_TTL_MS,
  createCodexUserInputPrompt,
  resetCodexConversationChatControlsForTests,
} from "./conversation-chat-controls.js";

let tempDir: string;

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function readReplyButtons(reply: {
  presentation?: { blocks?: unknown[] };
}): Array<{ label: string; action?: { command?: string } }> {
  const block = reply.presentation?.blocks?.find(
    (entry): entry is { buttons: Array<{ label: string; action?: { command?: string } }> } =>
      Boolean(entry) &&
      typeof entry === "object" &&
      Array.isArray((entry as { buttons?: unknown }).buttons),
  );
  return block?.buttons ?? [];
}

describe("codex conversation binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
  });

  afterEach(async () => {
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({ version: 1, agents: {} });
    agentRuntimeMocks.ensureAuthProfileStore.mockReset();
    agentRuntimeMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
    agentRuntimeMocks.resolveApiKeyForProfile.mockReset();
    agentRuntimeMocks.resolveAuthProfileOrder.mockReset();
    agentRuntimeMocks.resolveDefaultAgentDir.mockClear();
    agentRuntimeMocks.resolvePersistedAuthProfileOwnerAgentDir.mockReset();
    agentRuntimeMocks.resolveProviderIdForAuth.mockClear();
    agentRuntimeMocks.resolveSessionAgentIds.mockClear();
    agentRuntimeMocks.saveAuthProfileStore.mockReset();
    codexRequirementsTomlMock.mockReset();
    resolveSandboxContextMock.mockReset();
    resolveSandboxContextMock.mockResolvedValue(null);
    resetCodexConversationChatControlsForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue([]);
    agentRuntimeMocks.resolveDefaultAgentDir.mockReturnValue("/agent");
    agentRuntimeMocks.resolveProviderIdForAuth.mockImplementation(
      (provider: string, _lookup?: { config?: unknown }) => provider,
    );
    agentRuntimeMocks.resolveSessionAgentIds.mockReturnValue({
      defaultAgentId: "main",
      sessionAgentId: "main",
    });
  });

  it("uses the default Codex auth profile and omits the public OpenAI provider for new binds", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const config = {
      auth: { order: { openai: ["openai:default"] } },
    };
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
        },
      },
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await startCodexConversationThread({
      config: config as never,
      sessionFile,
      workspaceDir: tempDir,
      model: "gpt-5.4-mini",
      modelProvider: "openai",
    });

    const authOrderParams = mockCallArg(agentRuntimeMocks.resolveAuthProfileOrder) as {
      cfg?: unknown;
      provider?: unknown;
    };
    expect(authOrderParams?.cfg).toBe(config);
    expect(authOrderParams?.provider).toBe("openai");
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams?.authProfileId).toBe("openai:default");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("thread/start");
    expect(requests[0]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[0]?.params.personality).toBe("none");
    expect(requests[0]?.params).not.toHaveProperty("modelProvider");
    await expect(fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8")).resolves.toContain(
      '"authProfileId": "openai:default"',
    );
  });

  it("preserves Codex auth and omits the public OpenAI provider for native bind threads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        work: {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-old",
        cwd: tempDir,
        authProfileId: "work",
        modelProvider: "openai",
      }),
    );
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
          modelProvider: "openai",
        };
      }),
    });

    await startCodexConversationThread({
      sessionFile,
      workspaceDir: tempDir,
      model: "gpt-5.4-mini",
      modelProvider: "openai",
    });

    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams?.authProfileId).toBe("work");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("thread/start");
    expect(requests[0]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[0]?.params.personality).toBe("none");
    expect(requests[0]?.params).not.toHaveProperty("modelProvider");
    await expect(fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8")).resolves.toContain(
      '"authProfileId": "work"',
    );
    await expect(
      fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    ).resolves.not.toContain('"modelProvider": "openai"');
  });

  it("stores and uses the owning agent dir for bound app-server sessions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-a", "agent");
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => ({
        thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
        model: "gpt-5.4-mini",
      })),
    });

    const data = await startCodexConversationThread({
      sessionFile,
      workspaceDir: tempDir,
      agentDir,
      model: "gpt-5.4-mini",
    });

    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      agentDir?: unknown;
    };
    expect(sharedClientParams?.agentDir).toBe(agentDir);
    expect(data.agentDir).toBe(agentDir);
  });

  it("rejects binding when configured exec auto mode may need unrouted human approvals", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await expect(
      startCodexConversationThread({
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        } as never,
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(requests).toEqual([]);
  });

  it("rejects binding when configured exec ask mode needs unrouted user approvals", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await expect(
      startCodexConversationThread({
        config: {
          tools: {
            exec: {
              mode: "ask",
            },
          },
        } as never,
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(requests).toEqual([]);
  });

  it("applies host exec approval floors to configless native bind threads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({
      version: 1,
      defaults: {
        security: "deny",
        ask: "off",
      },
      agents: {},
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await expect(
      startCodexConversationThread({
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow("tools.exec.mode=deny");
    expect(execApprovalsRuntimeMocks.loadExecApprovals).toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("clears the Codex app-server sidecar when a pending bind is denied", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sidecar = `${sessionFile}.codex-app-server.json`;
    await fs.writeFile(sidecar, JSON.stringify({ schemaVersion: 1, threadId: "thread-1" }));

    await handleCodexConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile,
          workspaceDir: tempDir,
        },
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
        },
      },
    });

    await expect(fs.stat(sidecar)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("starts a new bound Codex turn for non-authorized typed text on a bound conversation", async () => {
    // Regression: previously, a non-command-authorized typed message on a
    // bound app-server conversation was silently swallowed by
    // `return { handled: true }` after the freeform matcher. A bound
    // chat session should always reach Codex as a fresh turn prompt
    // so the user sees a response, even if the typed text is plain
    // prose rather than a /codex command. Slash commands are still
    // protected upstream by answerCodexUserInputFreeform's "/" check.
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let turnStarted = false;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method === "turn/start") {
          turnStarted = true;
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "run this",
        channel: "discord",
        isGroup: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(turnStarted).toBe(true);
    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toMatch(/Codex (app-server )?turn/);
  });

  it("does not start a bound turn for unauthorized slash-prefixed text", async () => {
    // Unauthorized slash commands (e.g. /help, /codex detach when
    // the user is not authorized for /codex) are routed to the
    // bound plugin rather than bypassed by core's
    // `shouldBypassPluginOwnedBindingForCommand` and must NOT
    // start a Codex turn. The freeform matcher above rejects "/"
    // as a control-command prefix, and this guard consumes the
    // event so it does not become a fresh Codex turn prompt.
    let turnStarted = false;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method === "turn/start") {
          turnStarted = true;
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );

    const result = await handleCodexConversationInboundClaim(
      {
        content: "/help",
        bodyForAgent: "/help",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        threadId: "chat-1",
        sessionKey: "session-key",
        isGroup: true,
        commandAuthorized: false,
      },
      {
        channelId: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
    );

    expect(turnStarted).toBe(false);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true });
  });

  it("consumes a typed reply that did not match a pending Codex input control", async () => {
    // Regression: when a pending Codex request_user_input control is
    // queued and the user's typed text does not match a valid
    // option, the freeform matcher returns matched: false. The
    // fall-through to a new Codex turn is wrong here — bound turns
    // are serialized by sessionFile, so the new turn would queue
    // behind the unresolved pending input and hang until the
    // 10-minute pending-input TTL. Instead, consume the event
    // with a short reply that points the user back to the pending
    // button row / Other input.
    //
    // Use a question with isOther: false so the matcher genuinely
    // rejects the typed answer (instead of accepting it as a free
    // Other reply).
    const { createCodexUserInputPromptControl, resetCodexConversationChatControlsForTests } =
      await import("./conversation-chat-controls.js");
    resetCodexConversationChatControlsForTests();
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    createCodexUserInputPromptControl({
      scope: {
        sessionFile,
        threadId: "thread-1",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        messageThreadId: "chat-1",
      },
      resolveText,
      questions: [
        {
          id: "shape",
          header: "Plan",
          question: "Which plan shape?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Small Patch", description: "" },
            { label: "Feature Slice", description: "" },
          ],
        },
        {
          id: "approval",
          header: "Approval",
          question: "Approve?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Approve", description: "" },
            { label: "Hold", description: "" },
          ],
        },
      ],
    });

    let turnStarted = false;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method === "turn/start") {
          turnStarted = true;
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    try {
      const result = await handleCodexConversationInboundClaim(
        {
          content: "totally not a valid answer",
          bodyForAgent: "totally not a valid answer",
          channel: "discord",
          senderId: "user-1",
          accountId: "default",
          threadId: "chat-1",
          sessionKey: "session-key",
          isGroup: true,
          commandAuthorized: false,
        },
        {
          channelId: "discord",
          senderId: "user-1",
          accountId: "default",
          sessionKey: "session-key",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "discord",
            accountId: "default",
            conversationId: "channel-1",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: tempDir,
            },
          },
        },
      );

      expect(turnStarted).toBe(false);
      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
      expect(result).toEqual({
        handled: true,
        reply: expect.objectContaining({
          text: expect.stringMatching(/couldn't match your reply/i),
        }),
      });
      // The pending control must NOT have been consumed — the
      // user can still click a button or type a different answer.
      let stillPendingSettled = false;
      answered.then(
        () => {
          stillPendingSettled = true;
        },
        () => {
          stillPendingSettled = true;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(stillPendingSettled).toBe(false);
    } finally {
      resetCodexConversationChatControlsForTests();
    }
  });

  it("does not consume a fresh prompt when a pending Codex input is on a different session", async () => {
    // A pending Codex request_user_input control on a different
    // sessionFile must NOT consume a normal fresh prompt in this
    // bound conversation. The new turn must start, fall through
    // to runCodexBoundConversationPrompt, and time out (as the
    // test mock does not deliver a turn/completed notification).
    const { createCodexUserInputPromptControl, resetCodexConversationChatControlsForTests } =
      await import("./conversation-chat-controls.js");
    resetCodexConversationChatControlsForTests();
    // Pend on a different sessionFile.
    const otherSessionFile = path.join(tempDir, "other-session.jsonl");
    createCodexUserInputPromptControl({
      scope: {
        sessionFile: otherSessionFile,
        threadId: "thread-other",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        messageThreadId: "chat-1",
      },
      resolveText: () => undefined,
      questions: [
        {
          id: "mode",
          header: "Mode",
          question: "Pick a mode",
          isOther: false,
          isSecret: false,
          options: [{ label: "Quick", description: "" }],
        },
      ],
    });

    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let turnStarted = false;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method === "turn/start") {
          turnStarted = true;
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    try {
      const result = await handleCodexConversationInboundClaim(
        {
          content: "fresh prompt with no pending input here",
          bodyForAgent: "fresh prompt with no pending input here",
          channel: "discord",
          senderId: "user-1",
          accountId: "default",
          threadId: "chat-1",
          sessionKey: "session-key",
          isGroup: true,
          commandAuthorized: false,
        },
        {
          channelId: "discord",
          senderId: "user-1",
          accountId: "default",
          sessionKey: "session-key",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "discord",
            accountId: "default",
            conversationId: "channel-1",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: tempDir,
            },
          },
        },
        { timeoutMs: 50 },
      );

      // The fresh prompt must start a turn (the pending on the
      // other sessionFile does not block this conversation).
      expect(turnStarted).toBe(true);
      expect(result?.handled).toBe(true);
    } finally {
      resetCodexConversationChatControlsForTests();
    }
  });

  it("starts a new bound Codex turn for slash-leading prose when the core router marks it authorized non-command text", async () => {
    // Slash-prefixed plain text (e.g. "/tmp/foo is failing" typed
    // as a normal Codex prompt) is treated as non-command prose
    // by the core router and routed here as commandAuthorized: true.
    // The slash must not cause the inbound_claim to silently drop
    // the message. The freeform matcher above rejects "/" as a
    // control-command prefix, but commandAuthorized: true means
    // the dispatch layer did not classify this as a command, so
    // the fall-through to a new turn is correct.
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let turnStarted = false;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method === "turn/start") {
          turnStarted = true;
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "/tmp/foo is failing on read",
        bodyForAgent: "/tmp/foo is failing on read",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        threadId: "chat-1",
        sessionKey: "session-key",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(turnStarted).toBe(true);
    expect(result?.handled).toBe(true);
  });

  it("routes bound Codex CLI node sessions through node resume", async () => {
    const resumeCodexCliSessionOnNode = vi.fn(async () => ({
      ok: true as const,
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
      text: "done",
    }));

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "node-session",
      },
      {
        channelId: "discord",
        sessionKey: "node-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "mb-m5",
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
          },
        },
      },
      {
        config: { tools: { exec: { host: "node", node: "mb-m5" } } },
        resumeCodexCliSessionOnNode,
        timeoutMs: 1234,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(resumeCodexCliSessionOnNode).toHaveBeenCalledWith({
      nodeId: "mb-m5",
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
      prompt: "continue the task",
      cwd: "/repo",
      timeoutMs: 1234,
    });
  });

  it("blocks bound Codex app-server turns when the current OpenClaw session is sandboxed", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-1", cwd: tempDir }),
    );

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "sandboxed-session",
      },
      {
        channelId: "discord",
        sessionKey: "sandboxed-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex app-server conversation binding is unavailable because OpenClaw sandboxing is active for this session.",
        ),
      },
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("blocks bound Codex app-server turns when exec host=node is active", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-1", cwd: tempDir }),
    );

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "node-session",
      },
      {
        channelId: "discord",
        sessionKey: "node-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex app-server conversation binding is unavailable because OpenClaw exec host=node is active for this session.",
        ),
      },
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("blocks bound Codex CLI node turns when the current OpenClaw session is sandboxed", async () => {
    const resumeCodexCliSessionOnNode = vi.fn();

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "sandboxed-session",
      },
      {
        channelId: "discord",
        sessionKey: "sandboxed-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "mb-m5",
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
          },
        },
      },
      {
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        resumeCodexCliSessionOnNode,
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex CLI node conversation binding is unavailable because OpenClaw sandboxing is active for this session.",
        ),
      },
    });
    expect(resumeCodexCliSessionOnNode).not.toHaveBeenCalled();
  });

  it("recreates a missing bound thread and preserves auth plus turn overrides", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        work: {
          type: "oauth",
          provider: "openai",
          access: "access-token",
        },
      },
    });
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-old",
        cwd: tempDir,
        authProfileId: "work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        serviceTier: "fast",
        collaborationMode: "plan",
        reasoningEffort: "minimal",
      }),
    );
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "turn/start" && requestParams.threadId === "thread-old") {
          throw new Error("thread not found: thread-old");
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.4-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [
                      {
                        id: "assistant-1",
                        type: "agentMessage",
                        text: "Recovered",
                      },
                    ],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 500 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Recovered" } });
    expect(requests.map((request) => request.method)).toEqual([
      "turn/start",
      "thread/start",
      "turn/start",
    ]);
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams?.authProfileId).toBe("work");
    expect(requests[1]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[1]?.params.approvalPolicy).toBe("on-request");
    expect(requests[1]?.params.sandbox).toBe("workspace-write");
    expect(requests[1]?.params.serviceTier).toBe("priority");
    expect(requests[1]?.params).not.toHaveProperty("modelProvider");
    expect(requests[2]?.params.threadId).toBe("thread-new");
    expect(requests[2]?.params.approvalPolicy).toBe("on-request");
    expect(requests[2]?.params.serviceTier).toBe("priority");
    expect(requests[2]?.params.effort).toBe("low");
    expect(requests[2]?.params.collaborationMode).toEqual({
      mode: "plan",
      settings: {
        model: "gpt-5.4-mini",
        reasoning_effort: "low",
        developer_instructions: null,
      },
    });
    const savedBinding = JSON.parse(
      await fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    );
    expect(savedBinding.threadId).toBe("thread-new");
    expect(savedBinding.authProfileId).toBe("work");
    expect(savedBinding.approvalPolicy).toBe("on-request");
    expect(savedBinding.sandbox).toBe("workspace-write");
    expect(savedBinding.serviceTier).toBe("priority");
    expect(savedBinding.collaborationMode).toBe("plan");
    expect(savedBinding.reasoningEffort).toBe("minimal");
    expect(savedBinding).not.toHaveProperty("modelProvider");
  });

  it("omits collaborationMode when the bound binding has no stored model", async () => {
    // Regression: previously buildBoundConversationCollaborationMode
    // emitted settings.model: null whenever the binding had no stored
    // model. The Codex app-server contract requires Settings.model to
    // be a string, so turn/start would fail before the turn started.
    // Skip the collaboration mode object in that case.
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-old",
        cwd: tempDir,
        authProfileId: "work",
        // model intentionally omitted
        collaborationMode: "plan",
      }),
    );
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "turn/start" && requestParams.threadId === "thread-old") {
          throw new Error("thread not found: thread-old");
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [
                      {
                        id: "assistant-1",
                        type: "agentMessage",
                        text: "Recovered",
                      },
                    ],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 500 },
    );

    const turnStart = requests.find(
      (request) => request.method === "turn/start" && request.params.threadId === "thread-new",
    );
    expect(turnStart).toBeDefined();
    expect(turnStart?.params.collaborationMode).toBeUndefined();
  });

  it("does not silently decline auto-mode approvals during missing thread recovery", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-old",
        cwd: tempDir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "turn/start" && requestParams.threadId === "thread-old") {
          throw new Error("thread not found: thread-old");
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.4-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [{ id: "assistant-1", type: "agentMessage", text: "Recovered" }],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 500,
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(requests).toEqual([]);
  });

  it("creates a fresh thread when recovery finds the binding already cleared", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.5-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [{ id: "assistant-1", type: "agentMessage", text: "Recovered fresh" }],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "redacted-group",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 500 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Recovered fresh" } });
    expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
    expect(requests[1]?.params.threadId).toBe("thread-new");
    expect(requests[1]?.params.personality).toBe("none");
    const savedBinding = JSON.parse(
      await fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    );
    expect(savedBinding.threadId).toBe("thread-new");
  });

  it("passes sandbox state when resolving bound turn policy", async () => {
    codexRequirementsTomlMock.mockReturnValue(
      [
        'allowed_sandbox_modes = ["read-only", "workspace-write"]',
        'allowed_approval_policies = ["never", "on-request"]',
        'allowed_approvals_reviewers = ["user"]',
      ].join("\n"),
    );
    resolveSandboxContextMock.mockResolvedValue({ enabled: true });
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue",
        bodyForAgent: "continue",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
        sessionKey: "agent:main:session-1",
      },
      {
        channelId: "telegram",
        sessionKey: "agent:main:session-1",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 50,
        config: {
          tools: {
            exec: {
              security: "full",
              ask: "on-miss",
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(result?.reply?.text).not.toContain(
      "legacy full exec security with ask requires Codex app-server danger-full-access",
    );
    expect(resolveSandboxContextMock).toHaveBeenCalledWith({
      config: {
        tools: {
          exec: {
            security: "full",
            ask: "on-miss",
          },
        },
      },
      sessionKey: "agent:main:session-1",
      workspaceDir: tempDir,
    });
    expect(turnStartParams).toEqual([]);
  });

  it("uses configured Codex think defaults for execute and plan turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        model: "gpt-5.4-mini",
      }),
    );
    const turnStartParams: Record<string, unknown>[] = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        const turnIndex = turnStartParams.length + 1;
        turnStartParams.push(requestParams);
        setImmediate(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: `turn-${turnIndex}`,
                  status: "completed",
                  items: [{ type: "agentMessage", id: `item-${turnIndex}`, text: "done" }],
                },
              },
            });
          }
        });
        return { turn: { id: `turn-${turnIndex}` } };
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });
    const pluginConfig = {
      appServer: {
        conversationReasoningDefaults: {
          execute: "medium",
          plan: "xhigh",
        },
      },
    };
    const bindingContext = {
      channelId: "telegram",
      pluginBinding: {
        bindingId: "binding-1",
        pluginId: "codex",
        pluginRoot: tempDir,
        channel: "telegram",
        accountId: "default",
        conversationId: "5185575566",
        boundAt: Date.now(),
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile,
          workspaceDir: tempDir,
        },
      },
    };

    await expect(
      handleCodexConversationInboundClaim(
        {
          content: "execute this",
          bodyForAgent: "execute this",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
        },
        bindingContext,
        { pluginConfig, timeoutMs: 50 },
      ),
    ).resolves.toEqual({ handled: true, reply: { text: "done" } });
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        model: "gpt-5.4-mini",
        collaborationMode: "plan",
      }),
    );
    await expect(
      handleCodexConversationInboundClaim(
        {
          content: "plan this",
          bodyForAgent: "plan this",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
        },
        bindingContext,
        { pluginConfig, timeoutMs: 50 },
      ),
    ).resolves.toEqual({ handled: true, reply: { text: "done" } });

    expect(turnStartParams[0]?.effort).toBe("medium");
    expect(turnStartParams[0]?.collaborationMode).toEqual({
      mode: "default",
      settings: {
        model: "gpt-5.4-mini",
        reasoning_effort: "medium",
        developer_instructions: null,
      },
    });
    expect(turnStartParams[1]?.effort).toBe("xhigh");
    expect(turnStartParams[1]?.collaborationMode).toEqual({
      mode: "plan",
      settings: {
        model: "gpt-5.4-mini",
        reasoning_effort: "xhigh",
        developer_instructions: null,
      },
    });
  });

  it("returns approve and stay buttons when a plan-mode turn proposes a plan", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        model: "gpt-5.4-mini",
        collaborationMode: "plan",
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        setImmediate(() =>
          notificationHandler?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                items: [
                  {
                    id: "plan-1",
                    type: "plan",
                    text: "<proposed_plan>Run the tests.</proposed_plan>",
                  },
                ],
              },
            },
          }),
        );
        return { turn: { id: "turn-1" } };
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "make a plan",
        bodyForAgent: "make a plan",
        channel: "telegram",
        senderId: "user-1",
        accountId: "default",
        threadId: "chat-1",
        sessionKey: "session-key",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result?.reply?.text).toBe("Run the tests.");
    expect(readReplyButtons(result?.reply ?? {}).map((button) => button.label)).toEqual([
      "Approve and execute",
      "Approve and execute with clean context",
      "Stay in plan mode",
    ]);
  });

  it("prefers native proposed plan text over a later assistant summary", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        model: "gpt-5.4-mini",
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        setImmediate(() =>
          notificationHandler?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                items: [
                  {
                    id: "plan-1",
                    type: "plan",
                    text: "<proposed_plan>Run the focused tests.</proposed_plan>",
                  },
                  {
                    id: "assistant-1",
                    type: "agentMessage",
                    text: "I returned the improved version inside the proposed_plan block above.",
                  },
                ],
              },
            },
          }),
        );
        return { turn: { id: "turn-1" } };
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "make a plan",
        bodyForAgent: "make a plan",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        threadId: "chat-1",
        sessionKey: "session-key",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result?.reply?.text).toBe("Run the focused tests.");
    expect(result?.reply?.text).not.toContain("block above");
    expect(readReplyButtons(result?.reply ?? {}).map((button) => button.label)).toEqual([
      "Approve and execute",
      "Approve and execute with clean context",
      "Stay in plan mode",
    ]);
  });

  it("retries when a plan-mode reply references a missing proposed plan block", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        model: "gpt-5.4-mini",
        collaborationMode: "plan",
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    let turnIndex = 0;
    const request = vi.fn(async (method: string, params?: { input?: unknown }) => {
      if (method !== "turn/start") {
        throw new Error(`unexpected method: ${method}`);
      }
      turnIndex += 1;
      const turnId = `turn-${turnIndex}`;
      const items =
        turnIndex === 1
          ? [
              {
                id: "assistant-1",
                type: "agentMessage",
                text: "Yes. I made a complete implement-ready plan in the previous message inside the <proposed_plan> block.",
              },
            ]
          : [
              {
                id: "plan-1",
                type: "plan",
                text: "<proposed_plan>Run the focused tests.</proposed_plan>",
              },
            ];
      setImmediate(() =>
        notificationHandler?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: turnId, status: "completed", items },
          },
        }),
      );
      return { turn: { id: turnId } };
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "did u make a plan",
        bodyForAgent: "did u make a plan",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        threadId: "chat-1",
        sessionKey: "session-key",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result?.reply?.text).toBe("Run the focused tests.");
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(request.mock.calls[1]?.[1])).toContain(
      "No proposed_plan block was delivered",
    );
    expect(readReplyButtons(result?.reply ?? {}).map((button) => button.label)).toEqual([
      "Approve and execute",
      "Approve and execute with clean context",
      "Stay in plan mode",
    ]);
  });

  it("returns approve and stay buttons for plain Markdown plan text in plan mode", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        model: "gpt-5.4-mini",
        collaborationMode: "plan",
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        setImmediate(() =>
          notificationHandler?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                items: [
                  {
                    id: "plan-1",
                    type: "plan",
                    text: "# OpenClaw Plan\n\n- Fail closed",
                  },
                ],
              },
            },
          }),
        );
        return { turn: { id: "turn-1" } };
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "make a plan",
        bodyForAgent: "make a plan",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        threadId: "chat-1",
        sessionKey: "session-key",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result?.reply?.text).toBe("# OpenClaw Plan\n\n- Fail closed");
    expect(result?.reply?.text).not.toBe("Codex completed without a text reply.");
    expect(readReplyButtons(result?.reply ?? {}).map((button) => button.label)).toEqual([
      "Approve and execute",
      "Approve and execute with clean context",
      "Stay in plan mode",
    ]);
  });

  it("delivers live progress updates for bound turns when enabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        liveProgress: true,
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        setImmediate(() => {
          notificationHandler?.({
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { id: "tool-1", type: "toolCall", tool: "shell" },
            },
          });
          notificationHandler?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                items: [{ id: "assistant-1", type: "agentMessage", text: "done" }],
              },
            },
          });
        });
        return { turn: { id: "turn-1" } };
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });
    const sendProgressReply = vi.fn(async () => undefined);

    await expect(
      handleCodexConversationInboundClaim(
        {
          content: "run",
          bodyForAgent: "run",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
        },
        {
          channelId: "telegram",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: tempDir,
            },
          },
        },
        { timeoutMs: 50, sendProgressReply },
      ),
    ).resolves.toEqual({ handled: true, reply: { text: "done" } });

    expect(sendProgressReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "Codex started shell (toolCall)." },
      }),
    );
  });

  it("routes Codex user-input requests through chat buttons", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    let requestHandler:
      | ((request: { method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    let userInputResponse: unknown;
    const sendProgressReply = vi.fn(async ({ payload }) => {
      const block = payload.presentation?.blocks.find(
        (entry): entry is { buttons: Array<{ value?: string }> } => entry.type === "buttons",
      );
      answerCodexUserInputCallback({
        payload: block?.buttons[1]?.value?.slice("codex:".length) ?? "",
        ctx: {
          channel: "telegram",
          senderId: "user-1",
          accountId: "default",
          sessionKey: "session-key",
          messageThreadId: "chat-1",
        },
        sessionFile,
      });
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        setImmediate(async () => {
          userInputResponse = await requestHandler?.({
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "input-1",
              questions: [
                {
                  id: "q1",
                  header: "Mode",
                  question: "Pick one",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "Plan", description: "Stay in plan" },
                    { label: "Execute", description: "Run now" },
                  ],
                },
              ],
            },
          });
          notificationHandler?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                items: [{ id: "assistant-1", type: "agentMessage", text: "done" }],
              },
            },
          });
        });
        return { turn: { id: "turn-1" } };
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn((handler) => {
        requestHandler = handler;
        return () => undefined;
      }),
    });

    await expect(
      handleCodexConversationInboundClaim(
        {
          content: "ask",
          bodyForAgent: "ask",
          channel: "telegram",
          senderId: "user-1",
          accountId: "default",
          threadId: "chat-1",
          sessionKey: "session-key",
          isGroup: false,
          commandAuthorized: true,
        },
        {
          channelId: "telegram",
          senderId: "user-1",
          accountId: "default",
          sessionKey: "session-key",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: tempDir,
            },
          },
        },
        { timeoutMs: 50, sendProgressReply },
      ),
    ).resolves.toEqual({ handled: true, reply: { text: "done" } });

    expect(sendProgressReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: expect.stringContaining("Codex needs input:"),
          presentation: expect.objectContaining({
            blocks: [
              expect.objectContaining({
                buttons: [
                  expect.objectContaining({ label: "Plan" }),
                  expect.objectContaining({ label: "Execute" }),
                ],
              }),
            ],
          }),
        }),
      }),
    );
    expect(userInputResponse).toEqual({ answers: { q1: { answers: ["Execute"] } } });
  });

  it("interrupts the Codex turn when chat user-input controls expire unanswered", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    let requestHandler:
      | ((request: { method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    let userInputResponse: unknown;
    let userInputError: unknown;
    let interrupted = false;
    const request = vi.fn(async (method: string) => {
      if (method === "turn/start") {
        setTimeout(async () => {
          try {
            userInputResponse = await requestHandler?.({
              method: "item/tool/requestUserInput",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "input-1",
                questions: [
                  {
                    id: "q1",
                    header: "Mode",
                    question: "Pick one",
                    isOther: true,
                    isSecret: false,
                    options: [
                      { label: "Plan", description: "Stay in plan" },
                      { label: "Execute", description: "Run now" },
                    ],
                  },
                ],
              },
            });
          } catch (error) {
            userInputError = error;
          }
          if (!interrupted) {
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [
                    {
                      id: "assistant-1",
                      type: "agentMessage",
                      text: "continued after timeout",
                    },
                  ],
                },
              },
            });
          }
        }, 0);
        return { turn: { id: "turn-1" } };
      }
      if (method === "turn/interrupt") {
        interrupted = true;
        setTimeout(() => {
          notificationHandler?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "interrupted", items: [] },
            },
          });
        }, 0);
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn((handler) => {
        requestHandler = handler;
        return () => undefined;
      }),
    });
    const sendProgressReply = vi.fn(async () => undefined);

    vi.useFakeTimers();
    try {
      const result = handleCodexConversationInboundClaim(
        {
          content: "ask",
          bodyForAgent: "ask",
          channel: "telegram",
          senderId: "user-1",
          accountId: "default",
          threadId: "chat-1",
          sessionKey: "session-key",
          isGroup: false,
          commandAuthorized: true,
        },
        {
          channelId: "telegram",
          senderId: "user-1",
          accountId: "default",
          sessionKey: "session-key",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: tempDir,
            },
          },
        },
        { timeoutMs: CODEX_PENDING_CONTROL_TTL_MS + 1_000, sendProgressReply },
      );

      await vi.waitFor(() => {
        expect(sendProgressReply).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({
              text: expect.stringContaining("Codex needs input:"),
            }),
          }),
        );
      });
      await vi.advanceTimersByTimeAsync(CODEX_PENDING_CONTROL_TTL_MS);
      await vi.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toEqual({
        handled: true,
        reply: {
          text: "Codex input request timed out before an answer was sent. I stopped the Codex turn so it will not continue with a default answer.",
        },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 60_000 },
    );
    expect(userInputResponse).toBeUndefined();
    expect(userInputError).toMatchObject({
      message: "client request resolved because the turn state was changed",
      data: { reason: "turnTransition" },
    });
  });

  it("routes typed other replies to the pending Codex user-input request", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    createCodexUserInputPrompt({
      scope: {
        sessionFile,
        threadId: "thread-1",
        channel: "telegram",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        messageThreadId: "chat-1",
      },
      resolveText,
      questions: [
        {
          id: "q1",
          header: "Other",
          question: "Type an answer",
          isOther: true,
          isSecret: false,
          options: [{ label: "Runtime", description: "" }],
        },
      ],
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "can openmanager execute?",
        bodyForAgent: "can openmanager execute?",
        channel: "telegram",
        senderId: "user-1",
        accountId: "default",
        threadId: "chat-1",
        sessionKey: "session-key",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Sent answer to Codex." } });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    await expect(answered).resolves.toBe("can openmanager execute?");
  });

  it("routes unauthorized typed other replies to the pending Codex user-input request", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    let resolveText: (text: string) => void = () => undefined;
    const answered = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    createCodexUserInputPrompt({
      scope: {
        sessionFile,
        threadId: "thread-1",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        messageThreadId: "chat-1",
      },
      resolveText,
      questions: [
        {
          id: "q1",
          header: "Other",
          question: "Type an answer",
          isOther: true,
          isSecret: false,
          options: [{ label: "Runtime", description: "" }],
        },
      ],
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "openclaw only",
        bodyForAgent: "openclaw only",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        threadId: "chat-1",
        sessionKey: "session-key",
        isGroup: true,
        commandAuthorized: false,
      },
      {
        channelId: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Sent answer to Codex." } });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    await expect(answered).resolves.toBe("openclaw only");
  });

  it("starts a new bound Codex turn for non-authorized plain text on a bound conversation", async () => {
    // Previously this test asserted the silent-drop behavior that
    // swallowed non-command-authorized typed text on a bound
    // conversation. A bound chat session should always reach Codex as
    // a fresh turn prompt so the user sees a response. Slash
    // commands are still protected upstream by
    // answerCodexUserInputFreeform's "/" check, so they do not
    // enter the new-turn path.
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let turnStarted = false;
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method === "turn/start") {
          turnStarted = true;
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "openclaw only",
        bodyForAgent: "openclaw only",
        channel: "discord",
        senderId: "user-1",
        accountId: "default",
        threadId: "chat-1",
        sessionKey: "session-key",
        isGroup: true,
        commandAuthorized: false,
      },
      {
        channelId: "discord",
        senderId: "user-1",
        accountId: "default",
        sessionKey: "session-key",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(turnStarted).toBe(true);
    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toMatch(/Codex (app-server )?turn/);
  });

  it("returns a clean failure reply when app-server turn start rejects", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-b", "agent");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        authProfileId: "openai:work",
      }),
    );
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method === "turn/start") {
          throw new Error(
            "unexpected status 401 Unauthorized: Missing bearer <@U123> [trusted](https://evil) @here",
          );
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    try {
      const result = await handleCodexConversationInboundClaim(
        {
          content: "hi",
          bodyForAgent: "hi",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
        },
        {
          channelId: "telegram",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: tempDir,
              agentDir,
            },
          },
        },
        { timeoutMs: 50 },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(result).toEqual({
        handled: true,
        reply: {
          text: "Codex app-server turn failed: unexpected status 401 Unauthorized: Missing bearer &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
        },
      });
      const replyText = result?.reply?.text ?? "";
      expect(replyText).not.toContain("<@U123>");
      expect(replyText).not.toContain("[trusted](https://evil)");
      expect(replyText).not.toContain("@here");
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("falls back to content when the channel body for agent is blank", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-b", "agent");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "use the fallback prompt",
        bodyForAgent: "",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      agentDir?: unknown;
    };
    expect(sharedClientParams?.agentDir).toBe(agentDir);
    expect(turnStartParams[0]?.input).toEqual([
      { type: "text", text: "use the fallback prompt", text_elements: [] },
    ]);
    expect(turnStartParams[0]?.approvalPolicy).toBe("never");
    expect(turnStartParams[0]?.approvalsReviewer).toBe("user");
    expect(turnStartParams[0]?.sandboxPolicy).toEqual({
      type: "dangerFullAccess",
    });
  });
});
