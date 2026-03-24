import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const {
  createChannelPairingControllerMock,
  dispatchInboundReplyWithBaseMock,
  readStoreAllowFromForDmPolicyMock,
  resolveDmGroupAccessWithCommandGateMock,
  resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveDefaultGroupPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnceMock,
} = vi.hoisted(() => {
  return {
    createChannelPairingControllerMock: vi.fn(),
    dispatchInboundReplyWithBaseMock: vi.fn(),
    readStoreAllowFromForDmPolicyMock: vi.fn(),
    resolveDmGroupAccessWithCommandGateMock: vi.fn(),
    resolveAllowlistProviderRuntimeGroupPolicyMock: vi.fn(),
    resolveDefaultGroupPolicyMock: vi.fn(),
    warnMissingProviderGroupPolicyFallbackOnceMock: vi.fn(),
  };
});

const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());
const sendReactionNextcloudTalkMock = vi.hoisted(() => vi.fn());
const resolveNextcloudTalkRoomKindMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: createChannelPairingControllerMock,
    dispatchInboundReplyWithBase: dispatchInboundReplyWithBaseMock,
    readStoreAllowFromForDmPolicy: readStoreAllowFromForDmPolicyMock,
    resolveDmGroupAccessWithCommandGate: resolveDmGroupAccessWithCommandGateMock,
    resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
    resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
    warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
  };
});

vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
  sendReactionNextcloudTalk: sendReactionNextcloudTalkMock,
}));

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return {
    ...actual,
    resolveNextcloudTalkRoomKind: resolveNextcloudTalkRoomKindMock,
  };
});

function installRuntime() {
  setNextcloudTalkRuntime({
    channel: {
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
      },
      commands: {
        shouldHandleTextCommands: vi.fn(() => false),
      },
      text: {
        hasControlCommand: vi.fn(() => false),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionPatterns: vi.fn(() => false),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "agent-1",
          accountId: "default",
          sessionKey: "session-1",
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/session"),
        readSessionUpdatedAt: vi.fn(() => undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn(() => "formatted body"),
        finalizeInboundContext: vi.fn(() => ({})),
      },
    },
  } as unknown as PluginRuntime);
}

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createAccount(
  overrides?: Partial<ResolvedNextcloudTalkAccount>,
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      dmPolicy: "open",
      allowFrom: ["user-1"],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
    ...overrides,
  };
}

function createMessage(
  overrides?: Partial<NextcloudTalkInboundMessage>,
): NextcloudTalkInboundMessage {
  return {
    messageId: "msg-1",
    roomToken: "room-1",
    roomName: "Room 1",
    senderId: "user-1",
    senderName: "Alice",
    text: "hello",
    mediaType: "text/plain",
    timestamp: Date.now(),
    isGroupChat: false,
    ...overrides,
  };
}

function setupAllowedDmAccess() {
  createChannelPairingControllerMock.mockReturnValue({
    readStoreForDmPolicy: vi.fn(),
    issueChallenge: vi.fn(),
  });
  resolveDmGroupAccessWithCommandGateMock.mockReturnValue({
    decision: "allow",
    reason: "open",
    commandAuthorized: false,
    effectiveGroupAllowFrom: [],
    shouldBlockControlCommand: false,
  });
  resolveNextcloudTalkRoomKindMock.mockResolvedValue("direct");
  resolveDefaultGroupPolicyMock.mockReturnValue("allowlist");
  resolveAllowlistProviderRuntimeGroupPolicyMock.mockReturnValue({
    groupPolicy: "allowlist",
    providerMissingFallbackApplied: false,
  });
  warnMissingProviderGroupPolicyFallbackOnceMock.mockReturnValue(undefined);
  readStoreAllowFromForDmPolicyMock.mockResolvedValue([]);
  dispatchInboundReplyWithBaseMock.mockResolvedValue(undefined);
  sendReactionNextcloudTalkMock.mockResolvedValue({ ok: true });
}

describe("nextcloud-talk inbound ack reaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRuntime();
  });

  it("calls sendReactionNextcloudTalk with account-level ackReaction when configured", async () => {
    setupAllowedDmAccess();

    const account = createAccount({
      config: {
        dmPolicy: "open",
        allowFrom: ["user-1"],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        ackReaction: "👀",
      },
    });

    await handleNextcloudTalkInbound({
      message: createMessage(),
      account,
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    expect(sendReactionNextcloudTalkMock).toHaveBeenCalledWith(
      "room-1",
      "msg-1",
      "👀",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("calls sendReactionNextcloudTalk with room-level ackReaction when configured", async () => {
    setupAllowedDmAccess();

    const account = createAccount({
      config: {
        dmPolicy: "open",
        allowFrom: ["user-1"],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        ackReaction: "👀",
        rooms: {
          "room-1": {
            ackReaction: "✅",
          },
        },
      },
    });

    await handleNextcloudTalkInbound({
      message: createMessage(),
      account,
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    // Room-level takes precedence over account-level
    expect(sendReactionNextcloudTalkMock).toHaveBeenCalledWith(
      "room-1",
      "msg-1",
      "✅",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("does not call sendReactionNextcloudTalk when ackReaction is not configured", async () => {
    setupAllowedDmAccess();

    await handleNextcloudTalkInbound({
      message: createMessage(),
      account: createAccount(),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    expect(sendReactionNextcloudTalkMock).not.toHaveBeenCalled();
  });

  it("logs error but does not throw when sendReactionNextcloudTalk rejects", async () => {
    setupAllowedDmAccess();
    sendReactionNextcloudTalkMock.mockRejectedValue(new Error("network error"));

    const runtime = createRuntimeEnv();
    const account = createAccount({
      config: {
        dmPolicy: "open",
        allowFrom: ["user-1"],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        ackReaction: "👀",
      },
    });

    // Should not throw
    await expect(
      handleNextcloudTalkInbound({
        message: createMessage(),
        account,
        config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
        runtime,
      }),
    ).resolves.toBeUndefined();

    // Error should be logged (eventually, after microtask queue drains)
    await vi.waitFor(() => {
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("ack reaction failed for msg-1"),
      );
    });
  });

  it("does not call sendReactionNextcloudTalk when message is dropped (no allowlist match)", async () => {
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(),
      issueChallenge: vi.fn(),
    });
    resolveDmGroupAccessWithCommandGateMock.mockReturnValue({
      decision: "deny",
      reason: "not_allowed",
      commandAuthorized: false,
      effectiveGroupAllowFrom: [],
      shouldBlockControlCommand: false,
    });
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("direct");
    resolveDefaultGroupPolicyMock.mockReturnValue("allowlist");
    resolveAllowlistProviderRuntimeGroupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    warnMissingProviderGroupPolicyFallbackOnceMock.mockReturnValue(undefined);
    readStoreAllowFromForDmPolicyMock.mockResolvedValue([]);

    const account = createAccount({
      config: {
        dmPolicy: "open",
        allowFrom: ["user-1"],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        ackReaction: "👀",
      },
    });

    await handleNextcloudTalkInbound({
      message: createMessage({ senderId: "unknown-user" }),
      account,
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    expect(sendReactionNextcloudTalkMock).not.toHaveBeenCalled();
    expect(dispatchInboundReplyWithBaseMock).not.toHaveBeenCalled();
  });
});
