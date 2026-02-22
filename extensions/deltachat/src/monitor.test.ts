import { C } from "@deltachat/jsonrpc-client";
import {
  resolveControlCommandGate,
  resolveMentionGatingWithBypass,
  recordInboundSession,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external modules - using plugin-sdk paths
vi.mock("openclaw/plugin-sdk", () => ({
  mergeAllowlist: vi.fn((opts) => opts.existing || []),
  summarizeMapping: vi.fn(),
  createTypingCallbacks: vi.fn(() => ({
    onReplyStart: vi.fn(),
  })),
  createReplyPrefixContext: vi.fn(() => ({
    responsePrefix: "",
    responsePrefixContextProvider: () => ({}),
  })),
  resolveControlCommandGate: vi.fn(() => ({ commandAuthorized: true, shouldBlock: false })),
  resolveMentionGatingWithBypass: vi.fn(() => ({
    effectiveWasMentioned: false,
    shouldSkip: false,
    shouldBypassMention: false,
  })),
  recordInboundSession: vi.fn(),
  recordPendingHistoryEntryIfEnabled: vi.fn(),
  clearHistoryEntriesIfEnabled: vi.fn(),
  hasControlCommand: vi.fn(),
  finalizeInboundContext: vi.fn((ctx) => ctx),
  resolveAgentRoute: vi.fn(() => ({
    agentId: "test-agent",
    sessionKey: "test-session",
    mainSessionKey: "test-main-session",
    accountId: "default",
  })),
  upsertChannelPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
  resolveAckReaction: vi.fn(() => null),
  removeAckReactionAfterReply: vi.fn(),
  shouldAckReaction: vi.fn(() => false),
}));

vi.mock("./error-utils.js", () => ({
  extractErrorMessage: vi.fn((err) => {
    if (err instanceof Error) {
      return err.message;
    }
    if (typeof err === "string") {
      return err;
    }
    if (err && typeof err === "object") {
      const anyErr = err as Record<string, unknown>;
      if (typeof anyErr.message === "string") {
        return anyErr.message;
      }
      if (typeof anyErr.error === "string") {
        return anyErr.error;
      }
      if (typeof anyErr.code === "string" || typeof anyErr.code === "number") {
        return `Error code: ${anyErr.code}`;
      }
      if (anyErr.result && typeof anyErr.result === "string") {
        return anyErr.result;
      }
      try {
        return JSON.stringify(err);
      } catch {
        return String(err);
      }
    }
    return String(err);
  }),
}));

vi.mock("./rpc-server.js", () => ({
  rpcServerManager: {
    start: vi.fn(),
    get: vi.fn(),
    isResponsive: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(),
    getDataDir: vi.fn(),
  },
}));

// Runtime mock that properly simulates the actual runtime behavior
// The actual runtime.ts uses a module-level variable to store the runtime
// and getDeltaChatRuntime() returns that variable
let mockRuntimeObj: any = null;

vi.mock("./runtime.js", () => {
  return {
    getDeltaChatRuntime: vi.fn(() => {
      if (!mockRuntimeObj) {
        throw new Error("Delta.Chat runtime not initialized");
      }
      return mockRuntimeObj;
    }),
    setDeltaChatRuntime: vi.fn((runtime: any) => {
      mockRuntimeObj = runtime;
    }),
    updateDeltaChatRuntimeState: vi.fn(),
    getDeltaChatRuntimeState: vi.fn(() => ({
      lastInboundAt: null,
      lastOutboundAt: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    })),
  };
});

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

vi.mock("./pairing-storage.js", () => ({
  PairingQrCodeStorage: {
    storeQrCode: vi.fn(),
    retrieveQrCode: vi.fn(),
  },
}));

vi.mock("./reactions.js", () => ({
  resolveDeltaChatReactionLevel: vi.fn(() => ({
    level: "minimal",
    ackEnabled: false,
    agentReactionsEnabled: true,
    agentReactionGuidance: "minimal",
  })),
  sendReactionDeltaChat: vi.fn(() => ({ ok: true })),
  removeReactionDeltaChat: vi.fn(() => ({ ok: true })),
  normalizeDeltaChatReactionParams: vi.fn(),
  getReactionsDeltaChat: vi.fn(() => []),
}));

// Import mocked modules at top level for use in beforeEach blocks
// Note: We use the mocked versions directly since vi.mock() hoists the mock
// and we don't want to import the real modules which would trigger singleton initialization
import { rpcServerManager } from "./rpc-server.js";
import { getDeltaChatRuntime, setDeltaChatRuntime } from "./runtime.js";

describe("Delta.Chat Monitor - Security Policy Enforcement", () => {
  // Shared event handler storage for retrievable event handlers
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
      getChatSecurejoinQrCode: vi.fn(),
    },
    getContextEvents: vi.fn(() => ({
      on: onMock,
      off: vi.fn(),
    })),
    close: vi.fn(),
    transport: {
      input: {
        end: vi.fn(),
      },
      output: vi.fn(),
      _send: vi.fn(),
      _requestId: 0,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      setEncoding: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      pipe: vi.fn(),
      unpipe: vi.fn(),
      destroy: vi.fn(),
      close: vi.fn(),
      _onmessage: vi.fn(),
      notification: vi.fn(),
      request: vi.fn(),
      _onclose: vi.fn(),
      _onerror: vi.fn(),
      e: vi.fn(),
      _on: vi.fn(),
    },
    contextEmitters: {},
    eventTask: vi.fn(),
    rpcClient: {},
    process: {},
    stdin: {},
    stdout: {},
    stderr: {},
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    eventLoop: vi.fn(),
    listAccounts: vi.fn(),
    emit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default return values for mocks that tests may override with mockReturnValue.
    // vi.clearAllMocks() clears call history but NOT mockReturnValue overrides, so stale
    // overrides from tests like "block unauthorized commands" (shouldBlock:true) or
    // "drop when no mention" (shouldSkip:true) would otherwise leak into subsequent tests.
    vi.mocked(resolveControlCommandGate).mockReturnValue({
      commandAuthorized: true,
      shouldBlock: false,
    });
    vi.mocked(resolveMentionGatingWithBypass).mockReturnValue({
      effectiveWasMentioned: false,
      shouldSkip: false,
      shouldBypassMention: false,
    });
    // Reset event handlers for each test
    for (const key in eventHandlers) {
      delete eventHandlers[key];
    }
    vi.mocked(rpcServerManager.start).mockResolvedValue(mockDc as any);

    // Create a mock runtime and set it before importing monitor.js
    // Use the module-level mockRuntimeObj variable (not a local const)
    mockRuntimeObj = {
      config: { loadConfig: vi.fn(() => ({ channels: { deltachat: { dm: { allowFrom: [] } } } })) },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      // RuntimeEnv functions needed for logging operations
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    // Set the runtime before importing monitor.js
    // This will update the module-level mockRuntimeObj in the mock closure
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
  });

  it("should block DM when dmEnabled is false", async () => {
    // Setup mock config with dm disabled
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: false, allowFrom: ["test@example.com"] },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      // RuntimeEnv functions needed for logging operations
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    // Import monitor after mock is set up
    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Mock account as configured
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
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

    // Trigger the IncomingMsg event
    const eventHandler = eventHandlers["IncomingMsg"];

    if (!eventHandler) {
      throw new Error("eventHandler not found");
    }

    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify runtime.log was called with correct message
    expect(mockRuntimeObj.log).toHaveBeenCalledWith(
      expect.stringContaining("dropping message from test@example.com (dm disabled)"),
    );

    abortController.abort();
    await promise;
  });

  it("should skip self-messages (chatmail echo of bot's own replies)", async () => {
    // Chatmail servers echo the bot's sent messages back to its inbox as IncomingMsg.
    // fromId === DC_CONTACT_ID_SELF (1) identifies these and they must be silently dropped.
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: { deltachat: { dm: { enabled: true, policy: "open" } } },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: { resolveTextChunkLimit: vi.fn(() => 4000), hasControlCommand: vi.fn() },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: { readAllowFromStore: vi.fn(() => Promise.resolve([])) },
        commands: {
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => ({
            authorized: true,
            shouldDeny: false,
          })),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatInboundEnvelope: vi.fn(() => "body"),
          finalizeInboundContext: vi.fn((ctx) => ctx),
          dispatchReplyFromConfig: vi.fn(() => ({ queuedFinal: true })),
          createReplyDispatcherWithTyping: vi.fn(() => ({
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          })),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "main",
            sessionKey: "s",
            mainSessionKey: "m",
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({ chatType: C.DC_CHAT_TYPE_SINGLE });
    // fromId: 1 = DC_CONTACT_ID_SELF and isFromSelf: true — bot's own message echoed back by chatmail
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "Morning!",
      fromId: 1,
      isFromSelf: true,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "bot@chatmail.example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });
    await eventListenerReady;

    await eventHandlers["IncomingMsg"]({ chatId: 5, msgId: 42 });

    // dispatchReplyFromConfig must NOT have been called — self-message was dropped
    expect(mockRuntimeObj.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();

    abortController.abort();
    await promise;
  });

  it("should block DM when dmPolicy is disabled", async () => {
    // Setup mock config with dm policy disabled
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "disabled", allowFrom: ["test@example.com"] },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      // RuntimeEnv functions needed for logging operations
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
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

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    expect(mockRuntimeObj.log).toHaveBeenCalledWith(
      expect.stringContaining("dropping message from test@example.com (dm policy disabled)"),
    );

    abortController.abort();
    await promise;
  });

  it("should block DM when sender not in allowlist (allowlist policy)", async () => {
    // Setup mock config with allowlist policy
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "allowlist", allowFrom: ["allowed@example.com"] },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      // RuntimeEnv functions needed for logging operations
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({ chatType: C.DC_CHAT_TYPE_SINGLE });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "test message",
      fromId: 2,
      isFromSelf: false,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "unauthorized@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    expect(mockRuntimeObj.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "dropping message from unauthorized@example.com (dm not allowed, policy: allowlist)",
      ),
    );

    abortController.abort();
    await promise;
  });

  it("should create pairing request for unapproved sender (pairing policy)", async () => {
    // Setup mock config with pairing policy
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "pairing", allowFrom: ["allowed@example.com"] },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      // RuntimeEnv functions needed for logging operations
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({ chatType: C.DC_CHAT_TYPE_SINGLE });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "test message",
      fromId: 2,
      isFromSelf: false,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "unauthorized@example.com" });
    // Mock isResponsive to return true so the code reaches miscSendTextMessage
    vi.mocked(rpcServerManager.isResponsive).mockResolvedValue(true);

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify pairing request was created
    expect(mockRuntimeObj.channel.pairing.upsertPairingRequest).toHaveBeenCalledWith({
      channel: "deltachat",
      id: "unauthorized@example.com",
      meta: {
        sender: "unauthorized@example.com",
        chatId: "1",
      },
    });

    // Verify pairing code was sent
    expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(
      1,
      1,
      expect.stringContaining("OpenClaw pairing request:"),
    );

    // Verify message was still blocked
    expect(mockRuntimeObj.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "dropping message from unauthorized@example.com (dm not allowed, policy: pairing)",
      ),
    );

    abortController.abort();
    await promise;
  });

  it("should log pairing send failures with error details (not [object Object])", async () => {
    // Setup mock config with pairing policy
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "pairing", allowFrom: ["allowed@example.com"] },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({ chatType: C.DC_CHAT_TYPE_SINGLE });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "test message",
      fromId: 2,
      isFromSelf: false,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "unauthorized@example.com" });

    // Mock miscSendTextMessage to throw an error with a message property (common in Delta.Chat RPC errors)
    mockDc.rpc.miscSendTextMessage.mockRejectedValue({ message: "RPC connection failed" });
    // Mock isResponsive to return true so the code reaches miscSendTextMessage
    vi.mocked(rpcServerManager.isResponsive).mockResolvedValue(true);

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify error was logged with the actual error message, not [object Object]
    expect(mockRuntimeObj.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send pairing code to unauthorized@example.com"),
    );
    expect(mockRuntimeObj.error).toHaveBeenCalledWith(
      expect.stringContaining("RPC connection failed"),
    );
    // Make sure it's NOT logging "[object Object]"
    expect(mockRuntimeObj.error).not.toHaveBeenCalledWith(
      expect.stringContaining("[object Object]"),
    );

    abortController.abort();
    await promise;
  });

  it("should log pairing send failures with Error instance details", async () => {
    // Setup mock config with pairing policy
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "pairing", allowFrom: ["allowed@example.com"] },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({ chatType: C.DC_CHAT_TYPE_SINGLE });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "test message",
      fromId: 2,
      isFromSelf: false,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "unauthorized@example.com" });

    // Mock miscSendTextMessage to throw a standard Error
    mockDc.rpc.miscSendTextMessage.mockRejectedValue(new Error("Network timeout"));
    // Mock isResponsive to return true so the code reaches miscSendTextMessage
    vi.mocked(rpcServerManager.isResponsive).mockResolvedValue(true);

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify error was logged with the Error's message property
    expect(mockRuntimeObj.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send pairing code to unauthorized@example.com"),
    );
    expect(mockRuntimeObj.error).toHaveBeenCalledWith(expect.stringContaining("Network timeout"));

    abortController.abort();
    await promise;
  });

  it("should accept contact request before sending pairing code", async () => {
    // Setup mock config with pairing policy
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "pairing", allowFrom: ["allowed@example.com"] },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    // Simulate a contact request chat (isContactRequest: true)
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_SINGLE,
      isContactRequest: true,
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "test message",
      fromId: 2,
      isFromSelf: false,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "unauthorized@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify acceptChat was called because this was a contact request
    expect(mockDc.rpc.acceptChat).toHaveBeenCalledWith(1, 1);

    // Verify pairing code was sent after accepting the contact request
    expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(
      1,
      1,
      expect.stringContaining("OpenClaw pairing request:"),
    );

    // Verify message was still blocked
    expect(mockRuntimeObj.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "dropping message from unauthorized@example.com (dm not allowed, policy: pairing)",
      ),
    );

    abortController.abort();
    await promise;
  });

  it("should not call acceptChat when chat is not a contact request", async () => {
    // Setup mock config with pairing policy
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "pairing", allowFrom: ["allowed@example.com"] },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    // Normal chat (not a contact request)
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_SINGLE,
      isContactRequest: false,
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "test message",
      fromId: 2,
      isFromSelf: false,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "unauthorized@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify acceptChat was NOT called for normal chats
    expect(mockDc.rpc.acceptChat).not.toHaveBeenCalled();

    // Verify pairing code was still sent
    expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(
      1,
      1,
      expect.stringContaining("OpenClaw pairing request:"),
    );

    // Verify message was blocked
    expect(mockRuntimeObj.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "dropping message from unauthorized@example.com (dm not allowed, policy: pairing)",
      ),
    );

    abortController.abort();
    await promise;
  });

  it("should block group messages not in allowlist", async () => {
    // Setup mock config with group allowlist (keyed by chat ID)
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              groupPolicy: "allowlist",
              groups: {
                "99": { users: [] },
              },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "unauthorized-group",
    });
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

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    expect(mockRuntimeObj.log).toHaveBeenCalledWith(
      expect.stringContaining("dropping message from group 1 (not in allowlist)"),
    );

    abortController.abort();
    await promise;
  });
});

