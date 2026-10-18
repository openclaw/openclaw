import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  createPluginRuntimeMock,
  createTestInboundDebounceFlush,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createRuntimeEnv as testRuntime } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostPost } from "./client.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import { registerMattermostBlockProgressTests } from "./monitor.block-progress.test-support.js";
import { monitorMattermostProvider } from "./monitor.js";
import { registerMattermostPreviewDeliveryTests } from "./monitor.preview-delivery.test-support.js";
import { registerMattermostPreviewPolicyTests } from "./monitor.preview-policy.test-support.js";
import type { OpenClawConfig, ReplyPayload } from "./runtime-api.js";

class FakeWebSocket extends EventEmitter<{
  open: [];
  message: [Buffer];
  pong: [Buffer];
  close: [number, Buffer];
  error: [unknown];
}> {
  send(_data: string): void {}
  ping(): void {}
  close(): void {}
  terminate(): void {
    this.emit("close", 1000, Buffer.alloc(0));
  }
  async emitMessage(payload: unknown): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(payload), "utf8");
    await Promise.all(
      this.listeners("message").map((listener) => Promise.resolve(listener(buffer))),
    );
  }
}

const mockState = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  createReplyDispatcherWithTyping: vi.fn(),
  createMattermostClient: vi.fn(),
  createMattermostDraftStream: vi.fn(),
  deliveryPlanObserver: vi.fn(),
  dispatchInboundMessage: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  fetchMattermostMe: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  ingressQueue: undefined as unknown,
  progressDrafts: [] as Array<{ getSnapshot: () => { lines: readonly unknown[] } }>,
  registerMattermostMonitorSlashCommands: vi.fn(),
  registerPluginHttpRoute: vi.fn(),
  recordMattermostThreadParticipation: vi.fn(),
  resolveChannelInfo: vi.fn(),
  resolveMattermostMedia: vi.fn(),
  resolveUserInfo: vi.fn(),
  runtimeCore: undefined as unknown,
  sendMessageMattermost: vi.fn(),
  updateMattermostPost: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner: mockState.getGlobalHookRunner,
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelProgressDraftCompositor: (
      ...args: Parameters<typeof actual.createChannelProgressDraftCompositor>
    ) => {
      const draft = actual.createChannelProgressDraftCompositor(...args);
      mockState.progressDrafts.push(draft);
      return draft;
    },
  };
});

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createMattermostClient: mockState.createMattermostClient,
  fetchMattermostMe: mockState.fetchMattermostMe,
  normalizeMattermostBaseUrl: (value: string | undefined) => value?.trim() ?? "",
  updateMattermostPost: mockState.updateMattermostPost,
}));

vi.mock("./draft-stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./draft-stream.js")>()),
  createMattermostDraftStream: mockState.createMattermostDraftStream,
}));

vi.mock("./monitor-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-resources.js")>()),
  createMattermostMonitorResources: () => ({
    resolveMattermostMedia: mockState.resolveMattermostMedia,
    sendTypingIndicator: vi.fn(async () => {}),
    resolveChannelInfo: mockState.resolveChannelInfo,
    resolveUserInfo: mockState.resolveUserInfo,
    updateModelPickerPost: vi.fn(async () => {}),
  }),
}));

vi.mock("./monitor-ingress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor-ingress.js")>();
  return {
    ...actual,
    createMattermostIngressMonitor: (
      options: Parameters<typeof actual.createMattermostIngressMonitor>[0],
    ) => {
      if (mockState.ingressQueue) {
        return actual.createMattermostIngressMonitor({
          ...options,
          queue: mockState.ingressQueue as NonNullable<typeof options.queue>,
          pollIntervalMs: 60_000,
        });
      }
      return {
        receive: async (rawEvent: string) => {
          const payload = JSON.parse(rawEvent) as MattermostEventPayload;
          const post =
            typeof payload.data?.post === "string"
              ? (JSON.parse(payload.data.post) as MattermostPost)
              : (payload.data?.post as MattermostPost | undefined);
          if (payload.event !== "posted" || !post) {
            return;
          }
          const senderId = post.user_id?.trim();
          if (!senderId) {
            throw new Error("Mattermost posted event is missing post.user_id");
          }
          await options.dispatch({ ...post, user_id: senderId }, payload, {
            abortSignal: new AbortController().signal,
            onAdopted: async () => {},
            onDeferred: () => {},
            onAdoptionFinalizing: () => {},
            onAbandoned: async () => {},
          });
        },
        stop: async () => {},
        waitForIdle: async () => {},
      };
    },
  };
});

