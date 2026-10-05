// Matrix tests cover inbound burst debouncing ahead of the room-message handler.
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import type { MatrixRoomMessageDispatchOptions } from "./handler.js";
import { createMatrixInboundDebouncer } from "./inbound-debounce.js";
import { joinMatrixInboundReplayClaims } from "./inbound-dedupe.js";
import type { MatrixRawEvent } from "./types.js";

const ROOM = "!room:example.org";
const ALICE = "@alice:example.org";
const BOB = "@bob:example.org";
const DEBOUNCE_MS = 1000;

type Dispatched = {
  roomId: string;
  event: MatrixRawEvent;
  options: MatrixRoomMessageDispatchOptions | undefined;
};

function text(eventId: string, body: string, extra: Partial<MatrixRawEvent> = {}): MatrixRawEvent {
  return {
    type: "m.room.message",
    event_id: eventId,
    sender: ALICE,
    origin_server_ts: 0,
    content: { msgtype: "m.text", body },
    ...extra,
  };
}

function withContent(event: MatrixRawEvent, content: Record<string, unknown>): MatrixRawEvent {
  return { ...event, content: { ...event.content, ...content } };
}

function media(eventId: string, msgtype: string, body: string): MatrixRawEvent {
  return {
    type: "m.room.message",
    event_id: eventId,
    sender: ALICE,
    origin_server_ts: 0,
    content: { msgtype, body, url: "mxc://example.org/media" },
  };
}

function createClaim(eventId: string) {
  return {
    keys: [eventId],
    commit: vi.fn(async () => true),
    release: vi.fn(),
  } satisfies ChannelReplayClaimHandle;
}

function createSubject(params?: { debounceMs?: number; duplicates?: Set<string> }) {
  const dispatched: Dispatched[] = [];
  const claims = new Map<string, ReturnType<typeof createClaim>>();
  let stopped = false;
  const cfg = {
    messages: { inbound: { byChannel: { matrix: params?.debounceMs ?? DEBOUNCE_MS } } },
  } as CoreConfig;
  const enqueue = createMatrixInboundDebouncer({
    cfg,
    selfUserId: "@bot:example.org",
    handleRoomMessage: async (roomId, event, options) => {
      dispatched.push({ roomId, event, options });
    },
    inboundDeduper: {
      claim: vi.fn(async ({ eventId }: { roomId: string; eventId: string }) => {
        if (params?.duplicates?.has(eventId)) {
          return { kind: "duplicate" as const };
        }
        const claim = createClaim(eventId);
        claims.set(eventId, claim);
        return { kind: "claimed" as const, handle: claim };
      }),
    } as never,
    runDetachedTask: async (_label, task) => {
      if (!stopped) {
        await task();
      }
    },
    logVerboseMessage: () => {},
    onError: (err) => {
      throw err;
    },
  });
  return {
    enqueue,
    dispatched,
    claims,
    stop: () => {
      stopped = true;
    },
  };
}