describe("Delta.Chat Monitor - Command Detection", () => {
  // Shared event handler storage for retrievable event handlers
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
      getChatSecurejoinQrCode: vi.fn(),
    },
    getContextEvents: vi.fn(() => ({
      on: onMock,
      off: vi.fn(),
    })),
    close: vi.fn(),
    transport: {
      input: {
        end: vi.fn(),
      },
      output: vi.fn(),
      _send: vi.fn(),
      _requestId: 0,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      setEncoding: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      pipe: vi.fn(),
      unpipe: vi.fn(),
      destroy: vi.fn(),
      close: vi.fn(),
      _onmessage: vi.fn(),
      notification: vi.fn(),
      request: vi.fn(),
      _onclose: vi.fn(),
      _onerror: vi.fn(),
      e: vi.fn(),
      _on: vi.fn(),
    },
    contextEmitters: {},
    eventTask: vi.fn(),
    rpcClient: {},
    process: {},
    stdin: {},
    stdout: {},
    stderr: {},
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    eventLoop: vi.fn(),
    listAccounts: vi.fn(),
    emit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default return values for mocks that tests may override with mockReturnValue.
    // vi.clearAllMocks() clears call history but NOT mockReturnValue overrides, so stale
    // overrides from tests like "block unauthorized commands" (shouldBlock:true) or
    // "drop when no mention" (shouldSkip:true) would otherwise leak into subsequent tests.
    vi.mocked(resolveControlCommandGate).mockReturnValue({
      commandAuthorized: true,
      shouldBlock: false,
    });
    vi.mocked(resolveMentionGatingWithBypass).mockReturnValue({
      effectiveWasMentioned: false,
      shouldSkip: false,
      shouldBypassMention: false,
    });
    // Reset event handlers for each test
    for (const key in eventHandlers) {
      delete eventHandlers[key];
    }
    vi.mocked(rpcServerManager.start).mockResolvedValue(mockDc as any);

    // Create a mock runtime and set it before importing monitor.js
    // Use the module-level mockRuntimeObj variable (not a local const)
    mockRuntimeObj = {
      config: { loadConfig: vi.fn(() => ({ channels: { deltachat: { dm: { allowFrom: [] } } } })) },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      // RuntimeEnv functions needed for logging operations
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    // Set the runtime before importing monitor.js
    // This will update the module-level mockRuntimeObj in the mock closure
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
  });

  it("should block unauthorized commands in groups", async () => {
    // Setup mock config with group allowlist (keyed by chat ID)
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              groupPolicy: "allowlist",
              groups: {
                "1": { users: [] },
              },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(() => true),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
          buildPairingReply: vi.fn(
            (opts: { channel: string; idLine: string; code: string }) =>
              `OpenClaw pairing request:\nChannel: ${opts.channel}\n${opts.idLine}\nCode: ${opts.code}`,
          ),
        },
        commands: {
          // This should return unauthorized for the test
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => ({
            authorized: false,
            shouldDeny: true,
          })),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatInboundEnvelope: vi.fn(() => "formatted-body"),
          finalizeInboundContext: vi.fn((ctx) => ctx),
          dispatchReplyFromConfig: vi.fn(() => ({ queuedFinal: true })),
          createReplyDispatcherWithTyping: vi.fn(() => ({
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
    vi.mocked(resolveControlCommandGate).mockReturnValue({
      commandAuthorized: false,
      shouldBlock: true,
    });

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "allowed-group",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "!help",
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

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    expect(mockRuntimeObj.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "dropping message from test@example.com (control command unauthorized)",
      ),
    );

    abortController.abort();
    await promise;
  });

  it("should allow commands from authorized DM senders", async () => {
    vi.mocked(resolveControlCommandGate).mockReturnValue({
      commandAuthorized: true,
      shouldBlock: false,
    });

    // Setup mock config with allowed sender
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "allowlist", allowFrom: ["allowed@example.com"] },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(() => true),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          })),
          recordPendingHistoryEntryIfEnabled: vi.fn(),
          clearHistoryEntriesIfEnabled: vi.fn(),
          createReplyPrefixContext: vi.fn(() => ({
            responsePrefix: "",
            responsePrefixContextProvider: vi.fn(),
          })),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "test-agent",
            sessionKey: "test-session",
            mainSessionKey: "test-main-session",
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    // Set up mockDc mocks BEFORE importing monitor.js
    // This is critical because monitor.js initialization calls getChatSecurejoinQrCode
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({ chatType: C.DC_CHAT_TYPE_SINGLE });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "!help",
      fromId: 2,
      isFromSelf: false,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "allowed@example.com" });
    mockDc.rpc.getChatSecurejoinQrCode.mockResolvedValue("test-qr-code-data");

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Should not block the message - verify no error was logged
    expect(mockRuntimeObj.error).not.toHaveBeenCalled();

    abortController.abort();
    await promise;
  });
});

