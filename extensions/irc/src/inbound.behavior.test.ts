import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedIrcAccount } from "./accounts.js";
import type { IrcClient } from "./client.js";
import type { IrcIngressLifecycle } from "./irc-ingress.js";
import { monitorIrcProvider } from "./monitor.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

const connectIrcClientMock = vi.hoisted(() =>
  vi.fn<typeof import("./client.js").connectIrcClient>(),
);
const createIrcIngressMonitorMock = vi.hoisted(() =>
  vi.fn<typeof import("./irc-ingress.js").createIrcIngressMonitor>(),
);

// mock-isolation: policy fixtures enter the real monitor without a socket or durable drain.
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  connectIrcClient: connectIrcClientMock,
}));
vi.mock("./irc-ingress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./irc-ingress.js")>()),
  createIrcIngressMonitor: createIrcIngressMonitorMock,
}));

let coreRuntime: ReturnType<typeof createPluginRuntimeMock>;
let runtime: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let sendReply: ReturnType<typeof vi.fn<IrcClient["sendPrivmsg"]>>;

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

const openConfig = {
  dmPolicy: "open",
  allowFrom: ["*"],
  groupPolicy: "allowlist",
  groupAllowFrom: [],
} satisfies ResolvedIrcAccount["config"];

function adoptionLifecycle(): IrcIngressLifecycle {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
  };
}

async function receive(
  overrides: {
    message?: IrcInboundMessage;
    account?: Partial<ResolvedIrcAccount["config"]>;
    nick?: string;
    config?: CoreConfig;
    turnAdoptionLifecycle?: IrcIngressLifecycle;
  } = {},
) {
  const message = overrides.message ?? createMessage();
  const nick = overrides.nick ?? "OpenClaw";
  const config = overrides.config ?? { channels: { irc: {} } };
  const client: IrcClient = {
    nick,
    isReady: () => true,
    join: vi.fn(),
    sendPrivmsg: async (target, text) => await sendReply(target, text, undefined),
    quit: vi.fn(),
    close: vi.fn(),
  };
  connectIrcClientMock.mockResolvedValue(client);
  createIrcIngressMonitorMock.mockReturnValue({
    openConnection: () => ({ connectionEpoch: "test-connection", accept: async () => {} }),
    start: vi.fn(),
    pause: async () => {},
    stop: async () => {},
    waitForIdle: async () => {},
  });
  const monitor = await monitorIrcProvider({
    config: {
      ...config,
      channels: {
        ...config.channels,
        irc: {
          host: "irc.example.test",
          nick,
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          ...overrides.account,
        },
      },
    },
    runtime: { ...runtime, exit: vi.fn() },
  });
  try {
    const dispatch = createIrcIngressMonitorMock.mock.lastCall?.[0].dispatch;
    if (!dispatch) {
      throw new Error("Expected IRC ingress dispatch");
    }
    return await dispatch(message, overrides.turnAdoptionLifecycle ?? adoptionLifecycle(), {
      connectedNick: client.nick,
      connectionEpoch: "test-connection",
    });
  } finally {
    await monitor.stop();
  }
}

