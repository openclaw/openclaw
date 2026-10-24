// Matrix tests cover the optional hold that joins a captionless attachment with its text.
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixReactionEvent,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import {
  createMatrixHoldControlCommandCheck,
  createMatrixMediaHold,
  type MatrixHoldEventHydrator,
} from "./media-hold.js";
import { resolveMatrixReactionMayStartWork } from "./reaction-events.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";

const { downloadMatrixMediaMock } = vi.hoisted(() => ({
  downloadMatrixMediaMock: vi.fn(),
}));

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
  };
});

const ROOM = "!dm:example.org";
const USER = "@user:example.org";
const BOT = "@bot:example.org";
const HOLD_MS = 20_000;
const THREADED = { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } } as const;

function imageEvent(
  eventId: string,
  extra: Partial<RoomMessageEventContent> & Record<string, unknown> = {},
  sender = USER,
): MatrixRawEvent {
  return createMatrixRoomMessageEvent({
    eventId,
    sender,
    content: {
      msgtype: "m.image",
      body: "photo.png",
      url: "mxc://example.org/photo",
      info: { mimetype: "image/png", size: 123 },
      ...extra,
    },
  });
}

function textEvent(eventId: string, body: string, sender = USER, threadRootId?: string) {
  return createMatrixTextMessageEvent({
    eventId,
    sender,
    body,
    ...(threadRootId ? { relatesTo: { rel_type: "m.thread", event_id: threadRootId } } : {}),
  });
}

/** One durable ingress claim as the drain hands it to a delivery, with observable callbacks. */
type Claim = ChannelIngressMonitorLifecycle & {
  onAdopted: Mock<() => Promise<void>>;
  onCancelled: Mock<() => Promise<void>>;
  onDeferredHeartbeat?: Mock<() => void>;
  onFailed?: Mock<(error: unknown) => Promise<void>>;
};

function claim(extra: Partial<Claim> = {}): Claim {
  return {
    admission: "exclusive",
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
    onCancelled: vi.fn(async () => {}),
    ...extra,
  };
}

type DispatchCall = {
  event: MatrixRawEvent;
  lifecycle: ChannelIngressMonitorLifecycle;
};

function createHold(
  params: {
    isControlCommand?: (roomId: string, event: MatrixRawEvent) => Promise<boolean>;
    reactionMayStartWork?: (roomId: string, event: MatrixRawEvent) => Promise<boolean>;
    hydrateEvents?: MatrixHoldEventHydrator;
    holdMs?: number;
    /** What the handler does with each dispatched event (default: adopt the turn). */
    onDispatch?: (call: DispatchCall) => Promise<void>;
  } = {},
) {
  const calls: DispatchCall[] = [];
  const dispatch = vi.fn(
    async (_roomId: string, event: MatrixRawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
      const call = { event, lifecycle };
      calls.push(call);
      await (params.onDispatch ?? (async (dispatched) => await dispatched.lifecycle.onAdopted()))(
        call,
      );
    },
  );
  const hold = createMatrixMediaHold({
    holdMs: params.holdMs ?? HOLD_MS,
    selfUserId: BOT,
    dispatch,
    isControlCommand: params.isControlCommand ?? (async () => false),
    reactionMayStartWork: params.reactionMayStartWork ?? (async () => true),
    ...(params.hydrateEvents ? { hydrateEvents: params.hydrateEvents } : {}),
    logVerboseMessage: () => {},
  });
  return { hold, dispatch, calls, ids: () => calls.map((call) => call.event.event_id) };
}