vi.mock("./monitor-slash.js", () => ({
  registerMattermostMonitorSlashCommands: mockState.registerMattermostMonitorSlashCommands,
}));

vi.mock("./thread-participation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-participation.js")>()),
  recordMattermostThreadParticipation: mockState.recordMattermostThreadParticipation,
}));

vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  createChannelPairingController: vi.fn(() => ({
    readStoreForDmPolicy: vi.fn(async () => []),
    upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
  })),
  createChannelMessageReplyPipeline: vi.fn((params: { cfg: OpenClawConfig }) => ({
    onModelSelected: vi.fn(),
    typingCallbacks: {},
    resolveResponsePrefix: () => params.cfg.channels?.mattermost?.responsePrefix,
  })),
  registerPluginHttpRoute: mockState.registerPluginHttpRoute,
  resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
  warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageMattermost: mockState.sendMessageMattermost,
}));

function installRuntime(
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
    resolveInboundDebounceMs?: typeof resolveInboundDebounceMs;
    isControlCommandMessage?: (text?: string) => boolean;
    shouldHandleTextCommands?: () => boolean;
    createInboundDebouncer?: typeof createInboundDebouncer;
    verboseDebug?: (message: string) => void;
    chunkMarkdownTextWithMode?: PluginRuntime["channel"]["text"]["chunkMarkdownTextWithMode"];
    chunkMode?: "length" | "newline";
    textChunkLimit?: number;
  } = {},
) {
  type ReplyDispatcherOptions = {
    deliver: (payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
  };
  mockState.createReplyDispatcherWithTyping.mockImplementation(
    (options: ReplyDispatcherOptions) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
      options,
    }),
  );
  type RecordInboundSessionInput = Parameters<
    PluginRuntime["channel"]["session"]["recordInboundSession"]
  >[0];
  const recordInboundSession = vi.fn(async (_params: RecordInboundSessionInput) => {});
  const run = vi.fn(
    async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => unknown;
        resolveTurn: (
          input: unknown,
          eventClass: { kind: "message"; canStartAgentTurn: true },
          preflight: Record<string, never>,
        ) => ChannelInboundTurnPlan;
      };
    }) => {
      const input = params.adapter.ingest(params.raw);
      const turn = params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      );
      mockState.deliveryPlanObserver(turn.delivery.observeMessageSent);
      await recordInboundSession({
        storePath: "/tmp/openclaw-test-sessions.json",
        sessionKey: turn.ctxPayload.SessionKey ?? turn.route.sessionKey,
        ctx: turn.ctxPayload,
        groupResolution: turn.record?.groupResolution,
        createIfMissing: turn.record?.createIfMissing,
        updateLastRoute: turn.record?.updateLastRoute,
        onRecordError: turn.record?.onRecordError ?? (() => undefined),
      });
      const prepared = mockState.createReplyDispatcherWithTyping({
        ...turn.dispatcherOptions,
        deliver: turn.delivery.deliver,
        onError: turn.delivery.onError,
      });
      const dispatchResult = await mockState.dispatchInboundMessage({
        ctx: turn.ctxPayload,
        cfg: turn.cfg,
        dispatcher: prepared.dispatcher,
        replyOptions: { ...prepared.replyOptions, ...turn.replyOptions },
        onSettled: turn.dispatcherOptions?.onSettled,
      });
      return {
        admission: { kind: "dispatch" as const },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.route.sessionKey,
        dispatchResult,
      };
    },
  );
  return (mockState.runtimeCore = {
    config: { current: () => cfg },
    logging: {
      shouldLogVerbose: () => Boolean(overrides.verboseDebug),
      getChildLogger: () => ({
        debug: overrides.verboseDebug ?? vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    },
    system: { enqueueSystemEvent: mockState.enqueueSystemEvent },
    channel: {
      activity: { record: vi.fn() },
      commands: {
        isControlCommandMessage: overrides.isControlCommandMessage ?? (() => false),
        shouldHandleTextCommands: overrides.shouldHandleTextCommands ?? (() => false),
      },
      debounce: {
        resolveInboundDebounceMs:
          overrides.resolveInboundDebounceMs ?? (() => overrides.inboundDebounceMs ?? 0),
        createInboundDebouncer:
          overrides.createInboundDebouncer ??
          (<T>(params: {
            onFlush: (
              entries: T[],
              createFlush: typeof createTestInboundDebounceFlush,
            ) => { completion: Promise<void> };
          }) => ({
            enqueue: async (entry: T) => {
              await params.onFlush([entry], createTestInboundDebounceFlush).completion;
            },
            flushKey: async () => {},
            cancelKey: () => false,
            drain: async () => {},
          })),
      },
      groups: {
        resolveRequireMention: (params: { requireMentionOverride?: boolean }) =>
          params.requireMentionOverride ?? false,
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: () => false,
      },
      pairing: { buildPairingReply: () => "pairing required" },
      reply: { settleReplyDispatcher: vi.fn(async ({ onSettled }) => onSettled?.()) },
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
        recordInboundSession,
      },
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        run,
      },
      text: {
        chunkMarkdownTextWithMode:
          overrides.chunkMarkdownTextWithMode ?? ((text: string) => [text]),
        convertMarkdownTables: (text: string) => text,
        resolveChunkMode: () => overrides.chunkMode ?? "length",
        resolveMarkdownTableMode: () => "off",
        resolveTextChunkLimit: () => overrides.textChunkLimit ?? 4000,
      },
    },
  });
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
const botUser = { id: "bot-user", username: "openclaw", update_at: 1 };
const publicChannel = {
  id: "chan-1",
  name: "town-square",
  display_name: "Town Square",
  team_id: "team-1",
  type: "O",
};

