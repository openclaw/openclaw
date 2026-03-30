import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixClient } from "../sdk.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

describe("createMatrixRoomMessageHandler inbound body formatting", () => {
  beforeEach(() => {
    installMatrixMonitorTestRuntime({
      matchesMentionPatterns: () => false,
      saveMediaBuffer: vi.fn(),
    });
  });

  it("records thread metadata for group thread messages", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        client: {
          getEvent: async () =>
            createMatrixTextMessageEvent({
              eventId: "$thread-root",
              sender: "@alice:example.org",
              body: "Root topic",
            }),
        },
        isDirectMessage: false,
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@alice:example.org" ? "Alice" : "sender",
      });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$reply1",
        body: "@room follow up",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$thread-root",
          "m.in_reply_to": { event_id: "$thread-root" },
        },
        mentions: { room: true },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$thread-root",
        ThreadStarterBody: "Matrix thread root $thread-root from Alice:\nRoot topic",
      }),
    );
    // Thread messages get thread-scoped session keys (thread isolation feature).
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main:thread:$thread-root",
      }),
    );
  });

  it("records formatted poll results for inbound poll response events", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        client: {
          getEvent: async () => ({
            event_id: "$poll",
            sender: "@bot:example.org",
            type: "m.poll.start",
            origin_server_ts: 1,
            content: {
              "m.poll.start": {
                question: { "m.text": "Lunch?" },
                kind: "m.poll.disclosed",
                max_selections: 1,
                answers: [
                  { id: "a1", "m.text": "Pizza" },
                  { id: "a2", "m.text": "Sushi" },
                ],
              },
            },
          }),
          getRelations: async () => ({
            events: [
              {
                type: "m.poll.response",
                event_id: "$vote1",
                sender: "@user:example.org",
                origin_server_ts: 2,
                content: {
                  "m.poll.response": { answers: ["a1"] },
                  "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
                },
              },
            ],
            nextBatch: null,
            prevBatch: null,
          }),
        } as unknown as Partial<MatrixClient>,
        isDirectMessage: true,
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@bot:example.org" ? "Bot" : "sender",
      });

    await handler("!room:example.org", {
      type: "m.poll.response",
      sender: "@user:example.org",
      event_id: "$vote1",
      origin_server_ts: 2,
      content: {
        "m.poll.response": { answers: ["a1"] },
        "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
      },
    } as MatrixRawEvent);

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: expect.stringMatching(/1\. Pizza \(1 vote\)[\s\S]*Total voters: 1/),
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main",
      }),
    );
  });

  it("records reply context for quoted poll start events inside always-threaded replies", async () => {
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async (_roomId: string, eventId: string) => {
          if (eventId === "$thread-root") {
            return createMatrixTextMessageEvent({
              eventId: "$thread-root",
              sender: "@bob:example.org",
              body: "Root topic",
            });
          }

          return {
            event_id: "$poll",
            sender: "@alice:example.org",
            type: "m.poll.start",
            origin_server_ts: 1,
            content: {
              "m.poll.start": {
                question: { "m.text": "Lunch?" },
                kind: "m.poll.disclosed",
                max_selections: 1,
                answers: [
                  { id: "a1", "m.text": "Pizza" },
                  { id: "a2", "m.text": "Sushi" },
                ],
              },
            },
          } satisfies MatrixRawEvent;
        },
      } as unknown as Partial<MatrixClient>,
      isDirectMessage: false,
      threadReplies: "always",
      getMemberDisplayName: async (_roomId, userId) => {
        if (userId === "@alice:example.org") {
          return "Alice";
        }
        if (userId === "@bob:example.org") {
          return "Bob";
        }
        return "sender";
      },
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$reply1",
        body: "@room follow up",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$thread-root",
          "m.in_reply_to": { event_id: "$poll" },
        },
        mentions: { room: true },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$thread-root",
        ReplyToId: undefined,
        ReplyToSender: "Alice",
        ReplyToBody: "[Poll]\nLunch?\n\n1. Pizza\n2. Sushi",
        ThreadStarterBody: "Matrix thread root $thread-root from Bob:\nRoot topic",
      }),
    );
  });

  it("reuses the fetched thread root when reply context points at the same event", async () => {
    const getEvent = vi.fn(async () =>
      createMatrixTextMessageEvent({
        eventId: "$thread-root",
        sender: "@alice:example.org",
        body: "Root topic",
      }),
    );
    const getMemberDisplayName = vi.fn(async (_roomId: string, userId: string) =>
      userId === "@alice:example.org" ? "Alice" : "sender",
    );
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      client: { getEvent },
      isDirectMessage: false,
      threadReplies: "always",
      getMemberDisplayName,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$reply1",
        body: "@room follow up",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$thread-root",
          "m.in_reply_to": { event_id: "$thread-root" },
        },
        mentions: { room: true },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$thread-root",
        ReplyToId: undefined,
        ReplyToSender: "Alice",
        ReplyToBody: "Root topic",
        ThreadStarterBody: "Matrix thread root $thread-root from Alice:\nRoot topic",
      }),
    );
    expect(getEvent).toHaveBeenCalledTimes(1);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(2);
  });
});
