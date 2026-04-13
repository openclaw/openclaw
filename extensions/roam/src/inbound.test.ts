import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedRoamAccount } from "./accounts.js";
import { handleRoamInbound } from "./inbound.js";
import type { CoreConfig, RoamInboundMessage } from "./types.js";

// --- Hoisted mocks ---

const {
  mockSendMessageRoam,
  mockSendTypingRoam,
  mockFetchRemoteMedia,
  mockSaveMediaBuffer,
  mockDispatchInboundReplyWithBase,
  mockCreateChannelPairingController,
  mockDeliverFormattedTextWithAttachments,
  mockReadStoreAllowFrom,
  mockLogInboundDrop,
  mockLogTypingFailure,
  mockResolveDmGroupAccessWithCommandGate,
  mockResolveAllowlistProviderRuntimeGroupPolicy,
  mockWarnMissingProviderGroupPolicyFallbackOnce,
} = vi.hoisted(() => ({
  mockSendMessageRoam: vi.fn().mockResolvedValue({ chatId: "chat-1", timestamp: 1000 }),
  mockSendTypingRoam: vi.fn().mockResolvedValue(undefined),
  mockFetchRemoteMedia: vi.fn(),
  mockSaveMediaBuffer: vi.fn(),
  mockDispatchInboundReplyWithBase: vi.fn().mockResolvedValue(undefined),
  mockCreateChannelPairingController: vi.fn(),
  mockDeliverFormattedTextWithAttachments: vi.fn().mockResolvedValue(undefined),
  mockReadStoreAllowFrom: vi.fn().mockResolvedValue([]),
  mockLogInboundDrop: vi.fn(),
  mockLogTypingFailure: vi.fn(),
  mockResolveDmGroupAccessWithCommandGate: vi.fn(() => ({
    decision: "allow",
    reason: "open",
    commandAuthorized: true,
    shouldBlockControlCommand: false,
    effectiveGroupAllowFrom: undefined,
  })),
  mockResolveAllowlistProviderRuntimeGroupPolicy: vi.fn(() => ({
    groupPolicy: "open",
    providerMissingFallbackApplied: false,
  })),
  mockWarnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageRoam: mockSendMessageRoam,
  sendTypingRoam: mockSendTypingRoam,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  fetchRemoteMedia: mockFetchRemoteMedia,
  saveMediaBuffer: mockSaveMediaBuffer,
}));

// --- Runtime mock ---

const mockActivityRecord = vi.fn();
const mockResolveAgentRoute = vi.fn(() => ({
  agentId: "default",
  sessionKey: "roam:test:session",
  accountId: "default",
}));

const mockShouldHandleTextCommands = vi.fn(() => true);
const mockHasControlCommand = vi.fn(() => false);
const mockBuildMentionRegexes = vi.fn(() => []);
const mockMatchesMentionPatterns = vi.fn(() => false);
const mockResolveStorePath = vi.fn(() => "/tmp/store");
const mockReadSessionUpdatedAt = vi.fn(() => undefined);
const mockFormatAgentEnvelope = vi.fn((p: { body: string }) => p.body);
const mockFinalizeInboundContext = vi.fn((p: Record<string, unknown>) => p);
const mockResolveEnvelopeFormatOptions = vi.fn(() => ({}));
const mockRecordInboundSession = vi.fn().mockResolvedValue(undefined);
const mockDispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue(undefined);

const runtimeCore = {
  channel: {
    activity: { record: mockActivityRecord },
    session: {
      recordInboundSession: mockRecordInboundSession,
      resolveStorePath: mockResolveStorePath,
      readSessionUpdatedAt: mockReadSessionUpdatedAt,
    },
    routing: { resolveAgentRoute: mockResolveAgentRoute },
    reply: {
      resolveEnvelopeFormatOptions: mockResolveEnvelopeFormatOptions,
      formatAgentEnvelope: mockFormatAgentEnvelope,
      finalizeInboundContext: mockFinalizeInboundContext,
      dispatchReplyWithBufferedBlockDispatcher: mockDispatchReplyWithBufferedBlockDispatcher,
    },
    commands: { shouldHandleTextCommands: mockShouldHandleTextCommands },
    text: { hasControlCommand: mockHasControlCommand },
    mentions: {
      buildMentionRegexes: mockBuildMentionRegexes,
      matchesMentionPatterns: mockMatchesMentionPatterns,
    },
  },
};