describe("irc inbound behavior", () => {
  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.doUnmock("./irc-ingress.js");
    vi.resetModules();
  });
  beforeEach(() => {
    coreRuntime = createPluginRuntimeMock();
    vi.mocked(coreRuntime.channel.commands.shouldHandleTextCommands).mockReturnValue(false);
    vi.mocked(coreRuntime.channel.pairing.upsertPairingRequest).mockResolvedValue({
      code: "CODE",
      created: true,
    });
    setIrcRuntime(coreRuntime);
    runtime = { log: vi.fn(), error: vi.fn() };
    sendReply = vi.fn<IrcClient["sendPrivmsg"]>(async () => {});
  });

  it("issues a DM pairing challenge and sends the reply to the sender nick", async () => {
    vi.mocked(coreRuntime.channel.mentions.buildMentionRegexes).mockReturnValue([]);
    vi.mocked(coreRuntime.channel.mentions.matchesMentionPatterns).mockReturnValue(false);
    await receive();

    expect(coreRuntime.channel.pairing.upsertPairingRequest).toHaveBeenCalledWith({
      channel: "irc",
      accountId: "default",
      id: "alice!ident@example.com",
      meta: { name: "alice" },
    });
    expect(sendReply).toHaveBeenCalledExactlyOnceWith(
      "alice",
      "OpenClaw: access not configured.\n\nYour IRC id: alice!ident@example.com\nPairing code:\n```\nCODE\n```\n\nAsk the bot owner to approve with:\n```\nopenclaw pairing approve irc CODE\n```",
      undefined,
    );
  });

  it("drops unauthorized group control commands before dispatch", async () => {
    vi.mocked(coreRuntime.channel.mentions.buildMentionRegexes).mockReturnValue([]);
    vi.mocked(coreRuntime.channel.mentions.matchesMentionPatterns).mockReturnValue(false);
    vi.mocked(coreRuntime.channel.commands.shouldHandleTextCommands).mockReturnValue(true);
    vi.mocked(coreRuntime.channel.text.hasControlCommand).mockReturnValue(true);

    await receive({
      message: createMessage({ target: "#ops", isGroup: true, text: "/admin" }),
      account: {
        groupAllowFrom: ["bob!ident@example.com"],
        groups: { "#ops": { allowFrom: ["alice!ident@example.com"] } },
      },
      config: { channels: { irc: {} }, commands: { useAccessGroups: true } } as CoreConfig,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      "irc: drop control command (unauthorized) target=alice!ident@example.com",
    );
  });

  it("leaves completion to reply-lane adoption instead of settling in the inbound adapter", async () => {
    const turnAdoptionLifecycle = adoptionLifecycle();
    const { onAdopted } = turnAdoptionLifecycle;
    const result = await receive({
      account: openConfig,
      turnAdoptionLifecycle,
    });

    const replyOptions = vi.mocked(
      coreRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).mock.calls[0]?.[0].replyOptions;
    expect(replyOptions?.turnAdoptionLifecycle).toEqual(
      expect.objectContaining({ abortSignal: turnAdoptionLifecycle.abortSignal }),
    );
    expect(onAdopted).not.toHaveBeenCalled();
    await replyOptions?.turnAdoptionLifecycle?.onAdopted();
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });

  it("sanitizes mixed assistant text on the inbound reply path", async () => {
    vi.mocked(
      coreRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed" },
        { kind: "final" },
      );
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    await receive({ account: openConfig });

    expect(sendReply.mock.calls.map((call) => call[1])).toEqual(["Done."]);
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
      await receive({
        message: createMessage({ target: "#ops", isGroup: true, text }),
        account: {
          ...openConfig,
          groupPolicy: "open",
          groups: { "#ops": { enabled: true, requireMention: true } },
        },
        nick,
      });

      expect(coreRuntime.channel.inbound.dispatch).toHaveBeenCalledTimes(mentioned ? 1 : 0);
      if (!mentioned) {
        expect(runtime.log).toHaveBeenCalledWith("irc: drop channel #ops (missing-mention)");
      }
    },
  );

  it("drops a spoofed sender for a host-less nick!user DM allowlist entry", async () => {
    await receive({
      message: createMessage({ senderHost: "attacker.example" }),
      account: { dmPolicy: "allowlist", allowFrom: ["alice!ident"] },
    });

    expect(coreRuntime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "irc: drop DM sender alice!ident@attacker.example (dmPolicy=allowlist)",
    );
  });

  it("admits a sender matching the host-bound DM allowlist entry", async () => {
    await receive({
      account: { dmPolicy: "allowlist", allowFrom: ["alice@example.com"] },
    });

    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledOnce();
  });
});