describe("createMatrixMediaHold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins a captionless attachment with the sender's next text under both claims", async () => {
    const { hold, calls } = createHold();
    const media = claim();
    const text = claim();

    await expect(hold.onRoomMessage(ROOM, imageEvent("$image"), media)).resolves.toEqual({
      kind: "deferred",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(0);
    await hold.onRoomMessage(ROOM, textEvent("$text", "what is this?"), text);

    expect(calls).toHaveLength(1);
    const [{ event }] = calls as [DispatchCall];
    expect(event.event_id).toBe("$text");
    expect(event.content).toMatchObject({
      msgtype: "m.image",
      body: "what is this?",
      filename: "photo.png",
      url: "mxc://example.org/photo",
      info: { mimetype: "image/png", size: 123 },
    });
    expect(media.onAdopted).toHaveBeenCalledTimes(1);
    expect(text.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("dispatches the attachment alone under its own claim when no text arrives", async () => {
    const { hold, calls, ids } = createHold();
    const media = claim();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ids()).toEqual(["$image"]);
    expect(calls[0]?.event.content.body).toBe("photo.png");
    expect(media.onAdopted).toHaveBeenCalledTimes(1);

    await hold.onRoomMessage(ROOM, textEvent("$text", "late text"), claim());
    expect(ids()).toEqual(["$image", "$text"]);
    expect(calls[1]?.event.content.msgtype).toBe("m.text");
  });

  it("keeps the held claim alive with deferred heartbeats while it waits", async () => {
    const { hold } = createHold();
    const heartbeat = vi.fn();
    const media = claim({ onDeferredHeartbeat: heartbeat, deferredHeartbeatIntervalMs: 4_000 });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    const beats = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(heartbeat).toHaveBeenCalledTimes(beats);
  });

  it("dispatches a held attachment first when a second attachment arrives", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(ROOM, imageEvent("$image1"), claim());
    await hold.onRoomMessage(ROOM, imageEvent("$image2"), claim());
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["$image1"]);

    await hold.onRoomMessage(ROOM, textEvent("$text", "compare these"), claim());
    expect(ids()).toEqual(["$image1", "$text"]);
    expect(ids()).not.toContain("$image2");
  });

  it("admits the held attachment before another sender's message starts", async () => {
    const order: string[] = [];
    const { hold, calls, ids } = createHold({
      onDispatch: async ({ event, lifecycle }) => {
        order.push(`start:${event.event_id}`);
        await lifecycle.onAdopted();
        order.push(`adopted:${event.event_id}`);
      },
    });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(ROOM, textEvent("$other", "hi", "@other:example.org"), claim());

    expect(ids()).toEqual(["$image", "$other"]);
    expect(order).toEqual(["start:$image", "adopted:$image", "start:$other", "adopted:$other"]);
    expect(calls[1]?.event.content.msgtype).toBe("m.text");
  });

  it("never folds a control command into an attachment", async () => {
    const isControlCommand = vi.fn(
      async (_roomId: string, event: MatrixRawEvent) =>
        (event.content as RoomMessageEventContent).body === "OpenClaw: /stop",
    );
    const { hold, calls, ids } = createHold({ isControlCommand });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(ROOM, textEvent("$stop", "OpenClaw: /stop"), claim());

    expect(ids()).toEqual(["$image", "$stop"]);
    expect(calls[1]?.event.content).toMatchObject({ msgtype: "m.text", body: "OpenClaw: /stop" });
    expect(isControlCommand).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ event_id: "$stop" }),
    );
  });

  it("releases a held attachment before a poll or location from the same conversation", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(
      ROOM,
      {
        type: "org.matrix.msc3381.poll.start",
        sender: USER,
        event_id: "$poll",
        origin_server_ts: Date.now(),
        content: { "org.matrix.msc3381.poll.start": { question: { body: "Which?" } } },
      } as MatrixRawEvent,
      claim(),
    );

    expect(ids()).toEqual(["$image", "$poll"]);
  });

  it("holds a legacy attachment whose file name sits in the body with spaces", async () => {
    const { hold, calls } = createHold();

    await hold.onRoomMessage(ROOM, imageEvent("$legacy", { body: "vacation photo.jpg" }), claim());
    expect(calls).toHaveLength(0);
    await hold.onRoomMessage(ROOM, textEvent("$text", "where was this?"), claim());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.event.content).toMatchObject({
      msgtype: "m.image",
      filename: "vacation photo.jpg",
      body: "where was this?",
    });
  });

  it("never folds or holds an event the server already bundles an edit for", async () => {
    const { hold, calls, ids } = createHold();
    const edited = { "m.relations": { "m.replace": { event_id: "$edit" } } };

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(
      ROOM,
      createMatrixTextMessageEvent({ eventId: "$editedText", body: "old text", unsigned: edited }),
      claim(),
    );
    expect(ids()).toEqual(["$editedText"]);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(ids()).toEqual(["$editedText", "$image"]);
    expect(calls[1]?.event.content.body).toBe("photo.png");

    await hold.onRoomMessage(
      ROOM,
      createMatrixRoomMessageEvent({
        eventId: "$editedImage",
        sender: USER,
        unsigned: edited,
        content: { msgtype: "m.image", body: "photo.png", url: "mxc://example.org/photo" },
      }),
      claim(),
    );
    expect(ids()).toEqual(["$editedText", "$image", "$editedImage"]);
  });

  it("releases every attachment held in the room before a reaction, whatever its thread", async () => {
    const order: string[] = [];
    const { hold, ids } = createHold({
      onDispatch: async ({ event, lifecycle }) => {
        order.push(`start:${event.event_id}`);
        await lifecycle.onAdopted();
        order.push(`adopted:${event.event_id}`);
      },
    });

    await hold.onRoomMessage(ROOM, imageEvent("$threadImage", THREADED), claim());
    await hold.onRoomMessage(ROOM, imageEvent("$roomImage"), claim());
    await hold.onRoomMessage(
      ROOM,
      createMatrixReactionEvent({ eventId: "$reaction", targetEventId: "$botMessage", key: "👍" }),
      claim(),
    );

    expect(ids().toSorted()).toEqual(["$reaction", "$roomImage", "$threadImage"]);
    expect(order.at(-2)).toBe("start:$reaction");
    expect(order.slice(0, 4).filter((step) => step.startsWith("adopted:"))).toHaveLength(2);
  });

  it("does not join replayed text sent outside the hold window", async () => {
    const { hold, ids } = createHold();
    const sentAt = 1_700_000_000_000;

    await hold.onRoomMessage(
      ROOM,
      createMatrixRoomMessageEvent({
        eventId: "$stale",
        sender: USER,
        originServerTs: sentAt,
        content: { msgtype: "m.image", body: "photo.png", url: "mxc://example.org/photo" },
      }),
      claim(),
    );
    await hold.onRoomMessage(
      ROOM,
      createMatrixTextMessageEvent({
        eventId: "$later",
        body: "unrelated, hours later",
        originServerTs: sentAt + HOLD_MS + 1,
      }),
      claim(),
    );

    expect(ids()).toEqual(["$stale", "$later"]);
  });

  it("lets an attachment already on its way to a turn be admitted before a reaction", async () => {
    const order: string[] = [];
    let admitImage: () => void = () => {};
    const { hold } = createHold({
      onDispatch: async ({ event, lifecycle }) => {
        order.push(`start:${event.event_id}`);
        if (event.event_id === "$image") {
          await new Promise<void>((resolve) => {
            admitImage = resolve;
          });
        }
        await lifecycle.onAdopted();
        order.push(`adopted:${event.event_id}`);
      },
    });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(order).toEqual(["start:$image"]);

    const reaction = hold.onRoomMessage(
      ROOM,
      createMatrixReactionEvent({ eventId: "$reaction", targetEventId: "$image", key: "👍" }),
      claim(),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(["start:$image"]);
    admitImage();
    await reaction;

    expect(order).toEqual([
      "start:$image",
      "adopted:$image",
      "start:$reaction",
      "adopted:$reaction",
    ]);
  });

  it("logs instead of rejecting when a held claim cannot be reopened on close", async () => {
    const logged: string[] = [];
    const hold = createMatrixMediaHold({
      holdMs: HOLD_MS,
      selfUserId: BOT,
      dispatch: async () => {},
      isControlCommand: async () => false,
      reactionMayStartWork: async () => false,
      logVerboseMessage: (message) => logged.push(message),
    });
    const media = claim({
      onCancelled: vi.fn(async () => {
        throw new Error("queue write failed");
      }),
    });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    hold.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(media.onCancelled).toHaveBeenCalledTimes(1);
    expect(logged.some((line) => line.includes("could not reopen claim"))).toBe(true);
  });

  it("keeps the attachment's original deadline when it is replayed after a restart", async () => {
    const { hold, ids } = createHold();
    const sentAt = Date.now();

    await hold.onRoomMessage(
      ROOM,
      createMatrixRoomMessageEvent({
        eventId: "$replayed",
        sender: USER,
        originServerTs: sentAt - (HOLD_MS - 5_000),
        content: { msgtype: "m.image", body: "photo.png", url: "mxc://example.org/photo" },
      }),
      claim(),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ids()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ids()).toEqual(["$replayed"]);

    await hold.onRoomMessage(
      ROOM,
      createMatrixRoomMessageEvent({
        eventId: "$expired",
        sender: USER,
        originServerTs: sentAt - HOLD_MS - 1,
        content: { msgtype: "m.image", body: "photo.png", url: "mxc://example.org/photo" },
      }),
      claim(),
    );
    expect(ids()).toEqual(["$replayed", "$expired"]);
  });

  it("leaves a hold alone for a reaction the handler would ignore", async () => {
    const reactionMayStartWork = vi.fn(
      async (_roomId: string, event: MatrixRawEvent) =>
        ((event.content as RoomMessageEventContent)["m.relates_to"] as { event_id?: string })
          ?.event_id === "$botMessage",
    );
    const { hold, ids } = createHold({ reactionMayStartWork });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    // A reaction to the held attachment itself: never asked, never released.
    await hold.onRoomMessage(
      ROOM,
      createMatrixReactionEvent({ eventId: "$onImage", targetEventId: "$image", key: "👍" }),
      claim(),
    );
    expect(ids()).toEqual(["$onImage"]);
    expect(reactionMayStartWork).not.toHaveBeenCalled();
    // A reaction to some other user's message: ignored by the handler, hold kept.
    await hold.onRoomMessage(
      ROOM,
      createMatrixReactionEvent({ eventId: "$onOther", targetEventId: "$someone", key: "👍" }),
      claim(),
    );
    expect(ids()).toEqual(["$onImage", "$onOther"]);
    await hold.onRoomMessage(ROOM, textEvent("$text", "what is this?"), claim());
    expect(ids()).toEqual(["$onImage", "$onOther", "$text"]);

    // A reaction to the bot's own message may start work: it releases a new hold first.
    await hold.onRoomMessage(ROOM, imageEvent("$image2"), claim());
    await hold.onRoomMessage(
      ROOM,
      createMatrixReactionEvent({ eventId: "$onBot", targetEventId: "$botMessage", key: "👍" }),
      claim(),
    );
    expect(ids()).toEqual(["$onImage", "$onOther", "$text", "$image2", "$onBot"]);
  });

  it("pairs an expired replayed attachment with the text already queued behind it", async () => {
    const { hold, calls, ids } = createHold();
    const sentAt = Date.now() - HOLD_MS - 5_000;
    const image = createMatrixRoomMessageEvent({
      eventId: "$oldImage",
      sender: USER,
      originServerTs: sentAt,
      content: { msgtype: "m.image", body: "photo.png", url: "mxc://example.org/photo" },
    });
    image.room_id = ROOM;
    const text = createMatrixTextMessageEvent({
      eventId: "$oldText",
      body: "what is this?",
      originServerTs: sentAt + 3_000,
    });
    text.room_id = ROOM;
    const backlogRow = {
      id: text.event_id,
      payload: { version: 1, roomId: ROOM, event: text },
      receivedAt: 1,
      updatedAt: 1,
      attempts: 0,
    } as never;

    await expect(
      hold.onRoomMessage(ROOM, image, claim({ readLaneBacklog: async () => [backlogRow] })),
    ).resolves.toEqual({ kind: "deferred" });
    expect(ids()).toEqual([]);
    await hold.onRoomMessage(ROOM, text, claim());
    expect(ids()).toEqual(["$oldText"]);
    expect(calls[0]?.event.content).toMatchObject({ msgtype: "m.image", body: "what is this?" });

    // Without a queued companion, an expired attachment goes straight on.
    const lone = createMatrixRoomMessageEvent({
      eventId: "$loneOld",
      sender: USER,
      originServerTs: sentAt,
      content: { msgtype: "m.image", body: "photo.png", url: "mxc://example.org/photo" },
    });
    await hold.onRoomMessage(ROOM, lone, claim({ readLaneBacklog: async () => [] }));
    expect(ids()).toEqual(["$oldText", "$loneOld"]);
  });

  it("does not treat a queued edit as companion text for an expired replay", async () => {
    const { hold, ids } = createHold();
    const sentAt = Date.now() - HOLD_MS - 5_000;
    const image = createMatrixRoomMessageEvent({
      eventId: "$oldImage",
      sender: USER,
      originServerTs: sentAt,
      content: { msgtype: "m.image", body: "photo.png", url: "mxc://example.org/photo" },
    });
    image.room_id = ROOM;
    const edit = createMatrixTextMessageEvent({
      eventId: "$edit",
      body: "* fixed typo",
      originServerTs: sentAt + 3_000,
      relatesTo: { rel_type: "m.replace", event_id: "$earlier" },
    });
    edit.room_id = ROOM;
    const backlogRow = {
      id: edit.event_id,
      payload: { version: 1, roomId: ROOM, event: edit },
      receivedAt: 1,
      updatedAt: 1,
      attempts: 0,
    } as never;

    await hold.onRoomMessage(ROOM, image, claim({ readLaneBacklog: async () => [backlogRow] }));
    expect(ids()).toEqual(["$oldImage"]);
  });

  describe("expired replays in encrypted rooms and partly admitted sync batches", () => {
    const sentAt = () => Date.now() - HOLD_MS - 5_000;
    function oldImage(at: number) {
      const image = createMatrixRoomMessageEvent({
        eventId: "$oldImage",
        sender: USER,
        originServerTs: at,
        content: { msgtype: "m.image", body: "photo.png", url: "mxc://example.org/photo" },
      });
      image.room_id = ROOM;
      return image;
    }
    function oldText(at: number, eventId = "$oldText") {
      const text = createMatrixTextMessageEvent({
        eventId,
        body: "what is this?",
        originServerTs: at + 3_000,
      });
      text.room_id = ROOM;
      return text;
    }
    function ciphertext(text: MatrixRawEvent, sender = USER): MatrixRawEvent {
      return {
        event_id: text.event_id,
        sender,
        type: "m.room.encrypted",
        origin_server_ts: text.origin_server_ts,
        room_id: ROOM,
        content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "encrypted-fixture" },
      };
    }
    function backlog(event: MatrixRawEvent) {
      return {
        id: event.event_id,
        payload: { version: 1, roomId: ROOM, event },
        receivedAt: 1,
        updatedAt: 1,
        attempts: 0,
      } as never;
    }

    it("decrypts a queued companion before pairing an expired encrypted attachment", async () => {
      const at = sentAt();
      const text = oldText(at);
      const hydrateEvents = vi.fn<MatrixHoldEventHydrator>(async () => [text]);
      const { hold, calls, ids } = createHold({ hydrateEvents });

      await expect(
        hold.onRoomMessage(
          ROOM,
          oldImage(at),
          claim({ readLaneBacklog: async () => [backlog(ciphertext(text))] }),
        ),
      ).resolves.toEqual({ kind: "deferred" });
      expect(hydrateEvents).toHaveBeenCalledWith(ROOM, [ciphertext(text)]);
      expect(ids()).toEqual([]);
      await hold.onRoomMessage(ROOM, text, claim());
      expect(ids()).toEqual(["$oldText"]);
      expect(calls[0]?.event.content).toMatchObject({ msgtype: "m.image", body: "what is this?" });
    });

    it("goes straight on when the queued ciphertext decrypts to something other than text", async () => {
      const at = sentAt();
      const second = createMatrixRoomMessageEvent({
        eventId: "$secondImage",
        sender: USER,
        originServerTs: at + 3_000,
        content: { msgtype: "m.image", body: "other.png", url: "mxc://example.org/other" },
      });
      const { hold, ids } = createHold({ hydrateEvents: async () => [second] });

      await hold.onRoomMessage(
        ROOM,
        oldImage(at),
        claim({ readLaneBacklog: async () => [backlog(ciphertext(second))] }),
      );
      expect(ids()).toEqual(["$oldImage"]);
    });

    it("waits one window for queued ciphertext it cannot decrypt yet", async () => {
      const at = sentAt();
      const text = oldText(at);
      const { hold, ids } = createHold({
        hydrateEvents: async () => {
          throw new Error("room key not yet received");
        },
      });

      await expect(
        hold.onRoomMessage(
          ROOM,
          oldImage(at),
          claim({ readLaneBacklog: async () => [backlog(ciphertext(text))] }),
        ),
      ).resolves.toEqual({ kind: "deferred" });
      // The lane delivers the text once its key arrives; it joins by the normal rules.
      await hold.onRoomMessage(ROOM, text, claim());
      expect(ids()).toEqual(["$oldText"]);

      // Another sender's ciphertext is no reason to wait.
      await hold.onRoomMessage(
        ROOM,
        { ...oldImage(at), event_id: "$lone" },
        claim({ readLaneBacklog: async () => [backlog(ciphertext(text, "@other:example.org"))] }),
      );
      expect(ids()).toEqual(["$oldText", "$lone"]);
    });

    it("pairs an expired attachment with text later in a sync batch still being admitted", async () => {
      const at = sentAt();
      const image = oldImage(at);
      // Delivered events are hydrated and need not carry room_id.
      delete (image as { room_id?: string }).room_id;
      const text = oldText(at);
      const { hold, calls, ids } = createHold();

      const release = hold.noteSyncBatch([
        { roomId: ROOM, event: image },
        { roomId: ROOM, event: text },
      ]);
      // The drain delivers the attachment before the text in its batch is durable.
      await expect(
        hold.onRoomMessage(ROOM, image, claim({ readLaneBacklog: async () => [] })),
      ).resolves.toEqual({ kind: "deferred" });
      release();
      await hold.onRoomMessage(ROOM, text, claim());
      expect(ids()).toEqual(["$oldText"]);
      expect(calls[0]?.event.content).toMatchObject({ msgtype: "m.image", body: "what is this?" });

      // A released batch is no longer looked at.
      await hold.onRoomMessage(
        ROOM,
        { ...oldImage(at), event_id: "$after" },
        claim({ readLaneBacklog: async () => [] }),
      );
      expect(ids()).toEqual(["$oldText", "$after"]);
    });

    it("ignores other rooms in a sync batch", async () => {
      const at = sentAt();
      const elsewhere = { ...oldText(at), room_id: "!other:example.org" };
      const { hold, ids } = createHold();

      const release = hold.noteSyncBatch([{ roomId: "!other:example.org", event: elsewhere }]);
      await hold.onRoomMessage(ROOM, oldImage(at), claim({ readLaneBacklog: async () => [] }));
      release();
      expect(ids()).toEqual(["$oldImage"]);
    });
  });

  it("recognises a reaction without an explicit relation type like the handler does", async () => {
    const reactionMayStartWork = vi.fn(async () => true);
    const { hold, ids } = createHold({ reactionMayStartWork });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(
      ROOM,
      {
        type: "m.reaction",
        sender: USER,
        event_id: "$legacyReaction",
        origin_server_ts: Date.now(),
        content: { "m.relates_to": { event_id: "$image", key: "👍" } },
      } as MatrixRawEvent,
      claim(),
    );
    // It targets the held attachment, so the hold is kept and the owner is not asked.
    expect(ids()).toEqual(["$legacyReaction"]);
    expect(reactionMayStartWork).not.toHaveBeenCalled();
  });

  it("lets verification traffic through without releasing a hold", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(
      ROOM,
      createMatrixRoomMessageEvent({
        eventId: "$verify",
        sender: USER,
        content: {
          msgtype: "m.key.verification.request",
          body: "verify me",
          methods: ["m.sas.v1"],
        },
      }),
      claim(),
    );
    expect(ids()).toEqual(["$verify"]);
    await hold.onRoomMessage(ROOM, textEvent("$text", "what is this?"), claim());
    expect(ids()).toEqual(["$verify", "$text"]);
  });

  it("only joins text from the same thread", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(ROOM, textEvent("$threaded", "in a thread", USER, "$root"), claim());
    expect(ids()).toEqual(["$threaded"]);

    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(ids()).toEqual(["$threaded", "$image"]);
  });

  it("does not hold captioned attachments, voice messages or the bot's own events", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(
      ROOM,
      imageEvent("$captioned", { body: "look at this", filename: "photo.png" }),
      claim(),
    );
    await hold.onRoomMessage(
      ROOM,
      createMatrixRoomMessageEvent({
        eventId: "$voice",
        sender: USER,
        content: {
          msgtype: "m.audio",
          body: "voice.ogg",
          url: "mxc://example.org/voice",
          "org.matrix.msc3245.voice": {},
        },
      }),
      claim(),
    );
    await hold.onRoomMessage(ROOM, imageEvent("$held"), claim());
    await hold.onRoomMessage(ROOM, textEvent("$own", "my reply", BOT), claim());

    expect(ids()).toEqual(["$captioned", "$voice", "$own"]);
  });

  it("reopens held claims instead of starting turns when the monitor closes", async () => {
    const { hold, calls } = createHold();
    const media = claim();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    hold.close();
    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(calls).toHaveLength(0);
    expect(media.onCancelled).toHaveBeenCalledTimes(1);
    expect(media.onAdopted).not.toHaveBeenCalled();
    await hold.onRoomMessage(ROOM, imageEvent("$after"), claim());
    expect(calls.map((call) => call.event.event_id)).toEqual(["$after"]);
  });

  it("drops a held attachment whose claim the drain aborted", async () => {
    const { hold, calls } = createHold();
    const controller = new AbortController();
    const media = claim({ abortSignal: controller.signal });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    controller.abort(new Error("stopped"));
    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(calls).toHaveLength(0);
    expect(media.onCancelled).not.toHaveBeenCalled();
    expect(media.onAdopted).not.toHaveBeenCalled();
  });

  it("abandons both claims when the merged turn fails", async () => {
    const { hold } = createHold({
      onDispatch: async () => {
        throw new Error("handler failed");
      },
    });
    const media = claim({ onFailed: vi.fn(async () => {}) });
    const text = claim({ onFailed: vi.fn(async () => {}) });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    await hold.onRoomMessage(ROOM, textEvent("$text", "summarize"), text);

    expect(media.onFailed).toHaveBeenCalledTimes(1);
    expect(text.onFailed).toHaveBeenCalledTimes(1);
    expect(media.onAdopted).not.toHaveBeenCalled();
  });
});

