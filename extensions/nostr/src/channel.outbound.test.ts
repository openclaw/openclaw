import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import type { PluginRuntime } from "../runtime-api.js";
import { nostrPlugin } from "./channel.js";
import { setNostrRuntime } from "./runtime.js";
import { TEST_RESOLVED_PRIVATE_KEY, buildResolvedNostrAccount } from "./test-fixtures.js";

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

function createCfg() {
  return {
    channels: {
      nostr: {
        privateKey: TEST_RESOLVED_PRIVATE_KEY, // pragma: allowlist secret
      },
    },
  };
}

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
    mocks.startNostrBus.mockResolvedValueOnce(bus as unknown);

    const cleanup = (await nostrPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: buildResolvedNostrAccount(),
      }),
    )) as { stop: () => void };

    const cfg = createCfg();
    await nostrPlugin.outbound!.sendText!({
      cfg: cfg as unknown,
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

    cleanup.stop();
  });

  it("uses the configured defaultAccount when accountId is omitted", async () => {
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
    mocks.startNostrBus.mockResolvedValueOnce(bus as unknown);

    const cleanup = (await nostrPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: buildResolvedNostrAccount({ accountId: "work" }),
      }),
    )) as { stop: () => void };

    const cfg = {
      channels: {
        nostr: {
          privateKey: TEST_RESOLVED_PRIVATE_KEY, // pragma: allowlist secret
          defaultAccount: "work",
        },
      },
    };

    await nostrPlugin.outbound!.sendText!({
      cfg: cfg as unknown,
      to: "NPUB123",
      text: "hello",
    });

    expect(resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg,
      channel: "nostr",
      accountId: "work",
    });
    expect(sendDm).toHaveBeenCalledWith("normalized-npub123", "hello");

    cleanup.stop();
  });
});