function mattermostConfig(
  mattermost: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["mattermost"]>>,
  config: OpenClawConfig = {},
): OpenClawConfig {
  return {
    ...config,
    channels: {
      ...config.channels,
      mattermost: { ...testConfig.channels?.mattermost, ...mattermost },
    },
  };
}

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => mockState.runtimeCore,
  getOptionalMattermostRuntime: () => mockState.runtimeCore,
}));

function startTestMonitor(config: OpenClawConfig = testConfig) {
  const socket = new FakeWebSocket();
  const abortController = new AbortController();
  const socketFactory = vi.fn(() => socket);
  const monitor = monitorMattermostProvider({
    config,
    runtime: testRuntime(),
    abortSignal: abortController.signal,
    webSocketFactory: socketFactory,
  });
  let stopped = false;
  return {
    socket,
    abortController,
    socketFactory,
    monitor,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      abortController.abort();
      socket.emit("close", 1000, Buffer.alloc(0));
      await monitor;
    },
  };
}

async function openMonitor(config: OpenClawConfig = testConfig) {
  const provider = startTestMonitor(config);
  await vi.waitFor(() => expect(provider.socket.listenerCount("open")).toBeGreaterThan(0));
  provider.socket.emit("open");
  return provider;
}

function mattermostPostEvent(params: {
  id: string;
  message: string;
  channelId?: string;
  rootId?: string;
  senderId?: string;
  senderName?: string;
  createAt?: number;
  type?: string;
  fileIds?: string[];
  channelType?: string;
  includeChannelLabels?: boolean;
}) {
  const senderId = params.senderId ?? "user-1";
  const channelId = params.channelId ?? "chan-1";
  return {
    event: "posted",
    data: {
      ...(params.includeChannelLabels === false
        ? {}
        : { channel_name: "town-square", channel_display_name: "Town Square" }),
      channel_type: params.channelType,
      sender_name: params.senderName ?? "alice",
      post: JSON.stringify({
        id: params.id,
        channel_id: channelId,
        user_id: senderId,
        message: params.message,
        root_id: params.rootId,
        create_at: params.createAt ?? 1_714_000_000_000,
        type: params.type,
        file_ids: params.fileIds,
      }),
    },
  };
}
async function emitMattermostChannelPost(
  socket: FakeWebSocket,
  post: Parameters<typeof mattermostPostEvent>[0],
) {
  await socket.emitMessage(mattermostPostEvent(post));
}

