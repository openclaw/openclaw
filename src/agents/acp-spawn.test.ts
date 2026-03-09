import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";

function createDefaultSpawnConfig(): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex"],
    },
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    channels: {
      discord: {
        threadBindings: {
          enabled: true,
          spawnAcpSessions: true,
        },
      },
    },
  };
}

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const sessionBindingCapabilitiesMock = vi.fn();
  const sessionBindingBindMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingListBySessionMock = vi.fn();
  const closeSessionMock = vi.fn();
  const initializeSessionMock = vi.fn();
  const startAcpSpawnParentStreamRelayMock = vi.fn();
  const resolveAcpSpawnStreamLogPathMock = vi.fn();
  const loadSessionStoreMock = vi.fn();
  const resolveStorePathMock = vi.fn();
  const resolveSessionTranscriptFileMock = vi.fn();
  const state = {
    cfg: createDefaultSpawnConfig(),
  };
  return {
    callGatewayMock,
    sessionBindingCapabilitiesMock,
    sessionBindingBindMock,
    sessionBindingUnbindMock,
    sessionBindingResolveByConversationMock,
    sessionBindingListBySessionMock,
    closeSessionMock,
    initializeSessionMock,
    startAcpSpawnParentStreamRelayMock,
    resolveAcpSpawnStreamLogPathMock,
    loadSessionStoreMock,
    resolveStorePathMock,
    resolveSessionTranscriptFileMock,
    state,
  };
});

function buildSessionBindingServiceMock() {
  return {
    touch: vi.fn(),
    bind(input: unknown) {
      return hoisted.sessionBindingBindMock(input);
    },
    unbind(input: unknown) {
      return hoisted.sessionBindingUnbindMock(input);
    },
    getCapabilities(params: unknown) {
      return hoisted.sessionBindingCapabilitiesMock(params);
    },
    resolveByConversation(ref: unknown) {
      return hoisted.sessionBindingResolveByConversationMock(ref);
    },
    listBySession(targetSessionKey: string) {
      return hoisted.sessionBindingListBySessionMock(targetSessionKey);
    },
  };
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.state.cfg,
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: (storePath: string) => hoisted.loadSessionStoreMock(storePath),
    resolveStorePath: (store: unknown, opts: unknown) => hoisted.resolveStorePathMock(store, opts),
  };
});

vi.mock("../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/transcript.js")>();
  return {
    ...actual,
    resolveSessionTranscriptFile: (params: unknown) =>
      hoisted.resolveSessionTranscriptFileMock(params),
  };
});

vi.mock("../acp/control-plane/manager.js", () => {
  return {
    getAcpSessionManager: () => ({
      initializeSession: (params: unknown) => hoisted.initializeSessionMock(params),
      closeSession: (params: unknown) => hoisted.closeSessionMock(params),
    }),
  };
});

vi.mock("../infra/outbound/session-binding-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infra/outbound/session-binding-service.js")>();
  return {
    ...actual,
    getSessionBindingService: () => buildSessionBindingServiceMock(),
  };
});

vi.mock("./acp-spawn-parent-stream.js", () => ({
  startAcpSpawnParentStreamRelay: (...args: unknown[]) =>
    hoisted.startAcpSpawnParentStreamRelayMock(...args),
  resolveAcpSpawnStreamLogPath: (...args: unknown[]) =>
    hoisted.resolveAcpSpawnStreamLogPathMock(...args),
}));

const { spawnAcpDirect } = await import("./acp-spawn.js");

function createSessionBindingCapabilities() {
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current", "child"] as const,
  };
}

function createSessionBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:child-thread",
    targetSessionKey: "agent:codex:acp:s1",
    targetKind: "session",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "child-thread",
      parentConversationId: "parent-channel",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      agentId: "codex",
      boundBy: "system",
    },
    ...overrides,
  };
}

function createRelayHandle(overrides?: {
  dispose?: ReturnType<typeof vi.fn>;
  notifyStarted?: ReturnType<typeof vi.fn>;
}) {
  return {
    dispose: overrides?.dispose ?? vi.fn(),
    notifyStarted: overrides?.notifyStarted ?? vi.fn(),
  };
}

