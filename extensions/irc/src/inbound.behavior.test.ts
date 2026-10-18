// Irc tests cover inbound.behavior plugin behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedIrcAccount } from "./accounts.js";
import { handleIrcInbound } from "./inbound.js";
import type { IrcIngressLifecycle } from "./irc-ingress.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

const {
  buildMentionRegexesMock,
  hasControlCommandMock,
  matchesMentionPatternsMock,
  readAllowFromStoreMock,
  shouldHandleTextCommandsMock,
  upsertPairingRequestMock,
} = vi.hoisted(() => {
  return {
    buildMentionRegexesMock: vi.fn(() => []),
    hasControlCommandMock: vi.fn(() => false),
    matchesMentionPatternsMock: vi.fn(() => false),
    readAllowFromStoreMock: vi.fn(async () => []),
    shouldHandleTextCommandsMock: vi.fn(() => false),
    upsertPairingRequestMock: vi.fn(async () => ({ code: "CODE", created: true })),
  };
});

function installIrcRuntime() {
  setIrcRuntime(
    createPluginRuntimeMock({
      channel: {
        pairing: {
          readAllowFromStore: readAllowFromStoreMock,
          upsertPairingRequest: upsertPairingRequestMock,
        },
        commands: {
          shouldHandleTextCommands: shouldHandleTextCommandsMock,
        },
        text: {
          hasControlCommand: hasControlCommandMock,
        },
        mentions: {
          buildMentionRegexes: buildMentionRegexesMock,
          matchesMentionPatterns: matchesMentionPatternsMock,
        },
      },
    }),
  );
}

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

function createAccount(overrides?: Partial<ResolvedIrcAccount>): ResolvedIrcAccount {
  return {
    accountId: "default",
    enabled: true,
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

function resetInboundMocks() {
  buildMentionRegexesMock.mockReset().mockReturnValue([]);
  hasControlCommandMock.mockReset().mockReturnValue(false);
  matchesMentionPatternsMock.mockReset().mockReturnValue(false);
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  shouldHandleTextCommandsMock.mockReset().mockReturnValue(false);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "CODE", created: true });
}

const openConfig = {
  dmPolicy: "open",
  allowFrom: ["*"],
  groupPolicy: "allowlist",
  groupAllowFrom: [],
} satisfies ResolvedIrcAccount["config"];

function receive(overrides: Partial<Parameters<typeof handleIrcInbound>[0]>) {
  return handleIrcInbound({
    message: createMessage(),
    account: createAccount(),
    config: { channels: { irc: {} } },
    runtime: createRuntimeEnv(),
    ...overrides,
  });
}

