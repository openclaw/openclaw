import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../../test/helpers/extensions/start-account-context.js";
import type { PluginRuntime } from "../runtime-api.js";
import { nostrPlugin } from "./channel.js";
import { setNostrRuntime } from "./runtime.js";
import { buildResolvedNostrAccount } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  normalizePubkey: vi.fn((value: string) =>
    value
      .trim()
      .replace(/^nostr:/i, "")
      .toLowerCase(),
  ),
  startNostrBus: vi.fn(),
}));

vi.mock("./nostr-bus.js", () => ({
  DEFAULT_RELAYS: ["wss://relay.example.com"],
  getPublicKeyFromPrivate: vi.fn(() => "bot-pubkey"),
  normalizePubkey: mocks.normalizePubkey,
  startNostrBus: mocks.startNostrBus,
}));

function createRuntimeHarness() {
  const recordInboundSession = vi.fn(async () => {});
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "|a|b|" });
  });
  const runtime = {
    channel: {
      text: {
        resolveMarkdownTableMode: vi.fn(() => "off"),
        convertMarkdownTables: vi.fn((text: string) => `converted:${text}`),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => true),
      },
      routing: {
        resolveAgentRoute: vi.fn(({ accountId, peer }) => ({
          agentId: "agent-nostr",
          accountId,
          sessionKey: `nostr:${peer.id}`,
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/nostr-session-store"),
        recordInboundSession,
      },
      reply: {
        formatAgentEnvelope: vi.fn(({ body }) => `envelope:${body}`),
        resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: "agent" })),
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyWithBufferedBlockDispatcher,
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR1234", created: true })),
      },
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

describe("nostr inbound gateway path", () => {
  afterEach(() => {
    mocks.normalizePubkey.mockClear();
    mocks.startNostrBus.mockReset();
  });

  it("issues a pairing reply before decrypt for unknown senders", async () => {
    const harness = createRuntimeHarness();
    setNostrRuntime(harness.runtime);

    const bus = {
      sendDm: vi.fn(async () => {}),
      close: vi.fn(),
      getMetrics: vi.fn(() => ({ counters: {} })),
      publishProfile: vi.fn(),
      getProfileState: vi.fn(async () => null),
    };
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);

    const cleanup = (await nostrPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: buildResolvedNostrAccount({
          config: { dmPolicy: "pairing", allowFrom: [] },
        }),
      }),
    )) as { stop: () => void };

    const options = mocks.startNostrBus.mock.calls[0]?.[0] as {
      authorizeSender: (params: {
        senderPubkey: string;
        reply: (text: string) => Promise<void>;
      }) => Promise<string>;
    };
    const sendPairingReply = vi.fn(async (_text: string) => {});

    await expect(
      options.authorizeSender({
        senderPubkey: "nostr:UNKNOWN-SENDER",
        reply: sendPairingReply,
      }),
    ).resolves.toBe("pairing");
    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(sendPairingReply.mock.calls[0]?.[0]).toContain("Pairing code:");

    cleanup.stop();
  });

  it("routes allowed DMs through the standard reply pipeline", async () => {
    const harness = createRuntimeHarness();
    setNostrRuntime(harness.runtime);

    const bus = {
      sendDm: vi.fn(async () => {}),
      close: vi.fn(),
      getMetrics: vi.fn(() => ({ counters: {} })),
      publishProfile: vi.fn(),
      getProfileState: vi.fn(async () => null),
    };
    mocks.startNostrBus.mockResolvedValueOnce(bus as never);

    const cleanup = (await nostrPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: buildResolvedNostrAccount({
          publicKey: "bot-pubkey",
          config: { dmPolicy: "allowlist", allowFrom: ["nostr:sender-pubkey"] },
        }),
        cfg: {
          session: { store: { type: "jsonl" } },
          commands: { useAccessGroups: true },
        } as never,
      }),
    )) as { stop: () => void };

    const options = mocks.startNostrBus.mock.calls[0]?.[0] as {
      onMessage: (
        senderPubkey: string,
        text: string,
        reply: (text: string) => Promise<void>,
        meta: { eventId: string; createdAt: number },
      ) => Promise<void>;
    };
    const sendReply = vi.fn(async (_text: string) => {});

    await options.onMessage("sender-pubkey", "hello from nostr", sendReply, {
      eventId: "event-123",
      createdAt: 1_710_000_000,
    });

    expect(harness.recordInboundSession).toHaveBeenCalledTimes(1);
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(harness.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx).toMatchObject({
      BodyForAgent: "hello from nostr",
      SenderId: "sender-pubkey",
      MessageSid: "event-123",
      CommandAuthorized: true,
    });
    expect(sendReply).toHaveBeenCalledWith("converted:|a|b|");

    cleanup.stop();
  });
});
