import { describe, expect, it } from "vitest";
import { buzzSetupPlugin } from "../setup-plugin-api.js";
import { buzzPlugin } from "./channel.js";
import { buildBuzzMessageTags } from "./message-event.js";

describe("Buzz channel guidance", () => {
  it.each([
    ["runtime", buzzPlugin],
    ["setup", buzzSetupPlugin],
  ] as const)("%s opts into isolated named-account reloads", (_surface, plugin) => {
    expect(plugin.reload).toEqual({
      configPrefixes: ["channels.buzz"],
      accountScopedRestart: true,
    });
  });

  it.each([
    {
      label: "automatic off",
      replyDelivery: { replyToMode: "off" as const },
      explicit: false,
      expected: { threadId: null, replyToId: null },
    },
    {
      label: "automatic all",
      replyDelivery: { replyToMode: "all" as const },
      explicit: false,
      expected: { threadId: "thread-root", replyToId: "thread-root" },
    },
    {
      label: "implicit message tool",
      replyDelivery: undefined,
      explicit: false,
      expected: { threadId: "thread-root", replyToId: "thread-root" },
    },
    {
      label: "explicit child",
      replyDelivery: undefined,
      explicit: true,
      expected: { threadId: "thread-root", replyToId: "requested-parent" },
    },
  ])("routes $label replies at the intended depth", ({ replyDelivery, explicit, expected }) => {
    const original = { threadId: "thread-root", replyToId: "requested-parent" };
    const transport =
      buzzPlugin.threading?.resolveReplyTransport?.({
        cfg: {},
        ...original,
        replyToIsExplicit: explicit,
        replyDelivery,
      }) ?? original;
    expect(transport).toEqual(expected);
  });

  it("inherits the room thread root for an implicit mid-thread message-tool reply", () => {
    const threading = buzzPlugin.threading;
    if (!threading?.buildToolContext || !threading.resolveAutoThreadId) {
      throw new Error("expected Buzz threading adapter");
    }
    const roomId = "64f4debf-e7af-438c-8dcd-d6fbbe77405d";
    const otherRoomId = "48f551a5-7598-4d6e-a40c-f2219e0aa397";
    const rootId = "thread-root";
    const messageId = "child-message";
    const toolContext = threading.buildToolContext({
      cfg: {},
      accountId: "default",
      context: {
        Channel: "buzz",
        To: `buzz:${roomId}`,
        ChatType: "group",
        CurrentMessageId: messageId,
        MessageThreadId: rootId,
        ReplyToMode: "all",
      },
    });

    expect(toolContext).toMatchObject({
      currentChannelId: `buzz:${roomId}`,
      currentMessagingTarget: `buzz:${roomId}`,
      currentMessageId: messageId,
      currentThreadTs: rootId,
      replyToMode: "all",
    });
    expect(
      threading.resolveAutoThreadId({
        cfg: {},
        accountId: "default",
        to: roomId.toUpperCase(),
        toolContext,
        replyToId: messageId,
      }),
    ).toBe(rootId);
    expect(
      threading.resolveAutoThreadId({
        cfg: {},
        accountId: "default",
        to: `buzz:${otherRoomId}`,
        toolContext,
        replyToId: messageId,
      }),
    ).toBeUndefined();

    const transport = threading.resolveReplyTransport?.({
      cfg: {},
      accountId: "default",
      threadId: rootId,
      replyToId: messageId,
      replyToIsExplicit: false,
    });
    expect(transport).toEqual({ threadId: rootId, replyToId: rootId });
    expect(
      buildBuzzMessageTags({
        channelId: roomId,
        threadId: String(transport?.threadId),
        replyToId: transport?.replyToId ?? undefined,
      }),
    ).toEqual([
      ["h", roomId],
      ["e", rootId, "", "reply"],
    ]);
  });

  it("advertises directory room targets and native mention syntax", () => {
    const hints = buzzPlugin.agentPrompt?.messageToolHints?.({} as never) ?? [];

    expect(hints).toContain(
      "- Buzz targets: use a configured room UUID, `buzz:<ROOM_UUID>`, or a unique current room name. Use the UUID when room names are ambiguous.",
    );
    expect(hints).toContain(
      "- Buzz mentions: write a unique current room member as `@Display Name`. For an explicit identity, include `nostr:npub...`; the public key must belong to the target room. Any unresolved or ambiguous label needs an explicit identity for every intended member.",
    );
    expect(buzzPlugin.messaging?.targetResolver?.hint).toBe("<room UUID|configured room name>");
  });

  it("resolves Buzz reply sessions without treating the thread as part of the room UUID", () => {
    const roomId = "64f4debf-e7af-438c-8dcd-d6fbbe77405d";
    const threadId = "584e8d00bab48310ea80ff5f62550f824242bbc333fc4c259d7ae80be025c8aa";

    expect(
      buzzPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: `buzz:${roomId}:thread:${threadId}`,
      }),
    ).toEqual({
      id: roomId,
      threadId,
      baseConversationId: roomId,
      parentConversationCandidates: [roomId],
    });
  });
});
