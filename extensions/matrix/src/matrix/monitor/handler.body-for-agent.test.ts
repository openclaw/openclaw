import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixClient } from "../sdk.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

describe("createMatrixRoomMessageHandler inbound body formatting", () => {
  const roomId = "!room:example.org";
  function threadReply(quote: string, sender = "@user:example.org") {
    return createMatrixTextMessageEvent({
      eventId: "$reply1",
      sender,
      body: "@room follow up",
      relatesTo: {
        rel_type: "m.thread",
        event_id: "$thread-root",
        "m.in_reply_to": { event_id: quote },
      },
      mentions: { room: true },
    });
  }

  function pollStart(sender: string): MatrixRawEvent {
    return {
      event_id: "$poll",
      sender,
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
    };
  }

  beforeEach(() => {
    installMatrixMonitorTestRuntime({
      matchesMentionPatterns: () => false,
      saveMediaBuffer: vi.fn(),
    });
  });

  it("records formatted poll results for inbound poll response events", async () => {
    const vote = {
      type: "m.poll.response",
      sender: "@user:example.org",
      event_id: "$vote1",
      origin_server_ts: 2,
      content: {
        "m.poll.response": { answers: ["a1"] },
        "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
      },
    } satisfies MatrixRawEvent;
    const f = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () => pollStart("@bot:example.org"),
        getRelations: async () => ({
          events: [vote],
          nextBatch: null,
          prevBatch: null,
        }),
      } as unknown as Partial<MatrixClient>,
      isDirectMessage: true,
      getMemberDisplayName: async (_roomId, userId) =>
        userId === "@bot:example.org" ? "Bot" : "sender",
    });

    await f.handler(roomId, vote);

    const finalized = f.runPrepared.mock.calls.at(-1)![0].ctxPayload;
    expect(finalized.RawBody).toContain("1. Pizza (1 vote)");
    expect(finalized.RawBody).toContain("Total voters: 1");
    expect(vi.mocked(f.recordInboundSession).mock.calls.at(-1)?.[0]).toMatchObject({
      sessionKey: "agent:ops:main",
    });
  });

  it("records reply context for quoted poll start events inside always-threaded replies", async () => {
    const f = createMatrixHandlerTestHarness({
      client: {
        getEvent: async (_roomId: string, eventId: string) => {
          if (eventId === "$thread-root") {
            return createMatrixTextMessageEvent({
              eventId: "$thread-root",
              sender: "@bob:example.org",
              body: "Root topic",
            });
          }

          return pollStart("@alice:example.org");
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

    await f.handler(roomId, threadReply("$poll"));

    const finalized = f.runPrepared.mock.calls.at(-1)![0].ctxPayload;
    expect(finalized.MessageThreadId).toBe("$thread-root");
    expect(finalized.ReplyToId).toBeUndefined();
    expect(finalized.ReplyToSender).toBe("Alice");
    expect(finalized.ReplyToBody).toBe("[Poll]\nLunch?\n\n1. Pizza\n2. Sushi");
    expect(finalized.ThreadStarterBody).toBe(
      "Matrix thread root $thread-root from Bob:\nRoot topic",
    );
  });

  it.each(["allowlist", "allowlist_quote"] as const)(
    "filters disallowed thread context while applying %s quote visibility",
    async (contextVisibility) => {
      const f = createMatrixHandlerTestHarness({
        client: {
          getEvent: async () =>
            createMatrixTextMessageEvent({
              eventId: "$thread-root",
              sender: "@mallory:example.org",
              body: "Malicious root topic",
            }),
        },
        isDirectMessage: false,
        cfg: {
          channels: {
            matrix: {
              contextVisibility,
              groupAllowFrom: ["@alice:example.org"],
            },
          },
        },
        groupPolicy: "allowlist",
        groupAllowFrom: ["@alice:example.org"],
        roomsConfig: { "*": {} },
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@alice:example.org" ? "Alice" : "Mallory",
      });

      await f.handler(roomId, threadReply("$thread-root", "@alice:example.org"));

      const finalized = f.runPrepared.mock.calls.at(-1)![0].ctxPayload;
      expect(finalized.ThreadStarterBody).toBeUndefined();
      expect(finalized.ReplyToBody).toBe(
        contextVisibility === "allowlist_quote" ? "Malicious root topic" : undefined,
      );
      expect(finalized.ReplyToSender).toBe(
        contextVisibility === "allowlist_quote" ? "Mallory" : undefined,
      );
    },
  );
});