async function receivePost(
  post: Parameters<typeof emitMattermostChannelPost>[1],
  config: OpenClawConfig = testConfig,
): Promise<ChannelInboundTurnPlan["ctxPayload"] | undefined> {
  const { socket, abortController, stop } = await openMonitor(config);
  mockState.abortController = abortController;
  try {
    await emitMattermostChannelPost(socket, post);
  } finally {
    await stop();
  }
  return mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
}

describe("mattermost inbound user posts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.abortController = undefined;
    mockState.ingressQueue = undefined;
    mockState.progressDrafts.length = 0;
    mockState.getGlobalHookRunner.mockReturnValue(null);
    installRuntime(testConfig);
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => undefined),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    mockState.fetchMattermostMe.mockResolvedValue(botUser);
    mockState.registerMattermostMonitorSlashCommands.mockResolvedValue(undefined);
    mockState.registerPluginHttpRoute.mockReturnValue(vi.fn());
    mockState.resolveChannelInfo.mockResolvedValue(publicChannel);
    mockState.resolveMattermostMedia.mockResolvedValue([]);
    mockState.resolveUserInfo.mockResolvedValue({ id: "user-1", username: "alice" });
    mockState.sendMessageMattermost.mockResolvedValue({});
    mockState.dispatchInboundMessage.mockImplementation(async () => {
      mockState.abortController?.abort();
    });
  });

  it("changes Mattermost delay at collector admission without replacing the socket", async () => {
    const cfg = { ...testConfig, messages: { inbound: { debounceMs: 0 } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    mockState.dispatchInboundMessage.mockResolvedValue(undefined);
    installRuntime(cfg, undefined, {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    });
    const { socket, socketFactory, stop } = await openMonitor(cfg);
    const bodies = () =>
      mockState.dispatchInboundMessage.mock.calls.map(([params]) => params.ctx.BodyForAgent);
    const publish = (debounceMs: number) => {
      const current = { ...cfg, messages: { inbound: { byChannel: { mattermost: debounceMs } } } };
      setRuntimeConfigSnapshot(current, current);
    };
    try {
      await emitMattermostChannelPost(socket, { id: "debounce-1", message: "immediate" });
      await vi.waitFor(() => expect(bodies()).toEqual(["immediate"]));
      publish(500);
      await emitMattermostChannelPost(socket, { id: "debounce-2", message: "buffered" });
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(bodies()).toEqual(["immediate"]);
      publish(0);
      await vi.waitFor(() => expect(bodies()).toEqual(["immediate", "buffered"]));
      await emitMattermostChannelPost(socket, { id: "debounce-3", message: "after disable" });
      await vi.waitFor(() => expect(bodies()).toEqual(["immediate", "buffered", "after disable"]));
      expect(socketFactory).toHaveBeenCalledTimes(1);
    } finally {
      await stop();
      clearRuntimeConfigSnapshot();
    }
  });

  it("accounts for abandoned dispatches and honors retry backoff after restart", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mattermost-abandon-"));
    const stateDir = await fs.realpath(created);
    type Payload = { version: 1; receivedAt: number; rawEvent: string };
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "mattermost",
      accountId: "default",
      stateDir,
    });
    mockState.ingressQueue = queue;
    installRuntime(testConfig, undefined, {
      inboundDebounceMs: 0,
      createInboundDebouncer,
    });
    mockState.dispatchInboundMessage.mockRejectedValue(
      new Error("Mattermost dispatch failed before adoption"),
    );

    const activeProviders: Array<{ stop: () => Promise<void> }> = [];
    const startProvider = async () => {
      const provider = startTestMonitor();
      const { socket } = provider;
      for (let tick = 0; tick < 20 && socket.listenerCount("open") === 0; tick += 1) {
        await Promise.resolve();
      }
      expect(socket.listenerCount("open")).toBeGreaterThan(0);
      socket.emit("open");
      activeProviders.push(provider);
      return provider;
    };
    const pendingAttempt = async (attempts: number) => {
      let observed: Awaited<ReturnType<typeof queue.listPending>>[number] | undefined;
      await vi.waitFor(async () => {
        const pending = await queue.listPending({ limit: "all" });
        expect(pending).toEqual([
          expect.objectContaining({
            id: "post-abandon-retry",
            attempts,
            lastAttemptAt: expect.any(Number),
            lastError: "turn-abandoned",
          }),
        ]);
        observed = pending[0];
      });
      const lastAttemptAt = observed?.lastAttemptAt;
      if (lastAttemptAt === undefined) {
        throw new Error(`Missing Mattermost retry timestamp for attempt ${attempts}`);
      }
      return { ...observed, lastAttemptAt };
    };

    const attemptAfterRestart = async (dispatches: number, attempts?: number) => {
      const provider = await startProvider();
      await emitMattermostChannelPost(provider.socket, {
        id: "post-abandon-retry",
        message: "retry me",
      });
      const pending = attempts === undefined ? undefined : await pendingAttempt(attempts);
      if (attempts === undefined) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(dispatches);
      await provider.stop();
      return pending?.lastAttemptAt;
    };
    try {
      const firstAttempt = await attemptAfterRestart(1, 1);
      if (firstAttempt === undefined) {
        throw new Error("Expected first attempt timestamp");
      }
      vi.setSystemTime(firstAttempt + 999);
      await attemptAfterRestart(1);
      vi.setSystemTime(firstAttempt + 1_001);
      await attemptAfterRestart(2, 2);
    } finally {
      await Promise.allSettled(activeProviders.map(async (provider) => await provider.stop()));
      mockState.ingressQueue = undefined;
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("publishes recovering while API authentication retries, including 401", async () => {
    const abortController = new AbortController();
    const statusSink = vi.fn();
    mockState.fetchMattermostMe.mockRejectedValue(new Error("HTTP 401 Unauthorized"));

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      statusSink,
    });

    await vi.waitFor(() => {
      expect(statusSink).toHaveBeenCalledWith({
        connected: false,
        lifecycle: "recovering",
        lastError: "Error: HTTP 401 Unauthorized",
      });
    });
    abortController.abort();
    await monitor;
  });

  it("does not open a websocket after slash startup fails", async () => {
    const unregisterInteractions = vi.fn();
    const statusSink = vi.fn();
    const webSocketFactory = vi.fn(() => new FakeWebSocket());
    const failure = new Error("Mattermost slash setup failed");
    mockState.registerPluginHttpRoute.mockReturnValueOnce(unregisterInteractions);
    mockState.registerMattermostMonitorSlashCommands.mockRejectedValueOnce(failure);
    await expect(
      monitorMattermostProvider({
        config: testConfig,
        runtime: testRuntime(),
        abortSignal: new AbortController().signal,
        statusSink,
        webSocketFactory,
      }),
    ).rejects.toThrow(failure.message);
    expect(unregisterInteractions).toHaveBeenCalledOnce();
    expect(webSocketFactory).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

  it("dispatches ordered attachments without logging inbound content", async () => {
    const verboseDebug = vi.fn();
    installRuntime(testConfig, undefined, { verboseDebug });
    const message = `${"a".repeat(199)}😀tail`;
    const expectedBody = `${message}\n\n[mattermost attachment unavailable] "quarterly report.pdf"`;
    const media = [
      { contentType: "application/pdf", fileName: "quarterly report.pdf", kind: "document" },
      { path: "/tmp/mattermost-attachment.png", contentType: "image/png", kind: "image" },
    ];
    mockState.resolveMattermostMedia.mockResolvedValueOnce(media);
    const ctx = await receivePost({
      id: "post-regular",
      message,
      fileIds: ["file-1", "image-1"],
    });
    expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockState.deliveryPlanObserver).toHaveBeenCalledExactlyOnceWith(true);
    expect(ctx).toMatchObject({
      BodyForAgent: expectedBody,
      ConversationLabel: "Town Square id:chan-1",
      MessageSid: "post-regular",
      ConversationRouteContextObserved: true,
      ConversationRoutePeerId: "chan-1",
      GroupSpace: "team-1",
      NativeChannelId: "chan-1",
      InboundAccessAuthorized: true,
      OriginatingChannel: "mattermost",
      Provider: "mattermost",
    });
    expect(ctx?.media).toEqual(media.map((attachment) => expect.objectContaining(attachment)));
    expect(ctx?.media?.[0]?.path).toBeUndefined();
    expect(ctx?.media?.[0]?.url).toBeUndefined();
    const diagnostics = verboseDebug.mock.calls.flat().join("\n");
    expect(diagnostics).not.toContain("a".repeat(199));
    expect(diagnostics).toContain(`id=post-regular len=${expectedBody.length}`);
  });

  it.each([
    { name: "default visibility", contextVisibility: undefined, expectedHistory: true },
    { name: "allowlist visibility", contextVisibility: "allowlist", expectedHistory: false },
  ] as const)(
    "preserves denied history policy over authenticated Mattermost HTTP and WebSocket with $name",
    async ({ contextVisibility, expectedHistory }) => {
      const token = "mattermost-loopback-proof-token";
      const requests: Array<{ path: string; authorization?: string }> = [];
      const server = createServer((request, response) => {
        requests.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(401);
          response.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        if (request.url === "/api/v4/users/me") {
          response.end(JSON.stringify(botUser));
          return;
        }
        if (request.url === "/api/v4/channels/chan-1") {
          response.end(JSON.stringify(publicChannel));
          return;
        }
        response.writeHead(404);
        response.end(JSON.stringify({ message: "unknown loopback endpoint" }));
      });
      const websocket = new WebSocketServer({ server, path: "/api/v4/websocket" });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a Mattermost loopback TCP address");
      }

      const abortController = new AbortController();
      mockState.abortController = abortController;
      const verboseDebug = vi.fn();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const config = mattermostConfig(
        {
          baseUrl,
          botToken: token,
          groupPolicy: "allowlist",
          groupAllowFrom: ["allowed-user"],
          network: { dangerouslyAllowPrivateNetwork: true },
        },
        {
          agents: { defaults: { userTimezone: "Asia/Jakarta" } },
          messages: { groupChat: { historyLimit: 2 } },
          channels: contextVisibility ? { defaults: { contextVisibility } } : {},
        },
      );
      const isControlCommandMessage = vi.fn((text?: string) => text?.trim() === "/reset");
      const runtimeCore = installRuntime(config, undefined, {
        verboseDebug,
        isControlCommandMessage,
        shouldHandleTextCommands: () => true,
      });
      const actualClient = await vi.importActual<typeof import("./client.js")>("./client.js");
      mockState.createMattermostClient.mockImplementation(actualClient.createMattermostClient);
      mockState.fetchMattermostMe.mockImplementation(actualClient.fetchMattermostMe);
      mockState.resolveChannelInfo.mockImplementation(async (channelId: string) => {
        const client = mockState.createMattermostClient.mock.results.at(-1)?.value;
        if (!client) {
          throw new Error("expected the production Mattermost HTTP client");
        }
        return await actualClient.fetchMattermostChannel(client, channelId);
      });

      const connection = once(websocket, "connection");
      let monitor: Promise<void> | undefined;
      try {
        monitor = monitorMattermostProvider({
          config,
          runtime: testRuntime(),
          abortSignal: abortController.signal,
        });
        const [socket] = await connection;
        const [rawAuthentication] = await once(socket, "message");
        expect(JSON.parse(String(rawAuthentication))).toMatchObject({
          action: "authentication_challenge",
          data: { token },
        });

        const sendPost = (post: Parameters<typeof mattermostPostEvent>[0]) => {
          socket.send(JSON.stringify(mattermostPostEvent(post)));
        };

        for (const [index, message] of ["/reset", "denied second", "denied third"].entries()) {
          sendPost({
            id: `loopback-denied-${index}`,
            message,
            senderId: "denied-user",
          });
          await vi.waitFor(() => {
            const drops = verboseDebug.mock.calls.filter(([line]) =>
              String(line).includes("drop group sender=denied-user"),
            );
            expect(drops).toHaveLength(index + 1);
          });
          expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
          expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
          expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
          expect(mockState.createReplyDispatcherWithTyping).not.toHaveBeenCalled();
        }

        sendPost({
          id: "loopback-allowed",
          message: "summarize the conversation",
          senderId: "allowed-user",
          createAt: 1_714_003_600_000,
        });
        await vi.waitFor(() => {
          expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
        });

        const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
        expect(ctx?.SenderId).toBe("allowed-user");
        expect(ctx?.BodyForAgent).toBe("summarize the conversation");
        expect(ctx?.InboundHistory?.map((entry: { body: string }) => entry.body) ?? []).toEqual(
          expectedHistory ? ["denied second", "denied third"] : [],
        );
        expect(isControlCommandMessage).toHaveBeenCalledWith("/reset", config);
        expect(ctx?.CommandSource).toBeUndefined();
        expect(ctx?.Body).not.toContain("/reset");
        expect(ctx?.Body).toContain("Thu 2024-04-25 07:06:40");
        if (expectedHistory) {
          expect(ctx?.Body).toContain("Thu 2024-04-25 06:06:40");
          expect(ctx?.Body).toContain("denied second");
          expect(ctx?.Body).toContain("denied third");
        } else {
          expect(ctx?.Body).not.toContain("denied second");
          expect(ctx?.Body).not.toContain("denied third");
        }
        expect(requests.length).toBeGreaterThanOrEqual(4);
        expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
        expect(requests.some((request) => request.path === "/api/v4/users/me")).toBe(true);
        expect(requests.some((request) => request.path === "/api/v4/channels/chan-1")).toBe(true);
      } finally {
        abortController.abort();
        for (const client of websocket.clients) {
          client.terminate();
        }
        if (monitor) {
          await monitor;
        }
        await new Promise<void>((resolve, reject) => {
          websocket.close((error) => (error ? reject(error) : resolve()));
        });
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("dispatches a bare bot mention as a wake event", async () => {
    const ctx = await receivePost({ id: "post-bare-mention", message: "@openclaw" });
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(ctx).toMatchObject({
      BodyForAgent: "@openclaw",
      MessageSid: "post-bare-mention",
      OriginatingChannel: "mattermost",
      Provider: "mattermost",
    });
  });

  it("routes a mention-prefixed text command without debouncing", async () => {
    const config = mattermostConfig(
      { chatmode: "oncall", groupAllowFrom: ["user-1"] },
      { messages: { inbound: { debounceMs: 60_000 } } },
    );
    const isControlCommandMessage = vi.fn((text?: string) => text?.trim() === "/reset");
    installRuntime(config, undefined, {
      inboundDebounceMs: 60_000,
      createInboundDebouncer,
      isControlCommandMessage,
      shouldHandleTextCommands: () => true,
    });
    const ctx = await receivePost(
      { id: "post-mention-command", message: "@openclaw /reset" },
      config,
    );
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(isControlCommandMessage).toHaveBeenCalledWith("/reset", config);
    expect(ctx).toMatchObject({
      WasMentioned: true,
      BodyForAgent: "/reset",
      CommandBody: "/reset",
      CommandAuthorized: true,
      CommandSource: "text",
    });
  });

  it.each(["O", undefined])(
    "requires a trusted channel type, using websocket fallback %s",
    async (channelType) => {
      const config = mattermostConfig({ dmPolicy: "allowlist", allowFrom: ["trusted-user"] });
      const runtimeCore = installRuntime(config);
      mockState.resolveChannelInfo.mockResolvedValue(null);
      const ctx = await receivePost(
        { id: "post-channel-kind", message: "hello", senderId: "new-user", channelType },
        config,
      );
      if (channelType) {
        expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
        expect(ctx).toMatchObject({
          BodyForAgent: "hello",
          ChatType: "channel",
          ConversationLabel: "Town Square id:chan-1",
        });
        expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
      } else {
        expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
        expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
      }
    },
  );

  it("does not debounce denied senders or system posts into an allowed turn", async () => {
    const config = mattermostConfig(
      { groupPolicy: "allowlist", groupAllowFrom: ["allowed-user"] },
      { channels: { defaults: { contextVisibility: "allowlist" } } },
    );
    installRuntime(config, undefined, {
      inboundDebounceMs: 10,
      createInboundDebouncer,
    });
    const { socket, stop } = await openMonitor(config);
    for (const post of [
      { id: "post-denied", message: "denied text", senderId: "denied-user", senderName: "mallory" },
      {
        id: "post-system",
        message: "system text",
        senderId: "allowed-user",
        type: "system_join_channel",
      },
      { id: "post-allowed", message: "allowed text", senderId: "allowed-user" },
    ]) {
      await emitMattermostChannelPost(socket, post);
    }
    await vi.waitFor(() => expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1));
    await stop();
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx).toMatchObject({ SenderId: "allowed-user", BodyForAgent: "allowed text" });
    expect(ctx?.Body).not.toContain("denied text");
    expect(ctx?.Body).not.toContain("system text");
  });

  it("flushes pending group text before authorizing a bare abort without a mention", async () => {
    const config = mattermostConfig(
      { chatmode: "oncall", groupAllowFrom: ["user-1"] },
      { messages: { inbound: { debounceMs: 60_000 } } },
    );
    const isBareAbort = (text?: string) => ["abort", "stop"].includes(text?.trim() ?? "");
    installRuntime(config, undefined, {
      inboundDebounceMs: 60_000,
      createInboundDebouncer,
      isControlCommandMessage: isBareAbort,
      shouldHandleTextCommands: () => true,
    });
    const { socket, abortController, stop } = await openMonitor(config);
    mockState.abortController = abortController;
    await emitMattermostChannelPost(socket, { id: "post-pending", message: "pending text" });
    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
    await emitMattermostChannelPost(socket, {
      id: "post-abort",
      message: "abort",
      createAt: 1_714_000_000_100,
    });
    await stop();
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx).toMatchObject({
      BodyForAgent: "abort",
      CommandAuthorized: true,
    });
  });

  it.each(["main", "session"] as const)(
    "keeps direct-message route updates on the %s owner",
    async (lastRoutePolicy) => {
      const isolated = lastRoutePolicy === "session";
      const sessionKey = isolated
        ? "agent:main:mattermost:direct:user-1"
        : "mattermost:default:channel:chan-1";
      const config = mattermostConfig(
        { dmPolicy: "allowlist", allowFrom: ["user-1"] },
        isolated ? { session: { dmScope: "per-channel-peer" } } : {},
      );
      const runtimeCore = installRuntime(config, {
        lastRoutePolicy,
        mainSessionKey: isolated ? "agent:main:main" : sessionKey,
        sessionKey,
      });
      mockState.resolveChannelInfo.mockResolvedValue({
        ...publicChannel,
        id: "dm-1",
        name: "",
        display_name: "",
        type: "D",
      });
      await receivePost(
        { id: "post-dm", message: "direct hello", channelId: "dm-1", includeChannelLabels: false },
        config,
      );
      expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
      const [record] = runtimeCore.channel.session.recordInboundSession.mock.calls.at(0) ?? [];
      expect(record).toMatchObject({
        storePath: "/tmp/openclaw-test-sessions.json",
        sessionKey,
        updateLastRoute: {
          sessionKey,
          channel: "mattermost",
          to: "user:user-1",
          accountId: "default",
        },
      });
      if (isolated) {
        expect(record?.updateLastRoute?.sessionKey).not.toBe("agent:main:main");
        expect(record?.updateLastRoute?.mainDmOwnerPin).toBeUndefined();
      } else {
        expect(record?.updateLastRoute?.mainDmOwnerPin).toMatchObject({
          ownerRecipient: "user-1",
          senderRecipient: "user-1",
          onSkip: expect.any(Function),
        });
        expect(record?.createIfMissing).toBeUndefined();
        expect(record?.groupResolution).toBeUndefined();
        expect(record?.onRecordError).toBeInstanceOf(Function);
      }
    },
  );

  const harness = { testConfig, createRuntimeCore: installRuntime, receivePost, mockState };
  registerMattermostPreviewPolicyTests(harness);
  registerMattermostBlockProgressTests(harness);
  registerMattermostPreviewDeliveryTests(harness);
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
