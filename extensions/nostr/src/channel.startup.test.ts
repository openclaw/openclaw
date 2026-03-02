import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../test-utils/start-account-context.js";
import { setNostrRuntime } from "./runtime.js";
import type { ResolvedNostrAccount } from "./types.js";

const hoisted = vi.hoisted(() => ({
  startNostrBus: vi.fn(),
}));

vi.mock("./nostr-bus.js", async () => {
  const actual = await vi.importActual<typeof import("./nostr-bus.js")>("./nostr-bus.js");
  return {
    ...actual,
    startNostrBus: hoisted.startNostrBus,
  };
});

import { nostrPlugin } from "./channel.js";

function buildAccount(): ResolvedNostrAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    privateKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    publicKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    relays: ["wss://relay.damus.io"],
    config: {
      privateKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
  };
}

describe("nostrPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the bus", async () => {
    setNostrRuntime({
      channel: {
        reply: {},
        text: {
          resolveMarkdownTableMode: () => "plain",
          convertMarkdownTables: (text: string) => text,
        },
      },
      config: {
        loadConfig: () => ({}),
      },
    } as never);
    const close = vi.fn();
    hoisted.startNostrBus.mockResolvedValue({
      close,
      publicKey: "pub",
      sendDm: vi.fn(),
      getMetrics: vi.fn(() => ({})),
      publishProfile: vi.fn(),
      getProfileState: vi.fn(),
    });
    const abort = new AbortController();
    const task = nostrPlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: buildAccount(),
        abortSignal: abort.signal,
      }),
    );
    let settled = false;
    void task.then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(hoisted.startNostrBus).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    expect(close).not.toHaveBeenCalled();

    abort.abort();
    await task;

    expect(close).toHaveBeenCalledOnce();
  });
});