describe("Delta.Chat Monitor - Message Context Building", () => {
  // Shared event handler storage for retrievable event handlers
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
      getChatSecurejoinQrCode: vi.fn(),
    },
    getContextEvents: vi.fn(() => ({
      on: onMock,
      off: vi.fn(),
    })),
    close: vi.fn(),
    transport: {
      input: {
        end: vi.fn(),
      },
      output: vi.fn(),
      _send: vi.fn(),
      _requestId: 0,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      setEncoding: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      pipe: vi.fn(),
      unpipe: vi.fn(),
      destroy: vi.fn(),
      close: vi.fn(),
      _onmessage: vi.fn(),
      notification: vi.fn(),
      request: vi.fn(),
      _onclose: vi.fn(),
      _onerror: vi.fn(),
      e: vi.fn(),
      _on: vi.fn(),
    },
    contextEmitters: {},
    eventTask: vi.fn(),
    rpcClient: {},
    process: {},
    stdin: {},
    stdout: {},
    stderr: {},
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    eventLoop: vi.fn(),
    listAccounts: vi.fn(),
    emit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default return values for mocks that tests may override with mockReturnValue.
    // vi.clearAllMocks() clears call history but NOT mockReturnValue overrides, so stale
    // overrides from tests like "block unauthorized commands" (shouldBlock:true) or
    // "drop when no mention" (shouldSkip:true) would otherwise leak into subsequent tests.
    vi.mocked(resolveControlCommandGate).mockReturnValue({
      commandAuthorized: true,
      shouldBlock: false,
    });
    vi.mocked(resolveMentionGatingWithBypass).mockReturnValue({
      effectiveWasMentioned: false,
      shouldSkip: false,
      shouldBypassMention: false,
    });
    // Reset event handlers for each test
    for (const key in eventHandlers) {
      delete eventHandlers[key];
    }
    vi.mocked(rpcServerManager.start).mockResolvedValue(mockDc as any);

    // Create a mock runtime and set it before importing monitor.js
    // Use the module-level mockRuntimeObj variable (not a local const)
    mockRuntimeObj = {
      config: { loadConfig: vi.fn(() => ({ channels: { deltachat: { dm: { allowFrom: [] } } } })) },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      // RuntimeEnv functions needed for logging operations
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    // Set the runtime before importing monitor.js
    // This will update the module-level mockRuntimeObj in the mock closure
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
  });

  it("should build correct context for DM messages", async () => {
    // Setup mock config - use module-level mockRuntimeObj, not a local const
    mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "open" },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    // This will update the module-level mockRuntimeObj in the mock closure
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_SINGLE,
      name: "test@example.com",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "Hello, world!",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
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

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify agent route was resolved with correct peer-aware params
    expect(mockRuntimeObj.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "deltachat",
        accountId: "default",
        peer: { kind: "direct", id: "1" },
      }),
    );

    // Verify finalizeInboundContext was called with correct DM context
    expect(mockRuntimeObj.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        Body: "formatted-body",
        RawBody: "Hello, world!",
        CommandBody: "Hello, world!",
        From: "deltachat:test@example.com",
        To: "deltachat:test@example.com",
        SessionKey: "test-session",
        ChatType: "direct",
        ConversationLabel: "test@example.com",
        GroupSubject: undefined,
        SenderName: "test@example.com",
        SenderId: "test@example.com",
        Provider: "deltachat",
        Surface: "deltachat",
        Timestamp: 1234567890,
        OriginatingChannel: "deltachat",
        OriginatingTo: "deltachat:test@example.com",
      }),
    );

    // Verify session was recorded
    expect(mockRuntimeObj.channel.session.recordInboundSession).toHaveBeenCalled();

    abortController.abort();
    await promise;
  });

  it("should build correct context for group messages", async () => {
    // Setup mock config - use module-level mockRuntimeObj, not a local const
    mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              groupPolicy: "open",
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    // This will update the module-level mockRuntimeObj in the mock closure
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "test-group",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "Group message",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
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

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify agent route was resolved with correct peer-aware params
    expect(mockRuntimeObj.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "deltachat",
        accountId: "default",
        peer: { kind: "group", id: "1" },
      }),
    );

    // Verify finalizeInboundContext was called with correct group context
    expect(mockRuntimeObj.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        Body: "formatted-body",
        RawBody: "Group message",
        CommandBody: "Group message",
        From: "deltachat:group:1",
        To: "deltachat:group:1",
        SessionKey: "test-session",
        ChatType: "group",
        ConversationLabel: "test-group",
        GroupSubject: "test-group",
        SenderName: "test@example.com",
        SenderId: "test@example.com",
        Provider: "deltachat",
        Surface: "deltachat",
        Timestamp: 1234567890,
        OriginatingChannel: "deltachat",
        OriginatingTo: "deltachat:group:1",
      }),
    );

    // Verify session was recorded
    expect(mockRuntimeObj.channel.session.recordInboundSession).toHaveBeenCalled();

    // Verify pending history entry was recorded for group
    // Note: recordPendingHistoryEntryIfEnabled is called directly from the import, not through the runtime object
    // The test verifies the function was called by checking that the message was processed successfully

    abortController.abort();
    await promise;
  });

  it("should route different DM senders with different peer ids (enabling per-sender sessions)", async () => {
    mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: { deltachat: { dm: { enabled: true, policy: "open" } } },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
          matchesMentionWithExplicit: vi.fn(() => false),
        },
        text: { resolveTextChunkLimit: vi.fn(() => 4000), hasControlCommand: vi.fn() },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(),
          buildPairingReply: vi.fn(),
        },
        commands: {
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => ({
            authorized: true,
            shouldDeny: false,
          })),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatInboundEnvelope: vi.fn(() => "body"),
          finalizeInboundContext: vi.fn((ctx) => ctx),
          dispatchReplyFromConfig: vi.fn(() => ({ queuedFinal: true })),
          createReplyDispatcherWithTyping: vi.fn(() => ({
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          })),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "main",
            sessionKey: "agent:main:main",
            mainSessionKey: "agent:main:main",
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
        reactions: { shouldAckReaction: vi.fn(() => false), removeAckReactionAfterReply: vi.fn() },
        groups: { resolveGroupPolicy: vi.fn(), resolveRequireMention: vi.fn() },
      },
    } as any;

    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({ chatType: C.DC_CHAT_TYPE_SINGLE, name: "" });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "hi",
      fromId: 2,
      isFromSelf: false,
      timestamp: 100,
      systemMessageType: "Unknown",
      isInfo: false,
    });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });
    await eventListenerReady;

    const handler = eventHandlers["IncomingMsg"];

    // Alice sends a message
    mockDc.rpc.getContact.mockResolvedValue({ address: "alice@example.com" });
    await handler({ chatId: 1, msgId: 1 });

    // Bob sends a message
    mockDc.rpc.getContact.mockResolvedValue({ address: "bob@example.com" });
    await handler({ chatId: 2, msgId: 2 });

    const calls = vi.mocked(mockRuntimeObj.channel.routing.resolveAgentRoute).mock.calls;
    // Peer ID is chatId (stable per conversation), not sender email
    const aliceCall = calls.find((c: any[]) => c[0]?.peer?.id === "1"); // chatId=1 (Alice)
    const bobCall = calls.find((c: any[]) => c[0]?.peer?.id === "2"); // chatId=2 (Bob)

    expect(aliceCall).toBeDefined();
    expect(bobCall).toBeDefined();
    // Both are DMs
    expect(aliceCall![0].peer.kind).toBe("direct");
    expect(bobCall![0].peer.kind).toBe("direct");
    // Each conversation has a unique peer id — the routing layer will isolate them when dmScope=per-peer
    expect(aliceCall![0].peer.id).not.toBe(bobCall![0].peer.id);

    abortController.abort();
    await promise;
  });

  it("should route different group chats with different peer ids", async () => {
    mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: { deltachat: { groupPolicy: "open" } },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
          matchesMentionWithExplicit: vi.fn(() => false),
        },
        text: { resolveTextChunkLimit: vi.fn(() => 4000), hasControlCommand: vi.fn() },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(),
          buildPairingReply: vi.fn(),
        },
        commands: {
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => ({
            authorized: true,
            shouldDeny: false,
          })),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatInboundEnvelope: vi.fn(() => "body"),
          finalizeInboundContext: vi.fn((ctx) => ctx),
          dispatchReplyFromConfig: vi.fn(() => ({ queuedFinal: true })),
          createReplyDispatcherWithTyping: vi.fn(() => ({
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          })),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "main",
            sessionKey: "agent:main:deltachat:group:1",
            mainSessionKey: "agent:main:main",
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
        reactions: { shouldAckReaction: vi.fn(() => false), removeAckReactionAfterReply: vi.fn() },
        groups: { resolveGroupPolicy: vi.fn(), resolveRequireMention: vi.fn() },
      },
    } as any;

    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
    const { monitorDeltaChatProvider } = await import("./monitor.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getContact.mockResolvedValue({ address: "member@example.com" });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "hi",
      fromId: 2,
      isFromSelf: false,
      timestamp: 100,
      systemMessageType: "Unknown",
      isInfo: false,
    });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });
    await eventListenerReady;

    const handler = eventHandlers["IncomingMsg"];

    // Message from group 101
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "Team A",
    });
    await handler({ chatId: 101, msgId: 1 });

    // Message from group 202
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "Team B",
    });
    await handler({ chatId: 202, msgId: 2 });

    const calls = vi.mocked(mockRuntimeObj.channel.routing.resolveAgentRoute).mock.calls;
    const group101 = calls.find((c: any[]) => c[0]?.peer?.id === "101");
    const group202 = calls.find((c: any[]) => c[0]?.peer?.id === "202");

    expect(group101).toBeDefined();
    expect(group202).toBeDefined();
    expect(group101![0].peer.kind).toBe("group");
    expect(group202![0].peer.kind).toBe("group");
    expect(group101![0].peer.id).not.toBe(group202![0].peer.id);

    abortController.abort();
    await promise;
  });
});

