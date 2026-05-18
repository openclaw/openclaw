import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { monitorMattermostProvider } from "./monitor.js";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";

class FakeWebSocket {
  public readonly sent: string[] = [];
  private readonly openListeners: Array<() => void> = [];
  private readonly messageListeners: Array<(data: Buffer) => void | Promise<void>> = [];
  private readonly pongListeners: Array<(data: Buffer) => void> = [];
  private readonly closeListeners: Array<(code: number, reason: Buffer) => void> = [];
  private readonly errorListeners: Array<(err: unknown) => void> = [];

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void | Promise<void>): void;
  on(event: "pong", listener: (data: Buffer) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: "open" | "message" | "pong" | "close" | "error", listener: unknown): void {
    if (event === "open") {
      this.openListeners.push(listener as () => void);
      return;
    }
    if (event === "message") {
      this.messageListeners.push(listener as (data: Buffer) => void | Promise<void>);
      return;
    }
    if (event === "pong") {
      this.pongListeners.push(listener as (data: Buffer) => void);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener as (code: number, reason: Buffer) => void);
      return;
    }
    this.errorListeners.push(listener as (err: unknown) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {}

  close(): void {}

  terminate(): void {}

  get openListenerCount(): number {
    return this.openListeners.length;
  }

  emitOpen(): void {
    for (const listener of this.openListeners) {
      listener();
    }
  }

  async emitMessage(payload: unknown): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(payload), "utf8");
    await Promise.all(this.messageListeners.map((listener) => Promise.resolve(listener(buffer))));
  }

  emitClose(code: number, reason = ""): void {
    const buffer = Buffer.from(reason, "utf8");
    for (const listener of this.closeListeners) {
      listener(code, buffer);
    }
  }

  emitError(err: unknown): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}

const mockState = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  createMattermostClient: vi.fn(),
  createMattermostDraftStream: vi.fn(),
  dispatchReplyFromConfig: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  fetchMattermostMe: vi.fn(),
  interactionHandler: undefined as
    | ((req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void)
    | undefined,
  registerMattermostMonitorSlashCommands: vi.fn(),
  registerPluginHttpRoute: vi.fn(),
  resolveChannelInfo: vi.fn(),
  resolveMattermostMedia: vi.fn(),
  resolveUserInfo: vi.fn(),
  runtimeCore: undefined as unknown,
  updateMattermostPost: vi.fn(),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createMattermostClient: mockState.createMattermostClient,
    fetchMattermostMe: mockState.fetchMattermostMe,
    normalizeMattermostBaseUrl: (value: string | undefined) => value?.trim() ?? "",
    updateMattermostPost: mockState.updateMattermostPost,
  };
});

vi.mock("./draft-stream.js", () => ({
  buildMattermostToolStatusText: () => "Working",
  createMattermostDraftStream: mockState.createMattermostDraftStream,
}));

vi.mock("./monitor-resources.js", () => ({
  createMattermostMonitorResources: () => ({
    resolveMattermostMedia: mockState.resolveMattermostMedia,
    sendTypingIndicator: vi.fn(async () => {}),
    resolveChannelInfo: mockState.resolveChannelInfo,
    resolveUserInfo: mockState.resolveUserInfo,
    updateModelPickerPost: vi.fn(async () => {}),
  }),
}));

vi.mock("./monitor-slash.js", () => ({
  registerMattermostMonitorSlashCommands: mockState.registerMattermostMonitorSlashCommands,
}));

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  return {
    ...actual,
    buildAgentMediaPayload: vi.fn(() => ({})),
    createChannelPairingController: vi.fn(() => ({
      readStoreForDmPolicy: vi.fn(async () => []),
      upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
    })),
    createChannelMessageReplyPipeline: vi.fn(() => ({
      onModelSelected: vi.fn(),
      typingCallbacks: {},
    })),
    registerPluginHttpRoute: mockState.registerPluginHttpRoute,
    resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
    warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
  };
});

