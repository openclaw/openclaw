// Matrix tests cover inbound burst debouncing ahead of the room-message handler.
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import type { MatrixRoomMessageDispatchOptions } from "./handler.js";
import { createMatrixInboundDebouncer } from "./inbound-debounce.js";
import type { MatrixCommandPrefixInputs } from "./inbound-debounce.js";
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
    origin_server_ts: STARTUP_TS,
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
    origin_server_ts: STARTUP_TS,
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

const STARTUP_TS = 1_000;

const BOT = "@bot:example.org";
const BOT_NAME = "OpenClaw Bot";
const botPill = `<a href="https://matrix.to/#/${BOT}">${BOT_NAME}</a>`;

function createSubject(params?: {
  debounceMs?: number;
  duplicates?: Set<string>;
  prefixInputs?: (event: MatrixRawEvent) => Promise<MatrixCommandPrefixInputs>;
  onHandle?: (event: MatrixRawEvent, options?: MatrixRoomMessageDispatchOptions) => Promise<void>;
}) {
  const dispatched: Dispatched[] = [];
  const claims = new Map<string, ReturnType<typeof createClaim>>();
  let stopped = false;
  const cfg = {
    messages: { inbound: { byChannel: { matrix: params?.debounceMs ?? DEBOUNCE_MS } } },
  } as CoreConfig;
  const enqueue = createMatrixInboundDebouncer({
    readConfig: () => cfg,
    selfUserId: BOT,
    handleRoomMessage: async (roomId, event, options) => {
      dispatched.push({ roomId, event, options });
      await params?.onHandle?.(event, options);
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
    isPreStartupEvent: (event) => (event.origin_server_ts ?? STARTUP_TS) < STARTUP_TS,
    resolveCommandPrefixInputs: async (_roomId, event) =>
      (await params?.prefixInputs?.(event)) ?? { mentionRegexes: [] },
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
    // Every batched event is claimed once and settles with the merge base's claim.
    const joined = dispatched[0]?.options?.replayClaim;
    expect(joined?.keys).toEqual(["$3", "$1", "$2"]);
    await expect(joined?.commit()).resolves.toBe(true);
    for (const claim of claims.values()) {
      expect(claim.commit).toHaveBeenCalledOnce();
    }
  });

  it("dispatches immediately when no debounce window is configured", async () => {
    const { enqueue, dispatched, claims } = createSubject({ debounceMs: 0 });

    await enqueue(ROOM, text("$1", "one"));
    await enqueue(ROOM, text("$2", "two"));

    expect(dispatched.map((entry) => entry.event.content.body)).toEqual(["one", "two"]);
    // Single events keep the handler's own claim path.
    expect(dispatched[0]?.options?.replayClaim).toBeUndefined();
    expect(claims.size).toBe(0);
  });

  it("merges a text burst once when E2EE emits every event twice", async () => {
    const { enqueue, dispatched } = createSubject();
    const first = text("$1", "hey");
    const second = text("$2", "lool");

    // The decrypt bridge emits room.decrypted_event and room.message for each event.
    await enqueue(ROOM, first);
    await enqueue(ROOM, first);
    await enqueue(ROOM, second);
    await enqueue(ROOM, second);
    expect(dispatched).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched).toHaveLength(1);
    const [{ event, options }] = dispatched as [Dispatched];
    expect(event.event_id).toBe("$2");
    expect(event.content.body).toBe("hey\nlool");
    expect(options?.replayClaim?.keys).toEqual(["$2", "$1"]);
  });

  it.each([0, DEBOUNCE_MS])(
    "reprocesses a released event redelivered inside the repeat window (debounce %i ms)",
    async (debounceMs) => {
      let failNext = true;
      const { enqueue, dispatched } = createSubject({
        debounceMs,
        onHandle: async (_event, options) => {
          if (failNext) {
            failNext = false;
            // A pre-adoption failure releases the replay claim so a retry can run.
            options?.replayClaim?.release();
            throw new Error("transient");
          }
        },
      });
      const event = text("$retry", "hello");

      await enqueue(ROOM, event).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(debounceMs);
      expect(dispatched).toHaveLength(1);

      await enqueue(ROOM, event);
      await vi.advanceTimersByTimeAsync(debounceMs);
      expect(dispatched).toHaveLength(2);
    },
  );

  it("suppresses a simultaneous E2EE copy while the first is still being handled", async () => {
    let finish!: () => void;
    const { enqueue, dispatched } = createSubject({
      debounceMs: 0,
      onHandle: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const event = text("$twice", "hi");

    const first = enqueue(ROOM, event);
    await vi.advanceTimersByTimeAsync(0);
    await enqueue(ROOM, event);
    finish();
    await first;

    expect(dispatched).toHaveLength(1);
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
    ["a command behind the bot's MXID", text("$x", `${BOT}: /stop`)],
    ["an image", media("$x", "m.image", "photo.jpg")],
    [
      "a command behind a display-name pill",
      withContent(text("$x", `${BOT_NAME}: /stop`), {
        format: "org.matrix.custom.html",
        formatted_body: `${botPill}: /stop`,
      }),
    ],
    ["a command behind a mention pattern", text("$x", "synapse: /stop")],
  ])("flushes pending text before %s and dispatches it alone", async (_name, event) => {
    const { enqueue, dispatched } = createSubject({
      prefixInputs: async () => ({ displayName: BOT_NAME, mentionRegexes: [/\bsynapse\b/i] }),
    });

    await enqueue(ROOM, text("$1", "first"));
    await enqueue(ROOM, event);

    expect(dispatched.map((entry) => [entry.event.event_id, entry.event.content.body])).toEqual([
      ["$1", "first"],
      ["$x", event.content.body],
    ]);
  });

  it("keeps arrival order while prefix inputs resolve out of order", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { enqueue, dispatched } = createSubject({
      prefixInputs: async (event) => {
        if (event.event_id === "$1") {
          await firstGate;
        }
        return { mentionRegexes: [] };
      },
    });

    const first = enqueue(ROOM, text("$1", "one"));
    const second = enqueue(ROOM, text("$2", "two"));
    releaseFirst();
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched[0]?.event.content.body).toBe("one\ntwo");
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

  it("drops already-handled events and merges on the latest fresh one", async () => {
    const { enqueue, dispatched, claims } = createSubject({ duplicates: new Set(["$1", "$3"]) });

    await enqueue(ROOM, text("$1", "replayed"));
    await enqueue(ROOM, text("$2", "fresh"));
    await enqueue(ROOM, text("$3", "already handled"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.event.event_id).toBe("$2");
    expect(dispatched[0]?.event.content.body).toBe("fresh");
    expect(dispatched[0]?.options?.replayClaim).toBe(claims.get("$2"));
  });

  it("keeps each event's HTML and merges mentions across the burst", async () => {
    const { enqueue, dispatched } = createSubject();

    await enqueue(
      ROOM,
      withContent(text("$1", "hey bot"), {
        format: "org.matrix.custom.html",
        formatted_body: "<b>hey</b> bot",
        "m.mentions": { user_ids: [BOT] },
      }),
    );
    await enqueue(ROOM, withContent(text("$2", "you <there>?"), { "m.mentions": { room: true } }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched[0]?.event.content).toEqual({
      msgtype: "m.text",
      body: "hey bot\nyou <there>?",
      format: "org.matrix.custom.html",
      formatted_body: "<b>hey</b> bot<br>you &lt;there&gt;?",
      "m.mentions": { user_ids: [BOT], room: true },
    });
  });

  it("never merges cold-start history into a fresh turn", async () => {
    const { enqueue, dispatched } = createSubject();

    await enqueue(ROOM, text("$old", "from before startup", { origin_server_ts: STARTUP_TS - 1 }));
    await enqueue(ROOM, text("$new", "fresh"));
    await enqueue(ROOM, media("$img", "m.image", "a.jpg"));
    await enqueue(ROOM, text("$late", "history", { origin_server_ts: STARTUP_TS - 1 }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // History dispatches alone so the handler's startup filter drops it untouched.
    expect(dispatched.map((entry) => [entry.event.event_id, entry.event.content.body])).toEqual([
      ["$old", "from before startup"],
      ["$new", "fresh"],
      ["$img", "a.jpg"],
      ["$late", "history"],
    ]);
  });

  it("releases absorbed claims when the monitor stopped before the flush", async () => {
    const { enqueue, dispatched, claims, stop } = createSubject();

    await enqueue(ROOM, text("$1", "one"));
    await enqueue(ROOM, text("$2", "two"));
    stop();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched).toHaveLength(0);
    for (const eventId of ["$1", "$2"]) {
      expect(claims.get(eventId)?.release).toHaveBeenCalledOnce();
    }
  });
});
