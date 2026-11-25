import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixQaObservedEvent, MatrixQaRoomEvent } from "./events.js";
import { mockMatrixQaHttp } from "./http.test-support.js";
import { createMatrixQaRoomObserver, primeMatrixQaRoom } from "./sync.js";

const defaultRoomId = "!room:matrix-qa.test";
const baseUrl = "http://127.0.0.1:28008/";
afterEach(() => vi.restoreAllMocks());

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
  roomId = defaultRoomId,
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
    baseUrl,
    observedEvents,
    since: "start-batch",
    accessToken,
  });
}

function eventWait(eventId: string, roomId = defaultRoomId, timeoutMs = 1_000) {
  return {
    predicate: (event: MatrixQaObservedEvent) => event.eventId === eventId,
    roomId,
    timeoutMs,
  };
}
const missingEvent = { predicate: () => false, roomId: defaultRoomId, timeoutMs: 1_000 };

describe("matrix sync helpers", () => {
  it("primes the Matrix sync cursor without recording observed events", async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ next_batch: "primed-sync-cursor" });

    mockMatrixQaHttp(fetchImpl);
    await expect(primeMatrixQaRoom({ accessToken: "token", baseUrl })).resolves.toBe(
      "primed-sync-cursor",
    );
  });

  it("shares an in-flight poll and reuses its later same-batch events", async () => {
    const fetchStarted = createDeferred<void>();
    const fetchCanComplete = createDeferred<void>();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      fetchStarted.resolve();
      await fetchCanComplete.promise;
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
        message("$notice", "notice", { msgtype: "m.notice" }),
        message("$final", "final", {
          "m.new_content": {
            body: "final",
            msgtype: "m.text",
            "m.relates_to": { rel_type: "m.thread", event_id: "$wrong-root" },
          },
          "m.relates_to": { rel_type: "m.replace", event_id: "$preview" },
        }),
      ]);
    });
    const observedEvents: MatrixQaObservedEvent[] = [];
    const observer = makeObserver(fetchImpl, observedEvents, "token");

    const waits = Promise.all([
      observer.waitForRoomEvent(eventWait("$preview")),
      observer.waitForOptionalRoomEvent(eventWait("$notice")),
    ]);
    await fetchStarted.promise;
    await Promise.resolve();
    fetchCanComplete.resolve();
    const [preview, notice] = await waits;
    expect(notice).toMatchObject({
      event: { kind: "notice", eventId: "$notice" },
      matched: true,
      since: "next-batch-2",
    });
    expect(observedEvents.map((event) => event.eventId)).toEqual(["$preview", "$notice", "$final"]);
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
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps independent cursors for events observed while polling another room", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      syncResponse([message("$main-reply", "main reply")], "!main:matrix-qa.test"),
    );
    const observer = makeObserver(fetchImpl, [], "token");

    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1);
    await expect(
      observer.waitForOptionalRoomEvent({
        predicate: (event) => event.sender === "@sut:matrix-qa.test",
        roomId: "!secondary:matrix-qa.test",
        timeoutMs: 1,
      }),
    ).resolves.toEqual({ matched: false, since: "next-batch-2" });
    nowSpy.mockRestore();

    await expect(
      observer.waitForRoomEvent(eventWait("$main-reply", "!main:matrix-qa.test")),
    ).resolves.toMatchObject({ event: { eventId: "$main-reply" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("treats its own long-poll deadline as empty and recovers on the next wait", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const expiredSignal = AbortSignal.abort(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );
    vi.spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(expiredSignal)
      .mockReturnValue(new AbortController().signal);
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        now = 1;
        throw init?.signal instanceof AbortSignal ? init.signal.reason : expiredSignal.reason;
      }
      return syncResponse([message("$recovered", "recovered")], defaultRoomId, "recovered-batch");
    };
    const observer = makeObserver(fetchImpl);

    await expect(
      observer.waitForOptionalRoomEvent(eventWait("$missing", defaultRoomId, 1)),
    ).resolves.toEqual({ matched: false, since: "start-batch" });
    now = 2;
    await expect(observer.waitForRoomEvent(eventWait("$recovered"))).resolves.toMatchObject({
      event: { eventId: "$recovered" },
      since: "recovered-batch",
    });
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
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
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

    await expect(observer.waitForOptionalRoomEvent(missingEvent)).rejects.toBe(bodyError);
  });
});
