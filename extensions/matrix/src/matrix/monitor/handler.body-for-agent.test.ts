import { matchesMentionPatterns } from "openclaw/plugin-sdk/channel-inbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixClient } from "../sdk.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixTextMessageEvent as textMessage,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

describe("createMatrixRoomMessageHandler inbound body formatting", () => {
  const roomId = "!room:example.org";
  const names: Record<string, string> = {
    "@bot:example.org": "Bot",
    "@alice:example.org": "Alice",
    "@bob:example.org": "Bob",
    "@mallory:example.org": "Mallory",
  };
  async function receive(event: MatrixRawEvent, options: Parameters<typeof createHarness>[0] = {}) {
    const harness = createHarness({
      getMemberDisplayName: async (_room, user) => names[user] ?? "sender",
      ...options,
    });
    await harness.handler(roomId, event);
    return {
      ctx: harness.runPrepared.mock.calls.at(-1)![0].ctxPayload,
      record: harness.recordInboundSession,
    };
  }
  const root = (sender: string, body: string) =>
    textMessage({ eventId: "$thread-root", sender, body });
  const threadReply = (quote: string, sender = "@user:example.org") =>
    textMessage({
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

  const pollStart = (sender: string): MatrixRawEvent => ({
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
  });

  beforeEach(() => {
    installMatrixMonitorTestRuntime({
      matchesMentionPatterns,
      saveMediaBuffer: vi.fn(),
    });
  });

  it.each([
    { name: "quoted HTML link", body: "Solved.", html: "Solved.", admitted: false },
    {
      name: "quoted plain mention",
      body: "Solved.",
      html: "Solved.",
      quote: "Claw help?",
      plain: true,
      admitted: false,
    },
    {
      name: "quoted room mention",
      body: "Solved.",
      html: "Solved.",
      quote: "@room help?",
      plain: true,
      admitted: false,
    },
    {
      name: "fresh HTML link",
      body: "Bot, solved.",
      html: '<a href="https://matrix.to/#/@bot:example.org">Bot</a>, solved.',
      admitted: true,
    },
    {
      name: "fresh native mention",
      body: "@bot:example.org solved.",
      html: "Solved.",
      mentions: { user_ids: ["@bot:example.org"] },
      admitted: true,
    },
    { name: "fresh plain mention", body: "Claw solved.", html: "Solved.", admitted: true },
    {
      name: "fresh room mention",
      body: "@room solved.",
      html: "@room solved.",
      mentions: { room: true },
      admitted: true,
    },
    {
      name: "authored blockquote after fallback",
      body: "> Claw solved.\n\nAgreed.",
      html: "<blockquote>Claw solved.</blockquote>Agreed.",
      admitted: true,
    },
  ])(
    "uses only current reply content for $name",
    async ({ body, html, mentions, admitted, quote, plain }) => {
      const harness = createHarness({
        isDirectMessage: false,
        roomsConfig: { "*": { requireMention: true } },
        mentionRegexes: body.includes("Claw") || quote?.includes("Claw") ? [/\bClaw\b/i] : [],
        getMemberDisplayName: async (_room, user) => names[user] ?? user,
        client: {
          getEvent: async () =>
            textMessage({
              eventId: "$alice",
              sender: "@alice:example.org",
              body: "Hydrated original",
            }),
        },
        historyLimit: 5,
      });
      const event = textMessage({
        eventId: "$bob",
        sender: "@bob:example.org",
        body: `> <@alice:example.org> ${quote ?? "Bot help?"}\n> More old text\n\n${body}`,
        relatesTo: { "m.in_reply_to": { event_id: "$alice" } },
        mentions: mentions ?? { user_ids: [] },
      });
      if (!plain) {
        Object.assign(event.content, {
          format: "org.matrix.custom.html",
          formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/@bot:example.org">Bot</a> help?</blockquote></mx-reply>${html}`,
        });
      }
      const original = structuredClone(event);
      await harness.handler(roomId, event);
      expect(harness.runPrepared.mock.calls.map(([turn]) => turn.ctxPayload.RawBody)).toEqual(
        admitted ? [body] : [],
      );
      if (admitted) {
        expect(harness.runPrepared.mock.calls[0]![0].ctxPayload).toMatchObject({
          BodyForAgent: body,
          ReplyToBody: "Hydrated original",
          ReplyToSender: "Alice",
        });
      } else {
        await harness.handler(
          roomId,
          textMessage({ eventId: "$trigger", body: "@room next", mentions: { room: true } }),
        );
        expect(harness.runPrepared.mock.calls[0]![0].ctxPayload.InboundHistory).toEqual([
          expect.objectContaining({ body: "Solved." }),
        ]);
      }
      expect(event).toEqual(original);
    },
  );

  it.each([false, true])(
    "keeps an authored blockquote without fallback (reply=%s)",
    async (reply) => {
      const { ctx } = await receive(
        textMessage({
          eventId: "$blockquote",
          body: "> Claw says hello\n\nAgreed.",
          relatesTo: reply ? { "m.in_reply_to": { event_id: "$alice" } } : undefined,
        }),
        {
          isDirectMessage: false,
          roomsConfig: { "*": { requireMention: true } },
          mentionRegexes: [/Claw/i],
          client: {
            getEvent: async () =>
              textMessage({ eventId: "$alice", sender: "@alice:example.org", body: "Original" }),
          },
        },
      );
      expect(ctx.BodyForAgent).toBe("> Claw says hello\n\nAgreed.");
    },
  );

  it("keeps inbound content in the agent context, not verbose diagnostics", async () => {
    const diagnostics: string[] = [];
    const body = "private-matrix-message-contents";
    const { ctx } = await receive(textMessage({ eventId: "$private", body }), {
      logVerboseMessage: (line) => diagnostics.push(line),
    });
    expect(ctx.BodyForAgent).toBe(body);
    expect(diagnostics.join("\n")).toContain(`matrix inbound: room=${roomId}`);
    expect(diagnostics.join("\n")).not.toContain(body);
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
    const { ctx, record } = await receive(vote, {
      client: {
        getEvent: async () => pollStart("@bot:example.org"),
        getRelations: async () => ({ events: [vote], nextBatch: null, prevBatch: null }),
      } as unknown as Partial<MatrixClient>,
    });
    expect(ctx.RawBody).toContain("1. Pizza (1 vote)");
    expect(ctx.RawBody).toContain("Total voters: 1");
    expect(vi.mocked(record).mock.calls.at(-1)?.[0]).toMatchObject({
      sessionKey: "agent:ops:main",
    });
  });

  it("records reply context for quoted poll start events inside always-threaded replies", async () => {
    const { ctx } = await receive(threadReply("$poll"), {
      client: {
        getEvent: async (_roomId: string, eventId: string) =>
          eventId === "$thread-root"
            ? root("@bob:example.org", "Root topic")
            : pollStart("@alice:example.org"),
      } as unknown as Partial<MatrixClient>,
      isDirectMessage: false,
      threadReplies: "always",
    });
    expect(ctx).toMatchObject({
      MessageThreadId: "$thread-root",
      ReplyToSender: "Alice",
      ReplyToBody: "[Poll]\nLunch?\n\n1. Pizza\n2. Sushi",
      ThreadStarterBody: "Matrix thread root $thread-root from Bob:\nRoot topic",
    });
    expect(ctx.ReplyToId).toBeUndefined();
  });

  it.each(["allowlist", "allowlist_quote"] as const)(
    "filters disallowed thread context while applying %s quote visibility",
    async (contextVisibility) => {
      const { ctx } = await receive(threadReply("$thread-root", "@alice:example.org"), {
        client: {
          getEvent: async () => root("@mallory:example.org", "Malicious root topic"),
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
      });
      expect(ctx.ThreadStarterBody).toBeUndefined();
      expect(ctx.ReplyToBody).toBe(
        contextVisibility === "allowlist_quote" ? "Malicious root topic" : undefined,
      );
      expect(ctx.ReplyToSender).toBe(
        contextVisibility === "allowlist_quote" ? "Mallory" : undefined,
      );
    },
  );
});
