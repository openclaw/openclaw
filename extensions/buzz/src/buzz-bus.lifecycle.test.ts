import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return { ...(await importOriginal<typeof import("nostr-tools")>()), ...mockBuzzRelay() };
});

import { useBuzzBusLifecycleFixture } from "./buzz-bus.lifecycle.test-harness.js";
import { relayMocks } from "./buzz-bus.test-helpers.js";
import { BUZZ_TYPING_INDICATOR_KIND, type BuzzInboundMessage } from "./message-event.js";

const SECOND_CHANNEL_ID = "45cedd86-f853-45b7-8fea-812b7fe63d7a";
const {
  CHANNEL_ID,
  BOT_PUBLIC_KEY,
  SENDER_PUBLIC_KEY,
  startTestBus,
  sendTestTextOneShot,
  senderMessage,
  relayEvent,
  findSubscription,
  inboundFixture,
  expectError,
  roomMetadata,
} = useBuzzBusLifecycleFixture();
const THREAD = { channelId: CHANNEL_ID, threadId: "root-id", replyToId: "parent-id" };
const THREAD_TAGS = [
  ["h", CHANNEL_ID],
  ["e", "root-id", "", "root"],
  ["e", "parent-id", "", "reply"],
];

function abortReasonAsError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("aborted", { cause: reason });
}

function stallDiscovery() {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(abortReasonAsError(signal)), {
            once: true,
          });
        }),
    ),
  );
  return () => signal;
}