vi.mock("./runtime.js", () => ({
  getRoamRuntime: () => runtimeCore,
}));

// Mock the pairing controller
const mockIssuePairingChallenge = vi.fn().mockResolvedValue(undefined);
const mockReadStoreForDmPolicy = vi.fn().mockResolvedValue([]);

mockCreateChannelPairingController.mockReturnValue({
  issueChallenge: mockIssuePairingChallenge,
  readStoreForDmPolicy: mockReadStoreForDmPolicy,
});

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual("../runtime-api.js");
  return {
    ...(actual as object),
    dispatchInboundReplyWithBase: mockDispatchInboundReplyWithBase,
    deliverFormattedTextWithAttachments: mockDeliverFormattedTextWithAttachments,
    createChannelPairingController: mockCreateChannelPairingController,
    readStoreAllowFromForDmPolicy: mockReadStoreAllowFrom,
    logInboundDrop: mockLogInboundDrop,
    logTypingFailure: mockLogTypingFailure,
    resolveDmGroupAccessWithCommandGate: mockResolveDmGroupAccessWithCommandGate,
    resolveAllowlistProviderRuntimeGroupPolicy: mockResolveAllowlistProviderRuntimeGroupPolicy,
    resolveDefaultGroupPolicy: vi.fn(() => "open"),
    warnMissingProviderGroupPolicyFallbackOnce: mockWarnMissingProviderGroupPolicyFallbackOnce,
    GROUP_POLICY_BLOCKED_LABEL: { room: "room" },
  };
});

vi.mock("./policy.js", () => ({
  normalizeRoamAllowlist: vi.fn((v: unknown) => v ?? []),
  resolveRoamAllowlistMatch: vi.fn(() => ({ allowed: true })),
  resolveRoamGroupMatch: vi.fn(() => ({
    groupConfig: undefined,
    wildcardConfig: undefined,
    groupKey: undefined,
    matchSource: undefined,
    allowed: true,
    allowlistConfigured: false,
  })),
  resolveRoamGroupAllow: vi.fn(() => ({ allowed: true })),
  resolveRoamRequireMention: vi.fn(() => false),
  resolveRoamMentionGate: vi.fn(() => ({ shouldSkip: false, shouldBypassMention: false })),
}));

// --- Helpers ---

function makeMessage(overrides?: Partial<RoamInboundMessage>): RoamInboundMessage {
  return {
    messageId: "msg-1",
    chatId: "chat-1",
    senderId: "user-1",
    senderName: "Alice",
    text: "hello bot",
    timestamp: Date.now(),
    chatType: "direct",
    ...overrides,
  };
}

function makeAccount(overrides?: Partial<ResolvedRoamAccount>): ResolvedRoamAccount {
  return {
    accountId: "default",
    enabled: true,
    apiKey: "test-api-key",
    apiKeySource: "config" as const,
    config: {
      dmPolicy: "open",
    },
    ...overrides,
  };
}

const defaultConfig: CoreConfig = {};
const defaultRuntime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

// --- Tests ---

