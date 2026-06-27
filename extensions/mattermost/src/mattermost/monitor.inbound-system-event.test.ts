// Mattermost tests cover monitor.inbound system event plugin behavior.
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
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
  overrides: {
    inboundDebounceMs?: number;
    isControlCommandMessage?: (text?: string) => boolean;
    shouldComputeCommandAuthorized?: (text?: string) => boolean;
    shouldHandleTextCommands?: () => boolean;
    textHasControlCommand?: (text?: string) => boolean;
    createInboundDebouncer?: typeof createInboundDebouncer;
  } = {},
) {
  const dispatchPreparedForTest = vi.fn(
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
        ) => Parameters<typeof dispatchPreparedForTest>[0];
      };
    }) => {
      const input = params.adapter.ingest(params.raw);
      const turn = params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      );
      return await dispatchPreparedForTest(turn);
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
        isControlCommandMessage: overrides.isControlCommandMessage ?? (() => false),
        shouldComputeCommandAuthorized: overrides.shouldComputeCommandAuthorized ?? (() => false),
        shouldHandleTextCommands: overrides.shouldHandleTextCommands ?? (() => false),
      },
      debounce: {
        resolveInboundDebounceMs: () => overrides.inboundDebounceMs ?? 0,
        createInboundDebouncer:
          overrides.createInboundDebouncer ??
          (<T>(params: { onFlush: (entries: T[]) => Promise<void> | void }) => ({
            enqueue: async (entry: T) => {
              await params.onFlush([entry]);
            },
          })),
      },
      groups: {
        resolveRequireMention: (params: { requireMentionOverride?: boolean }) =>
          params.requireMentionOverride ?? false,
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
      inbound: {
        run,
      },
      text: {
        chunkMarkdownTextWithMode: (text: string) => [text],
        convertMarkdownTables: (text: string) => text,
        hasControlCommand: overrides.textHasControlCommand ?? (() => false),
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

describe("mattermost inbound user posts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.abortController = undefined;
    mockState.runtimeCore = createRuntimeCore(testConfig);
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      flush: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    });
    mockState.fetchMattermostMe.mockResolvedValue({
      id: "bot-user",
      username: "openclaw",
      update_at: 1,
    });
    mockState.registerMattermostMonitorSlashCommands.mockResolvedValue(undefined);
    mockState.registerPluginHttpRoute.mockReturnValue(vi.fn());
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

  it("dispatches a bare bot mention whose body is empty after normalization as a wake event", async () => {
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
          id: "post-bare-mention",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "@openclaw",
          create_at: 1_714_000_000_001,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("@openclaw");
    expect(ctx?.MessageSid).toBe("post-bare-mention");
    expect(ctx?.OriginatingChannel).toBe("mattermost");
    expect(ctx?.Provider).toBe("mattermost");
  });

  it("merges Mattermost progress preview updates and clears after message-tool delivery", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const draftStream = {
      update: vi.fn(),
      flush: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    mockState.createMattermostDraftStream.mockReturnValue(draftStream);
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "progress",
            progress: {
              label: false,
              toolProgress: true,
            },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    mockState.dispatchReplyFromConfig.mockImplementation(async (params) => {
      await params.replyOptions?.onToolStart?.({
        toolCallId: "read-1",
        name: "read",
        phase: "start",
      });
      params.replyOptions?.onAssistantMessageStart?.();
      params.replyOptions?.onReasoningEnd?.();
      await params.replyOptions?.onToolStart?.({
        toolCallId: "exec-1",
        name: "exec",
        phase: "start",
      });
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool:read-1",
        kind: "tool",
        name: "read",
        status: "completed",
        progressText: "done",
      });
      await params.replyOptions?.onReasoningStream?.({ text: "Thinking" });
      await params.replyOptions?.onReasoningEnd?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Checking" });
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool:read-1",
        kind: "tool",
        name: "read",
        status: "completed",
        progressText: "done",
      });
      await params.replyOptions?.onObservedReplyDelivery?.();
      abortController.abort();
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
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
          id: "post-progress",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "run this",
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

    const replyOptions = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    const updates = draftStream.update.mock.calls.map((call) => String(call[0]));
    expect(updates.at(-1)).toContain("Read");
    expect(updates.at(-1)).toContain("Exec");
    expect(updates.at(-1)).toContain("done");
    expect(updates.at(-1)).toContain("Checking");
    expect(updates.at(-1)).not.toContain("ThinkingChecking");
  });

  it("does not drop inline command-looking group text from non-command-authorized senders", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const inlineCommandConfig: OpenClawConfig = {
      commands: { useAccessGroups: true },
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
    const isControlCommandMessage = vi.fn(() => false);
    const shouldComputeCommandAuthorized = vi.fn(() => true);
    mockState.runtimeCore = createRuntimeCore(inlineCommandConfig, undefined, {
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands: () => true,
    });

    const monitor = monitorMattermostProvider({
      config: inlineCommandConfig,
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
          id: "post-inline-command",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "hello /status",
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

    expect(isControlCommandMessage).toHaveBeenCalledWith("hello /status", inlineCommandConfig);
    expect(mockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("hello /status");
    expect(ctx?.CommandAuthorized).toBe(false);
    // Inline non-control text must not be tagged as an explicit text-slash command turn —
    // only authorized control commands take the source-reply suppression bypass.
    expect(ctx?.CommandSource).toBeUndefined();
  });

  // Regression for issue #86664: typed `/reset` (and `/new`) on a Mattermost DM under
  // message_tool_only source delivery (e.g. Codex harness default) silently dropped the
  // acknowledgement because the inbound context was not tagged as an explicit text-slash
  // command turn. The explicit-command exception in source-reply-delivery-mode.ts only
  // fires when CommandSource is "text" (or "native") AND CommandAuthorized is true. Mirrors
  // the iMessage fix from #82642.
  it("tags authorized typed text-slash control commands with CommandSource: text", async () => {
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
    const isControlCommandMessage = vi.fn((text?: string) =>
      ["/reset", "/new"].includes(text?.trim() ?? ""),
    );
    const shouldComputeCommandAuthorized = vi.fn(() => true);
    mockState.runtimeCore = createRuntimeCore(directConfig, undefined, {
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands: () => true,
    });
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
          id: "post-reset",
          channel_id: "dm-1",
          user_id: "user-1",
          message: " /reset",
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

    expect(mockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("/reset");
    expect(ctx?.CommandBody).toBe("/reset");
    expect(ctx?.CommandAuthorized).toBe(true);
    expect(ctx?.CommandSource).toBe("text");
  });

  it("uses websocket channel type when REST channel lookup fails", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const runtimeCore = createRuntimeCore(testConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue(null);

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
        channel_type: "O",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-ws-kind",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "hello with websocket kind",
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

    expect(mockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("hello with websocket kind");
    expect(ctx?.ChatType).toBe("channel");
    expect(ctx?.ConversationLabel).toBe("Town Square id:chan-1");
    expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it("drops posts when neither REST nor websocket channel type can be resolved", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const channelTypeConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["trusted-user"],
        },
      },
    };
    const runtimeCore = createRuntimeCore(channelTypeConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue(null);

    const monitor = monitorMattermostProvider({
      config: channelTypeConfig,
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
        sender_name: "mallory",
        post: JSON.stringify({
          id: "post-missing-kind",
          channel_id: "dm-1",
          user_id: "new-user",
          message: "hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "new-user",
      },
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
  });

  it("flushes pending group text before authorizing a bare abort without a mention", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const mentionConfig: OpenClawConfig = {
      commands: { useAccessGroups: false },
      messages: { inbound: { debounceMs: 60_000 } },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "oncall",
          dmPolicy: "open",
          groupPolicy: "open",
        },
      },
    };
    const isBareAbort = (text?: string) => ["abort", "stop"].includes(text?.trim() ?? "");
    const runtimeCore = createRuntimeCore(mentionConfig, undefined, {
      inboundDebounceMs: 60_000,
      createInboundDebouncer,
      isControlCommandMessage: isBareAbort,
      shouldComputeCommandAuthorized: isBareAbort,
      shouldHandleTextCommands: () => true,
      textHasControlCommand: () => false,
    });
    mockState.runtimeCore = runtimeCore;

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
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
          id: "post-pending",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "pending text",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    expect(mockState.dispatchReplyFromConfig).not.toHaveBeenCalled();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-abort",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "abort",
          create_at: 1_714_000_000_100,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("abort");
    expect(ctx?.CommandAuthorized).toBe(true);
  });

  it("uses an edit-specific message id for edited post turns", async () => {
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
      event: "post_edited",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-lone-edit",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "@openclaw edited wake",
          create_at: 1_714_000_000_000,
          edit_at: 1_714_000_000_125,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("edited wake");
    expect(ctx?.MessageSid).toBe("post-lone-edit:edit:1714000000125");
    expect(ctx?.MessageSids).toBeUndefined();
  });

  it("collapses debounced edited posts to the latest post body", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const debounceConfig: OpenClawConfig = {
      ...testConfig,
      messages: { inbound: { debounceMs: 5 } },
    };
    const runtimeCore = createRuntimeCore(debounceConfig, undefined, {
      inboundDebounceMs: 5,
      createInboundDebouncer,
    });
    mockState.runtimeCore = runtimeCore;

    const monitor = monitorMattermostProvider({
      config: debounceConfig,
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
          id: "post-edited",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "stale pre-edit text",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    await socket.emitMessage({
      event: "post_edited",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-edited",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "@openclaw latest edited text",
          create_at: 1_714_000_000_000,
          edit_at: 1_714_000_000_050,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });

    await vi.waitFor(() => {
      expect(mockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    });
    socket.emitClose(1000);
    await monitor;

    const ctx = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("latest edited text");
    expect(ctx?.Body).toContain("latest edited text");
    expect(ctx?.Body).not.toContain("stale pre-edit text");
    expect(ctx?.MessageSid).toBe("post-edited:edit:1714000000050");
    expect(ctx?.MessageSids).toEqual(["post-edited", "post-edited:edit:1714000000050"]);
    expect(ctx?.MessageSidFirst).toBe("post-edited");
    expect(ctx?.MessageSidLast).toBe("post-edited:edit:1714000000050");
  });

  it("does not let bot edited draft posts consume debounced user posts", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const debounceConfig: OpenClawConfig = {
      ...testConfig,
      messages: { inbound: { debounceMs: 5 } },
    };
    const runtimeCore = createRuntimeCore(debounceConfig, undefined, {
      inboundDebounceMs: 5,
      createInboundDebouncer,
    });
    mockState.runtimeCore = runtimeCore;

    const monitor = monitorMattermostProvider({
      config: debounceConfig,
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
          id: "post-user",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "user question",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    await socket.emitMessage({
      event: "post_edited",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "openclaw",
        post: JSON.stringify({
          id: "preview-post",
          channel_id: "chan-1",
          user_id: "bot-user",
          message: "bot draft preview",
          create_at: 1_714_000_000_025,
          edit_at: 1_714_000_000_050,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "bot-user",
      },
    });

    await vi.waitFor(() => {
      expect(mockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    });
    socket.emitClose(1000);
    await monitor;

    const ctx = mockState.dispatchReplyFromConfig.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("user question");
    expect(ctx?.Body).toContain("user question");
    expect(ctx?.Body).not.toContain("bot draft preview");
    expect(ctx?.MessageSid).toBe("post-user");
    expect(ctx?.MessageSids).toBeUndefined();
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
    const { monitorMattermostProvider: monitorMattermostProviderLocal } =
      await import("./monitor.js");

    const monitor = monitorMattermostProviderLocal({
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
