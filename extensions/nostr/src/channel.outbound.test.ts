import type { PluginRuntime } from "openclaw/plugin-sdk/nostr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../test-utils/start-account-context.js";
import { nostrPlugin } from "./channel.js";
import { setNostrRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  normalizePubkey: vi.fn((value: string) => `normalized-${value.toLowerCase()}`),
  startNostrBus: vi.fn(),
}));

vi.mock("./nostr-bus.js", () => ({
  DEFAULT_RELAYS: ["wss://relay.example.com"],
  getPublicKeyFromPrivate: vi.fn(() => "pubkey"),
  normalizePubkey: mocks.normalizePubkey,
  startNostrBus: mocks.startNostrBus,
}));

describe("nostr outbound cfg threading", () => {
  afterEach(() => {
    mocks.normalizePubkey.mockClear();
    mocks.startNostrBus.mockReset();
  });

  it("uses resolved cfg when converting markdown tables before send", async () => {
    const resolveMarkdownTableMode = vi.fn(() => "off");
    const convertMarkdownTables = vi.fn((text: string) => `converted:${text}`);
    setNostrRuntime({
      channel: {
        text: {
          resolveMarkdownTableMode,
          convertMarkdownTables,
        },
      },
      reply: {},
    } as unknown as PluginRuntime);

    const sendDm = vi.fn(async () => {});
    const bus = {
      sendDm,
      close: vi.fn(),
      getMetrics: vi.fn(() => ({ counters: {} })),
      publishProfile: vi.fn(),
      getProfileState: vi.fn(async () => null),
    };
    mocks.startNostrBus.mockResolvedValueOnce(bus as any);

    const ac = new AbortController();

    // startAccount blocks until the abort signal fires, so don't await it.
    const startPromise = nostrPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: {
          accountId: "default",
          enabled: true,
          configured: true,
          privateKey: "dead".repeat(16), // pragma: allowlist secret
          publicKey: "face".repeat(16),
          relays: ["wss://relay.example.com"],
          config: {},
        },
        abortSignal: ac.signal,
      }),
    );

    // Let startAccount set up the bus before testing outbound.
    await vi.waitFor(() => expect(mocks.startNostrBus).toHaveBeenCalled());

    const cfg = {
      channels: {
        nostr: {
          nsec: "resolved-nostr-test-placeholder",
        },
      },
    };
    await nostrPlugin.outbound!.sendText!({
      cfg: cfg as any,
      to: "NPUB123",
      text: "|a|b|",
      accountId: "default",
    });

    expect(resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg,
      channel: "nostr",
      accountId: "default",
    });
    expect(convertMarkdownTables).toHaveBeenCalledWith("|a|b|", "off");
    expect(mocks.normalizePubkey).toHaveBeenCalledWith("NPUB123");
    expect(sendDm).toHaveBeenCalledWith("normalized-npub123", "converted:|a|b|");

    ac.abort();
    await startPromise;
  });
});