function createRuntimeCore(
  cfg: OpenClawConfig,
  routeOverride?: {
    accountId?: string;
    agentId?: string;
    lastRoutePolicy?: "main" | "session";
    mainSessionKey?: string;
    sessionKey?: string;
  },
) {
  const runPrepared = vi.fn(
    async (turn: {
      storePath: string;
      routeSessionKey: string;
      ctxPayload: { SessionKey?: string };
      recordInboundSession: (params: unknown) => Promise<void>;
      record?: {
        groupResolution?: unknown;
        createIfMissing?: boolean;
        updateLastRoute?: unknown;
        onRecordError?: (err: unknown) => void;
      };
      runDispatch: () => Promise<{
        queuedFinal: boolean;
        counts: { tool: number; block: number; final: number };
      }>;
    }) => {
      await turn.recordInboundSession({
        storePath: turn.storePath,
        sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
        ctx: turn.ctxPayload,
        groupResolution: turn.record?.groupResolution,
        createIfMissing: turn.record?.createIfMissing,
        updateLastRoute: turn.record?.updateLastRoute,
        onRecordError: turn.record?.onRecordError ?? (() => undefined),
      });
      const dispatchResult = await turn.runDispatch();
      return {
        admission: { kind: "dispatch" as const },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.routeSessionKey,
        dispatchResult,
      };
    },
  );
  const run = vi.fn(
    async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => unknown;
        resolveTurn: (
          input: unknown,
          eventClass: { kind: "message"; canStartAgentTurn: true },
          preflight: Record<string, never>,
        ) => Parameters<typeof runPrepared>[0];
      };
    }) => {
      const input = params.adapter.ingest(params.raw);
      const turn = params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      );
      return await runPrepared(turn);
    },
  );
  return {
    config: {
      current: () => cfg,
    },
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    },
    media: {
      mediaKindFromMime: () => "document",
    },
    system: {
      enqueueSystemEvent: mockState.enqueueSystemEvent,
    },
    channel: {
      activity: {
        record: vi.fn(),
      },
      commands: {
        shouldHandleTextCommands: () => false,
      },
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: <T>(params: {
          onFlush: (entries: T[]) => Promise<void> | void;
        }) => ({
          enqueue: async (entry: T) => {
            await params.onFlush([entry]);
          },
        }),
      },
      groups: {
        resolveRequireMention: () => false,
      },
      media: {
        readRemoteMediaBuffer: vi.fn(),
        saveMediaBuffer: vi.fn(),
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: () => false,
      },
      pairing: {
        buildPairingReply: () => "pairing required",
      },
      reply: {
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: vi.fn(),
          markRunComplete: vi.fn(),
        })),
        dispatchReplyFromConfig: mockState.dispatchReplyFromConfig,
        finalizeInboundContext: (context: unknown) => context,
        formatInboundEnvelope: (params: { channel: string; from: string; body: string }) =>
          `${params.channel} ${params.from}\n${params.body}`,
        resolveHumanDelayConfig: () => ({}),
        withReplyDispatcher: async (params: { run: () => unknown; onSettled?: () => void }) => {
          try {
            return await params.run();
          } finally {
            params.onSettled?.();
          }
        },
      },
      routing: {
        resolveAgentRoute: () => ({
          accountId: routeOverride?.accountId ?? "default",
          agentId: routeOverride?.agentId ?? "main",
          lastRoutePolicy: routeOverride?.lastRoutePolicy ?? "main",
          mainSessionKey: routeOverride?.mainSessionKey ?? "mattermost:default:channel:chan-1",
          sessionKey: routeOverride?.sessionKey ?? "mattermost:default:channel:chan-1",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-test-sessions.json",
        recordInboundSession: vi.fn(
          async (_params: {
            createIfMissing?: unknown;
            groupResolution?: unknown;
            onRecordError?: unknown;
            sessionKey?: string;
            storePath?: string;
            updateLastRoute?: {
              accountId?: string;
              channel?: string;
              mainDmOwnerPin?: {
                onSkip?: unknown;
                ownerRecipient?: string;
                senderRecipient?: string;
              };
              sessionKey?: string;
              to?: string;
            };
          }) => {},
        ),
        updateLastRoute: vi.fn(async () => {}),
      },
      turn: {
        run,
        runPrepared,
      },
      text: {
        chunkMarkdownTextWithMode: (text: string) => [text],
        convertMarkdownTables: (text: string) => text,
        hasControlCommand: () => false,
        resolveChunkMode: () => "off",
        resolveMarkdownTableMode: () => "off",
        resolveTextChunkLimit: () => 4000,
      },
    },
  };
}

const testConfig: OpenClawConfig = {
  channels: {
    mattermost: {
      enabled: true,
      baseUrl: "https://mattermost.example.com",
      botToken: "bot-token",
      chatmode: "onmessage",
      dmPolicy: "open",
      groupPolicy: "open",
    },
  },
};

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => mockState.runtimeCore,
}));

