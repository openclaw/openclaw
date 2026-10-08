import { finalizeEvent, type Event } from "nostr-tools";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return { ...(await importOriginal<typeof import("nostr-tools")>()), ...mockBuzzRelay() };
});

import { useBuzzBusLifecycleFixture } from "./buzz-bus.lifecycle.test-harness.js";
import { relayMocks } from "./buzz-bus.test-helpers.js";
import { handleBuzzInbound } from "./inbound.js";
import { setBuzzRuntime } from "./runtime.js";
import type { ResolvedBuzzAccount } from "./types.js";

const {
  PRIVATE_KEY,
  ACCOUNT_ID,
  CHANNEL_ID,
  BOT_PUBLIC_KEY,
  startTestBus,
  signSenderEvent,
  subscriptionIncludesKind,
} = useBuzzBusLifecycleFixture();

describe("Buzz bot-owned thread mentions", () => {
  it("hands a stalled root lookup to the account reconnect owner", async () => {
    vi.useFakeTimers();
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.stallThreadRootQueryEose = true;
    const onFatalError = vi.fn();
    const bus = await startTestBus({ onFatalError });
    try {
      const lookup = bus.isBotOwnedThread({ channelId: CHANNEL_ID, threadId: "f".repeat(64) });
      const rejection = expect(lookup).rejects.toThrow("Timed out loading Buzz thread root");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(onFatalError).toHaveBeenCalledOnce();
      expect(relayMocks.close).toHaveBeenCalledOnce();
      await expect(bus.sendText({ channelId: CHANNEL_ID, text: "late reply" })).rejects.toThrow(
        "Timed out loading Buzz thread root",
      );
    } finally {
      await bus.close();
    }
  });

  it("applies the room override only to verified bot roots through room ingress", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const runtime = createPluginRuntimeMock();
    setBuzzRuntime(runtime);
    let completed = createDeferred<void>();
    const account: ResolvedBuzzAccount = {
      accountId: ACCOUNT_ID,
      enabled: true,
      configured: true,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      authTag: "",
      publicKey: BOT_PUBLIC_KEY,
      config: { groupPolicy: "open" },
    };
    const bus = await startTestBus({
      onMessage: async (message, activeBus, signal, assertCurrent) => {
        try {
          await handleBuzzInbound({
            account,
            cfg: {},
            bus: activeBus,
            message,
            signal,
            assertCurrent,
            historyMap: new Map(),
          });
          completed.resolve();
        } catch (error) {
          completed.reject(error);
          throw error;
        }
      },
    });
    const roomSubscription = relayMocks.subscriptions.find((entry) =>
      subscriptionIncludesKind(entry, 9),
    );
    expect(roomSubscription).toBeDefined();
    const root = (content: string, tags: string[][] = [["h", CHANNEL_ID]]) =>
      structuredClone(
        finalizeEvent(
          { kind: 9, created_at: 1_700_000_000, content, tags },
          Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")),
        ),
      );
    const botRoot = root("bot root");
    const foreignRoot = signSenderEvent({
      kind: 9,
      created_at: 1_700_000_000,
      content: "human root",
      tags: [["h", CHANNEL_ID]],
    });
    const wrongRoomRoot = root("other room", [["h", "45cedd86-f853-45b7-8fea-812b7fe63d7a"]]);
    const botReply = root("reply inside human thread", [
      ["h", CHANNEL_ID],
      ["e", foreignRoot.id, "", "reply"],
    ]);
    const invalidRoot = { ...root("invalid signature"), sig: "0".repeat(128) };
    const cases: Array<{
      name: string;
      root?: Event;
      threadId?: string;
      requireMention?: boolean;
      requireMentionInBotThreads?: boolean;
      denySender?: boolean;
      dispatches: boolean;
    }> = [
      { name: "unset", root: botRoot, threadId: botRoot.id, dispatches: false },
      {
        name: "bot-owned",
        root: botRoot,
        threadId: botRoot.id,
        requireMentionInBotThreads: false,
        dispatches: true,
      },
      {
        name: "cached root",
        threadId: botRoot.id,
        requireMentionInBotThreads: false,
        dispatches: true,
      },
      {
        name: "forced mention",
        threadId: botRoot.id,
        requireMention: false,
        requireMentionInBotThreads: true,
        dispatches: false,
      },
      {
        name: "foreign root",
        root: foreignRoot,
        threadId: foreignRoot.id,
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "unknown root",
        threadId: "f".repeat(64),
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "wrong returned ID",
        root: botRoot,
        threadId: "e".repeat(64),
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "other room",
        root: wrongRoomRoot,
        threadId: wrongRoomRoot.id,
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "bot reply is not a root",
        root: botReply,
        threadId: botReply.id,
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "invalid signature",
        root: invalidRoot,
        threadId: invalidRoot.id,
        requireMentionInBotThreads: false,
        dispatches: false,
      },
      {
        name: "sender denied",
        threadId: botRoot.id,
        requireMentionInBotThreads: false,
        denySender: true,
        dispatches: false,
      },
      { name: "top-level message", requireMentionInBotThreads: false, dispatches: false },
      {
        name: "unknown owner keeps open room",
        threadId: "d".repeat(64),
        requireMention: false,
        requireMentionInBotThreads: true,
        dispatches: true,
      },
    ];
    try {
      for (const scenario of cases) {
        completed = createDeferred<void>();
        vi.mocked(runtime.channel.inbound.dispatch).mockClear();
        relayMocks.threadRootEvents = scenario.root ? [scenario.root] : [];
        account.config = {
          groupPolicy: scenario.denySender ? "allowlist" : "open",
          groupAllowFrom: [],
          groups: {
            [CHANNEL_ID]: {
              requireMention: scenario.requireMention ?? true,
              requireMentionInBotThreads: scenario.requireMentionInBotThreads,
            },
          },
        };
        roomSubscription?.handlers.onevent(
          signSenderEvent({
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            content: scenario.name,
            tags: [
              ["h", CHANNEL_ID],
              ...(scenario.threadId ? [["e", scenario.threadId, "", "reply"]] : []),
            ],
          }),
        );
        await completed.promise;
        expect(runtime.channel.inbound.dispatch, scenario.name).toHaveBeenCalledTimes(
          scenario.dispatches ? 1 : 0,
        );
      }
    } finally {
      await bus.close();
    }
  });
});
