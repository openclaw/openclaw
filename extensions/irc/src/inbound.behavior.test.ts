import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "./runtime-api.js";
import type { ResolvedIrcAccount } from "./accounts.js";
import { handleIrcInbound } from "./inbound.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

const {
  createChannelPairingControllerMock,
  deliverFormattedTextWithAttachmentsMock,
  dispatchInboundReplyWithBaseMock,
  isDangerousNameMatchingEnabledMock,
  logInboundDropMock,
  readStoreAllowFromForDmPolicyMock,
  resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveControlCommandGateMock,
  resolveDefaultGroupPolicyMock,
  resolveEffectiveAllowFromListsMock,
  warnMissingProviderGroupPolicyFallbackOnceMock,
} = vi.hoisted(() => {
  return {
    createChannelPairingControllerMock: vi.fn(),
    deliverFormattedTextWithAttachmentsMock: vi.fn(),
    dispatchInboundReplyWithBaseMock: vi.fn(),
    isDangerousNameMatchingEnabledMock: vi.fn(),
    logInboundDropMock: vi.fn(),
    readStoreAllowFromForDmPolicyMock: vi.fn(),
    resolveAllowlistProviderRuntimeGroupPolicyMock: vi.fn(),
    resolveControlCommandGateMock: vi.fn(),
    resolveDefaultGroupPolicyMock: vi.fn(),
    resolveEffectiveAllowFromListsMock: vi.fn(),
    warnMissingProviderGroupPolicyFallbackOnceMock: vi.fn(),
  };
});

const sendMessageIrcMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: createChannelPairingControllerMock,
    deliverFormattedTextWithAttachments: deliverFormattedTextWithAttachmentsMock,
    dispatchInboundReplyWithBase: dispatchInboundReplyWithBaseMock,
    isDangerousNameMatchingEnabled: isDangerousNameMatchingEnabledMock,
    logInboundDrop: logInboundDropMock,
    readStoreAllowFromForDmPolicy: readStoreAllowFromForDmPolicyMock,
    resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
    resolveControlCommandGate: resolveControlCommandGateMock,
    resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
    resolveEffectiveAllowFromLists: resolveEffectiveAllowFromListsMock,
    warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
  };
});

vi.mock("./send.js", () => ({
  sendMessageIrc: sendMessageIrcMock,
}));

function installIrcRuntime() {
  setIrcRuntime({
    channel: {
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
    },
  } as never);
}

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createAccount(overrides?: Partial<ResolvedIrcAccount>): ResolvedIrcAccount {
  return {
    accountId: "default",
    enabled: true,
    server: "irc.example.com",
    nick: "OpenClaw",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
    ...overrides,
  } as ResolvedIrcAccount;
}

function createMessage(overrides?: Partial<IrcInboundMessage>): IrcInboundMessage {
  return {
    messageId: "msg-1",
    target: "alice",
    senderNick: "alice",
    senderUser: "ident",
    senderHost: "example.com",
    text: "hello",
    timestamp: Date.now(),
    isGroup: false,
    ...overrides,
  };
}

describe("irc inbound behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installIrcRuntime();
    resolveDefaultGroupPolicyMock.mockReturnValue("allowlist");
    resolveAllowlistProviderRuntimeGroupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    warnMissingProviderGroupPolicyFallbackOnceMock.mockReturnValue(undefined);
    readStoreAllowFromForDmPolicyMock.mockResolvedValue([]);
    isDangerousNameMatchingEnabledMock.mockReturnValue(false);
    resolveEffectiveAllowFromListsMock.mockReturnValue({
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
    });
    deliverFormattedTextWithAttachmentsMock.mockImplementation(async ({ payload, send }) => {
      await send({ text: payload.text, replyToId: undefined });
      return true;
    });
  });

  it("issues a DM pairing challenge and sends the reply to the sender nick", async () => {
    const issueChallenge = vi.fn(async ({ sendPairingReply }) => {
      await sendPairingReply("pair me");
    });
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(),
      issueChallenge,
    });
    resolveControlCommandGateMock.mockReturnValue({
      commandAuthorized: false,
      shouldBlock: false,
    });
    const sendReply = vi.fn(async () => {});

    await handleIrcInbound({
      message: createMessage(),
      account: createAccount(),
      config: { channels: { irc: {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply,
    });

    expect(issueChallenge).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith("alice", "pair me", undefined);
    expect(dispatchInboundReplyWithBaseMock).not.toHaveBeenCalled();
  });

  it("drops unauthorized group control commands before dispatch", async () => {
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(),
      issueChallenge: vi.fn(),
    });
    resolveEffectiveAllowFromListsMock.mockReturnValue({
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: ["alice!ident@example.com"],
    });
    resolveControlCommandGateMock.mockReturnValue({
      commandAuthorized: false,
      shouldBlock: true,
    });
    const runtime = createRuntimeEnv();

    await handleIrcInbound({
      message: createMessage({
        target: "#ops",
        isGroup: true,
        text: "/admin",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: ["alice!ident@example.com"],
          groups: {
            "#ops": {},
          },
        },
      }),
      config: { channels: { irc: {} }, commands: { useAccessGroups: true } } as CoreConfig,
      runtime,
    });

    expect(logInboundDropMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "irc",
        reason: "control command (unauthorized)",
        target: "alice!ident@example.com",
      }),
    );
    expect(dispatchInboundReplyWithBaseMock).not.toHaveBeenCalled();
  });
});
