import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixQaObservedEvent, MatrixQaRoomEvent } from "./events.js";
import { mockMatrixQaHttp } from "./http.test-support.js";
import { createMatrixQaRoomObserver, primeMatrixQaRoom } from "./sync.js";

function message(
  eventId: string,
  body: string,
  content: Record<string, unknown> = {},
): MatrixQaRoomEvent {
  return {
    event_id: eventId,
    sender: "@sut:matrix-qa.test",
    type: "m.room.message",
    content: { body, msgtype: "m.text", ...content },
  };
}

function syncResponse(
  events: MatrixQaRoomEvent[],
  roomId = "!room:matrix-qa.test",
  nextBatch = "next-batch-2",
) {
  return Response.json({
    next_batch: nextBatch,
    rooms: { join: { [roomId]: { timeline: { events } } } },
  });
}

function makeObserver(
  fetchImpl: typeof fetch,
  observedEvents: MatrixQaObservedEvent[] = [],
  accessToken?: string,
) {
  mockMatrixQaHttp(fetchImpl);
  return createMatrixQaRoomObserver({
    baseUrl: "http://127.0.0.1:28008/",
    observedEvents,
    since: "start-batch",
    accessToken,
  });
}

function eventWait(eventId: string, roomId = "!room:matrix-qa.test", timeoutMs = 1_000) {
  return {
    predicate: (event: MatrixQaObservedEvent) => event.eventId === eventId,
    roomId,
    timeoutMs,
  };
}
const missingEvent = { predicate: () => false, roomId: "!room:matrix-qa.test", timeoutMs: 1_000 };

describe("matrix sync helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("primes the Matrix sync cursor without recording observed events", async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ next_batch: "primed-sync-cursor" });

    mockMatrixQaHttp(fetchImpl);

    await expect(
      primeMatrixQaRoom({
        accessToken: "token",
        baseUrl: "http://127.0.0.1:28008/",
      }),
    ).resolves.toBe("primed-sync-cursor");
  });

  it("lets a second wait reuse later same-batch events without another /sync", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return syncResponse([
        message("$preview", "preview", {
          msgtype: "m.notice",
          "m.relates_to": {
            rel_type: "m.thread",
            event_id: "$root",
            is_falling_back: true,
            "m.in_reply_to": { event_id: "$driver" },
          },
        }),
        message("$final", "final", {
          "m.new_content": {
            body: "final",
            msgtype: "m.text",
            "m.relates_to": { rel_type: "m.thread", event_id: "$wrong-root" },
          },
          "m.relates_to": { rel_type: "m.replace", event_id: "$preview" },
        }),
      ]);
    };
    const observedEvents: MatrixQaObservedEvent[] = [];
    const observer = makeObserver(fetchImpl, observedEvents, "token");

    const preview = await observer.waitForRoomEvent(eventWait("$preview"));
    expect(observedEvents.map((event) => event.eventId)).toEqual(["$preview", "$final"]);
    const finalized = await observer.waitForRoomEvent(eventWait("$final"));

    expect(preview.event.eventId).toBe("$preview");
    expect(finalized.event).toMatchObject({
      body: "final",
      eventId: "$final",
      replacesEventId: "$preview",
      relatesTo: {
        eventId: "$root",
        inReplyToId: "$driver",
        isFallingBack: true,
        relType: "m.thread",
      },
    });
    expect(calls).toBe(1);
  });

  it("keeps independent cursors for events observed while polling another room", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return syncResponse([message("$main-reply", "main reply")], "!main:matrix-qa.test");
    };
    const observer = makeObserver(fetchImpl, [], "token");

    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1);
    try {
      await expect(
        observer.waitForOptionalRoomEvent({
          predicate: (event) => event.sender === "@sut:matrix-qa.test",
          roomId: "!secondary:matrix-qa.test",
          timeoutMs: 1,
        }),
      ).resolves.toEqual({ matched: false, since: "next-batch-2" });
    } finally {
      nowSpy.mockRestore();
    }

    await expect(
      observer.waitForRoomEvent(eventWait("$main-reply", "!main:matrix-qa.test")),
    ).resolves.toMatchObject({ event: { eventId: "$main-reply" } });
    expect(calls).toBe(1);
  });

  it("shares one in-flight /sync poll across concurrent waits", async () => {
    let calls = 0;
    const fetchStarted = createDeferred<void>();
    const fetchCanComplete = createDeferred<void>();
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      fetchStarted.resolve();
      await fetchCanComplete.promise;
      return syncResponse([
        message("$reply", "reply"),
        message("$notice", "notice", { msgtype: "m.notice" }),
      ]);
    };
    const observer = makeObserver(fetchImpl, [], "token");

    const waits = Promise.all([
      observer.waitForRoomEvent(eventWait("$reply")),
      observer.waitForOptionalRoomEvent(eventWait("$notice")),
    ]);

    await fetchStarted.promise;
    await Promise.resolve();
    fetchCanComplete.resolve();
    const [reply, notice] = await waits;

    expect(reply.event.eventId).toBe("$reply");
    expect(notice).toEqual({
      event: {
        kind: "notice",
        roomId: "!room:matrix-qa.test",
        eventId: "$notice",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        body: "notice",
        msgtype: "m.notice",
      },
      matched: true,
      since: "next-batch-2",
    });
    expect(calls).toBe(1);
  });

  it("treats its own long-poll deadline as empty and recovers on the next wait", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const expiredSignal = AbortSignal.abort(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(expiredSignal)
      .mockReturnValue(new AbortController().signal);
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        now = 1;
        throw init?.signal instanceof AbortSignal ? init.signal.reason : expiredSignal.reason;
      }
      return syncResponse(
        [message("$recovered", "recovered")],
        "!room:matrix-qa.test",
        "recovered-batch",
      );
    };
    const observer = makeObserver(fetchImpl);

    try {
      await expect(
        observer.waitForOptionalRoomEvent(eventWait("$missing", "!room:matrix-qa.test", 1)),
      ).resolves.toEqual({ matched: false, since: "start-batch" });

      now = 2;
      await expect(observer.waitForRoomEvent(eventWait("$recovered"))).resolves.toMatchObject({
        event: { eventId: "$recovered" },
        since: "recovered-batch",
      });
    } finally {
      nowSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
    expect(calls).toBe(2);
  });

  it("preserves terminal sync failures, including unrelated TimeoutErrors", async () => {
    const timeoutError = new DOMException("upstream protocol timeout", "TimeoutError");
    const observer = makeObserver(async () => {
      throw timeoutError;
    });

    await expect(observer.waitForOptionalRoomEvent(missingEvent)).rejects.toBe(timeoutError);

    vi.restoreAllMocks();
    const authObserver = makeObserver(async () =>
      Response.json({ error: "invalid access token" }, { status: 401 }),
    );
    await expect(authObserver.waitForOptionalRoomEvent(missingEvent)).rejects.toThrow(
      "invalid access token",
    );
  });

  it("preserves response-body failures raised after its long-poll deadline fires", async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const bodyError = new Error("late Matrix response body failure");
    const observer = makeObserver(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              deadline.abort();
              controller.error(bodyError);
            },
          }),
        ),
    );

    try {
      await expect(observer.waitForOptionalRoomEvent(missingEvent)).rejects.toBe(bodyError);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