const testRuntime = (): RuntimeEnv =>
  ({
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  }) satisfies RuntimeEnv;

function createInteractionRequest(params: {
  body: unknown;
  remoteAddress?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const body = JSON.stringify(params.body);
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const req = {
    destroyed: false,
    method: "POST",
    headers: params.headers ?? {},
    socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
    destroy: vi.fn(),
    on(event: string, handler: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
      return this;
    },
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? [];
      listeners.set(
        event,
        existing.filter((entry) => entry !== handler),
      );
      return this;
    },
  } as unknown as IncomingMessage & { emitTest: (event: string, ...args: unknown[]) => void };

  req.emitTest = (event: string, ...args: unknown[]) => {
    const handlers = listeners.get(event) ?? [];
    for (const handler of handlers) {
      handler(...args);
    }
  };

  queueMicrotask(() => {
    req.emitTest("data", Buffer.from(body));
    req.emitTest("end");
  });

  return req;
}

function createInteractionResponse(): ServerResponse & {
  headers: Record<string, string>;
  body: string;
} {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name: string, value: string | number | readonly string[]) {
      res.headers[name] = Array.isArray(value) ? value.join(",") : String(value);
      return res;
    },
    end(
      chunk?: string | Buffer | Uint8Array,
      _encoding?: BufferEncoding | (() => void),
      cb?: () => void,
    ) {
      res.body = chunk ? String(chunk) : "";
      cb?.();
      return res;
    },
  } as ServerResponse & { headers: Record<string, string>; body: string };
  return res;
}

async function runRegisteredInteractionHandler(body: unknown) {
  const handler = mockState.interactionHandler;
  expect(handler).toBeDefined();
  const res = createInteractionResponse();
  await handler?.(createInteractionRequest({ body }), res);
  return res;
}

