import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Mock external modules
vi.mock("openclaw/plugin-sdk", () => ({
  mergeAllowlist: vi.fn(),
  summarizeMapping: vi.fn(),
  createTypingCallbacks: vi.fn(() => ({
    onReplyStart: vi.fn(),
  })),
  createReplyPrefixContext: vi.fn(() => ({
    responsePrefix: "",
    responsePrefixContextProvider: () => ({}),
  })),
  logInboundDrop: vi.fn(),
  resolveControlCommandGate: vi.fn(),
  recordInboundSession: vi.fn(),
  recordPendingHistoryEntryIfEnabled: vi.fn(),
  hasControlCommand: vi.fn(),
  finalizeInboundContext: vi.fn((ctx) => ctx),
  resolveAgentRoute: vi.fn(() => ({
    agentId: "test-agent",
    sessionKey: "test-session",
    mainSessionKey: "test-main-session",
  })),
  createInboundDebouncer: vi.fn(() => ({
    enqueue: vi.fn(),
    flush: vi.fn(),
  })),
  upsertChannelPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
}));

vi.mock("./error-utils.js", () => ({
  extractErrorMessage: vi.fn((err) => String(err)),
}));

vi.mock("./rpc-server.js", () => ({
  rpcServerManager: {
    start: vi.fn(),
    get: vi.fn(),
    isResponsive: vi.fn(),
  },
}));

vi.mock("./runtime.js", () => ({
  getDeltaChatRuntime: vi.fn(() => ({
    config: { loadConfig: vi.fn(() => ({ channels: { deltachat: {} } })) },
    logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
    channel: {
      mentions: { buildMentionRegexes: vi.fn() },
      text: {
        resolveTextChunkLimit: vi.fn(() => 4000),
        hasControlCommand: vi.fn(),
      },
      debounce: {
        resolveInboundDebounceMs: vi.fn(() => 1000),
        createInboundDebouncer: vi.fn(() => ({
          enqueue: vi.fn(),
          flush: vi.fn(),
        })),
      },
      pairing: {
        upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
        readAllowFromStore: vi.fn(() => Promise.resolve([])),
        buildPairingReply: vi.fn(
          (opts: { channel: string; idLine: string; code: string }) =>
            `OpenClaw pairing request:\nChannel: ${opts.channel}\n${opts.idLine}\nCode: ${opts.code}`,
        ),
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => ({
          authorized: true,
          shouldDeny: false,
        })),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatInboundEnvelope: vi.fn(() => "formatted-body"),
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyFromConfig: vi.fn(() => ({ queuedFinal: true })),
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: vi.fn(),
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        recordPendingHistoryEntryIfEnabled: vi.fn(),
        clearHistoryEntriesIfEnabled: vi.fn(),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "test-agent",
          sessionKey: "test-session",
          mainSessionKey: "test-main-session",
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/test/path"),
        recordInboundSession: vi.fn(),
      },
    },
  })),
  updateDeltaChatRuntimeState: vi.fn(),
}));

vi.mock("./send.js", () => ({
  deliverReplies: vi.fn(),
}));

vi.mock("./types.js", () => ({
  DEFAULT_DATA_DIR: "~/.openclaw/state/deltachat",
}));

vi.mock("./utils.js", () => ({
  ensureDataDir: vi.fn((dir) => dir),
  copyAvatarToDataDir: vi.fn(() => null),
}));

// Import modules at top level for use in beforeEach blocks
let rpcServerManager: any;
let getDeltaChatRuntime: any;
let updateDeltaChatRuntimeState: any;

beforeAll(async () => {
  const rpcServerModule = await import("./rpc-server.js");
  rpcServerManager = rpcServerModule.rpcServerManager;

  const runtimeModule = await import("./runtime.js");
  getDeltaChatRuntime = runtimeModule.getDeltaChatRuntime;
  updateDeltaChatRuntimeState = runtimeModule.updateDeltaChatRuntimeState;
});