describe("Delta.Chat Monitor - Debouncer", () => {
  // Shared event handler storage for retrievable event handlers
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
      getChatSecurejoinQrCode: vi.fn(),
    },
    getContextEvents: vi.fn(() => ({
      on: onMock,
      off: vi.fn(),
    })),
    close: vi.fn(),
    transport: {
      input: {
        end: vi.fn(),
      },
      output: vi.fn(),
      _send: vi.fn(),
      _requestId: 0,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      setEncoding: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      pipe: vi.fn(),
      unpipe: vi.fn(),
      destroy: vi.fn(),
      close: vi.fn(),
      _onmessage: vi.fn(),
      notification: vi.fn(),
      request: vi.fn(),
      _onclose: vi.fn(),
      _onerror: vi.fn(),
      e: vi.fn(),
      _on: vi.fn(),
    },
    contextEmitters: {},
    eventTask: vi.fn(),
    rpcClient: {},
    process: {},
    stdin: {},
    stdout: {},
    stderr: {},
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    eventLoop: vi.fn(),
    listAccounts: vi.fn(),
    emit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default return values for mocks that tests may override with mockReturnValue.
    // vi.clearAllMocks() clears call history but NOT mockReturnValue overrides, so stale
    // overrides from tests like "block unauthorized commands" (shouldBlock:true) or
    // "drop when no mention" (shouldSkip:true) would otherwise leak into subsequent tests.
    vi.mocked(resolveControlCommandGate).mockReturnValue({
      commandAuthorized: true,
      shouldBlock: false,
    });
    vi.mocked(resolveMentionGatingWithBypass).mockReturnValue({
      effectiveWasMentioned: false,
      shouldSkip: false,
      shouldBypassMention: false,
    });
    // Reset event handlers for each test
    for (const key in eventHandlers) {
      delete eventHandlers[key];
    }
    vi.mocked(rpcServerManager.start).mockResolvedValue(mockDc as any);

    // Create a mock runtime and set it before importing monitor.js
    // Use the module-level mockRuntimeObj variable (not a local const)
    mockRuntimeObj = {
      config: { loadConfig: vi.fn(() => ({ channels: { deltachat: { dm: { allowFrom: [] } } } })) },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      // RuntimeEnv functions needed for logging operations
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    // Set the runtime before importing monitor.js
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
  });

  it("should enqueue messages for debouncing", async () => {
    // Setup mock config - use module-level mockRuntimeObj, not a local const
    mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "open" },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    // This will update the module-level mockRuntimeObj in the mock closure
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Create a mock debouncer that will be returned by the runtime's createInboundDebouncer
    const mockDebouncer = {
      enqueue: vi.fn(),
      flushKey: vi.fn(),
    };
    // Set the mock to return our debouncer when createInboundDebouncer is called
    mockRuntimeObj.channel.debounce.createInboundDebouncer.mockReturnValue(mockDebouncer);

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_SINGLE,
      name: "test@example.com",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "test message",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
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

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify message was enqueued
    expect(mockDebouncer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        senderEmail: "test@example.com",
        chatId: 1,
        msgId: 1,
        text: "test message",
        isGroup: false,
        commandAuthorized: true,
        timestamp: 1234567890,
      }),
    );

    abortController.abort();
    await promise;
  });

  it("should skip debouncing for control commands", async () => {
    // Setup mock config - use module-level mockRuntimeObj, not a local const
    mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { enabled: true, policy: "open" },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(() => true),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              // Simulate real debouncer behavior when debounceMs is 0
              // It directly calls onFlush with the item
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
    } as any;

    // Set the runtime before importing monitor.js
    // This will update the module-level mockRuntimeObj in the mock closure
    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Spy on the mock debouncer's enqueue method
    let debouncerEnqueueSpy: any;
    const mockDebouncer = {
      enqueue: vi.fn(),
      flushKey: vi.fn(),
    };
    debouncerEnqueueSpy = mockDebouncer.enqueue;
    mockRuntimeObj.channel.debounce.createInboundDebouncer.mockReturnValue(mockDebouncer);

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_SINGLE,
      name: "test@example.com",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "!help",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
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

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify message was enqueued (debouncer still receives it, but shouldDebounce will return false)
    expect(debouncerEnqueueSpy).toHaveBeenCalled();

    abortController.abort();
    await promise;
  });
});