describe("createMatrixHoldControlCommandCheck", () => {
  beforeEach(() => {
    installMatrixMonitorTestRuntime();
  });

  it("uses the live config, the handler's mention stripping and the canonical command predicate", async () => {
    const liveCfg = { agents: {} };
    const isControlCommandMessage = vi.fn((text: string) => text === "stop" || text === "/stop");
    const buildMentionRegexes = vi.fn(() => [/^openclaw\b/i]);
    const check = createMatrixHoldControlCommandCheck({
      core: {
        config: { current: () => liveCfg },
        channel: {
          routing: {
            resolveAgentRoute: () => ({
              agentId: "main",
              channel: "matrix",
              accountId: "ops",
              sessionKey: "agent:main:main",
              mainSessionKey: "agent:main:main",
              matchedBy: "binding.account",
            }),
          },
          mentions: { buildMentionRegexes },
          commands: { isControlCommandMessage },
        },
      } as never,
      accountId: "ops",
      accountConfig: {},
      threadReplies: "inbound",
      selfUserId: BOT,
      directTracker: { isDirectMessage: async () => true },
      getMemberDisplayName: async () => "OpenClaw",
    });

    await expect(check(ROOM, textEvent("$bare", "stop"))).resolves.toBe(true);
    await expect(check(ROOM, textEvent("$prefixed", "OpenClaw: /stop"))).resolves.toBe(true);
    await expect(check(ROOM, textEvent("$plain", "what is this?"))).resolves.toBe(false);
    expect(isControlCommandMessage).toHaveBeenLastCalledWith("what is this?", liveCfg);
    expect(buildMentionRegexes).toHaveBeenCalledWith(liveCfg, "main", expect.any(Object));
  });
});

