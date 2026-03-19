import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

describe("createMatrixRoomMessageHandler inbound body formatting", () => {
  beforeEach(() => {
    setMatrixRuntime({
      channel: {
        mentions: {
          matchesMentionPatterns: () => false,
        },
        media: {
          saveMediaBuffer: vi.fn(),
        },
      },
      config: {
        loadConfig: () => ({}),
      },
      state: {
        resolveStateDir: () => "/tmp",
      },
    } as never);
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
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main",
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
});