describe("matrix inbound debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges a text burst into one turn on the latest event", async () => {
    const { enqueue, dispatched, claims } = createSubject();

    await enqueue(ROOM, text("$1", "one"));
    await enqueue(ROOM, text("$2", "two"));
    await enqueue(ROOM, text("$3", "three"));
    expect(dispatched).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.event.event_id).toBe("$3");
    expect(dispatched[0]?.event.content.body).toBe("one\ntwo\nthree");
    // The merged event claims itself in the handler; only absorbed events are pre-claimed.
    expect([...claims.keys()]).toEqual(["$1", "$2"]);
    expect(dispatched[0]?.options?.absorbedReplayClaims).toEqual([
      claims.get("$1"),
      claims.get("$2"),
    ]);
  });

  it("dispatches immediately when no debounce window is configured", async () => {
    const { enqueue, dispatched, claims } = createSubject({ debounceMs: 0 });

    await enqueue(ROOM, text("$1", "one"));
    await enqueue(ROOM, text("$2", "two"));

    expect(dispatched.map((entry) => entry.event.content.body)).toEqual(["one", "two"]);
    expect(dispatched[0]?.options?.absorbedReplayClaims).toEqual([]);
    expect(claims.size).toBe(0);
  });

  it("uses trailing text as the caption for one waiting attachment", async () => {
    const { enqueue, dispatched } = createSubject();

    await enqueue(ROOM, media("$img", "m.image", "IMG_0001.jpg"));
    await enqueue(ROOM, text("$q", "what is this?"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched).toHaveLength(1);
    const [{ event }] = dispatched as [Dispatched];
    expect(event.event_id).toBe("$img");
    expect(event.content).toMatchObject({
      msgtype: "m.image",
      url: "mxc://example.org/media",
      body: "what is this?",
      filename: "IMG_0001.jpg",
    });
  });

  it("starts a new batch for a second attachment", async () => {
    const { enqueue, dispatched } = createSubject();

    await enqueue(ROOM, media("$a", "m.image", "a.jpg"));
    await enqueue(ROOM, media("$b", "m.image", "b.jpg"));
    await enqueue(ROOM, text("$t", "caption for b"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched.map((entry) => [entry.event.event_id, entry.event.content.body])).toEqual([
      ["$a", "a.jpg"],
      ["$b", "caption for b"],
    ]);
  });

  it.each([
    ["an edit", withContent(text("$x", "* fixed"), { "m.relates_to": { rel_type: "m.replace" } })],
    [
      "a reply",
      withContent(text("$x", "answer"), {
        "m.relates_to": { "m.in_reply_to": { event_id: "$earlier" } },
      }),
    ],
    ["a control command", text("$x", "/status")],
    ["a voice note", media("$x", "m.audio", "voice.ogg")],
  ])("flushes pending text before %s and dispatches it immediately", async (_name, event) => {
    const { enqueue, dispatched } = createSubject();

    await enqueue(ROOM, text("$1", "first"));
    await enqueue(ROOM, event);

    expect(dispatched.map((entry) => entry.event.event_id)).toEqual(["$1", "$x"]);
  });

  it("keeps senders and threads in separate batches", async () => {
    const { enqueue, dispatched } = createSubject();
    const threaded = (eventId: string, body: string) =>
      withContent(text(eventId, body), {
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root",
          is_falling_back: true,
          "m.in_reply_to": { event_id: "$root" },
        },
      });

    await enqueue(ROOM, text("$a1", "alice main"));
    await enqueue(ROOM, text("$b1", "bob main", { sender: BOB }));
    await enqueue(ROOM, threaded("$t1", "alice thread 1"));
    await enqueue(ROOM, threaded("$t2", "alice thread 2"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched).toHaveLength(3);
    expect(dispatched.map((entry) => entry.event.content.body)).toEqual(
      expect.arrayContaining(["alice main", "alice thread 1\nalice thread 2", "bob main"]),
    );
  });

  it("drops absorbed events that were already handled", async () => {
    const { enqueue, dispatched } = createSubject({ duplicates: new Set(["$1"]) });

    await enqueue(ROOM, text("$1", "replayed"));
    await enqueue(ROOM, text("$2", "fresh"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.event.content.body).toBe("fresh");
    expect(dispatched[0]?.options?.absorbedReplayClaims).toEqual([]);
  });

  it("drops per-event HTML and merges mentions across the burst", async () => {
    const { enqueue, dispatched } = createSubject();

    await enqueue(
      ROOM,
      withContent(text("$1", "hey bot"), {
        format: "org.matrix.custom.html",
        formatted_body: "<b>hey</b> bot",
        "m.mentions": { user_ids: ["@bot:example.org"] },
      }),
    );
    await enqueue(ROOM, withContent(text("$2", "you there?"), { "m.mentions": { room: true } }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched[0]?.event.content).toEqual({
      msgtype: "m.text",
      body: "hey bot\nyou there?",
      "m.mentions": { user_ids: ["@bot:example.org"], room: true },
    });
  });

  it("releases absorbed claims when the monitor stopped before the flush", async () => {
    const { enqueue, dispatched, claims, stop } = createSubject();

    await enqueue(ROOM, text("$1", "one"));
    await enqueue(ROOM, text("$2", "two"));
    stop();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched).toHaveLength(0);
    expect(claims.get("$1")?.release).toHaveBeenCalledOnce();
  });
});

describe("joinMatrixInboundReplayClaims", () => {
  it("settles absorbed claims with the primary claim", async () => {
    const primary = createClaim("$3");
    const absorbed = [createClaim("$1"), createClaim("$2")];
    const joined = joinMatrixInboundReplayClaims(primary, absorbed);

    expect(joined.keys).toEqual(["$3", "$1", "$2"]);
    await expect(joined.commit()).resolves.toBe(true);
    for (const claim of [primary, ...absorbed]) {
      expect(claim.commit).toHaveBeenCalledOnce();
    }
    joined.release();
    for (const claim of [primary, ...absorbed]) {
      expect(claim.release).toHaveBeenCalledOnce();
    }
  });
});