describe("resolveMatrixReactionMayStartWork", () => {
  beforeEach(() => {
    installMatrixMonitorTestRuntime();
  });

  function reaction(targetEventId: string) {
    return createMatrixReactionEvent({ eventId: "$reaction", targetEventId, key: "👍" });
  }
  const cfgWith = (mode?: "off" | "own") =>
    ({ channels: { matrix: mode ? { reactionNotifications: mode } : {} } }) as never;

  it("follows the reaction handler: notification mode, target ownership, lookup failure", async () => {
    const client = {
      getEvent: vi.fn(async (_roomId: string, eventId: string) =>
        eventId === "$botMessage" ? { sender: BOT } : { sender: USER },
      ),
    };
    const base = { client: client as never, accountId: "ops", roomId: ROOM, selfUserId: BOT };

    await expect(
      resolveMatrixReactionMayStartWork({
        ...base,
        cfg: cfgWith("own"),
        event: reaction("$botMessage"),
      }),
    ).resolves.toBe(true);
    await expect(
      resolveMatrixReactionMayStartWork({
        ...base,
        cfg: cfgWith("own"),
        event: reaction("$userMessage"),
      }),
    ).resolves.toBe(false);
    await expect(
      resolveMatrixReactionMayStartWork({
        ...base,
        cfg: cfgWith("off"),
        event: reaction("$botMessage"),
      }),
    ).resolves.toBe(false);
    await expect(
      resolveMatrixReactionMayStartWork({
        ...base,
        cfg: cfgWith("own"),
        event: createMatrixReactionEvent({
          eventId: "$own",
          targetEventId: "$x",
          key: "👍",
          sender: BOT,
        }),
      }),
    ).resolves.toBe(false);

    client.getEvent.mockRejectedValueOnce(new Error("transient"));
    await expect(
      resolveMatrixReactionMayStartWork({
        ...base,
        cfg: cfgWith("own"),
        event: reaction("$botMessage"),
      }),
    ).resolves.toBe(true);
  });
});

