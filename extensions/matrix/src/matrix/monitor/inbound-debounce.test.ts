// Matrix tests cover inbound burst debouncing between durable ingress and the room handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import { createMatrixInboundDebouncer } from "./inbound-debounce.js";
import type { MatrixCommandPrefixInputs, MatrixInboundLifecycle } from "./inbound-debounce.js";
import type { MatrixRawEvent } from "./types.js";

const ROOM = "!room:example.org";
const ALICE = "@alice:example.org";
const BOB = "@bob:example.org";
const BOT = "@bot:example.org";
const BOT_NAME = "OpenClaw Bot";
const botPill = `<a href="https://matrix.to/#/${BOT}">${BOT_NAME}</a>`;
const DEBOUNCE_MS = 1000;

type Dispatched = { roomId: string; event: MatrixRawEvent; lifecycle: MatrixInboundLifecycle };

function text(eventId: string, body: string, extra: Partial<MatrixRawEvent> = {}): MatrixRawEvent {
  return {
    type: "m.room.message",
    event_id: eventId,
    sender: ALICE,
    origin_server_ts: 1_000,
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
    origin_server_ts: 1_000,
    content: { msgtype, body, url: "mxc://example.org/media" },
  };
}

function createLifecycle() {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
    onFailed: vi.fn(async () => {}),
    onCancelled: vi.fn(async () => {}),
  } satisfies MatrixInboundLifecycle;
}

function createSubject(params?: {
  debounceMs?: number;
  prefixInputs?: (event: MatrixRawEvent) => Promise<MatrixCommandPrefixInputs>;
  onHandle?: (event: MatrixRawEvent, lifecycle: MatrixInboundLifecycle) => Promise<void>;
}) {
  const dispatched: Dispatched[] = [];
  const lifecycles = new Map<string, ReturnType<typeof createLifecycle>>();
  const errors: unknown[] = [];
  const cfg = {
    messages: { inbound: { byChannel: { matrix: params?.debounceMs ?? DEBOUNCE_MS } } },
  } as CoreConfig;
  const debouncer = createMatrixInboundDebouncer({
    readConfig: () => cfg,
    selfUserId: BOT,
    dispatch: async (roomId, event, lifecycle) => {
      dispatched.push({ roomId, event, lifecycle });
      await params?.onHandle?.(event, lifecycle);
    },
    logVerboseMessage: () => {},
    resolveCommandPrefixInputs: async (_roomId, event) =>
      (await params?.prefixInputs?.(event)) ?? { mentionRegexes: [] },
    onError: (err) => {
      errors.push(err);
    },
  });
  const enqueue = (roomId: string, event: MatrixRawEvent) => {
    const lifecycle = createLifecycle();
    lifecycles.set(event.event_id ?? "", lifecycle);
    return debouncer.enqueue(roomId, event, lifecycle);
  };
  return { enqueue, stop: debouncer.stop, dispatched, lifecycles, errors };
}

const summarize = (dispatched: Dispatched[]) =>
  dispatched.map((entry) => [entry.event.event_id, entry.event.content.body]);

describe("matrix inbound debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges a text burst into one turn on the latest event", async () => {
    const { enqueue, dispatched, lifecycles } = createSubject({
      onHandle: async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      },
    });

    for (const [id, body] of [
      ["$1", "one"],
      ["$2", "two"],
      ["$3", "three"],
    ] as const) {
      await expect(enqueue(ROOM, text(id, body))).resolves.toEqual({ kind: "deferred" });
    }
    expect(dispatched).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(summarize(dispatched)).toEqual([["$3", "one\ntwo\nthree"]]);
    // Adopting the merged turn completes every batched event's durable claim, once.
    for (const lifecycle of lifecycles.values()) {
      expect(lifecycle.onAdopted).toHaveBeenCalledOnce();
    }
  });

  it("dispatches immediately when no debounce window is configured", async () => {
    const { enqueue, dispatched } = createSubject({ debounceMs: 0 });

    await enqueue(ROOM, text("$1", "one"));
    await enqueue(ROOM, text("$2", "two"));

    expect(summarize(dispatched)).toEqual([
      ["$1", "one"],
      ["$2", "two"],
    ]);
  });

  it("settles claims for a turn the handler gated without adopting", async () => {
    const { enqueue, lifecycles } = createSubject();

    await enqueue(ROOM, text("$1", "one"));
    await enqueue(ROOM, text("$2", "two"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    for (const lifecycle of lifecycles.values()) {
      expect(lifecycle.onAdopted).toHaveBeenCalledOnce();
    }
  });

  it("fails every batched claim when the handler throws so the drain retries them", async () => {
    const { enqueue, lifecycles, errors } = createSubject({
      onHandle: async () => {
        throw new Error("transient");
      },
    });

    await enqueue(ROOM, text("$1", "one"));
    await enqueue(ROOM, text("$2", "two"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    for (const lifecycle of lifecycles.values()) {
      expect(lifecycle.onFailed).toHaveBeenCalledOnce();
      expect(lifecycle.onAdopted).not.toHaveBeenCalled();
    }
    expect(errors).toHaveLength(1);
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

    expect(summarize(dispatched)).toEqual([
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

  it("merges only contiguous same-sender, same-thread text and keeps room order", async () => {
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
    await enqueue(ROOM, text("$a2", "alice main again"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(summarize(dispatched)).toEqual([
      ["$a1", "alice main"],
      ["$b1", "bob main"],
      ["$t2", "alice thread 1\nalice thread 2"],
      ["$a2", "alice main again"],
    ]);
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

  it("never batches the bot's own messages", async () => {
    const { enqueue, dispatched } = createSubject();

    await enqueue(ROOM, text("$1", "echo", { sender: BOT }));

    expect(summarize(dispatched)).toEqual([["$1", "echo"]]);
  });

  it("returns pending bursts to the durable queue when the monitor stops", async () => {
    const { enqueue, stop, dispatched, lifecycles } = createSubject();

    await enqueue(ROOM, text("$1", "one"));
    await enqueue(ROOM, text("$2", "two"));
    await stop();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(dispatched).toHaveLength(0);
    for (const lifecycle of lifecycles.values()) {
      expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
      expect(lifecycle.onAdopted).not.toHaveBeenCalled();
    }
    // Events admitted after stop go straight back to the queue as well.
    await expect(enqueue(ROOM, text("$3", "late"))).resolves.toEqual({ kind: "deferred" });
    expect(lifecycles.get("$3")?.onCancelled).toHaveBeenCalledOnce();
  });
});