describe("Delta.Chat Monitor - Simple Test", () => {
  const mockRuntimeObj = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    config: { loadConfig: vi.fn(() => ({ channels: { deltachat: {} } })) },
    logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
    channel: {
      mentions: { buildMentionRegexes: vi.fn() },
      text: {
        resolveTextChunkLimit: vi.fn(() => 4000),
        hasControlCommand: vi.fn(),
      },
      debounce: {
        resolveInboundDebounceMs: vi.fn(() => 1000),
        createInboundDebouncer: vi.fn(() => ({
          enqueue: vi.fn(),
          flush: vi.fn(),
        })),
      },
      pairing: {
        upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
        readAllowFromStore: vi.fn(() => Promise.resolve([])),
        buildPairingReply: vi.fn(
          (opts: { channel: string; idLine: string; code: string }) =>
            `OpenClaw pairing request:\nChannel: ${opts.channel}\n${opts.idLine}\nCode: ${opts.code}`,
        ),
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => ({
          authorized: true,
          shouldDeny: false,
        })),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatInboundEnvelope: vi.fn(() => "formatted-body"),
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyFromConfig: vi.fn(() => ({ queuedFinal: true })),
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: vi.fn(),
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        recordPendingHistoryEntryIfEnabled: vi.fn(),
        clearHistoryEntriesIfEnabled: vi.fn(),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "test-agent",
          sessionKey: "test-session",
          mainSessionKey: "test-main-session",
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/test/path"),
        recordInboundSession: vi.fn(),
      },
    },
  };

  const eventHandlers: Record<string, (...args: any[]) => any> = {};
  const onMock = vi.fn((event: string, handler: (...args: any[]) => any) => {
    eventHandlers[event] = handler;
  });

  const mockDc = {
    rpc: {
      getAllAccounts: vi.fn(),
      addAccount: vi.fn(),
      getAccountInfo: vi.fn(),
      startIo: vi.fn(),
      stopIo: vi.fn(),
      getBasicChatInfo: vi.fn(),
      getMessage: vi.fn(),
      getContact: vi.fn(),
      miscSendTextMessage: vi.fn(),
      batchSetConfig: vi.fn(),
      setConfigFromQr: vi.fn(),
      configure: vi.fn(),
      acceptChat: vi.fn(),
    },
    getContextEvents: vi.fn(() => ({
      on: onMock,
      off: vi.fn(),
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(rpcServerManager.start).mockResolvedValue(mockDc);
    vi.mocked(getDeltaChatRuntime).mockReturnValue({
      config: { loadConfig: vi.fn(() => ({ channels: { deltachat: {} } })) },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: { buildMentionRegexes: vi.fn() },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 1000),
          createInboundDebouncer: vi.fn(() => ({
            enqueue: vi.fn(),
            flush: vi.fn(),
          })),
        },
        pairing: {
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          buildPairingReply: vi.fn(
            (opts: { channel: string; idLine: string; code: string }) =>
              `OpenClaw pairing request:\nChannel: ${opts.channel}\n${opts.idLine}\nCode: ${opts.code}`,
          ),
        },
        commands: {
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => ({
            authorized: true,
            shouldDeny: false,
          })),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatInboundEnvelope: vi.fn(() => "formatted-body"),
          finalizeInboundContext: vi.fn((ctx) => ctx),
          dispatchReplyFromConfig: vi.fn(() => ({ queuedFinal: true })),
          createReplyDispatcherWithTyping: vi.fn(() => ({
            dispatcher: vi.fn(),
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          })),
          recordPendingHistoryEntryIfEnabled: vi.fn(),
          clearHistoryEntriesIfEnabled: vi.fn(),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "test-agent",
            sessionKey: "test-session",
            mainSessionKey: "test-main-session",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
        },
      },
    } as any);
  });

  it("should work with simple test", async () => {
    const { C } = await import("@deltachat/jsonrpc-client");
    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Mock account as configured
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "test", kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({ chatType: C.DC_CHAT_TYPE_SINGLE });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "test message",
      fromId: 2,
      isFromSelf: false,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "test@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    // Wait for event listener to be registered
    await eventListenerReady;

    // Trigger the IncomingMsg event using retrievable event handler
    const eventHandler = eventHandlers["IncomingMsg"];

    if (!eventHandler) {
      throw new Error("eventHandler not found");
    }

    await eventHandler({ chatId: 1, msgId: 1 });

    abortController.abort();
    await promise;
  });
});