describe("handleRoamInbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChannelPairingController.mockReturnValue({
      issueChallenge: mockIssuePairingChallenge,
      readStoreForDmPolicy: mockReadStoreForDmPolicy,
    });
  });

  describe("self-message filtering", () => {
    it("drops messages from the bot itself", async () => {
      await handleRoamInbound({
        message: makeMessage({ senderId: "bot-uuid" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
      expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining("drop self-message"));
    });

    it("dispatches messages from other users when botId is set", async () => {
      await handleRoamInbound({
        message: makeMessage({ senderId: "user-1" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
    });

    it("dispatches all messages when botId is undefined", async () => {
      await handleRoamInbound({
        message: makeMessage({ senderId: "any-sender" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: undefined,
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
    });
  });

  describe("empty text handling", () => {
    it("drops messages with empty text", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
    });

    it("drops messages with whitespace-only text", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "   " }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
    });
  });

  describe("bot mention stripping", () => {
    it("strips bot mention from message body when botId is known", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<@bot-uuid> hello world" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.BodyForAgent).toBe("hello world");
    });

    it("preserves other user mentions when botId is known", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<@other-user> hello" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.BodyForAgent).toBe("<@other-user> hello");
    });

    it("strips all mentions when botId is unknown", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<@01234567-abcd-4000-8000-000000000000> hello world" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: undefined,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.BodyForAgent).toBe("hello world");
    });

    it("does not treat arbitrary user mentions as bot mention when botId is unknown", async () => {
      await handleRoamInbound({
        message: makeMessage({
          text: "<@01234567-abcd-4000-8000-000000000000> hello",
          chatType: "group",
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: undefined,
      });

      // wasBotMentioned should return false when botId is unknown,
      // preventing the bot from waking on arbitrary user mentions in groups.
      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.WasMentioned).toBe(false);
    });

    it("drops mention-only message with no remaining content", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<@bot-uuid>" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
    });

    it("strips <!@botId> exclamation-mark mention format", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<!@bot-uuid> hello there" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.BodyForAgent).toBe("hello there");
    });
  });

  describe("media download", () => {
    it("downloads media URLs to local files", async () => {
      mockFetchRemoteMedia.mockResolvedValue({
        buffer: Buffer.from("image-data"),
        contentType: "image/png",
      });
      mockSaveMediaBuffer.mockResolvedValue({ path: "/tmp/media/img.png" });

      await handleRoamInbound({
        message: makeMessage({
          mediaUrls: ["https://example.com/photo.png"],
          mediaTypes: ["image/png"],
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockFetchRemoteMedia).toHaveBeenCalledWith({ url: "https://example.com/photo.png" });
      expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
        Buffer.from("image-data"),
        "image/png",
        "inbound",
      );

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.MediaPaths).toEqual(["/tmp/media/img.png"]);
      expect(ctxArg.MediaUrls).toEqual(["https://example.com/photo.png"]);
      expect(ctxArg.MediaTypes).toEqual(["image/png"]);
    });

    it("continues without media when download fails", async () => {
      mockFetchRemoteMedia.mockRejectedValue(new Error("download failed"));

      await handleRoamInbound({
        message: makeMessage({
          mediaUrls: ["https://example.com/photo.png"],
          mediaTypes: ["image/png"],
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.MediaPaths).toBeUndefined();
    });

    it("skips media download when no mediaUrls", async () => {
      await handleRoamInbound({
        message: makeMessage(),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockFetchRemoteMedia).not.toHaveBeenCalled();
      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.MediaPaths).toBeUndefined();
    });
  });

  describe("typing indicator", () => {
    it("passes typing callbacks to dispatch", async () => {
      await handleRoamInbound({
        message: makeMessage(),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0];
      expect(dispatchCall.typing).toBeDefined();
      expect(dispatchCall.typing.start).toBeInstanceOf(Function);
      expect(dispatchCall.typing.onStartError).toBeInstanceOf(Function);
    });

    it("typing.start calls sendTypingRoam with chatId", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatId: "chat-42" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0];
      await dispatchCall.typing.start();
      expect(mockSendTypingRoam).toHaveBeenCalledWith("chat-42", { accountId: "default" });
    });
  });

  describe("context payload", () => {
    it("sets Provider and Surface to roam", async () => {
      await handleRoamInbound({
        message: makeMessage(),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.Provider).toBe("roam");
      expect(ctxArg.Surface).toBe("roam");
    });

    it("sets ChatType to direct for DMs", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatType: "direct" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.ChatType).toBe("direct");
    });

    it("sets ChatType to group for group messages", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatType: "group" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.ChatType).toBe("group");
    });

    it("sets From with roam:group: prefix for groups", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatType: "group", chatId: "group-42" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.From).toBe("roam:group:group-42");
    });

    it("sets From with roam: prefix for DMs", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatType: "direct", senderId: "user-1" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.From).toBe("roam:user-1");
    });
  });

  describe("dispatch", () => {
    it("calls dispatchInboundReplyWithBase for allowed messages", async () => {
      await handleRoamInbound({
        message: makeMessage(),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalledOnce();
      const args = mockDispatchInboundReplyWithBase.mock.calls[0][0];
      expect(args.channel).toBe("roam");
      expect(args.accountId).toBe("default");
    });

    it("calls statusSink on inbound", async () => {
      const statusSink = vi.fn();
      const ts = Date.now();

      await handleRoamInbound({
        message: makeMessage({ timestamp: ts }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        statusSink,
      });

      expect(statusSink).toHaveBeenCalledWith({ lastInboundAt: ts });
    });
  });
});