describe("Matrix media hold with the room message handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installMatrixMonitorTestRuntime();
    downloadMatrixMediaMock.mockReset();
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/photo.png",
      contentType: "image/png",
      placeholder: "[matrix image attachment]",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function createHarness() {
    const harness = createMatrixHandlerTestHarness({});
    const contexts = () =>
      (
        harness.recordInboundSession as unknown as {
          mock: { calls: [{ ctx: Record<string, unknown> }][] };
        }
      ).mock.calls.map(([payload]) => payload.ctx);
    return { ...harness, contexts };
  }

  it("answers an attachment and the text sent after it in one turn", async () => {
    const { handler, contexts } = createHarness();
    const hold = createMatrixMediaHold({
      holdMs: HOLD_MS,
      selfUserId: BOT,
      dispatch: handler,
      isControlCommand: async () => false,
      reactionMayStartWork: async () => false,
      logVerboseMessage: () => {},
    });
    const media = claim();
    const text = claim();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    await vi.advanceTimersByTimeAsync(3_000);
    await hold.onRoomMessage(ROOM, textEvent("$text", "summarize this"), text);

    const turns = contexts();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      RawBody: "summarize this",
      MediaPath: "/tmp/inbound/photo.png",
      MessageSid: "$text",
    });
    expect(media.onAdopted).toHaveBeenCalledTimes(1);
    expect(text.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("keeps two turns without the hold", async () => {
    const { handler, contexts } = createHarness();

    await handler(ROOM, imageEvent("$image"));
    await handler(ROOM, textEvent("$text", "summarize this"));

    const turns = contexts();
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ MediaPath: "/tmp/inbound/photo.png", MessageSid: "$image" });
    expect(turns[1]).toMatchObject({ RawBody: "summarize this", MessageSid: "$text" });
    expect(turns[1]?.MediaPath).toBeUndefined();
  });
});