describe("mattermost inbound user posts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.abortController = undefined;
    mockState.interactionHandler = undefined;
    mockState.runtimeCore = createRuntimeCore(testConfig);
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      stop: vi.fn(async () => {}),
    });
    mockState.fetchMattermostMe.mockResolvedValue({
      id: "bot-user",
      username: "openclaw",
      update_at: 1,
    });
    mockState.registerMattermostMonitorSlashCommands.mockResolvedValue(undefined);
    mockState.registerPluginHttpRoute.mockImplementation(
      (params: { handler: NonNullable<typeof mockState.interactionHandler> }) => {
        mockState.interactionHandler = params.handler;
        return vi.fn();
      },
    );
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "chan-1",
      name: "town-square",
      display_name: "Town Square",
      team_id: "team-1",
      type: "O",
    });
    mockState.resolveMattermostMedia.mockResolvedValue([]);
    mockState.resolveUserInfo.mockResolvedValue({ id: "user-1", username: "alice" });
    mockState.dispatchReplyFromConfig.mockImplementation(async () => {
      mockState.abortController?.abort();
    });
  });

  it("does not enqueue regular user posts as system events", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-1",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "hello from mattermost",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("hello from mattermost");
    expect(ctx?.ConversationLabel).toBe("Town Square id:chan-1");
    expect(ctx?.MessageSid).toBe("post-1");
    expect(ctx?.OriginatingChannel).toBe("mattermost");
    expect(ctx?.Provider).toBe("mattermost");
  });

  it("drops user posts when channel type is unavailable from payload and lookup", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const restrictedDmConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "pairing",
          groupPolicy: "open",
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(restrictedDmConfig);
    mockState.resolveChannelInfo.mockResolvedValue(null);
    const { monitorMattermostProvider } = await import("./monitor.js");

    const monitor = monitorMattermostProvider({
      config: restrictedDmConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "dm-lookup-failed",
        sender_name: "mallory",
        post: JSON.stringify({
          id: "post-missing-type",
          channel_id: "dm-lookup-failed",
          user_id: "user-1",
          message: "direct hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-lookup-failed",
        user_id: "user-1",
      },
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.resolveChannelInfo).toHaveBeenCalledWith("dm-lookup-failed");
    expect(mockState.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("skips button system events and synthetic dispatch when channel lookup later fails", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const requestLog: string[] = [];
    mockState.createMattermostClient.mockReturnValue({
      request: vi.fn(async (path: string) => {
        requestLog.push(path);
        return {
          id: "post-button",
          channel_id: "button-channel",
          message: "Choose",
          props: {
            attachments: [
              {
                actions: [{ id: "approve", name: "Approve" }],
              },
            ],
          },
        };
      }),
    });
    mockState.resolveChannelInfo
      .mockResolvedValueOnce({
        id: "button-channel",
        name: "town-square",
        display_name: "Town Square",
        team_id: "team-1",
        type: "O",
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const { monitorMattermostProvider } = await import("./monitor.js");

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();
    await vi.waitFor(() => {
      expect(mockState.interactionHandler).toBeDefined();
    });

    const { generateInteractionToken } = await import("./interactions.js");
    const context = {
      action_id: "approve",
      __openclaw_channel_id: "button-channel",
    };
    const res = await runRegisteredInteractionHandler({
      user_id: "user-1",
      user_name: "mallory",
      channel_id: "button-channel",
      post_id: "post-button",
      context: {
        ...context,
        _token: generateInteractionToken(context, "default"),
      },
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("{}");
    expect(requestLog).toEqual(["/posts/post-button"]);
    expect(mockState.resolveChannelInfo).toHaveBeenCalledTimes(3);
    expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mockState.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockState.updateMattermostPost).toHaveBeenCalledWith(
      expect.anything(),
      "post-button",
      expect.objectContaining({ message: "Choose" }),
    );
  });

  it("pins direct-message main route updates to the configured owner", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const directConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["user-1"],
        },
      },
    };
    const runtimeCore = createRuntimeCore(directConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "dm-1",
      name: "",
      display_name: "",
      team_id: "team-1",
      type: "D",
    });
    const monitor = monitorMattermostProvider({
      config: directConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "dm-1",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-dm-1",
          channel_id: "dm-1",
          user_id: "user-1",
          message: "direct hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
    const [recordCall] = runtimeCore.channel.session.recordInboundSession.mock.calls.at(0) ?? [];
    expect(recordCall?.storePath).toBe("/tmp/openclaw-test-sessions.json");
    expect(recordCall?.sessionKey).toBe("mattermost:default:channel:chan-1");
    const updateLastRoute = recordCall?.updateLastRoute;
    expect(updateLastRoute?.sessionKey).toBe("mattermost:default:channel:chan-1");
    expect(updateLastRoute?.channel).toBe("mattermost");
    expect(updateLastRoute?.to).toBe("user:user-1");
    expect(updateLastRoute?.accountId).toBe("default");
    expect(updateLastRoute?.mainDmOwnerPin?.ownerRecipient).toBe("user-1");
    expect(updateLastRoute?.mainDmOwnerPin?.senderRecipient).toBe("user-1");
    expect(typeof updateLastRoute?.mainDmOwnerPin?.onSkip).toBe("function");
    expect(recordCall?.createIfMissing).toBeUndefined();
    expect(recordCall?.groupResolution).toBeUndefined();
    expect(recordCall?.onRecordError).toBeInstanceOf(Function);
  });

  it("keeps per-channel direct-message route updates on the isolated session", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const directConfig: OpenClawConfig = {
      session: { dmScope: "per-channel-peer" },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["user-1"],
        },
      },
    };
    const runtimeCore = createRuntimeCore(directConfig, {
      lastRoutePolicy: "session",
      mainSessionKey: "agent:main:main",
      sessionKey: "agent:main:mattermost:direct:user-1",
    });
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "dm-1",
      name: "",
      display_name: "",
      team_id: "team-1",
      type: "D",
    });
    const { monitorMattermostProvider } = await import("./monitor.js");

    const monitor = monitorMattermostProvider({
      config: directConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "dm-1",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-dm-2",
          channel_id: "dm-1",
          user_id: "user-1",
          message: "isolated direct hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
    const [recordCall] = runtimeCore.channel.session.recordInboundSession.mock.calls.at(0) ?? [];
    expect(recordCall?.sessionKey).toBe("agent:main:mattermost:direct:user-1");
    const updateLastRoute = recordCall?.updateLastRoute;
    expect(updateLastRoute?.sessionKey).toBe("agent:main:mattermost:direct:user-1");
    expect(updateLastRoute?.sessionKey).not.toBe("agent:main:main");
    expect(updateLastRoute?.channel).toBe("mattermost");
    expect(updateLastRoute?.to).toBe("user:user-1");
    expect(updateLastRoute?.accountId).toBe("default");
    expect(updateLastRoute?.mainDmOwnerPin).toBeUndefined();
  });
});
