import type { OpenClawConfig, PluginRuntime, ReplyPayload } from "openclaw/plugin-sdk";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { xmtpPlugin } from "./channel.js";
import { setXmtpRuntime } from "./runtime.js";
import type { ResolvedXmtpAccount } from "./types.js";

const TEST_WALLET_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_DB_KEY = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const TEST_SENDER = "0x1234567890abcdef1234567890abcdef12345678";

const busState = vi.hoisted(() => {
  const sendText = vi.fn(async (_target: string, _text: string) => {});
  const close = vi.fn(async () => {});
  const getAddress = vi.fn(() => "0xaabbccddeeff0011223344556677889900aabbcc");
  let onMessage:
    | ((params: {
        senderAddress: string;
        senderInboxId: string;
        conversationId: string;
        isDm: boolean;
        text: string;
        messageId: string;
      }) => Promise<void>)
    | undefined;

  const startXmtpBus = vi.fn(async (options: { onMessage: typeof onMessage }) => {
    onMessage = options.onMessage;
    return {
      sendText,
      close,
      getAddress,
    };
  });

  return {
    sendText,
    close,
    getAddress,
    startXmtpBus,
    getOnMessage: () => onMessage,
    reset() {
      onMessage = undefined;
      sendText.mockReset();
      close.mockReset();
      getAddress.mockReset();
      getAddress.mockReturnValue("0xaabbccddeeff0011223344556677889900aabbcc");
      startXmtpBus.mockReset();
      startXmtpBus.mockImplementation(async (options: { onMessage: typeof onMessage }) => {
        onMessage = options.onMessage;
        return {
          sendText,
          close,
          getAddress,
        };
      });
    },
  };
});

vi.mock("./xmtp-bus.js", async () => {
  const actual = await vi.importActual<typeof import("./xmtp-bus.js")>("./xmtp-bus.js");
  return {
    ...actual,
    startXmtpBus: busState.startXmtpBus,
  };
});

function createConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      xmtp: {
        walletKey: TEST_WALLET_KEY,
        dbEncryptionKey: TEST_DB_KEY,
        env: "dev",
        ...overrides,
      },
    },
  };
}

function createRuntime(cfg: OpenClawConfig) {
  const finalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ctx);
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
    async (_params: {
      dispatcherOptions: {
        deliver: (payload: ReplyPayload) => Promise<void>;
      };
    }) => {},
  );
  const recordInboundSession = vi.fn(async () => {});
  const readAllowFromStore = vi.fn(async () => [] as string[]);
  const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR-123", created: true }));
  const buildPairingReply = vi.fn(
    (params: { channel: string; idLine: string; code: string }) =>
      `[${params.channel}] ${params.idLine} code=${params.code}`,
  );
  const activityRecord = vi.fn();
  const shouldHandleTextCommands = vi.fn(() => true);
  const isControlCommandMessage = vi.fn((body: string) => body.trim().startsWith("/"));
  const outboundLogger = { debug: vi.fn() };

  const runtime = {
    config: {
      loadConfig: vi.fn(() => cfg),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: vi.fn(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          accountId: "default",
          sessionKey: "agent:main:xmtp:dm:sender",
        })),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
        formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
        finalizeInboundContext,
        dispatchReplyWithBufferedBlockDispatcher,
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
        recordInboundSession,
      },
      pairing: {
        readAllowFromStore,
        upsertPairingRequest,
        buildPairingReply,
      },
      commands: {
        shouldHandleTextCommands,
        isControlCommandMessage,
      },
      activity: {
        record: activityRecord,
      },
    },
    logging: {
      getChildLogger: vi.fn(() => outboundLogger),
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    finalizeInboundContext,
    dispatchReplyWithBufferedBlockDispatcher,
    recordInboundSession,
    readAllowFromStore,
    upsertPairingRequest,
    buildPairingReply,
    activityRecord,
    shouldHandleTextCommands,
    isControlCommandMessage,
    outboundLogger,
  };
}

function createGatewayContext(cfg: OpenClawConfig, account: ResolvedXmtpAccount) {
  return {
    cfg,
    accountId: account.accountId,
    account,
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    abortSignal: new AbortController().signal,
    setStatus: vi.fn(),
    getStatus: vi.fn(() => ({
      accountId: account.accountId,
      running: false,
    })),
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  };
}

