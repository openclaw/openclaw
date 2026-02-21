import { beforeEach, describe, expect, it, vi } from "vitest";

const { startNostrBusMock, getNostrRuntimeMock } = vi.hoisted(() => ({
  startNostrBusMock: vi.fn(),
  getNostrRuntimeMock: vi.fn(),
}));

vi.mock("./nostr-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nostr-bus.js")>();
  return {
    ...actual,
    startNostrBus: startNostrBusMock,
  };
});

vi.mock("./runtime.js", () => ({
  getNostrRuntime: getNostrRuntimeMock,
}));

import { nostrPlugin } from "./channel.js";

describe("nostr inbound dispatch", () => {
  beforeEach(() => {
    startNostrBusMock.mockReset();
    getNostrRuntimeMock.mockReset();
  });

  it("routes inbound DMs via dispatchReplyWithBufferedBlockDispatcher", async () => {
    type OnMessageHandler = (
      senderPubkey: string,
      text: string,
      reply: (text: string) => Promise<void>,
    ) => Promise<void>;
    let onMessageHandler: OnMessageHandler | null = null;

    const dispatchMock = vi.fn(
      async (params: {
        ctx?: Record<string, unknown>;
        dispatcherOptions: { deliver: (payload: { text?: string }) => Promise<void> };
      }) => {
        await params.dispatcherOptions.deliver({ text: "model-reply" });
      },
    );

    const recordInboundSessionMock = vi.fn(async () => {});
    const readAllowFromStoreMock = vi.fn(async () => []);
    const upsertPairingRequestMock = vi.fn(async () => ({ code: "PAIRING", created: true }));
    const buildPairingReplyMock = vi.fn(() => "pairing reply");
    const shouldComputeCommandAuthorizedMock = vi.fn(() => false);
    const resolveCommandAuthorizedFromAuthorizersMock = vi.fn(() => false);

    getNostrRuntimeMock.mockReturnValue({
      config: {
        loadConfig: () => ({
          agents: {
            main: {},
          },
        }),
      },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "nostr:session:1",
            mainSessionKey: "agent:main:main",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/sessions",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: recordInboundSessionMock,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({ mode: "compact" }),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
          dispatchReplyWithBufferedBlockDispatcher: dispatchMock,
        },
        text: {
          resolveMarkdownTableMode: () => "off",
          convertMarkdownTables: (text: string) => text,
        },
        pairing: {
          readAllowFromStore: readAllowFromStoreMock,
          upsertPairingRequest: upsertPairingRequestMock,
          buildPairingReply: buildPairingReplyMock,
        },
        commands: {
          shouldComputeCommandAuthorized: shouldComputeCommandAuthorizedMock,
          resolveCommandAuthorizedFromAuthorizers: resolveCommandAuthorizedFromAuthorizersMock,
        },
      },
    });

    startNostrBusMock.mockImplementation(async (options: { onMessage: OnMessageHandler }) => {
      onMessageHandler = options.onMessage;
      return {
        close: vi.fn(),
        publicKey: "bot-public-key",
        sendDm: vi.fn(async () => {}),
        getMetrics: vi.fn(() => ({ counters: {}, relays: {}, snapshots: [] })),
        publishProfile: vi.fn(async () => ({
          successes: [],
          failures: [],
          eventId: "",
          createdAt: 0,
        })),
        getProfileState: vi.fn(async () => ({
          lastPublishedAt: null,
          lastPublishedEventId: null,
          lastPublishResults: null,
        })),
      };
    });

    const startAccount = nostrPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("startAccount not available");
    }

    const gatewayContext = {
      cfg: {},
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        privateKey: "private-key",
        publicKey: "bot-public-key",
        relays: ["wss://relay.example"],
        config: {
          dmPolicy: "open",
        },
      },
      setStatus: vi.fn(),
      getStatus: vi.fn(() => ({})),
      accountId: "default",
      runtime: {
        running: true,
      },
      abortSignal: new AbortController().signal,
      log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as Parameters<typeof startAccount>[0];

    await startAccount(gatewayContext);

    expect(onMessageHandler).toBeTypeOf("function");
    if (!onMessageHandler) {
      throw new Error("onMessage handler was not captured");
    }
    const runOnMessage: OnMessageHandler = onMessageHandler;

    const replySpy = vi.fn(async () => {});
    await runOnMessage("sender-pubkey", "incoming text", replySpy);

    expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
    const recordArg = recordInboundSessionMock.mock.calls[0]?.[0];
    expect(recordArg?.updateLastRoute).toEqual({
      sessionKey: "agent:main:main",
      channel: "nostr",
      to: "sender-pubkey",
      accountId: "default",
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatchMock.mock.calls[0]?.[0];
    expect(dispatchArg?.ctx?.Provider).toBe("nostr");
    expect(dispatchArg?.ctx?.ChatType).toBe("direct");
    expect(dispatchArg?.ctx?.SenderId).toBe("sender-pubkey");
    expect(replySpy).toHaveBeenCalledWith("model-reply");
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(buildPairingReplyMock).not.toHaveBeenCalled();
    expect(shouldComputeCommandAuthorizedMock).toHaveBeenCalledWith(
      "incoming text",
      expect.any(Object),
    );
    expect(resolveCommandAuthorizedFromAuthorizersMock).not.toHaveBeenCalled();
  });

  it("enforces pairing policy before dispatching unauthorized DMs", async () => {
    type OnMessageHandler = (
      senderPubkey: string,
      text: string,
      reply: (text: string) => Promise<void>,
    ) => Promise<void>;
    let onMessageHandler: OnMessageHandler | null = null;

    const dispatchMock = vi.fn();
    const recordInboundSessionMock = vi.fn(async () => {});
    const readAllowFromStoreMock = vi.fn(async () => []);
    const upsertPairingRequestMock = vi.fn(async () => ({ code: "PAIR123", created: true }));
    const shouldComputeCommandAuthorizedMock = vi.fn(() => false);
    const resolveCommandAuthorizedFromAuthorizersMock = vi.fn(() => false);

    getNostrRuntimeMock.mockReturnValue({
      config: {
        loadConfig: () => ({
          agents: {
            main: {},
          },
        }),
      },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "nostr:session:1",
            mainSessionKey: "agent:main:main",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/sessions",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: recordInboundSessionMock,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({ mode: "compact" }),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
          dispatchReplyWithBufferedBlockDispatcher: dispatchMock,
        },
        text: {
          resolveMarkdownTableMode: () => "off",
          convertMarkdownTables: (text: string) => text,
        },
        pairing: {
          readAllowFromStore: readAllowFromStoreMock,
          upsertPairingRequest: upsertPairingRequestMock,
          buildPairingReply: ({ code, idLine }: { code: string; idLine: string }) =>
            `OpenClaw: access not configured.\n${idLine}\nPairing code: ${code}`,
        },
        commands: {
          shouldComputeCommandAuthorized: shouldComputeCommandAuthorizedMock,
          resolveCommandAuthorizedFromAuthorizers: resolveCommandAuthorizedFromAuthorizersMock,
        },
      },
    });

    startNostrBusMock.mockImplementation(async (options: { onMessage: OnMessageHandler }) => {
      onMessageHandler = options.onMessage;
      return {
        close: vi.fn(),
        publicKey: "bot-public-key",
        sendDm: vi.fn(async () => {}),
        getMetrics: vi.fn(() => ({ counters: {}, relays: {}, snapshots: [] })),
        publishProfile: vi.fn(async () => ({
          successes: [],
          failures: [],
          eventId: "",
          createdAt: 0,
        })),
        getProfileState: vi.fn(async () => ({
          lastPublishedAt: null,
          lastPublishedEventId: null,
          lastPublishResults: null,
        })),
      };
    });

    const startAccount = nostrPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("startAccount not available");
    }

    const gatewayContext = {
      cfg: {},
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        privateKey: "private-key",
        publicKey: "bot-public-key",
        relays: ["wss://relay.example"],
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
      setStatus: vi.fn(),
      getStatus: vi.fn(() => ({})),
      accountId: "default",
      runtime: {
        running: true,
      },
      abortSignal: new AbortController().signal,
      log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as Parameters<typeof startAccount>[0];

    await startAccount(gatewayContext);

    expect(onMessageHandler).toBeTypeOf("function");
    if (!onMessageHandler) {
      throw new Error("onMessage handler was not captured");
    }

    const replySpy = vi.fn(async () => {});
    await onMessageHandler("sender-pubkey", "incoming text", replySpy);

    expect(readAllowFromStoreMock).toHaveBeenCalledWith("nostr", undefined, "default");
    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      channel: "nostr",
      id: "sender-pubkey",
      accountId: "default",
    });
    expect(recordInboundSessionMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledWith(expect.stringContaining("Pairing code: PAIR123"));
    expect(shouldComputeCommandAuthorizedMock).toHaveBeenCalledWith(
      "incoming text",
      expect.any(Object),
    );
    expect(resolveCommandAuthorizedFromAuthorizersMock).not.toHaveBeenCalled();
  });

  it("sets CommandAuthorized=true for allowlisted DM control commands", async () => {
    type OnMessageHandler = (
      senderPubkey: string,
      text: string,
      reply: (text: string) => Promise<void>,
    ) => Promise<void>;
    let onMessageHandler: OnMessageHandler | null = null;

    const dispatchMock = vi.fn(async () => {});
    const recordInboundSessionMock = vi.fn(async () => {});
    const readAllowFromStoreMock = vi.fn(async () => []);
    const shouldComputeCommandAuthorizedMock = vi.fn(() => true);
    const resolveCommandAuthorizedFromAuthorizersMock = vi.fn(
      (params: { authorizers: Array<{ configured: boolean; allowed: boolean }> }) =>
        params.authorizers.some((entry) => entry.configured && entry.allowed),
    );

    getNostrRuntimeMock.mockReturnValue({
      config: {
        loadConfig: () => ({
          agents: {
            main: {},
          },
        }),
      },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "nostr:session:1",
            mainSessionKey: "agent:main:main",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/sessions",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: recordInboundSessionMock,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({ mode: "compact" }),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
          dispatchReplyWithBufferedBlockDispatcher: dispatchMock,
        },
        text: {
          resolveMarkdownTableMode: () => "off",
          convertMarkdownTables: (text: string) => text,
        },
        pairing: {
          readAllowFromStore: readAllowFromStoreMock,
          upsertPairingRequest: vi.fn(async () => ({ code: "PAIR", created: true })),
          buildPairingReply: vi.fn(() => "pairing reply"),
        },
        commands: {
          shouldComputeCommandAuthorized: shouldComputeCommandAuthorizedMock,
          resolveCommandAuthorizedFromAuthorizers: resolveCommandAuthorizedFromAuthorizersMock,
        },
      },
    });

    startNostrBusMock.mockImplementation(async (options: { onMessage: OnMessageHandler }) => {
      onMessageHandler = options.onMessage;
      return {
        close: vi.fn(),
        publicKey: "bot-public-key",
        sendDm: vi.fn(async () => {}),
        getMetrics: vi.fn(() => ({ counters: {}, relays: {}, snapshots: [] })),
        publishProfile: vi.fn(async () => ({
          successes: [],
          failures: [],
          eventId: "",
          createdAt: 0,
        })),
        getProfileState: vi.fn(async () => ({
          lastPublishedAt: null,
          lastPublishedEventId: null,
          lastPublishResults: null,
        })),
      };
    });

    const startAccount = nostrPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("startAccount not available");
    }

    const gatewayContext = {
      cfg: {},
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        privateKey: "private-key",
        publicKey: "bot-public-key",
        relays: ["wss://relay.example"],
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["sender-pubkey"],
        },
      },
      setStatus: vi.fn(),
      getStatus: vi.fn(() => ({})),
      accountId: "default",
      runtime: {
        running: true,
      },
      abortSignal: new AbortController().signal,
      log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as Parameters<typeof startAccount>[0];

    await startAccount(gatewayContext);

    expect(onMessageHandler).toBeTypeOf("function");
    if (!onMessageHandler) {
      throw new Error("onMessage handler was not captured");
    }

    const replySpy = vi.fn(async () => {});
    await onMessageHandler("sender-pubkey", "/model openai/gpt-4.1-mini", replySpy);

    expect(resolveCommandAuthorizedFromAuthorizersMock).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: true }],
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatchMock.mock.calls[0]?.[0];
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(true);
    expect(replySpy).not.toHaveBeenCalled();
  });
});
