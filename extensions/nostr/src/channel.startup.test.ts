import type { PluginRuntime } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nostrPlugin, resolveNostrTimestampMs } from "./channel.js";
import { startNostrBus } from "./nostr-bus.js";
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

    let capturedOnMessage:
      | ((payload: unknown, reply: () => Promise<void>) => Promise<void>)
      | null = null;

    vi.mocked(startNostrBus).mockImplementation(async ({ onMessage }) => {
      capturedOnMessage = onMessage;
      return {
        close: vi.fn(),
        publicKey: "bot-pubkey",
        sendDm: vi.fn(),
        getMetrics: vi.fn(() => ({})),
        publishProfile: vi.fn(),
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
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime;

    setNostrRuntime(runtime);

    await nostrPlugin.gateway.startAccount({
      account: {
        accountId: "default",
        configured: true,
        privateKey: "a".repeat(64),
        relays: ["ws://localhost:7777"],
        publicKey: "b".repeat(64),
        enabled: true,
        name: "default",
        config: {},
        lastError: null,
        profile: null,
      },
      cfg: {},
      runtime,
      abortSignal: undefined,
      log: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      setStatus: vi.fn(),
    } as never);

    if (!capturedOnMessage) {
      throw new Error("inbound handler was not registered");
    }

    await capturedOnMessage(
      {
        senderPubkey: "sender".repeat(8).slice(0, 64),
        text: "hello world",
        createdAt: 1_700_000_000,
        eventId: "event-id",
        kind: 25802,
      },
      async () => undefined,
    );

    const expectedTimestampMs = resolveNostrTimestampMs(1_700_000_000);

    expect(formatAgentEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: expectedTimestampMs }),
    );
    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ Timestamp: expectedTimestampMs }),
    );
  });
});
