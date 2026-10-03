import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools";
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
import { BUZZ_TYPING_INDICATOR_KIND, type BuzzInboundMessage } from "./message-event.js";
import { setBuzzRuntime } from "./runtime.js";
import type { ResolvedBuzzAccount } from "./types.js";

const SECOND_CHANNEL_ID = "45cedd86-f853-45b7-8fea-812b7fe63d7a";
const {
  PRIVATE_KEY,
  ACCOUNT_ID,
  CHANNEL_ID,
  BOT_PUBLIC_KEY,
  SENDER_PUBLIC_KEY,
  RELAY_PUBLIC_KEY,
  startTestBus,
  sendTestTextOneShot,
  signSenderEvent,
  subscriptionIncludesKind,
} = useBuzzBusLifecycleFixture();

function abortReasonAsError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("aborted", { cause: reason });
}

describe("Buzz bus lifecycle", () => {
  it("joins the active presence publish before bus close settles", async () => {
    vi.useFakeTimers();
    relayMocks.auth.mockResolvedValue("ok");
    const publication = createDeferred<string>();
    relayMocks.publish.mockImplementation((event) =>
      event.kind === 20_001 ? publication.promise : Promise.resolve(""),
    );
    const bus = await startTestBus();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(relayMocks.publish).toHaveBeenCalledOnce();
      let closed = false;
      const closing = bus.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      publication.resolve("");
      await closing;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(relayMocks.publish).toHaveBeenCalledOnce();
    } finally {
      publication.resolve("");
      await bus.close();
      vi.useRealTimers();
    }
  });

  it("closes the relay and aborts NIP-11 discovery when authentication fails", async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            fetchSignal = init?.signal ?? undefined;
            fetchSignal?.addEventListener("abort", () => reject(abortReasonAsError(fetchSignal)), {
              once: true,
            });
          }),
      ),
    );

    await expect(startTestBus()).rejects.toThrow("auth rejected");

    expect(relayMocks.connect).toHaveBeenCalledOnce();
    expect(relayMocks.close).toHaveBeenCalledOnce();
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("bounds stalled Buzz relay session setup", async () => {
    vi.useFakeTimers();
    relayMocks.auth.mockResolvedValue("ok");
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            fetchSignal = init?.signal ?? undefined;
            fetchSignal?.addEventListener("abort", () => reject(abortReasonAsError(fetchSignal)), {
              once: true,
            });
          }),
      ),
    );
    const start = startTestBus();
    const rejection = expect(start).rejects.toThrow("Timed out setting up Buzz relay session");

    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;

    expect(fetchSignal?.aborted).toBe(true);
    expect(relayMocks.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("publishes and closes a standalone authenticated send", async () => {
    relayMocks.auth.mockResolvedValue("ok");

    const messageId = await sendTestTextOneShot({
      threadId: "root-id",
      replyToId: "parent-id",
    });

    const event = relayMocks.publish.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      id: messageId,
      kind: 9,
      content: "hello",
      tags: [
        ["h", CHANNEL_ID],
        ["e", "root-id", "", "root"],
        ["e", "parent-id", "", "reply"],
      ],
    });
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("sends room and thread typing without waiting for a relay acknowledgement", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const bus = await startTestBus();

    await bus.sendTyping({
      channelId: CHANNEL_ID,
      threadId: "root-id",
      replyToId: "parent-id",
    });

    const messageFrame = relayMocks.send.mock.calls
      .map(([raw]) => JSON.parse(raw) as [string, Event])
      .find(([type]) => type === "EVENT");
    const frame = messageFrame ?? ["", {} as Event];
    expect(frame[0]).toBe("EVENT");
    expect(frame[1]).toMatchObject({
      kind: 20_002,
      content: "",
      pubkey: BOT_PUBLIC_KEY,
      tags: [
        ["h", CHANNEL_ID],
        ["e", "root-id", "", "root"],
        ["e", "parent-id", "", "reply"],
      ],
    });
    expect(relayMocks.publish).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 20_002 }));
    relayMocks.connected = false;
    relayMocks.send.mockClear();
    await bus.sendTyping({ channelId: CHANNEL_ID });
    expect(relayMocks.send).not.toHaveBeenCalled();
    relayMocks.connected = true;
    await bus.close();

    relayMocks.send.mockClear();
    await bus.sendTyping({ channelId: CHANNEL_ID });
    expect(relayMocks.send).not.toHaveBeenCalled();
  });

  it.for(["all", "off"] as const)(
    "signs %s-mode replies and typing without changing inbound threads",
    async (replyToMode, { signal }) => {
      relayMocks.auth.mockResolvedValue("ok");
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const account: ResolvedBuzzAccount = {
        accountId: ACCOUNT_ID,
        name: "OpenClaw",
        enabled: true,
        configured: true,
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        authTag: "",
        publicKey: BOT_PUBLIC_KEY,
        config: {
          groupPolicy: "open",
          replyToMode,
          groups: { [CHANNEL_ID]: { requireMention: false } },
        },
      };
      const handled = new Map<string, ReturnType<typeof createDeferred<void>>>();
      const failPending = (error: unknown) => {
        for (const completion of handled.values()) {
          completion.reject(error);
        }
      };
      const onAbort = () => failPending(signal.reason);
      const bus = await startTestBus({
        onMessage: async (message, activeBus, messageSignal, assertCurrent) => {
          await handleBuzzInbound({
            account,
            cfg: {},
            bus: activeBus,
            message,
            signal: messageSignal,
            assertCurrent,
            historyMap: new Map(),
          });
          handled.get(message.id)?.resolve();
        },
        onMessageError: failPending,
      });

      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const rootId = "a".repeat(64);
        const messageSubscription = relayMocks.subscriptions.find((entry) =>
          subscriptionIncludesKind(entry, 9),
        );
        for (const [index, parentId] of ["b".repeat(64), undefined].entries()) {
          const inbound = signSenderEvent({
            kind: 9,
            created_at: 1_700_000_000 + index,
            content: `follow-up ${index + 1}`,
            tags: [
              ["h", CHANNEL_ID],
              ...(parentId
                ? [
                    ["e", rootId, "", "root"],
                    ["e", parentId, "", "reply"],
                  ]
                : []),
            ],
          });
          signal.throwIfAborted();
          const completion = createDeferred<void>();
          handled.set(inbound.id, completion);
          messageSubscription?.handlers.onevent(inbound);
          try {
            await completion.promise;
          } finally {
            handled.delete(inbound.id);
          }
          expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(index + 1);
          const dispatch = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[index]?.[0];
          expect(dispatch?.ctxPayload.MessageThreadId).toBe(parentId ? rootId : undefined);
          await dispatch?.delivery.deliver({ text: `reply ${index + 1}` }, { kind: "final" });
          await dispatch?.replyPipeline?.typing?.start();

          const published = relayMocks.publish.mock.calls.find(
            ([event]) => event.kind === 9 && event.content === `reply ${index + 1}`,
          )?.[0];
          const typing = relayMocks.send.mock.calls
            .map(([frame]) => JSON.parse(frame) as [string, Event])
            .filter(
              ([frameType, event]) =>
                frameType === "EVENT" && event.kind === BUZZ_TYPING_INDICATOR_KIND,
            )[index]?.[1];
          const expectedTags = [
            ["h", CHANNEL_ID],
            ...(replyToMode === "all" ? [["e", parentId ? rootId : inbound.id, "", "reply"]] : []),
          ];
          expect(published?.tags).toEqual(expectedTags);
          expect(typing?.tags).toEqual(expectedTags);
          expect(published && verifyEvent(published)).toBe(true);
          expect(typing && verifyEvent(typing)).toBe(true);
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        await bus.close();
      }
    },
  );

  it("dispatches room history without buffering behind another room EOSE", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.membershipEvents.push({
      ...relayMocks.membershipEvents[0]!,
      id: "membership-2",
      tags: [
        ["d", SECOND_CHANNEL_ID],
        ["p", BOT_PUBLIC_KEY, "", "bot"],
        ["p", SENDER_PUBLIC_KEY, "", "member"],
      ],
    });
    relayMocks.roomHistoryEvents = [
      signSenderEvent({
        kind: 9,
        created_at: 1_700_000_000,
        content: "historical message",
        tags: [["h", CHANNEL_ID]],
      }),
    ];
    relayMocks.stallRoomEoseChannelId = SECOND_CHANNEL_ID;
    const onMessage = vi.fn(async (_message: BuzzInboundMessage) => {});

    const start = startTestBus({
      channelIds: [CHANNEL_ID, SECOND_CHANNEL_ID],
      onMessage,
    });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    const stalledSubscription = relayMocks.subscriptions.find(
      (entry) => entry.filter["#h"]?.[0] === SECOND_CHANNEL_ID,
    );
    stalledSubscription?.handlers.oneose?.();
    const bus = await start;
    await bus.close();
  });

  it("bounds replay dispatch when a relay ignores the historical limit", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.roomHistoryEvents = Array.from({ length: 1_033 }, (_, index) => ({
      id: index.toString(16).padStart(64, "0"),
      kind: 9,
      pubkey: SENDER_PUBLIC_KEY,
      created_at: 1_700_000_000 + index,
      content: `historical message ${index}`,
      sig: "e".repeat(128),
      tags: [["h", CHANNEL_ID]],
    }));
    const onMessage = vi.fn(async () => {});
    const onFatalError = vi.fn();

    await expect(startTestBus({ onMessage, onFatalError })).rejects.toThrow(
      "Buzz inbound replay exceeded the 1024-message pending limit",
    );
    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Buzz inbound replay exceeded the 1024-message pending limit",
      }),
    );
    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
    expect(relayMocks.close).toHaveBeenCalled();
  });

  it.each(["queue", "dedupe claim"] as const)(
    "rejects revoked membership across the %s",
    async (boundary) => {
      relayMocks.auth.mockResolvedValue("ok");
      const remainingSecret = Uint8Array.from(Buffer.from("02".repeat(32), "hex"));
      const remainingPublicKey = getPublicKey(remainingSecret);
      relayMocks.membershipEvents[0]!.tags.push(["p", remainingPublicKey, "", "member"]);
      let releaseRunning: () => void = () => {};
      const running = new Promise<void>((resolve) => {
        releaseRunning = resolve;
      });
      const handled: string[] = [];
      const onMessageError = vi.fn();
      const bus = await startTestBus({
        onMessage: async (message) => {
          handled.push(message.text);
          if (message.text.startsWith("running-")) {
            await running;
          }
        },
        onMessageError,
      });
      const subscription = relayMocks.subscriptions.find((entry) =>
        subscriptionIncludesKind(entry, 9),
      );
      try {
        const runningCount = boundary === "queue" ? 8 : 0;
        for (let index = 0; index < runningCount; index += 1) {
          subscription?.handlers.onevent(
            signSenderEvent({
              kind: 9,
              created_at: 1_700_000_000 + index,
              content: `running-${index}`,
              tags: [["h", CHANNEL_ID]],
            }),
          );
        }
        await vi.waitFor(() => expect(handled).toHaveLength(runningCount));
        subscription?.handlers.onevent(
          signSenderEvent({
            kind: 9,
            created_at: 1_700_000_010,
            content: "queued-before-removal",
            tags: [["h", CHANNEL_ID]],
          }),
        );
        const removeSender = () =>
          subscription?.handlers.onevent({
            id: "remove-queued-sender",
            kind: 40_099,
            pubkey: RELAY_PUBLIC_KEY,
            created_at: 1_700_000_011,
            content: JSON.stringify({ type: "member_removed", target: SENDER_PUBLIC_KEY }),
            sig: "e".repeat(128),
            tags: [["h", CHANNEL_ID]],
          });
        if (boundary === "dedupe claim") {
          queueMicrotask(removeSender);
        } else {
          removeSender();
        }
        subscription?.handlers.onevent(
          finalizeEvent(
            {
              kind: 9,
              created_at: 1_700_000_012,
              content: "remaining-member",
              tags: [["h", CHANNEL_ID]],
            },
            remainingSecret,
          ),
        );
        releaseRunning();
        await vi.waitFor(() => expect(handled).toContain("remaining-member"));
        expect(handled).not.toContain("queued-before-removal");
        expect(onMessageError).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("no longer a room member") }),
        );
      } finally {
        releaseRunning();
        await bus.close();
      }
    },
  );

  it("refreshes relay-signed room metadata after a live edit", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    const onRoomDirectoryChanged = vi.fn();
    relayMocks.roomMetadataEvents = [
      {
        id: "room-metadata-1",
        kind: 39_000,
        pubkey: "f".repeat(64),
        created_at: 1_700_000_000,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["d", CHANNEL_ID],
          ["name", "Engineering"],
        ],
      },
    ];
    const bus = await startTestBus({
      onRoomDirectoryChanged,
    });
    await vi.waitFor(() => expect(bus.directory.listGroups({})[0]?.name).toBe("Engineering"));

    relayMocks.roomMetadataEvents = [
      {
        ...relayMocks.roomMetadataEvents[0]!,
        id: "room-metadata-2",
        created_at: 1_700_000_001,
        tags: [
          ["d", CHANNEL_ID],
          ["name", "Platform"],
        ],
      },
    ];
    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 9_002))
      ?.handlers.onevent({
        id: "edit-metadata-1",
        kind: 9_002,
        pubkey: SENDER_PUBLIC_KEY,
        created_at: 1_700_000_001,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["h", CHANNEL_ID],
          ["name", "Untrusted event name"],
        ],
      });

    await vi.waitFor(() => expect(bus.directory.listGroups({})[0]?.name).toBe("Platform"));
    expect(onRoomDirectoryChanged).toHaveBeenCalledOnce();
    await bus.close();
  });

  it("refreshes room metadata edits replayed during startup", async () => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.roomMetadataEvents = [
      {
        id: "room-metadata-active",
        kind: 39_000,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_000,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["d", CHANNEL_ID],
          ["name", "Engineering"],
        ],
      },
    ];
    relayMocks.roomHistoryEvents = [
      {
        id: "archive-room-during-startup",
        kind: 9_002,
        pubkey: SENDER_PUBLIC_KEY,
        created_at: 1_700_000_001,
        content: "",
        sig: "e".repeat(128),
        tags: [["h", CHANNEL_ID]],
      },
    ];
    relayMocks.beforeRoomHistoryEvent = () => {
      relayMocks.roomMetadataEvents = [
        {
          id: "room-metadata-archived",
          kind: 39_000,
          pubkey: RELAY_PUBLIC_KEY,
          created_at: 1_700_000_001,
          content: "",
          sig: "e".repeat(128),
          tags: [
            ["d", CHANNEL_ID],
            ["name", "Engineering"],
            ["archived", "true"],
          ],
        },
      ];
    };
    const onFatalError = vi.fn();

    const bus = await startTestBus({
      onFatalError,
    });

    await vi.waitFor(() =>
      expect(onFatalError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `Buzz room ${CHANNEL_ID} archive status changed; rebuilding subscriptions`,
        }),
      ),
    );
    await bus.close();
  });
});
