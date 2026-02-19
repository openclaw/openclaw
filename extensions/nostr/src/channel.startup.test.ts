import type { PluginRuntime } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nostrPlugin, resolveNostrSessionId, resolveNostrTimestampMs } from "./channel.js";
import {
  startNostrBus,
  type NostrBusOptions,
  type NostrInboundMessage,
  type NostrOutboundMessageOptions,
} from "./nostr-bus.js";
import { setNostrRuntime } from "./runtime.js";

vi.mock("./nostr-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nostr-bus.js")>();
  return {
    ...actual,
    startNostrBus: vi.fn(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nostrPlugin gateway.startAccount", () => {
  it("normalizes inbound created_at to milliseconds in reply context", async () => {
    const formatAgentEnvelope = vi.fn();
    const finalizeInboundContext = vi.fn((ctx) => ctx);
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "default-agent",
      accountId: "default",
      sessionKey: "session:user",
      mainSessionKey: "session",
    }));

    const recordInboundSession = vi.fn(async () => undefined);
    const mockReplyDispatcher = vi.fn(async () => undefined);

    type OnMessage = NostrBusOptions["onMessage"];
    let capturedOnMessage: OnMessage | null = null;

    vi.mocked(startNostrBus).mockImplementation(async (options: NostrBusOptions) => {
      const { onMessage } = options;
      capturedOnMessage = onMessage;
      return {
        close: vi.fn(),
        publicKey: "bot-pubkey",
        sendDm: vi.fn(),
        getMetrics: vi.fn(() => ({})),
        publishProfile: vi.fn(),
        publishAiInfo: vi.fn(),
        getProfileState: vi.fn(),
      } as never;
    });

    const runtime = {
      channel: {
        routing: {
          resolveAgentRoute,
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nostr-session-store.json"),
          readSessionUpdatedAt: vi.fn(() => 1_700_000_500_000),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
          formatAgentEnvelope: formatAgentEnvelope,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher: mockReplyDispatcher,
        },
        text: {
          resolveMarkdownTableMode: vi.fn(() => "code"),
          convertMarkdownTables: vi.fn((text: string) => text),
        },
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(),
          buildPairingReply: vi.fn(),
        },
        commands: {
          shouldComputeCommandAuthorized: vi.fn(() => false),
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => true),
        },
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime;

    setNostrRuntime(runtime);

    const startAccount = nostrPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("nostr plugin startAccount is not defined");
    }
    const abort = new AbortController();
    abort.abort();
    await startAccount({
      account: {
        accountId: "default",
        configured: true,
        privateKey: "a".repeat(64),
        relays: ["ws://localhost:7777"],
        publicKey: "b".repeat(64),
        enabled: true,
        name: "default",
        config: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
        lastError: null,
        profile: null,
      },
      cfg: {},
      runtime,
      abortSignal: abort.signal,
      log: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      setStatus: vi.fn(),
    } as never);

    if (!capturedOnMessage) {
      throw new Error("inbound handler was not registered");
    }

    await (capturedOnMessage as OnMessage)(
      {
        senderPubkey: "sender".repeat(8).slice(0, 64),
        text: "hello world",
        createdAt: 1_700_000_000,
        eventId: "event-id",
        kind: 25802,
      },
      async (_content: unknown, _options?: NostrOutboundMessageOptions) => undefined,
    );

    const expectedTimestampMs = resolveNostrTimestampMs(1_700_000_000);

    expect(formatAgentEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: expectedTimestampMs }),
    );
    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ Timestamp: expectedTimestampMs }),
    );
  });

  it("maps dispatcher kind to NIP-63 response kind", async () => {
    const formatAgentEnvelope = vi.fn();
    const finalizeInboundContext = vi.fn((ctx) => ctx);
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "default-agent",
      accountId: "default",
      sessionKey: "session:user",
      mainSessionKey: "session",
    }));
    const recordInboundSession = vi.fn(async () => undefined);
    const mockReplyDispatcher = vi.fn(async (params) => {
      await params.replyOptions.onToolStart?.({
        name: "web_search",
        phase: "start",
      });
      params.dispatcherOptions.deliver(
        {
          text: "thinking",
        } satisfies { text: string },
        { kind: "tool" as const },
      );
      params.dispatcherOptions.deliver(
        {
          text: "block step",
        } satisfies { text: string },
        { kind: "block" as const },
      );
      params.dispatcherOptions.deliver(
        {
          text: "final answer",
        } satisfies { text: string },
        { kind: "final" as const },
      );
      return undefined;
    });

    const senderPubkey = "f".repeat(64);
    const eventId = "event-id";
    const sessionId = resolveNostrSessionId(senderPubkey, undefined);
    const replySpy = vi.fn(async (_content: unknown, _options?: NostrOutboundMessageOptions) => {});
    type OnMessage = NostrBusOptions["onMessage"];
    let capturedOnMessage: OnMessage | null = null;

    vi.mocked(startNostrBus).mockImplementation(async (options: NostrBusOptions) => {
      const { onMessage } = options;
      capturedOnMessage = onMessage;
      return {
        close: vi.fn(),
        publicKey: "bot-pubkey",
        sendDm: vi.fn(),
        getMetrics: vi.fn(() => ({})),
        publishProfile: vi.fn(),
        publishAiInfo: vi.fn(),
        getProfileState: vi.fn(),
      } as never;
    });

    const runtime = {
      channel: {
        routing: {
          resolveAgentRoute,
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nostr-session-store.json"),
          readSessionUpdatedAt: vi.fn(() => 1_700_000_500_000),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
          formatAgentEnvelope,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher: mockReplyDispatcher,
        },
        text: {
          resolveMarkdownTableMode: vi.fn(() => "code"),
          convertMarkdownTables: vi.fn((text: string) => text),
        },
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(),
          buildPairingReply: vi.fn(),
        },
        commands: {
          shouldComputeCommandAuthorized: vi.fn(() => false),
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => true),
        },
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime;

    setNostrRuntime(runtime);

    const startAccount = nostrPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("nostr plugin startAccount is not defined");
    }
    const abort = new AbortController();
    abort.abort();
    await startAccount({
      account: {
        accountId: "default",
        configured: true,
        privateKey: "a".repeat(64),
        relays: ["ws://localhost:7777"],
        publicKey: "b".repeat(64),
        enabled: true,
        name: "default",
        config: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
        lastError: null,
        profile: null,
      },
      cfg: {},
      runtime,
      abortSignal: abort.signal,
      log: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      setStatus: vi.fn(),
    } as never);

    if (!capturedOnMessage) {
      throw new Error("inbound handler was not registered");
    }
    const onMessageHandler = capturedOnMessage as OnMessage;

    await onMessageHandler(
      {
        senderPubkey,
        text: "hello world",
        createdAt: 1_700_000_000,
        eventId,
        kind: 25802,
      },
      replySpy,
    );

    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        state: "thinking",
        info: "run_started",
        progress: 0,
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25800,
    );
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        state: "tool_use",
        info: "web_search",
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25800,
    );
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        name: "web_search",
        phase: "start",
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25804,
    );
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        name: "tool",
        phase: "result",
        output: expect.objectContaining({
          text: "thinking",
        }),
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25804,
    );
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        event: "block",
        phase: "update",
        text: "block step",
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25801,
    );
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        state: "done",
        info: "run_completed",
        progress: 100,
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25800,
    );
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        text: "final answer",
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25803,
    );
    expect(mockReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: false,
          onToolStart: expect.any(Function),
        }),
      }),
    );
  });

  it("emits fallback final when dispatcher never emits final", async () => {
    const formatAgentEnvelope = vi.fn();
    const finalizeInboundContext = vi.fn((ctx) => ctx);
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "default-agent",
      accountId: "default",
      sessionKey: "session:user",
      mainSessionKey: "session",
    }));
    const recordInboundSession = vi.fn(async () => undefined);
    const mockReplyDispatcher = vi.fn(async (params) => {
      params.dispatcherOptions.deliver(
        {
          text: "partial output",
        } satisfies { text: string },
        { kind: "block" as const },
      );
      return undefined;
    });

    const senderPubkey = "e".repeat(64);
    const eventId = "event-fallback";
    const sessionId = resolveNostrSessionId(senderPubkey, undefined);
    const replySpy = vi.fn(async (_content: unknown, _options?: NostrOutboundMessageOptions) => {});
    type OnMessage = NostrBusOptions["onMessage"];
    let capturedOnMessage: OnMessage | null = null;

    vi.mocked(startNostrBus).mockImplementation(async (options: NostrBusOptions) => {
      const { onMessage } = options;
      capturedOnMessage = onMessage;
      return {
        close: vi.fn(),
        publicKey: "bot-pubkey",
        sendDm: vi.fn(),
        getMetrics: vi.fn(() => ({})),
        publishProfile: vi.fn(),
        publishAiInfo: vi.fn(),
        getProfileState: vi.fn(),
      } as never;
    });

    const runtime = {
      channel: {
        routing: {
          resolveAgentRoute,
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nostr-session-store.json"),
          readSessionUpdatedAt: vi.fn(() => 1_700_000_500_000),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
          formatAgentEnvelope,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher: mockReplyDispatcher,
        },
        text: {
          resolveMarkdownTableMode: vi.fn(() => "code"),
          convertMarkdownTables: vi.fn((text: string) => text),
        },
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(),
          buildPairingReply: vi.fn(),
        },
        commands: {
          shouldComputeCommandAuthorized: vi.fn(() => false),
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => true),
        },
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime;

    setNostrRuntime(runtime);

    const startAccount = nostrPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("nostr plugin startAccount is not defined");
    }
    const abort = new AbortController();
    abort.abort();
    await startAccount({
      account: {
        accountId: "default",
        configured: true,
        privateKey: "a".repeat(64),
        relays: ["ws://localhost:7777"],
        publicKey: "b".repeat(64),
        enabled: true,
        name: "default",
        config: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
        lastError: null,
        profile: null,
      },
      cfg: {},
      runtime,
      abortSignal: abort.signal,
      log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      setStatus: vi.fn(),
    } as never);

    if (!capturedOnMessage) {
      throw new Error("inbound handler was not registered");
    }
    const onMessageHandler = capturedOnMessage as OnMessage;

    await onMessageHandler(
      {
        senderPubkey,
        text: "hello fallback",
        createdAt: 1_700_000_000,
        eventId,
        kind: 25802,
      },
      replySpy,
    );

    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        event: "block",
        text: "partial output",
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25801,
    );
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        state: "done",
        info: "run_completed_fallback",
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25800,
    );
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ver: 1,
        text: "partial output",
      }),
      expect.objectContaining({
        sessionId,
        inReplyTo: eventId,
      }),
      25803,
    );
  });
});