describe("xmtpPlugin behavior", () => {
  let activeStop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    busState.reset();
    activeStop = null;
  });

  afterEach(async () => {
    if (activeStop) {
      await activeStop();
      activeStop = null;
    }
  });

  async function startGateway(params?: {
    runtime?: ReturnType<typeof createRuntime>;
    cfg?: OpenClawConfig;
  }) {
    const cfg = params?.cfg ?? createConfig();
    const runtimeBundle = params?.runtime ?? createRuntime(cfg);
    setXmtpRuntime(runtimeBundle.runtime);

    const account = xmtpPlugin.config.resolveAccount(cfg, "default");
    const startAccount = xmtpPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("startAccount is not available");
    }

    const gatewayCtx = createGatewayContext(cfg, account);
    const lifecycle = (await startAccount(gatewayCtx)) as {
      stop: () => Promise<void>;
    };
    activeStop = lifecycle.stop;
    return { runtimeBundle, gatewayCtx };
  }

  async function emitInboundMessage(text: string) {
    const onMessage = busState.getOnMessage();
    expect(onMessage).toBeTypeOf("function");
    if (!onMessage) {
      throw new Error("onMessage handler was not registered");
    }

    await onMessage({
      senderAddress: TEST_SENDER,
      senderInboxId: "inbox-1",
      conversationId: "conversation-123",
      isDm: true,
      text,
      messageId: "xmtp-message-123",
    });
  }

  it("routes outbound sends to address targets via bus and records activity", async () => {
    const cfg = createConfig();
    const runtimeBundle = createRuntime(cfg);
    await startGateway({ cfg, runtime: runtimeBundle });

    await xmtpPlugin.outbound?.sendText?.({
      cfg,
      to: TEST_SENDER,
      text: "hello outbound",
      accountId: "default",
    });

    expect(busState.sendText).toHaveBeenCalledWith(TEST_SENDER, "hello outbound");
    expect(runtimeBundle.activityRecord).toHaveBeenCalledWith({
      channel: "xmtp",
      accountId: "default",
      direction: "outbound",
    });
    expect(runtimeBundle.outboundLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("xmtp outbound:"),
    );
  });

  it("uses address target for pairing approval notifications", async () => {
    const cfg = createConfig();
    const runtimeBundle = createRuntime(cfg);
    await startGateway({ cfg, runtime: runtimeBundle });

    await xmtpPlugin.pairing?.notifyApproval?.({
      cfg,
      id: TEST_SENDER,
    });

    expect(busState.sendText).toHaveBeenCalledWith(TEST_SENDER, PAIRING_APPROVED_MESSAGE);
    expect(runtimeBundle.activityRecord).toHaveBeenCalledWith({
      channel: "xmtp",
      accountId: "default",
      direction: "outbound",
    });
  });

  it("fails pairing approval notify when gateway bus is not running", async () => {
    const cfg = createConfig();
    const runtimeBundle = createRuntime(cfg);
    setXmtpRuntime(runtimeBundle.runtime);

    await expect(
      xmtpPlugin.pairing?.notifyApproval?.({
        cfg,
        id: TEST_SENDER,
      }),
    ).rejects.toThrow("XMTP bus not running");
  });

  it("uses inbound XMTP message id as MessageSid and records inbound sessions", async () => {
    const cfg = createConfig({ dmPolicy: "open" });
    const runtimeBundle = createRuntime(cfg);
    await startGateway({ runtime: runtimeBundle, cfg });

    await emitInboundMessage("hello inbound");

    expect(runtimeBundle.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageSid: "xmtp-message-123",
        MessageSidFull: "xmtp-message-123",
      }),
    );
    expect(runtimeBundle.recordInboundSession).toHaveBeenCalled();
    expect(runtimeBundle.activityRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "xmtp",
        accountId: "default",
        direction: "inbound",
      }),
    );
  });

  it("replies to inbound messages using conversation id and records outbound activity", async () => {
    const cfg = createConfig({ dmPolicy: "open" });
    const runtimeBundle = createRuntime(cfg);
    runtimeBundle.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async (params: {
        dispatcherOptions: {
          deliver: (payload: ReplyPayload) => Promise<void>;
        };
      }) => {
        await params.dispatcherOptions.deliver({ text: "reply text" });
      },
    );

    const { gatewayCtx } = await startGateway({ runtime: runtimeBundle, cfg });
    await emitInboundMessage("hello inbound");

    expect(busState.sendText).toHaveBeenCalledWith("conversation-123", "reply text");
    expect(runtimeBundle.activityRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "outbound",
      }),
    );
    expect(gatewayCtx.log.debug).toHaveBeenCalledWith(expect.stringContaining("xmtp outbound:"));
  });

  it("blocks unauthorized DM senders when dmPolicy is allowlist", async () => {
    const cfg = createConfig({ dmPolicy: "allowlist", allowFrom: [] });
    const runtimeBundle = createRuntime(cfg);
    await startGateway({ runtime: runtimeBundle, cfg });

    await emitInboundMessage("hello inbound");

    expect(runtimeBundle.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(runtimeBundle.upsertPairingRequest).not.toHaveBeenCalled();
    expect(busState.sendText).not.toHaveBeenCalled();
  });

  it("creates pairing requests and replies for unauthorized DM senders in pairing mode", async () => {
    const cfg = createConfig({ dmPolicy: "pairing", allowFrom: [] });
    const runtimeBundle = createRuntime(cfg);
    await startGateway({ runtime: runtimeBundle, cfg });

    await emitInboundMessage("hello inbound");

    expect(runtimeBundle.upsertPairingRequest).toHaveBeenCalledWith({
      channel: "xmtp",
      id: TEST_SENDER,
      accountId: "default",
      meta: {
        inboxId: "inbox-1",
      },
    });
    expect(runtimeBundle.buildPairingReply).toHaveBeenCalledWith({
      channel: "xmtp",
      idLine: `Your XMTP address: ${TEST_SENDER}`,
      code: "PAIR-123",
    });
    expect(busState.sendText).toHaveBeenCalledWith(
      "conversation-123",
      expect.stringContaining("code=PAIR-123"),
    );
    expect(runtimeBundle.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("allows configured or paired DM senders and sets command authorization", async () => {
    const cfg = createConfig({ dmPolicy: "allowlist", allowFrom: [] });
    const runtimeBundle = createRuntime(cfg);
    runtimeBundle.readAllowFromStore.mockResolvedValue([TEST_SENDER]);
    await startGateway({ runtime: runtimeBundle, cfg });

    await emitInboundMessage("/status");

    expect(runtimeBundle.readAllowFromStore).toHaveBeenCalledWith("xmtp", "default");
    expect(runtimeBundle.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        CommandAuthorized: true,
      }),
    );
    expect(runtimeBundle.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
  });

  it("blocks control commands in open mode when sender is not command-authorized", async () => {
    const cfg = createConfig({ dmPolicy: "open", allowFrom: [] });
    const runtimeBundle = createRuntime(cfg);
    await startGateway({ runtime: runtimeBundle, cfg });

    await emitInboundMessage("/status");

    expect(runtimeBundle.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(runtimeBundle.finalizeInboundContext).not.toHaveBeenCalled();
  });

  it("drops all inbound DMs when dmPolicy is disabled", async () => {
    const cfg = createConfig({ dmPolicy: "disabled", allowFrom: [TEST_SENDER] });
    const runtimeBundle = createRuntime(cfg);
    await startGateway({ runtime: runtimeBundle, cfg });

    await emitInboundMessage("hello inbound");

    expect(runtimeBundle.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(runtimeBundle.finalizeInboundContext).not.toHaveBeenCalled();
  });

  it("logs pairing and inbound diagnostics for troubleshooting", async () => {
    const cfg = createConfig({ dmPolicy: "pairing", allowFrom: [] });
    const runtimeBundle = createRuntime(cfg);
    const { gatewayCtx } = await startGateway({ runtime: runtimeBundle, cfg });

    await emitInboundMessage("hello inbound");

    expect(gatewayCtx.log.info).toHaveBeenCalledWith(
      expect.stringContaining("xmtp pairing request"),
    );

    runtimeBundle.readAllowFromStore.mockResolvedValue([TEST_SENDER]);
    await emitInboundMessage("hello after allow");

    expect(gatewayCtx.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("xmtp pairing reply"),
    );
    expect(gatewayCtx.log.debug).toHaveBeenCalledWith(expect.stringContaining("xmtp inbound:"));
  });
});
