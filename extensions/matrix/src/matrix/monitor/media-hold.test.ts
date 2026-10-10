// Matrix tests cover the optional hold that joins a captionless attachment with its text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import { createMatrixMediaHold, type MatrixRoomMessageDispatchOptions } from "./media-hold.js";
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
const HOLD_MS = 20_000;

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

function createHold(params: { isControlCommand?: (text: string) => boolean } = {}) {
  const calls: { event: MatrixRawEvent; options?: MatrixRoomMessageDispatchOptions }[] = [];
  const dispatch = vi.fn(
    async (_roomId: string, event: MatrixRawEvent, options?: MatrixRoomMessageDispatchOptions) => {
      calls.push({ event, options });
    },
  );
  const hold = createMatrixMediaHold({
    holdMs: HOLD_MS,
    selfUserId: "@bot:example.org",
    dispatch,
    isControlCommand: params.isControlCommand ?? ((text) => text.startsWith("/")),
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

  it("joins a captionless attachment with the sender's next text as one captioned event", async () => {
    const { hold, calls } = createHold();

    const media = hold.onRoomMessage(ROOM, imageEvent("$image"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(0);
    await Promise.all([media, hold.onRoomMessage(ROOM, textEvent("$text", "what is this?"))]);

    expect(calls).toHaveLength(1);
    const [{ event, options }] = calls as [(typeof calls)[number]];
    expect(event.event_id).toBe("$text");
    expect(event.content).toMatchObject({
      msgtype: "m.image",
      body: "what is this?",
      filename: "photo.png",
      url: "mxc://example.org/photo",
      info: { mimetype: "image/png", size: 123 },
    });
    expect(options).toEqual({ absorbedEventIds: ["$image"] });
  });

  it("dispatches the attachment alone when no text arrives in the window", async () => {
    const { hold, calls, ids } = createHold();

    const media = hold.onRoomMessage(ROOM, imageEvent("$image"));
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await media;
    expect(calls[0]?.event.content.body).toBe("photo.png");
    expect(calls[0]?.options).toBeUndefined();

    await hold.onRoomMessage(ROOM, textEvent("$text", "late text"));
    expect(ids()).toEqual(["$image", "$text"]);
    expect(calls[1]?.event.content.msgtype).toBe("m.text");
  });

  it("dispatches a held attachment first when a second attachment arrives", async () => {
    const { hold, ids } = createHold();

    const first = hold.onRoomMessage(ROOM, imageEvent("$image1"));
    const second = hold.onRoomMessage(ROOM, imageEvent("$image2"));
    await first;
    expect(ids()).toEqual(["$image1"]);

    await Promise.all([second, hold.onRoomMessage(ROOM, textEvent("$text", "compare these"))]);
    expect(ids()).toEqual(["$image1", "$text"]);
  });

  it("keeps order when another sender writes in the same conversation", async () => {
    const { hold, calls, ids } = createHold();

    const media = hold.onRoomMessage(ROOM, imageEvent("$image"));
    await Promise.all([
      media,
      hold.onRoomMessage(ROOM, textEvent("$other", "hi", "@other:example.org")),
    ]);

    expect(ids()).toEqual(["$image", "$other"]);
    expect(calls[1]?.event.content.msgtype).toBe("m.text");
  });

  it("never folds a control command into an attachment", async () => {
    const { hold, calls, ids } = createHold();

    const media = hold.onRoomMessage(ROOM, imageEvent("$image"));
    await Promise.all([media, hold.onRoomMessage(ROOM, textEvent("$stop", "/stop"))]);

    expect(ids()).toEqual(["$image", "$stop"]);
    expect(calls[1]?.event.content).toMatchObject({ msgtype: "m.text", body: "/stop" });
  });

  it("only joins text from the same thread", async () => {
    const { hold, ids } = createHold();

    const media = hold.onRoomMessage(ROOM, imageEvent("$image"));
    await hold.onRoomMessage(ROOM, textEvent("$threaded", "in a thread", USER, "$root"));
    expect(ids()).toEqual(["$threaded"]);

    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await media;
    expect(ids()).toEqual(["$threaded", "$image"]);
  });

  it("does not hold captioned attachments or voice messages", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(
      ROOM,
      imageEvent("$captioned", { body: "look at this", filename: "photo.png" }),
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
    );

    expect(ids()).toEqual(["$captioned", "$voice"]);
  });

  it("dispatches held attachments immediately when flushed for shutdown", async () => {
    const { hold, ids } = createHold();

    const media = hold.onRoomMessage(ROOM, imageEvent("$image"));
    await hold.flushHeld();
    await media;

    expect(ids()).toEqual(["$image"]);
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
    const committed: string[] = [];
    const harness = createMatrixHandlerTestHarness({
      dropPreStartupMessages: false,
      inboundDeduper: {
        claim: vi.fn(async ({ eventId }: { roomId: string; eventId: string }) => ({
          kind: "claimed" as const,
          handle: {
            keys: [eventId] as const,
            commit: async () => {
              committed.push(eventId);
              return true;
            },
            release: () => {},
          },
        })),
      },
    });
    const contexts = () =>
      (
        harness.recordInboundSession as unknown as {
          mock: { calls: [{ ctx: Record<string, unknown> }][] };
        }
      ).mock.calls.map(([payload]) => payload.ctx);
    return { ...harness, committed, contexts };
  }

  it("answers an attachment and the text sent after it in one turn", async () => {
    const { handler, contexts, committed } = createHarness();
    const hold = createMatrixMediaHold({
      holdMs: HOLD_MS,
      selfUserId: "@bot:example.org",
      dispatch: handler,
      isControlCommand: () => false,
      logVerboseMessage: () => {},
    });

    const media = hold.onRoomMessage(ROOM, imageEvent("$image"));
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([media, hold.onRoomMessage(ROOM, textEvent("$text", "summarize this"))]);

    const turns = contexts();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      RawBody: "summarize this",
      MediaPath: "/tmp/inbound/photo.png",
      MessageSid: "$text",
    });
    expect(committed.toSorted()).toEqual(["$image", "$text"]);
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