describe("irc inbound behavior", () => {
  beforeEach(() => {
    resetInboundMocks();
    installIrcRuntime();
  });

  it("issues a DM pairing challenge and sends the reply to the sender nick", async () => {
    const sendReply = vi.fn<(target: string, text: string, replyToId?: string) => Promise<void>>(
      async () => {},
    );

    await receive({
      sendReply,
    });

    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      channel: "irc",
      accountId: "default",
      id: "alice!ident@example.com",
      meta: { name: "alice" },
    });
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(
      "alice",
      [
        "OpenClaw: access not configured.",
        "",
        "Your IRC id: alice!ident@example.com",
        "Pairing code:",
        "```",
        "CODE",
        "```",
        "",
        "Ask the bot owner to approve with:",
        "```",
        "openclaw pairing approve irc CODE",
        "```",
      ].join("\n"),
      undefined,
    );
  });

  it("drops unauthorized group control commands before dispatch", async () => {
    const runtime = createRuntimeEnv();
    shouldHandleTextCommandsMock.mockReturnValue(true);
    hasControlCommandMock.mockReturnValue(true);

    await receive({
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
          groupAllowFrom: ["bob!ident@example.com"],
          groups: {
            "#ops": {
              allowFrom: ["alice!ident@example.com"],
            },
          },
        },
      }),
      config: { channels: { irc: {} }, commands: { useAccessGroups: true } } as CoreConfig,
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      "irc: drop control command (unauthorized) target=alice!ident@example.com",
    );
  });

  it("binds durable completion to reply-lane adoption", async () => {
    const coreRuntime = createPluginRuntimeMock();
    setIrcRuntime(coreRuntime as never);
    const onAdopted = vi.fn(async () => undefined);
    const turnAdoptionLifecycle: IrcIngressLifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted,
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(async () => undefined),
    };
    const result = await receive({
      account: createAccount({ config: openConfig }),
      turnAdoptionLifecycle,
      sendReply: vi.fn(async () => {}),
    });

    const dispatchReply = coreRuntime.channel.reply
      .dispatchReplyWithBufferedBlockDispatcher as unknown as { mock: { calls: unknown[][] } };
    const replyOptions = (
      dispatchReply.mock.calls[0]?.[0] as
        | { replyOptions?: { turnAdoptionLifecycle?: IrcIngressLifecycle } }
        | undefined
    )?.replyOptions;
    expect(replyOptions?.turnAdoptionLifecycle).toEqual(
      expect.objectContaining({ abortSignal: turnAdoptionLifecycle.abortSignal }),
    );
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: "completed" });
  });

  it.each([
    {
      name: "mixed assistant text",
      reply: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      expected: ["Done."],
    },
  ])("sanitizes $name on the inbound reply path", async ({ reply, expected }) => {
    const coreRuntime = createPluginRuntimeMock();
    const sendReply = vi.fn<(target: string, text: string, replyToId?: string) => Promise<void>>(
      async () => {},
    );
    const dispatchReply = coreRuntime.channel.inbound.dispatchReply as unknown as ReturnType<
      typeof vi.fn<
        (params: {
          delivery: { deliver: (payload: { text: string }) => Promise<void> };
        }) => Promise<void>
      >
    >;
    dispatchReply.mockImplementation(
      async (params: { delivery: { deliver: (payload: { text: string }) => Promise<void> } }) => {
        await params.delivery.deliver({ text: reply });
      },
    );
    setIrcRuntime(coreRuntime as never);

    await receive({
      account: createAccount({ config: openConfig }),
      sendReply,
    });

    expect(sendReply.mock.calls.map((call) => call[1])).toEqual(expected);
  });

  it.each([
    { label: "trailing hyphen", nick: "Claw-", text: "Claw-: hello", mentioned: true },
    { label: "RFC1459 vertical bar", nick: "|Claw", text: "\\claw: hello", mentioned: true },
    {
      label: "punctuated nick inside a longer nick",
      nick: "[Claw]",
      text: "prefix[Claw]: hello",
      mentioned: false,
    },
  ])(
    "recognizes only complete IRC nickname mentions: $label",
    async ({ nick, text, mentioned }) => {
      const coreRuntime = createPluginRuntimeMock();
      const runtime = createRuntimeEnv();
      setIrcRuntime(coreRuntime as never);

      await receive({
        message: createMessage({
          target: "#ops",
          isGroup: true,
          text,
        }),
        account: createAccount({
          nick,
          config: {
            dmPolicy: "open",
            allowFrom: ["*"],
            groupPolicy: "open",
            groupAllowFrom: [],
            groups: {
              "#ops": { enabled: true, requireMention: true },
            },
          },
        }),
        runtime,
        sendReply: vi.fn(async () => {}),
      });

      expect(coreRuntime.channel.inbound.dispatch).toHaveBeenCalledTimes(mentioned ? 1 : 0);
      if (!mentioned) {
        expect(runtime.log).toHaveBeenCalledWith("irc: drop channel #ops (missing-mention)");
      }
    },
  );

  it("drops a spoofed sender for a host-less nick!user DM allowlist entry", async () => {
    const coreRuntime = createPluginRuntimeMock();
    const runtime = createRuntimeEnv();
    setIrcRuntime(coreRuntime as never);

    await receive({
      message: createMessage({
        target: "alice",
        senderNick: "alice",
        senderUser: "ident",
        senderHost: "attacker.example",
        text: "hello",
      }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["alice!ident"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      runtime,
      sendReply: vi.fn(async () => {}),
    });

    expect(
      (coreRuntime.channel.inbound.dispatchReply as unknown as { mock: { calls: unknown[][] } })
        .mock.calls.length,
    ).toBe(0);
    expect(runtime.log).toHaveBeenCalledWith(
      "irc: drop DM sender alice!ident@attacker.example (dmPolicy=allowlist)",
    );
  });

  it.each(["alice@example.com"])(
    "admits a sender matching the host-bound DM allowlist entry %s",
    async (entry) => {
      const coreRuntime = createPluginRuntimeMock();
      const runtime = createRuntimeEnv();
      setIrcRuntime(coreRuntime as never);

      await receive({
        message: createMessage({
          target: "alice",
          senderNick: "alice",
          senderUser: "ident",
          senderHost: "example.com",
          text: "hello",
        }),
        account: createAccount({
          config: {
            dmPolicy: "allowlist",
            allowFrom: [entry],
            groupPolicy: "allowlist",
            groupAllowFrom: [],
          },
        }),
        runtime,
        sendReply: vi.fn(async () => {}),
      });

      expect(
        (coreRuntime.channel.inbound.dispatchReply as unknown as { mock: { calls: unknown[][] } })
          .mock.calls.length,
      ).toBe(1);
    },
  );
});