describe("Delta.Chat Monitor - Enhanced Group Support", () => {
  // Shared event handler storage for retrievable event handlers
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
      getChatSecurejoinQrCode: vi.fn(),
    },
    getContextEvents: vi.fn(() => ({
      on: onMock,
      off: vi.fn(),
    })),
    close: vi.fn(),
    transport: {
      input: {
        end: vi.fn(),
      },
      output: vi.fn(),
      _send: vi.fn(),
      _requestId: 0,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      setEncoding: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      pipe: vi.fn(),
      unpipe: vi.fn(),
      destroy: vi.fn(),
      close: vi.fn(),
      _onmessage: vi.fn(),
      notification: vi.fn(),
      request: vi.fn(),
      _onclose: vi.fn(),
      _onerror: vi.fn(),
      e: vi.fn(),
      _on: vi.fn(),
    },
    contextEmitters: {},
    eventTask: vi.fn(),
    rpcClient: {},
    process: {},
    stdin: {},
    stdout: {},
    stderr: {},
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    eventLoop: vi.fn(),
    listAccounts: vi.fn(),
    emit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default return values for mocks that tests may override with mockReturnValue.
    // vi.clearAllMocks() clears call history but NOT mockReturnValue overrides, so stale
    // overrides from earlier tests would otherwise leak into subsequent tests.
    vi.mocked(resolveControlCommandGate).mockReturnValue({
      commandAuthorized: true,
      shouldBlock: false,
    });
    vi.mocked(resolveMentionGatingWithBypass).mockReturnValue({
      effectiveWasMentioned: false,
      shouldSkip: false,
      shouldBypassMention: false,
    });
    // Reset event handlers for each test
    for (const key in eventHandlers) {
      delete eventHandlers[key];
    }
    vi.mocked(rpcServerManager.start).mockResolvedValue(mockDc as any);
  });

  it("should drop group messages when requireMention is true and no mention found", async () => {
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { allowFrom: [] },
              groups: {
                "test-group": {
                  requireMention: true,
                  tools: "allow",
                },
              },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(() => true),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
    // requireMention=true and no mention found → mentionGate should skip
    vi.mocked(resolveMentionGatingWithBypass).mockReturnValue({
      effectiveWasMentioned: false,
      shouldSkip: true,
      shouldBypassMention: false,
    });

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Spy on the mock debouncer's enqueue method
    let debouncerEnqueueSpy: any;
    const mockDebouncer = {
      enqueue: vi.fn(),
      flushKey: vi.fn(),
    };
    debouncerEnqueueSpy = mockDebouncer.enqueue;
    mockRuntimeObj.channel.debounce.createInboundDebouncer.mockReturnValue(mockDebouncer);

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "test-group",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "!help",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "user@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify message was NOT enqueued (requireMention=true, no mention found)
    expect(debouncerEnqueueSpy).not.toHaveBeenCalled();

    abortController.abort();
    await promise;
  });

  it("should process group messages when requireMention is true and mention found", async () => {
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { allowFrom: [] },
              groups: {
                "1": {
                  requireMention: true,
                  tools: "allow",
                },
              },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => true),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(() => true),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Spy on the mock debouncer's enqueue method
    let debouncerEnqueueSpy: any;
    const mockDebouncer = {
      enqueue: vi.fn(),
      flushKey: vi.fn(),
    };
    debouncerEnqueueSpy = mockDebouncer.enqueue;
    mockRuntimeObj.channel.debounce.createInboundDebouncer.mockReturnValue(mockDebouncer);

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "test-group",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "@OpenClaw !help",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "user@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify message WAS enqueued (requireMention=true, mention found)
    expect(debouncerEnqueueSpy).toHaveBeenCalled();

    abortController.abort();
    await promise;
  });

  it("should process group messages when requireMention is false", async () => {
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { allowFrom: [] },
              groups: {
                "1": {
                  requireMention: false,
                  tools: "allow",
                },
              },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(() => true),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Spy on the mock debouncer's enqueue method
    let debouncerEnqueueSpy: any;
    const mockDebouncer = {
      enqueue: vi.fn(),
      flushKey: vi.fn(),
    };
    debouncerEnqueueSpy = mockDebouncer.enqueue;
    mockRuntimeObj.channel.debounce.createInboundDebouncer.mockReturnValue(mockDebouncer);

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "test-group",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "!help",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "user@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify message WAS enqueued (requireMention=false, always processed)
    expect(debouncerEnqueueSpy).toHaveBeenCalled();

    abortController.abort();
    await promise;
  });

  it("should drop commands when tools policy is deny", async () => {
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { allowFrom: [] },
              groups: {
                "1": {
                  requireMention: false,
                  tools: "deny",
                },
              },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(() => true),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Spy on the mock debouncer's enqueue method
    let debouncerEnqueueSpy: any;
    const mockDebouncer = {
      enqueue: vi.fn(),
      flushKey: vi.fn(),
    };
    debouncerEnqueueSpy = mockDebouncer.enqueue;
    mockRuntimeObj.channel.debounce.createInboundDebouncer.mockReturnValue(mockDebouncer);

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "test-group",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "!help",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "user@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify message was NOT enqueued (tools=deny)
    expect(debouncerEnqueueSpy).not.toHaveBeenCalled();

    abortController.abort();
    await promise;
  });

  it("should apply sender-specific tool policy override", async () => {
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { allowFrom: [] },
              groups: {
                "1": {
                  requireMention: false,
                  tools: "deny",
                  toolsBySender: {
                    "admin@example.com": "allow",
                  },
                },
              },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(() => true),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Spy on the mock debouncer's enqueue method
    let debouncerEnqueueSpy: any;
    const mockDebouncer = {
      enqueue: vi.fn(),
      flushKey: vi.fn(),
    };
    debouncerEnqueueSpy = mockDebouncer.enqueue;
    mockRuntimeObj.channel.debounce.createInboundDebouncer.mockReturnValue(mockDebouncer);

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "test-group",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "!help",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "admin@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify message WAS enqueued (sender-specific allow overrides group deny)
    expect(debouncerEnqueueSpy).toHaveBeenCalled();

    abortController.abort();
    await promise;
  });

  it("should apply wildcard group config to all groups", async () => {
    const mockRuntimeObj = {
      config: {
        loadConfig: vi.fn(() => ({
          channels: {
            deltachat: {
              dm: { allowFrom: [] },
              groups: {
                "*": {
                  requireMention: true,
                  tools: "allow",
                },
              },
            },
          },
        })),
      },
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      channel: {
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          hasControlCommand: vi.fn(() => true),
        },
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn((params: { onFlush: (items: any[]) => Promise<void> }) => ({
            enqueue: async (item: any) => {
              await params.onFlush([item]);
            },
            flushKey: vi.fn(),
          })),
        },
        pairing: {
          readAllowFromStore: vi.fn(() => Promise.resolve([])),
          upsertPairingRequest: vi.fn(() => ({ code: "test-code", created: true })),
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
            dispatcher: { markComplete: vi.fn(), waitForIdle: vi.fn(() => Promise.resolve()) },
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
            accountId: "default",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/test/path"),
          recordInboundSession: vi.fn(),
          readSessionUpdatedAt: vi.fn(() => null),
        },
        activity: { record: vi.fn() },
      },
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as any;

    setDeltaChatRuntime(mockRuntimeObj);
    vi.mocked(getDeltaChatRuntime).mockReturnValue(mockRuntimeObj);
    // wildcard requireMention=true and no mention found → mentionGate should skip
    vi.mocked(resolveMentionGatingWithBypass).mockReturnValue({
      effectiveWasMentioned: false,
      shouldSkip: true,
      shouldBypassMention: false,
    });

    const { monitorDeltaChatProvider } = await import("./monitor.js");

    // Spy on the mock debouncer's enqueue method
    let debouncerEnqueueSpy: any;
    const mockDebouncer = {
      enqueue: vi.fn(),
      flushKey: vi.fn(),
    };
    debouncerEnqueueSpy = mockDebouncer.enqueue;
    mockRuntimeObj.channel.debounce.createInboundDebouncer.mockReturnValue(mockDebouncer);

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: 1, kind: "Configured" }]);
    mockDc.rpc.getBasicChatInfo.mockResolvedValue({
      chatType: C.DC_CHAT_TYPE_GROUP,
      name: "some-other-group",
    });
    mockDc.rpc.getMessage.mockResolvedValue({
      text: "!help",
      fromId: 2,
      isFromSelf: false,
      timestamp: 1234567890,
      systemMessageType: "Unknown",
      isInfo: false,
    });
    mockDc.rpc.getContact.mockResolvedValue({ address: "user@example.com" });

    const abortController = new AbortController();
    let promise!: Promise<void>;
    const eventListenerReady = new Promise<void>((resolve) => {
      promise = monitorDeltaChatProvider({
        abortSignal: abortController.signal,
        runtime: mockRuntimeObj,
        onEventListenerRegistered: resolve,
      });
    });

    await eventListenerReady;

    const eventHandler = eventHandlers["IncomingMsg"];
    await eventHandler({ chatId: 1, msgId: 1 });

    // Verify message was NOT enqueued (wildcard requireMention=true, no mention found)
    expect(debouncerEnqueueSpy).not.toHaveBeenCalled();

    abortController.abort();
    await promise;
  });
});
