// Shared Mattermost inbound monitor test harness and mocks.
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { vi } from "vitest";
import type { FakeWebSocket } from "./monitor.inbound-system-event.test-helper.js";
import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "./runtime-api.js";

const mockState = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  createReplyDispatcherWithTyping: vi.fn(),
  createMattermostClient: vi.fn(),
  createMattermostDraftStream: vi.fn(),
  dispatchInboundMessage: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  fetchMattermostMe: vi.fn(),
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

export const getMattermostInboundTestState = () => mockState;

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    createReplyDispatcherWithTyping: (...args: unknown[]) =>
      mockState.createReplyDispatcherWithTyping(...args),
    dispatchInboundMessage: async (params: Parameters<typeof actual.dispatchInboundMessage>[0]) => {
      try {
        return await mockState.dispatchInboundMessage(params);
      } finally {
        await params.onSettled?.();
      }
    },
  };
});

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

vi.mock("./draft-stream.js", async () => {
  const actual = await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
  return {
    createMattermostDraftStream: mockState.createMattermostDraftStream,
    createMattermostDraftPreviewBoundaryController:
      actual.createMattermostDraftPreviewBoundaryController,
  };
});

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

vi.mock("./monitor-slash.js", () => ({
  registerMattermostMonitorSlashCommands: mockState.registerMattermostMonitorSlashCommands,
}));

vi.mock("./thread-participation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-participation.js")>()),
  recordMattermostThreadParticipation: mockState.recordMattermostThreadParticipation,
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
    createChannelMessageReplyPipeline: vi.fn((params: { cfg: OpenClawConfig }) => ({
      onModelSelected: vi.fn(),
      typingCallbacks: {},
      resolveResponsePrefix: () => params.cfg.messages?.responsePrefix,
    })),
    registerPluginHttpRoute: mockState.registerPluginHttpRoute,
    resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
    warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
  };
});

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendMessageMattermost: mockState.sendMessageMattermost,
  };
});

export function createRuntimeCore(
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
    verboseDebug?: (message: string) => void;
    chunkMarkdownTextWithMode?: (
      text: string,
      limit: number,
      mode: "length" | "newline",
    ) => string[];
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
  type RecordInboundSessionInput = {
    storePath: string;
    sessionKey: string;
    ctx: unknown;
    createIfMissing?: boolean;
    groupResolution?: unknown;
    onRecordError?: (error: unknown) => void;
    updateLastRoute?: {
      accountId?: string;
      channel?: string;
      mainDmOwnerPin?: {
        onSkip?: () => void;
        ownerRecipient?: string;
        senderRecipient?: string;
      };
      sessionKey?: string;
      to?: string;
    };
  };
  const recordInboundSession = vi.fn(async (_params: RecordInboundSessionInput) => {});
  const dispatchPreparedForTest = vi.fn(
    async (turn: {
      route: { agentId: string; sessionKey: string };
      ctxPayload: { SessionKey?: string };
      record?: {
        groupResolution?: unknown;
        createIfMissing?: boolean;
        updateLastRoute?: RecordInboundSessionInput["updateLastRoute"];
        onRecordError?: (err: unknown) => void;
      };
      runDispatch: () => Promise<{
        queuedFinal: boolean;
        counts: { tool: number; block: number; final: number };
      }>;
    }) => {
      await recordInboundSession({
        storePath: "/tmp/openclaw-test-sessions.json",
        sessionKey: turn.ctxPayload.SessionKey ?? turn.route.sessionKey,
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
        routeSessionKey: turn.route.sessionKey,
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
      shouldLogVerbose: () => Boolean(overrides.verboseDebug),
      getChildLogger: () => ({
        debug: overrides.verboseDebug ?? vi.fn(),
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
        settleReplyDispatcher: vi.fn(async ({ onSettled }) => onSettled?.()),
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
        recordInboundSession,
        updateLastRoute: vi.fn(async () => {}),
      },
      inbound: {
        run,
      },
      text: {
        chunkMarkdownTextWithMode:
          overrides.chunkMarkdownTextWithMode ?? ((text: string) => [text]),
        convertMarkdownTables: (text: string) => text,
        hasControlCommand: overrides.textHasControlCommand ?? (() => false),
        resolveChunkMode: () => overrides.chunkMode ?? "length",
        resolveMarkdownTableMode: () => "off",
        resolveTextChunkLimit: () => overrides.textChunkLimit ?? 4000,
      },
    },
  };
}

export const testConfig: OpenClawConfig = {
  channels: {
    mattermost: {
      enabled: true,
      baseUrl: "https://mattermost.example.com",
      botToken: "test-auth-token",
      chatmode: "onmessage",
      dmPolicy: "open",
      groupPolicy: "open",
    },
  },
};

export const mentionConfig: OpenClawConfig = {
  ...testConfig,
  channels: {
    mattermost: {
      ...testConfig.channels?.mattermost,
      chatmode: "oncall",
    },
  },
};

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => mockState.runtimeCore,
}));

export const testRuntime = (): RuntimeEnv =>
  ({
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  }) satisfies RuntimeEnv;

export async function emitMattermostChannelPost(
  socket: FakeWebSocket,
  params: { id: string; message: string; rootId?: string; userId?: string },
) {
  const userId = params.userId ?? "user-1";
  await socket.emitMessage({
    event: "posted",
    data: {
      channel_id: "chan-1",
      channel_name: "town-square",
      channel_display_name: "Town Square",
      sender_name: userId === "user-1" ? "alice" : "bob",
      post: JSON.stringify({
        id: params.id,
        channel_id: "chan-1",
        user_id: userId,
        message: params.message,
        root_id: params.rootId,
        create_at: 1_714_000_000_000,
      }),
    },
    broadcast: {
      channel_id: "chan-1",
      user_id: userId,
    },
  });
}

export async function emitMattermostEditedPost(
  socket: FakeWebSocket,
  params: {
    id: string;
    message: string;
    editAt: number;
    channelId?: string;
    userId?: string;
    fileIds?: string[];
    props?: Record<string, unknown>;
  },
) {
  const channelId = params.channelId ?? "chan-1";
  const userId = params.userId ?? "user-1";
  await socket.emitMessage({
    event: "post_edited",
    data: {
      channel_id: channelId,
      channel_name: "town-square",
      channel_display_name: "Town Square",
      sender_name: userId === "user-1" ? "alice" : "mallory",
      post: JSON.stringify({
        id: params.id,
        channel_id: channelId,
        user_id: userId,
        message: params.message,
        file_ids: params.fileIds,
        props: params.props,
        create_at: 1_714_000_000_000,
        edit_at: params.editAt,
      }),
    },
    broadcast: {
      channel_id: channelId,
      user_id: userId,
    },
  });
}

export function resetMattermostInboundTestState() {
  vi.clearAllMocks();
  mockState.abortController = undefined;
  mockState.runtimeCore = createRuntimeCore(testConfig);
  mockState.createMattermostClient.mockReturnValue({});
  mockState.createMattermostDraftStream.mockReturnValue({
    update: vi.fn(),
    updateAssistantText: vi.fn(),
    flush: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    settleBoundaries: vi.fn(async () => {}),
    resolveFinalText: (text: string) => ({ kind: "full" as const, text }),
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
  mockState.sendMessageMattermost.mockResolvedValue({});
  mockState.dispatchInboundMessage.mockImplementation(async () => {
    mockState.abortController?.abort();
  });
}