function expectResolvedIntroTextInBindMetadata(): void {
  const callWithMetadata = hoisted.sessionBindingBindMock.mock.calls.find(
    (call: unknown[]) =>
      typeof (call[0] as { metadata?: { introText?: unknown } } | undefined)?.metadata
        ?.introText === "string",
  );
  const introText =
    (callWithMetadata?.[0] as { metadata?: { introText?: string } } | undefined)?.metadata
      ?.introText ?? "";
  expect(introText.includes("session ids: pending (available after the first reply)")).toBe(false);
}

describe("spawnAcpDirect", () => {
  beforeEach(() => {
    hoisted.state.cfg = createDefaultSpawnConfig();

    hoisted.callGatewayMock.mockReset().mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as { method?: string };
      if (args.method === "sessions.patch") {
        return { ok: true };
      }
      if (args.method === "agent") {
        return { runId: "run-1" };
      }
      if (args.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    hoisted.closeSessionMock.mockReset().mockResolvedValue({
      runtimeClosed: true,
      metaCleared: false,
    });
    hoisted.initializeSessionMock.mockReset().mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as {
        sessionKey: string;
        agent: string;
        mode: "persistent" | "oneshot";
        cwd?: string;
      };
      const runtimeSessionName = `${args.sessionKey}:runtime`;
      const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
      return {
        runtime: {
          close: vi.fn().mockResolvedValue(undefined),
        },
        handle: {
          sessionKey: args.sessionKey,
          backend: "acpx",
          runtimeSessionName,
          ...(cwd ? { cwd } : {}),
          agentSessionId: "codex-inner-1",
          backendSessionId: "acpx-1",
        },
        meta: {
          backend: "acpx",
          agent: args.agent,
          runtimeSessionName,
          ...(cwd ? { runtimeOptions: { cwd }, cwd } : {}),
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-1",
            agentSessionId: "codex-inner-1",
            lastUpdatedAt: Date.now(),
          },
          mode: args.mode,
          state: "idle",
          lastActivityAt: Date.now(),
        },
      };
    });

    hoisted.sessionBindingCapabilitiesMock
      .mockReset()
      .mockReturnValue(createSessionBindingCapabilities());
    hoisted.sessionBindingBindMock
      .mockReset()
      .mockImplementation(
        async (input: {
          targetSessionKey: string;
          conversation: { accountId: string };
          metadata?: Record<string, unknown>;
        }) =>
          createSessionBinding({
            targetSessionKey: input.targetSessionKey,
            conversation: {
              channel: "discord",
              accountId: input.conversation.accountId,
              conversationId: "child-thread",
              parentConversationId: "parent-channel",
            },
            metadata: {
              boundBy:
                typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
              agentId: "codex",
              webhookId: "wh-1",
            },
          }),
      );
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);
    hoisted.startAcpSpawnParentStreamRelayMock
      .mockReset()
      .mockImplementation(() => createRelayHandle());
    hoisted.resolveAcpSpawnStreamLogPathMock
      .mockReset()
      .mockReturnValue("/tmp/sess-main.acp-stream.jsonl");
    hoisted.resolveStorePathMock.mockReset().mockReturnValue("/tmp/codex-sessions.json");
    hoisted.loadSessionStoreMock.mockReset().mockImplementation(() => {
      const store: Record<string, { sessionId: string; updatedAt: number }> = {};
      return new Proxy(store, {
        get(_target, prop) {
          if (typeof prop === "string" && prop.startsWith("agent:codex:acp:")) {
            return { sessionId: "sess-123", updatedAt: Date.now() };
          }
          return undefined;
        },
      });
    });
    hoisted.resolveSessionTranscriptFileMock
      .mockReset()
      .mockImplementation(async (params: unknown) => {
        const typed = params as { threadId?: string };
        const sessionFile = typed.threadId
          ? `/tmp/agents/codex/sessions/sess-123-topic-${typed.threadId}.jsonl`
          : "/tmp/agents/codex/sessions/sess-123.jsonl";
        return {
          sessionFile,
          sessionEntry: {
            sessionId: "sess-123",
            updatedAt: Date.now(),
            sessionFile,
          },
        };
      });
  });

  it("spawns ACP session, binds a new thread, and dispatches initial task", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
        agentThreadId: "requester-thread",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:codex:acp:/);
    expect(result.runId).toBe("run-1");
    expect(result.mode).toBe("session");
    const patchCalls = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .filter((request) => request.method === "sessions.patch");
    expect(patchCalls[0]?.params).toMatchObject({
      key: result.childSessionKey,
      spawnedBy: "agent:main:main",
    });
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "session",
        placement: "child",
      }),
    );
    expectResolvedIntroTextInBindMetadata();

    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    expect(agentCall?.params?.sessionKey).toMatch(/^agent:codex:acp:/);
    expect(agentCall?.params?.to).toBe("channel:child-thread");
    expect(agentCall?.params?.threadId).toBe("child-thread");
    expect(agentCall?.params?.deliver).toBe(true);
    expect(hoisted.initializeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(/^agent:codex:acp:/),
        agent: "codex",
        mode: "persistent",
      }),
    );
    const transcriptCalls = hoisted.resolveSessionTranscriptFileMock.mock.calls.map(
      (call: unknown[]) => call[0] as { threadId?: string },
    );
    expect(transcriptCalls).toHaveLength(2);
    expect(transcriptCalls[0]?.threadId).toBeUndefined();
    expect(transcriptCalls[1]?.threadId).toBe("child-thread");
  });

  it("does not inline delivery for fresh oneshot ACP runs", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "run",
      },
      {
        agentSessionKey: "agent:main:telegram:direct:6098642967",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:6098642967",
        agentThreadId: "1",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.mode).toBe("run");
    expect(hoisted.resolveSessionTranscriptFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-123",
        storePath: "/tmp/codex-sessions.json",
        agentId: "codex",
      }),
    );
    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    expect(agentCall?.params?.deliver).toBe(false);
    expect(agentCall?.params?.channel).toBeUndefined();
    expect(agentCall?.params?.to).toBeUndefined();
    expect(agentCall?.params?.threadId).toBeUndefined();
  });

  it("keeps ACP spawn running when session-file persistence fails", async () => {
    hoisted.resolveSessionTranscriptFileMock.mockRejectedValueOnce(new Error("disk full"));

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "run",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:6098642967",
        agentThreadId: "1",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:codex:acp:/);
    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    expect(agentCall?.params?.sessionKey).toBe(result.childSessionKey);
  });

  it("includes cwd in ACP thread intro banner when provided at spawn time", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Check workspace",
        agentId: "codex",
        cwd: "/home/bob/clawd",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    expect(result.status).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.stringContaining("cwd: /home/bob/clawd"),
        }),
      }),
    );
  });

  it("rejects disallowed ACP agents", async () => {
    hoisted.state.cfg = {
      ...hoisted.state.cfg,
      acp: {
        enabled: true,
        backend: "acpx",
        allowedAgents: ["claudecode"],
      },
    };

    const result = await spawnAcpDirect(
      {
        task: "hello",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result).toMatchObject({
      status: "forbidden",
    });
  });

  it("requires an explicit ACP agent when no config default exists", async () => {
    const result = await spawnAcpDirect(
      {
        task: "hello",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("set `acp.defaultAgent`");
  });

  it("fails fast when Discord ACP thread spawn is disabled", async () => {
    hoisted.state.cfg = {
      ...hoisted.state.cfg,
      channels: {
        discord: {
          threadBindings: {
            enabled: true,
            spawnAcpSessions: false,
          },
        },
      },
    };

    const result = await spawnAcpDirect(
      {
        task: "hello",
        agentId: "codex",
        thread: true,
        mode: "session",
      },
      {
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("spawnAcpSessions=true");
  });

  it("forbids ACP spawn from sandboxed requester sessions", async () => {
    hoisted.state.cfg = {
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          sandbox: { mode: "all" },
        },
      },
    };

    const result = await spawnAcpDirect(
      {
        task: "hello",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:subagent:parent",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toContain("Sandboxed sessions cannot spawn ACP sessions");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
  });

  it('forbids sandbox="require" for runtime=acp', async () => {
    const result = await spawnAcpDirect(
      {
        task: "hello",
        agentId: "codex",
        sandbox: "require",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toContain('sandbox="require"');
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
  });

  it('streams ACP progress to parent when streamTo="parent"', async () => {
    const firstHandle = createRelayHandle();
    const secondHandle = createRelayHandle();
    hoisted.startAcpSpawnParentStreamRelayMock
      .mockReset()
      .mockReturnValueOnce(firstHandle)
      .mockReturnValueOnce(secondHandle);

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        streamTo: "parent",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.streamLogPath).toBe("/tmp/sess-main.acp-stream.jsonl");
    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    const agentCallIndex = hoisted.callGatewayMock.mock.calls.findIndex(
      (call: unknown[]) => (call[0] as { method?: string }).method === "agent",
    );
    const relayCallOrder = hoisted.startAcpSpawnParentStreamRelayMock.mock.invocationCallOrder[0];
    const agentCallOrder = hoisted.callGatewayMock.mock.invocationCallOrder[agentCallIndex];
    expect(agentCall?.params?.deliver).toBe(false);
    expect(typeof relayCallOrder).toBe("number");
    expect(typeof agentCallOrder).toBe("number");
    expect(relayCallOrder < agentCallOrder).toBe(true);
    expect(hoisted.startAcpSpawnParentStreamRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:main",
        agentId: "codex",
        logPath: "/tmp/sess-main.acp-stream.jsonl",
        emitStartNotice: false,
      }),
    );
    const relayRuns = hoisted.startAcpSpawnParentStreamRelayMock.mock.calls.map(
      (call: unknown[]) => (call[0] as { runId?: string }).runId,
    );
    expect(relayRuns).toContain(agentCall?.params?.idempotencyKey);
    expect(relayRuns).toContain(result.runId);
    expect(hoisted.resolveAcpSpawnStreamLogPathMock).toHaveBeenCalledWith({
      childSessionKey: expect.stringMatching(/^agent:codex:acp:/),
    });
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(firstHandle.notifyStarted).not.toHaveBeenCalled();
    expect(secondHandle.notifyStarted).toHaveBeenCalledTimes(1);
  });

  it("announces parent relay start only after successful child dispatch", async () => {
    const firstHandle = createRelayHandle();
    const secondHandle = createRelayHandle();
    hoisted.startAcpSpawnParentStreamRelayMock
      .mockReset()
      .mockReturnValueOnce(firstHandle)
      .mockReturnValueOnce(secondHandle);

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        streamTo: "parent",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(firstHandle.notifyStarted).not.toHaveBeenCalled();
    expect(secondHandle.notifyStarted).toHaveBeenCalledTimes(1);
    const notifyOrder = secondHandle.notifyStarted.mock.invocationCallOrder;
    const agentCallIndex = hoisted.callGatewayMock.mock.calls.findIndex(
      (call: unknown[]) => (call[0] as { method?: string }).method === "agent",
    );
    const agentCallOrder = hoisted.callGatewayMock.mock.invocationCallOrder[agentCallIndex];
    expect(typeof agentCallOrder).toBe("number");
    expect(typeof notifyOrder[0]).toBe("number");
    expect(notifyOrder[0] > agentCallOrder).toBe(true);
  });

  it("keeps inline delivery for thread-bound ACP session mode", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:telegram:group:-1003342490704:topic:2",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:-1003342490704",
        agentThreadId: "2",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.mode).toBe("session");
    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    expect(agentCall?.params?.deliver).toBe(true);
    expect(agentCall?.params?.channel).toBe("telegram");
  });

  it("disposes pre-registered parent relay when initial ACP dispatch fails", async () => {
    const relayHandle = createRelayHandle();
    hoisted.startAcpSpawnParentStreamRelayMock.mockReturnValueOnce(relayHandle);
    hoisted.callGatewayMock.mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as { method?: string };
      if (args.method === "sessions.patch") {
        return { ok: true };
      }
      if (args.method === "agent") {
        throw new Error("agent dispatch failed");
      }
      if (args.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        streamTo: "parent",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("agent dispatch failed");
    expect(relayHandle.dispose).toHaveBeenCalledTimes(1);
    expect(relayHandle.notifyStarted).not.toHaveBeenCalled();
  });

  it('rejects streamTo="parent" without requester session context', async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        streamTo: "parent",
      },
      {
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain('streamTo="parent"');
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });
});
