import { M_POLL_KIND_DISCLOSED, M_POLL_KIND_UNDISCLOSED } from "matrix-js-sdk/lib/@types/polls.js";
import { PollResponseEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollResponseEvent.js";
import { PollStartEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollStartEvent.js";
import { MatrixError } from "matrix-js-sdk/lib/http-api/errors.js";
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { buildHttpError } from "../sdk/event-helpers.js";
import { editMatrixMessage, readMatrixMessages } from "./messages.js";
import type { MatrixMessageSummary } from "./types.js";

const ROOM = "!room:example.org";

const MATRIX_ACTION_TEST_CFG = { channels: { matrix: {} } };
type RawEvent = Record<string, unknown>;
const ALICE = "@alice:example.org";
const httpError = (code: number, error: string) =>
  buildHttpError(code, JSON.stringify({ errcode: "M_UNKNOWN", error }));

function rawEvent(
  event_id: string,
  type: string,
  content: RawEvent,
  origin_server_ts = 1,
  sender = ALICE,
): RawEvent {
  return { event_id, type, content, origin_server_ts, sender };
}

function createPollResponseEvent(): RawEvent {
  return rawEvent(
    "$vote",
    "m.poll.response",
    {
      "m.poll.response": { answers: ["a1"] },
      "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
    },
    20,
    "@bob:example.org",
  );
}

function createPollStartEvent(content: RawEvent = {}, threadId?: string): RawEvent {
  return rawEvent("$poll", "m.poll.start", {
    ...(threadId ? { "m.relates_to": { rel_type: "m.thread", event_id: threadId } } : {}),
    "m.poll.start": {
      question: { "m.text": "Favorite fruit?" },
      answers: [{ id: "a1", "m.text": "Apple" }],
      ...content,
    },
  });
}

function message(
  eventId: string,
  body: string,
  timestamp: number,
  params: {
    sender?: string;
    threadId?: string;
    replaces?: string;
    omitNewContent?: boolean;
    newThreadId?: string;
  } = {},
): RawEvent {
  const content: RawEvent = { msgtype: "m.text", body };
  if (params.threadId) {
    content["m.relates_to"] = { rel_type: "m.thread", event_id: params.threadId };
  }
  if (params.replaces) {
    content.body = `* ${body}`;
    content["m.relates_to"] = { rel_type: "m.replace", event_id: params.replaces };
    if (!params.omitNewContent) {
      content["m.new_content"] = { msgtype: "m.text", body };
      if (params.newThreadId) {
        content["m.new_content"] = {
          msgtype: "m.text",
          body,
          "m.relates_to": { rel_type: "m.thread", event_id: params.newThreadId },
        };
      }
    }
  }
  return rawEvent(eventId, "m.room.message", content, timestamp, params.sender);
}

function createMessagesClient(params: {
  chunk?: RawEvent[];
  hydratedChunk?: RawEvent[];
  pollRoot?: RawEvent;
  pollRelations?: RawEvent[];
  threadRelations?: RawEvent[];
}) {
  const doRequest = vi.fn(async () => ({
    chunk: params.chunk ?? [],
    start: "start-token",
    end: "end-token",
  }));
  const hydrateEvents = vi.fn(
    async (_roomId: string, _events: RawEvent[]) => params.hydratedChunk ?? _events,
  );
  const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
    params.pollRoot?.event_id === eventId ? params.pollRoot : null,
  );
  const getRelations = vi.fn(async (_roomId: string, _eventId: string, relType: string) => ({
    events:
      relType === "m.thread"
        ? (params.threadRelations ?? params.pollRelations ?? [])
        : (params.pollRelations ?? []),
    nextBatch: null,
    prevBatch: null,
  }));

  const client = { doRequest, hydrateEvents, getEvent, getRelations, stop: vi.fn() };
  return { ...client, client: client as unknown as MatrixClient };
}

function createEditClient() {
  const sendMessage = vi.fn().mockResolvedValue("evt-edit");
  const client = {
    getEvent: vi.fn().mockResolvedValue({ content: { body: "original" } }),
    getRelations: vi.fn().mockResolvedValue({ events: [], nextBatch: null }),
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    sendMessage,
  } as unknown as MatrixClient;

  return { client, sendMessage };
}

const readHistory = (opts: Parameters<typeof readMatrixMessages>[1]) =>
  readMatrixMessages("room:!room:example.org", opts);
const readThread = (client: MatrixClient, before?: string) =>
  readHistory({ client, threadId: "$thread-root", limit: 1, before });

function threadPage(root = message("$thread-root", "thread root", 10)) {
  return createMessagesClient({
    pollRoot: root,
    threadRelations: [message("$thread-reply", "thread reply", 20, { threadId: "$thread-root" })],
  });
}

function threadRequest(threadId: string, limit: number, from?: string) {
  return [ROOM, threadId, "m.thread", undefined, { dir: "b", from, limit }] as const;
}

describe("matrix message actions", () => {
  it("rejects whitespace-only Matrix edits", async () => {
    await expect(
      editMatrixMessage(ROOM, "$original", "   \n  ", { cfg: MATRIX_ACTION_TEST_CFG }),
    ).rejects.toThrow("Matrix edit requires content");
  });

  it("returns the edit receipt and sends the replacement text", async () => {
    const text = "updated";
    const { client, sendMessage } = createEditClient();
    const result = await editMatrixMessage(ROOM, "$original", text, {
      cfg: MATRIX_ACTION_TEST_CFG,
      client,
    });
    expect(result).toEqual({ eventId: "evt-edit" });
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      ROOM,
      expect.objectContaining({
        "m.new_content": expect.objectContaining({ body: text }),
      }),
    );
  });

  it.each([
    { kind: M_POLL_KIND_DISCLOSED.name, disclosed: true },
    { kind: M_POLL_KIND_UNDISCLOSED.name, disclosed: false },
  ])("preserves $kind results in room and thread history", async ({ kind, disclosed }) => {
    const poll = PollStartEvent.from("Favorite fruit?", ["Apple", "Strawberry"], kind);
    const pollRoot = {
      ...poll.serialize(),
      event_id: "$poll",
      sender: "@alice:example.org",
      origin_server_ts: 1,
    };
    const vote = {
      ...PollResponseEvent.from(
        poll.answers.slice(0, 1).map((answer) => answer.id),
        "$poll",
      ).serialize(),
      event_id: "$vote",
      sender: "@bob:example.org",
      origin_server_ts: 20,
    };
    const { client } = createMessagesClient({
      chunk: [vote],
      pollRoot,
      pollRelations: [vote],
      threadRelations: [],
    });
    for (const threadId of [undefined, "$poll"]) {
      const result = await readHistory({ client, threadId });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.body).toBe(
        disclosed
          ? "[Poll]\nFavorite fruit?\n\n1. Apple (1 vote)\n2. Strawberry (0 votes)\n\nTotal voters: 1"
          : "[Poll]\nFavorite fruit?\n\n1. Apple\n2. Strawberry\n\nResponses are hidden until the poll closes.",
      );
    }
  });

  it("hydrates history before deduping multiple events for the same poll", async () => {
    const encrypted = rawEvent("$enc", "m.room.encrypted", {}, 20, "@bob:example.org");
    const { client } = createMessagesClient({
      chunk: [encrypted],
      hydratedChunk: [createPollResponseEvent(), createPollStartEvent()],
      pollRoot: createPollStartEvent(),
      pollRelations: [],
    });
    const result = await readHistory({ client });
    expect(result.messages).toMatchObject([
      { eventId: "$poll", body: expect.stringContaining("[Poll]") },
    ]);
  });

  const original = message("$original", "original", 10);
  const edit = (
    id: string,
    body: string,
    timestamp = 20,
    opts: Parameters<typeof message>[3] = {},
  ) => message(id, body, timestamp, { replaces: "$original", ...opts });
  const chronological = [original, edit("$old", "intermediate"), edit("$new", "final", 30)];
  const finalMessage = {
    eventId: "$original",
    sender: ALICE,
    body: "final",
    timestamp: 10,
    relatesTo: undefined,
  };
  type HistoryCase = [
    name: string,
    fixture: Parameters<typeof createMessagesClient>[0],
    messages: MatrixMessageSummary[],
    opts?: { after?: string; threadId?: string },
  ];
  it.each<HistoryCase>([
    ["latest backward replacement", { chunk: chronological.toReversed() }, [finalMessage]],
    [
      "latest forward replacement",
      { chunk: chronological },
      [finalMessage],
      { after: "previous-page" },
    ],
    [
      "tie-break and original thread membership",
      {
        chunk: [
          edit("$a", "earlier"),
          edit("$z", "winner", 20, { newThreadId: "$forged-thread" }),
          original,
        ],
      },
      [{ eventId: "$original", body: "winner", relatesTo: undefined }],
    ],
    [
      "malformed and cross-sender replacements",
      {
        chunk: [
          edit("$forged", "forged", 40, { sender: "@mallory:example.org" }),
          edit("$malformed", "malformed", 30, { omitNewContent: true }),
          original,
        ],
      },
      [{ eventId: "$original", body: "original" }],
    ],
    [
      "cross-page replacement",
      { chunk: [edit("$edit", "cross-page")] },
      [
        {
          eventId: "$edit",
          body: "cross-page",
          relatesTo: { relType: "m.replace", eventId: "$original" },
        },
      ],
      { after: "previous-page" },
    ],
    [
      "redacted original",
      {
        chunk: [edit("$edit", "redacted"), { ...original, unsigned: { redacted_because: {} } }],
      },
      [],
    ],
    [
      "bundled replacement on a thread root",
      {
        pollRoot: {
          ...message("$thread-root", "original root", 10),
          unsigned: {
            "m.relations": {
              "m.replace": message("$thread-edit", "edited root", 20, { replaces: "$thread-root" }),
            },
          },
        },
      },
      [{ eventId: "$thread-root", body: "edited root" }],
      { threadId: "$thread-root" },
    ],
    [
      "thread reply excluded from room history",
      {
        chunk: [
          message("$reply", "thread reply", 20, { threadId: "$thread-root" }),
          message("$main", "main room", 10),
        ],
      },
      [{ eventId: "$main" }],
    ],
    [
      "threaded poll excluded from room history",
      {
        chunk: [createPollResponseEvent()],
        pollRoot: createPollStartEvent({}, "$thread-root"),
        pollRelations: [createPollResponseEvent()],
      },
      [],
    ],
    [
      "poll snapshot in thread relations",
      {
        pollRoot: createPollStartEvent({ kind: "m.poll.disclosed", max_selections: 1 }),
        pollRelations: [createPollResponseEvent()],
      },
      [{ body: expect.stringContaining("1. Apple (1 vote)") }],
      { threadId: "$thread-root" },
    ],
    [
      "non-start poll excluded as a thread root",
      {
        pollRoot: createPollResponseEvent(),
        threadRelations: [message("$thread-reply", "thread reply", 20, { threadId: "$vote" })],
      },
      [{ eventId: "$thread-reply" }],
      { threadId: "$vote" },
    ],
  ])("reads %s", async (_name, fixture, messages, opts) => {
    const { client } = createMessagesClient(fixture);
    expect((await readHistory({ client, ...opts, limit: 5 })).messages).toMatchObject(messages);
  });

  it("counts the thread root toward the requested first-page limit", async () => {
    const { client } = threadPage();
    const result = await readThread(client);
    expect(result.messages.map((event) => event.eventId)).toEqual(["$thread-root"]);
    expect(result.nextBatch).toEqual(
      expect.stringContaining("openclaw.matrix.thread-relations-start:"),
    );
    const next = await readThread(client, result.nextBatch ?? undefined);
    expect(next.messages.map((event) => event.eventId)).toEqual(["$thread-reply"]);
  });

  it("forwards a noncanonical synthetic thread cursor as an opaque Matrix token", async () => {
    const firstPage = threadPage();
    const first = await readThread(firstPage.client);
    const cursor = first.nextBatch;
    if (!cursor) {
      throw new Error("Expected a synthetic thread cursor");
    }
    const nonCanonicalCursor = `${cursor}!`;
    const nextPage = createMessagesClient({});
    await readThread(nextPage.client, nonCanonicalCursor);
    expect(nextPage.getRelations).toHaveBeenLastCalledWith(
      ...threadRequest("$thread-root", 1, nonCanonicalCursor),
    );
  });

  it("does not reserve first-page thread capacity for a redacted root", async () => {
    const { client } = threadPage({
      ...message("$thread-root", "", 10),
      unsigned: { redacted_because: {} },
      content: {},
    });
    const result = await readThread(client);
    expect(result.messages.map((event) => event.eventId)).toEqual(["$thread-reply"]);
    expect(result.nextBatch).toBeNull();
  });

  it.each([
    ["room history", undefined, httpError(500, "bad cursor")],
    [
      "thread relations",
      "$thread-root",
      new MatrixError({ errcode: "M_INVALID_PARAM", error: "bad cursor" }, 400),
    ],
  ] as const)(
    "names the cursor contract when the homeserver rejects a %s cursor",
    async (_page, threadId, failure) => {
      const { client, doRequest, getRelations } = createMessagesClient({});
      (threadId ? getRelations : doRequest).mockRejectedValueOnce(failure);

      const error = await readHistory({ client, threadId, after: "$event-id" }).catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("bad cursor");
      expect((error as Error).message).toContain("nextBatch or prevBatch, not an event id");
      expect((error as Error).cause).toBe(failure);
    },
  );

  it("leaves first-page and non-cursor read failures unchanged", async () => {
    const serverError = httpError(500, "boom");
    const firstPage = createMessagesClient({});
    firstPage.doRequest.mockRejectedValueOnce(serverError);
    await expect(readHistory({ client: firstPage.client })).rejects.toBe(serverError);
    const forbidden = httpError(403, "no");
    const pagedRead = createMessagesClient({});
    pagedRead.doRequest.mockRejectedValueOnce(forbidden);
    await expect(readHistory({ client: pagedRead.client, before: "t1" })).rejects.toBe(forbidden);
  });

  it("rejects before and after together instead of paging one token in the other direction", async () => {
    const { client, doRequest, getRelations } = createMessagesClient({});
    await expect(readHistory({ client, before: "t1", after: "t2" })).rejects.toThrow(
      "Matrix read accepts either before or after, not both.",
    );
    expect(doRequest).not.toHaveBeenCalled();
    expect(getRelations).not.toHaveBeenCalled();
  });
});