describe("Buzz bus lifecycle", () => {
  beforeEach(() => {
    relayMocks.auth.mockResolvedValue("ok");
  });

  it.each([
    { mode: "one-shot", stopped: false },
    { mode: "one-shot", stopped: true },
    { mode: "text", stopped: false },
    { mode: "text", stopped: true },
    { mode: "typing", stopped: false },
    { mode: "typing", stopped: true },
  ] as const)(
    "prepares $mode before relay handoff (stopped=$stopped)",
    async ({ mode, stopped }) => {
      const bus = mode === "one-shot" ? undefined : await startTestBus();
      const preparing = createDeferred<void>();
      const prepared = createDeferred<void>();
      const handedOff = createDeferred<void>();
      const acknowledgment = createDeferred<string>();
      const failure = new Error("Buzz message authority ended");
      const authority = fetchRuntime.captureEffectAuthority();
      const capture = vi.spyOn(fetchRuntime, "captureEffectAuthority").mockReturnValue({
        ...authority,
        async initiate(effect) {
          preparing.resolve();
          await prepared.promise;
          if (stopped && mode === "one-shot") {
            throw failure;
          }
          return authority.initiate(effect);
        },
      });
      let handoffs = 0;
      relayMocks.publish.mockImplementation((event) => {
        if (event.kind !== 9) {
          return Promise.resolve("");
        }
        handoffs++;
        handedOff.resolve();
        return acknowledgment.promise;
      });
      relayMocks.send.mockImplementation(() => {
        handoffs++;
        handedOff.resolve();
        return acknowledgment.promise.then(() => {});
      });
      const sending = (
        bus
          ? mode === "typing"
            ? bus.sendTyping({ channelId: CHANNEL_ID })
            : bus.sendText({ channelId: CHANNEL_ID, text: "prepared" })
          : sendTestTextOneShot({ text: "prepared" })
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          preparing.promise,
          handedOff.promise.then(() => {
            throw new Error("relay call bypassed preparation");
          }),
        ]);
        expect(handoffs).toBe(0);
        if (stopped) {
          await bus?.close();
        }
        prepared.resolve();
        if (!stopped) {
          await handedOff.promise;
          acknowledgment.resolve("");
        }
        const result = await sending;
        if (stopped) {
          expect(result).toEqual({
            error:
              mode === "one-shot"
                ? failure
                : expect.objectContaining({ message: "Buzz bus closed" }),
          });
        } else {
          expect(result).toEqual({ value: mode === "typing" ? undefined : expect.any(String) });
        }
        expect(handoffs).toBe(stopped ? 0 : 1);
      } finally {
        prepared.resolve();
        acknowledgment.resolve("");
        await sending;
        capture.mockRestore();
        await bus?.close();
      }
    },
  );

  it("joins the active presence publish before bus close settles", async () => {
    vi.useFakeTimers();

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
    }
  });

  it.each(["auth rejection", "setup timeout"])("aborts NIP-11 discovery on %s", async (failure) => {
    const rejected = failure === "auth rejection";
    if (rejected) {
      relayMocks.auth.mockRejectedValue(new Error("auth rejected"));
    } else {
      vi.useFakeTimers();
    }
    const fetchSignal = stallDiscovery();
    const rejection = expect(startTestBus()).rejects.toThrow(
      rejected ? "auth rejected" : "Timed out setting up Buzz relay session",
    );
    if (!rejected) {
      await vi.advanceTimersByTimeAsync(20_000);
    }
    await rejection;
    expect(relayMocks.connect).toHaveBeenCalledOnce();
    expect(fetchSignal()?.aborted).toBe(true);
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("publishes and closes a standalone authenticated send", async () => {
    const messageId = await sendTestTextOneShot(THREAD);

    expect(relayMocks.publish.mock.calls[0]?.[0]).toMatchObject({
      id: messageId,
      kind: 9,
      content: "hello",
      tags: THREAD_TAGS,
    });
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("sends room and thread typing without waiting for a relay acknowledgement", async () => {
    const bus = await startTestBus();

    await bus.sendTyping(THREAD);

    const messageFrame = relayMocks.send.mock.calls
      .map(([raw]) => JSON.parse(raw) as [string, Event])
      .find(([type]) => type === "EVENT");
    expect(messageFrame).toMatchObject([
      "EVENT",
      {
        kind: 20_002,
        content: "",
        pubkey: BOT_PUBLIC_KEY,
        tags: THREAD_TAGS,
      },
    ]);
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
      const { runtime, onMessage } = inboundFixture(
        {
          groupPolicy: "open",
          replyToMode,
          groups: { [CHANNEL_ID]: { requireMention: false } },
        },
        "OpenClaw",
      );
      const handled = new Map<string, ReturnType<typeof createDeferred<void>>>();
      const failPending = (error: unknown) => {
        for (const completion of handled.values()) {
          completion.reject(error);
        }
      };
      const onAbort = () => failPending(signal.reason);
      const bus = await startTestBus({
        onMessage: async (...args) => {
          await onMessage(...args);
          handled.get(args[0].id)?.resolve();
        },
        onMessageError: failPending,
      });

      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const rootId = "a".repeat(64);
        const messageSubscription = findSubscription(9);
        for (const [index, parentId] of ["b".repeat(64), undefined].entries()) {
          const inbound = senderMessage(`follow-up ${index + 1}`, {
            created_at: 1_700_000_000 + index,
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
    relayMocks.membershipEvents.push({
      ...relayMocks.membershipEvents[0]!,
      id: "membership-2",
      tags: [
        ["d", SECOND_CHANNEL_ID],
        ["p", BOT_PUBLIC_KEY, "", "bot"],
        ["p", SENDER_PUBLIC_KEY, "", "member"],
      ],
    });
    relayMocks.roomHistoryEvents = [senderMessage("historical message")];
    relayMocks.stallRoomEoseChannelId = SECOND_CHANNEL_ID;
    const onMessage = vi.fn(async (_message: BuzzInboundMessage) => {});

    const start = startTestBus({ channelIds: [CHANNEL_ID, SECOND_CHANNEL_ID], onMessage });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    const stalledSubscription = relayMocks.subscriptions.find(
      (entry) => entry.filter["#h"]?.[0] === SECOND_CHANNEL_ID,
    );
    stalledSubscription?.handlers.oneose?.();
    const bus = await start;
    await bus.close();
  });

  it("bounds replay dispatch when a relay ignores the historical limit", async () => {
    relayMocks.roomHistoryEvents = Array.from({ length: 1_033 }, (_, index) =>
      relayEvent(9, {
        id: index.toString(16).padStart(64, "0"),
        pubkey: SENDER_PUBLIC_KEY,
        created_at: 1_700_000_000 + index,
        content: `historical message ${index}`,
        tags: [["h", CHANNEL_ID]],
      }),
    );
    const onMessage = vi.fn(async () => {});
    const onFatalError = vi.fn();

    await expect(startTestBus({ onMessage, onFatalError })).rejects.toThrow(
      "Buzz inbound replay exceeded the 1024-message pending limit",
    );
    expectError(onFatalError, "Buzz inbound replay exceeded the 1024-message pending limit");
    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
    expect(relayMocks.close).toHaveBeenCalled();
  });

  it.each(["queue", "dedupe claim"] as const)(
    "rejects revoked membership across the %s",
    async (boundary) => {
      const remainingSecret = Uint8Array.from(Buffer.from("02".repeat(32), "hex"));
      const remainingPublicKey = getPublicKey(remainingSecret);
      relayMocks.membershipEvents[0]!.tags.push(["p", remainingPublicKey, "", "member"]);
      const running = createDeferred<void>();
      const handled: string[] = [];
      const onMessageError = vi.fn();
      const bus = await startTestBus({
        onMessage: async (message) => {
          handled.push(message.text);
          if (message.text.startsWith("running-")) {
            await running.promise;
          }
        },
        onMessageError,
      });
      const subscription = findSubscription(9);
      try {
        const runningCount = boundary === "queue" ? 8 : 0;
        for (let index = 0; index < runningCount; index += 1) {
          subscription?.handlers.onevent(
            senderMessage(`running-${index}`, { created_at: 1_700_000_000 + index }),
          );
        }
        await vi.waitFor(() => expect(handled).toHaveLength(runningCount));
        subscription?.handlers.onevent(
          senderMessage("queued-before-removal", { created_at: 1_700_000_010 }),
        );
        const removeSender = () =>
          subscription?.handlers.onevent(
            relayEvent(40_099, {
              id: "remove-queued-sender",
              created_at: 1_700_000_011,
              content: JSON.stringify({ type: "member_removed", target: SENDER_PUBLIC_KEY }),
              tags: [["h", CHANNEL_ID]],
            }),
          );
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
        running.resolve();
        await vi.waitFor(() => expect(handled).toContain("remaining-member"));
        expect(handled).not.toContain("queued-before-removal");
        expectError(onMessageError, expect.stringContaining("no longer a room member"));
      } finally {
        running.resolve();
        await bus.close();
      }
    },
  );

  it.each(["live", "startup"] as const)(
    "refreshes signed room metadata after a %s edit",
    async (phase) => {
      const onRoomDirectoryChanged = vi.fn();
      const onFatalError = vi.fn();
      const startup = phase === "startup";
      relayMocks.roomMetadataEvents = [roomMetadata("room-metadata-1", "Engineering")];
      const edit = relayEvent(9_002, {
        id: "edit-metadata-1",
        pubkey: SENDER_PUBLIC_KEY,
        created_at: 1_700_000_001,
        tags: [["h", CHANNEL_ID], ...(startup ? [] : [["name", "Untrusted event name"]])],
      });
      const updateSnapshot = () => {
        relayMocks.roomMetadataEvents = [
          roomMetadata("room-metadata-2", startup ? "Engineering" : "Platform", {
            created_at: 1_700_000_001,
            archived: startup,
          }),
        ];
      };
      if (startup) {
        relayMocks.roomHistoryEvents = [edit];
        relayMocks.beforeRoomHistoryEvent = updateSnapshot;
      }
      const bus = await startTestBus({ onFatalError, onRoomDirectoryChanged });
      if (startup) {
        await vi.waitFor(() =>
          expectError(
            onFatalError,
            `Buzz room ${CHANNEL_ID} archive status changed; rebuilding subscriptions`,
          ),
        );
      } else {
        await vi.waitFor(() => expect(bus.directory.listGroups({})[0]?.name).toBe("Engineering"));
        updateSnapshot();
        findSubscription(9_002)?.handlers.onevent(edit);
        await vi.waitFor(() => expect(bus.directory.listGroups({})[0]?.name).toBe("Platform"));
        expect(onRoomDirectoryChanged).toHaveBeenCalledOnce();
      }
      await bus.close();
    },
  );
});
