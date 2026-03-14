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
    const abort = new AbortController();

    let settled = false;
    const task = nostrPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: {
          accountId: "default",
          enabled: true,
          configured: true,
          privateKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // pragma: allowlist secret
          publicKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", // pragma: allowlist secret
          relays: ["wss://relay.example.com"],
          config: {},
        },
        abortSignal: abort.signal,
      }),
    );
    void task.then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(mocks.startNostrBus).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);

    const cfg = {
      channels: {
        nostr: {
          privateKey: "resolved-nostr-private-key", // pragma: allowlist secret
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

    abort.abort();
    await task;
    expect(bus.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to attachment links for sendMedia", async () => {
    const resolveMarkdownTableMode = vi.fn(() => "off");
    const convertMarkdownTables = vi.fn((text: string) => text);
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
    const abort = new AbortController();
    const task = nostrPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: {
          accountId: "default",
          enabled: true,
          configured: true,
          privateKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // pragma: allowlist secret
          publicKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", // pragma: allowlist secret
          relays: ["wss://relay.example.com"],
          config: {},
        },
        abortSignal: abort.signal,
      }),
    );

    await vi.waitFor(() => {
      expect(mocks.startNostrBus).toHaveBeenCalledOnce();
    });

    await nostrPlugin.outbound!.sendMedia!({
      cfg: {} as any,
      to: "NPUB123",
      text: "see attachment",
      mediaUrl: "https://example.com/file.png",
      accountId: "default",
    });

    expect(sendDm).toHaveBeenCalledWith(
      "normalized-npub123",
      "see attachment\n\nAttachment: https://example.com/file.png",
    );

    abort.abort();
    await task;
  });
});
