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

function createConfig(): OpenClawConfig {
  return {
    channels: {
      xmtp: {
        walletKey: TEST_WALLET_KEY,
        dbEncryptionKey: TEST_DB_KEY,
        env: "dev",
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
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    finalizeInboundContext,
    dispatchReplyWithBufferedBlockDispatcher,
    recordInboundSession,
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

    const lifecycle = (await startAccount(createGatewayContext(cfg, account))) as {
      stop: () => Promise<void>;
    };
    activeStop = lifecycle.stop;
    return runtimeBundle;
  }

  it("routes outbound sends to address targets via bus", async () => {
    await startGateway();

    await xmtpPlugin.outbound?.sendText?.({
      cfg: createConfig(),
      to: TEST_SENDER,
      text: "hello outbound",
      accountId: "default",
    });

    expect(busState.sendText).toHaveBeenCalledWith(TEST_SENDER, "hello outbound");
  });

  it("uses address target for pairing approval notifications", async () => {
    await startGateway();

    await xmtpPlugin.pairing?.notifyApproval?.({
      cfg: createConfig(),
      id: TEST_SENDER,
    });

    expect(busState.sendText).toHaveBeenCalledWith(TEST_SENDER, PAIRING_APPROVED_MESSAGE);
  });

  it("uses inbound XMTP message id as MessageSid", async () => {
    const runtimeBundle = createRuntime(createConfig());
    await startGateway({ runtime: runtimeBundle });

    const onMessage = busState.getOnMessage();
    expect(onMessage).toBeTypeOf("function");
    if (!onMessage) {
      return;
    }

    await onMessage({
      senderAddress: TEST_SENDER,
      senderInboxId: "inbox-1",
      conversationId: "conversation-123",
      isDm: true,
      text: "hello inbound",
      messageId: "xmtp-message-123",
    });

    expect(runtimeBundle.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageSid: "xmtp-message-123",
        MessageSidFull: "xmtp-message-123",
      }),
    );
    expect(runtimeBundle.recordInboundSession).toHaveBeenCalled();
  });

  it("replies to inbound messages using conversation id", async () => {
    const runtimeBundle = createRuntime(createConfig());
    runtimeBundle.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async (params: {
        dispatcherOptions: {
          deliver: (payload: ReplyPayload) => Promise<void>;
        };
      }) => {
        await params.dispatcherOptions.deliver({ text: "reply text" });
      },
    );

    await startGateway({ runtime: runtimeBundle });

    const onMessage = busState.getOnMessage();
    expect(onMessage).toBeTypeOf("function");
    if (!onMessage) {
      return;
    }

    await onMessage({
      senderAddress: TEST_SENDER,
      senderInboxId: "inbox-1",
      conversationId: "conversation-123",
      isDm: true,
      text: "hello inbound",
      messageId: "xmtp-message-123",
    });

    expect(busState.sendText).toHaveBeenCalledWith("conversation-123", "reply text");
  });
});
