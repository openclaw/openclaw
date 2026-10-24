import type { QaBusInboundMessageInput } from "openclaw/plugin-sdk/qa-channel-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";

describe("qa-bus state", () => {
  it("roundtrips canonical target kinds and rejects non-canonical prefix casing", () => {
    for (const [prefix, kind] of [
      ["dm", "direct"],
      ["channel", "channel"],
      ["group", "group"],
    ] as const) {
      expect(outbound(`${prefix}:CaseSensitive`, prefix).conversation).toEqual({
        id: "CaseSensitive",
        kind,
      });
    }
    const thread = outbound("thread:CaseSensitive/ThreadCase", "thread");
    expect(thread.conversation).toEqual({ id: "CaseSensitive", kind: "channel" });
    expect(thread.threadId).toBe("ThreadCase");
    expect(() =>
      state.addOutboundMessage({ to: "CHANNEL:CaseSensitive", text: "invalid" }),
    ).toThrow("qa-channel target prefixes must be lowercase");
  });

  it("records inbound and outbound traffic in cursor order", () => {
    const received = inbound({});
    const sent = outbound("dm:alice", "hi");
    const snapshot = state.getSnapshot();
    expect(snapshot.cursor).toBe(2);
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "inbound-message",
      "outbound-message",
    ]);
    expect(snapshot.messages.map((message) => message.id)).toEqual([received.id, sent.id]);
  });

  it("records provider-native inbound IDs before indexing and publishing messages", () => {
    const providerMessageId = "$provider-event:matrix.test";

    const received = inbound(
      { conversation: { id: "qa-room", kind: "group" }, text: "provider-native identity" },
      providerMessageId,
    );
    const snapshot = state.getSnapshot();

    expect(received.id).toBe(providerMessageId);
    expect(snapshot.messages[0]?.id).toBe(providerMessageId);
    expect(snapshot.events[0]).toMatchObject({
      kind: "inbound-message",
      message: { id: providerMessageId },
    });
    expect(state.poll().events[0]).toMatchObject({
      kind: "inbound-message",
      message: { id: providerMessageId },
    });
    expect(state.readMessage({ messageId: providerMessageId })).toMatchObject({
      id: providerMessageId,
      text: "provider-native identity",
    });
  });

  let state: ReturnType<typeof createQaBusState>;
  beforeEach(() => {
    state = createQaBusState();
  });
  const inbound = (input: Partial<QaBusInboundMessageInput>, messageId?: string) =>
    state.addInboundMessage(
      {
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text: "hello",
        ...input,
      },
      messageId,
    );
  const outbound = (to: string, text: string, accountId?: string) =>
    state.addOutboundMessage({ to, text, accountId });
  const read = (messageId: string, accountId?: string) =>
    state.readMessage({ messageId, accountId });
  function expectRejectedMutations(
    input: { messageId: string; accountId?: string },
    error: string,
  ) {
    expect(() => state.editMessage({ ...input, text: "forbidden edit" })).toThrow(error);
    expect(() => state.reactToMessage({ ...input, emoji: "eyes" })).toThrow(error);
    expect(() => state.deleteMessage(input)).toThrow(error);
  }

  it("keeps identical provider-native message IDs isolated by account", () => {
    const messageId = "42";

    for (const accountId of ["account-a", "account-b"]) {
      inbound(
        {
          accountId,
          conversation: { id: `${accountId}-room`, kind: "group" },
          text: `${accountId} original`,
        },
        messageId,
      );
    }

    const snapshot = state.getSnapshot();
    expect(snapshot.messages.map((message) => [message.accountId, message.id])).toEqual([
      ["account-a", messageId],
      ["account-b", messageId],
    ]);
    expect(snapshot.events.map((event) => event.accountId)).toEqual(["account-a", "account-b"]);

    for (const accountId of ["account-a", "account-b"]) {
      expect(read(messageId, accountId)).toMatchObject({
        accountId,
        id: messageId,
        text: `${accountId} original`,
      });
      expect(state.searchMessages({ accountId })).toEqual([
        expect.objectContaining({ accountId, id: messageId }),
      ]);
      expect(state.poll({ accountId }).events).toEqual([
        expect.objectContaining({ accountId, message: expect.objectContaining({ id: messageId }) }),
      ]);
    }

    state.editMessage({ accountId: "account-a", messageId, text: "account-a edited" });
    state.reactToMessage({ accountId: "account-b", messageId, emoji: "eyes" });
    expect(read(messageId, "account-a")).toMatchObject({
      text: "account-a edited",
      reactions: [],
    });
    expect(read(messageId, "account-b")).toMatchObject({
      text: "account-b original",
      reactions: [expect.objectContaining({ emoji: "eyes" })],
    });
  });

  it("rejects ambiguous provider-native IDs instead of selecting the wrong conversation", () => {
    const accountId = "account-a";
    const messageId = "42";

    for (const conversationId of ["first-room", "second-room"]) {
      inbound(
        {
          accountId,
          conversation: { id: conversationId, kind: "group" },
          text: `${conversationId} original`,
        },
        messageId,
      );
    }

    const originalSnapshot = state.getSnapshot();
    expect(originalSnapshot.messages.map((message) => message.conversation.id)).toEqual([
      "first-room",
      "second-room",
    ]);
    expect(originalSnapshot.events.map((event) => event.accountId)).toEqual([accountId, accountId]);
    for (const conversationId of ["first-room", "second-room"]) {
      expect(state.searchMessages({ accountId, conversationId })).toEqual([
        expect.objectContaining({
          id: messageId,
          conversation: expect.objectContaining({ id: conversationId }),
        }),
      ]);
    }

    const ambiguousMessage = "qa-bus message id is ambiguous for selected account: 42";
    expect(() => state.readMessage({ accountId, messageId })).toThrow(ambiguousMessage);
    expectRejectedMutations({ accountId, messageId }, ambiguousMessage);
    expect(state.getSnapshot()).toEqual(originalSnapshot);
  });

  it("normalizes the dm ingress alias before channel routing", () => {
    const message = inbound({
      conversation: { id: "alice", kind: "dm" as never },
    });

    expect(message.conversation).toEqual({ id: "alice", kind: "direct" });
    expect(state.getSnapshot().conversations).toEqual([
      expect.objectContaining({ id: "alice", kind: "direct" }),
    ]);
  });

  it("rejects unknown inbound conversation kinds instead of treating them as groups", () => {
    expect(() =>
      inbound({
        conversation: { id: "alice", kind: "private" as never },
      }),
    ).toThrow("invalid qa-channel conversation kind: private");
  });

  it("creates threads and mutates message state", () => {
    const thread = state.createThread({ conversationId: "qa-room", title: "QA thread" });
    const message = state.addOutboundMessage({
      to: `thread:qa-room/${thread.id}`,
      text: "inside thread",
      threadId: thread.id,
    });
    state.reactToMessage({ messageId: message.id, emoji: "eyes", senderId: "alice" });
    state.editMessage({ messageId: message.id, text: "inside thread (edited)" });
    state.deleteMessage({ messageId: message.id });

    const snapshot = state.getSnapshot();
    expect(snapshot.threads).toEqual([
      expect.objectContaining({ id: thread.id, conversationId: "qa-room", title: "QA thread" }),
    ]);
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        id: message.id,
        text: "inside thread (edited)",
        deleted: true,
        reactions: [{ emoji: "eyes", senderId: "alice", timestamp: expect.any(Number) }],
      }),
    ]);
  });

  it("keeps deleted messages inspectable but removes them from mutations and search", () => {
    const live = outbound("channel:qa-room", "needle live");
    const deleted = outbound("channel:qa-room", "needle deleted");

    state.deleteMessage({ messageId: deleted.id });
    const cursorAfterDelete = state.getSnapshot().cursor;

    expect(read(deleted.id).deleted).toBe(true);
    expect(state.getSnapshot().messages.map((message) => message.id)).toEqual([
      live.id,
      deleted.id,
    ]);
    expect(state.searchMessages({ query: "needle", limit: 1 })).toEqual([
      expect.objectContaining({ id: live.id }),
    ]);

    expectRejectedMutations({ messageId: deleted.id }, "qa-bus message was deleted");
    expect(state.getSnapshot().cursor).toBe(cursorAfterDelete);
  });

  it("adds each sender and emoji reaction at most once", () => {
    const message = outbound("channel:qa-room", "react once");

    state.reactToMessage({ messageId: message.id, emoji: "eyes", senderId: " alice " });
    const cursorAfterReaction = state.getSnapshot().cursor;

    const repeated = state.reactToMessage({
      messageId: message.id,
      emoji: "eyes",
      senderId: "alice",
    });
    expect(repeated.reactions).toHaveLength(1);
    expect(state.getSnapshot().cursor).toBe(cursorAfterReaction);

    state.reactToMessage({ messageId: message.id, emoji: "eyes", senderId: "bob" });
    state.reactToMessage({ messageId: message.id, emoji: "wave", senderId: "alice" });
    expect(read(message.id).reactions).toEqual([
      expect.objectContaining({ emoji: "eyes", senderId: "alice" }),
      expect.objectContaining({ emoji: "eyes", senderId: "bob" }),
      expect.objectContaining({ emoji: "wave", senderId: "alice" }),
    ]);
    expect(state.getSnapshot().cursor).toBe(cursorAfterReaction + 2);
  });

  it("keeps owned threads scoped to their account, channel, and conversation", () => {
    const thread = state.createThread({
      accountId: "account-a",
      conversationId: "qa-room",
      title: "Owned thread",
    });
    const originalSnapshot = state.getSnapshot();
    const notOwned = "qa-bus thread not found in selected account and conversation";

    expect(() => outbound(`thread:qa-room/${thread.id}`, "reply", "account-b")).toThrow(notOwned);
    expect(() => outbound(`thread:other-room/${thread.id}`, "reply", "account-a")).toThrow(
      notOwned,
    );
    for (const kind of ["direct", "group"] as const) {
      expect(() =>
        inbound({
          accountId: "account-a",
          conversation: { id: "qa-room", kind },
          threadId: thread.id,
        }),
      ).toThrow(notOwned);
    }
    expect(state.getSnapshot()).toEqual(originalSnapshot);

    const reply = outbound(`thread:qa-room/${thread.id}`, "owned reply", "account-a");
    const external = outbound("thread:other-room/external-thread", "reply", "account-b");
    expect(reply.threadId).toBe(thread.id);
    expect(external.threadId).toBe("external-thread");
  });

  it("rejects cross-account message reads and mutations", () => {
    const message = outbound("channel:qa-room", "account-owned", "account-a");
    const foreign = { accountId: "account-b", messageId: message.id };
    expect(() => state.readMessage(foreign)).toThrow("qa-bus message not found");
    expectRejectedMutations(foreign, "qa-bus message not found");

    const unchanged = read(message.id, "account-a");
    expect(unchanged).toMatchObject({ text: "account-owned", reactions: [] });
    expect(unchanged.deleted).not.toBe(true);
  });

  it("keeps message conversation identity isolated by account and kind", () => {
    const conversationA = { id: "shared", kind: "direct" as const, title: "Direct A" };
    const conversationB = { ...conversationA, title: "Direct B" };
    const directA = inbound({ accountId: "account-a", conversation: conversationA });
    const channelA = outbound("channel:shared", "channel a", "account-a");
    const directB = inbound({ accountId: "account-b", conversation: conversationB });
    expect(read(directA.id, "account-a").conversation).toEqual(conversationA);
    expect(read(channelA.id, "account-a").conversation).toEqual({ id: "shared", kind: "channel" });
    expect(read(directB.id, "account-b").conversation).toEqual(conversationB);
    expect(state.getSnapshot().conversations).toEqual(
      expect.arrayContaining([
        { accountId: "account-a", ...conversationA },
        { accountId: "account-a", id: "shared", kind: "channel" },
        { accountId: "account-b", ...conversationB },
      ]),
    );
  });

  it("applies kind and root-thread search scope before limiting results", () => {
    const root = outbound("channel:shared", "needle root");
    const direct = outbound("dm:shared", "needle direct");
    for (let index = 0; index < 25; index += 1) {
      outbound(`thread:shared/thread-${index}`, `needle thread ${index}`);
    }

    for (const [conversationKind, id] of [
      ["channel", root.id],
      ["direct", direct.id],
    ] as const) {
      expect(
        state
          .searchMessages({
            query: "needle",
            conversationId: "shared",
            conversationKind,
            threadId: null,
            limit: 2,
          })
          .map((message) => message.id),
      ).toEqual([id]);
    }
    expect(state.searchMessages({ conversationId: "", limit: 2 })).toEqual([]);
  });

  it("waits for a text match and rejects on timeout", async () => {
    const pending = state.waitFor({
      kind: "message-text",
      textIncludes: "needle",
      timeoutMs: 500,
    });

    setTimeout(() => {
      outbound("dm:alice", "haystack + needle");
    }, 20);

    const matched = await pending;
    expect("text" in matched && matched.text).toContain("needle");

    await expect(
      state.waitFor({
        kind: "message-text",
        textIncludes: "missing",
        timeoutMs: 20,
      }),
    ).rejects.toThrow("qa-bus wait timeout");
  });

  it("ignores deleted message matches until a visible replacement arrives", async () => {
    const marker = "QA-VISIBLE-REPLACEMENT";
    const wait = (timeoutMs: number) =>
      state.waitFor({
        direction: "outbound",
        kind: "message-text",
        textIncludes: marker,
        timeoutMs,
      });
    const deleted = outbound("dm:alice", marker);
    state.deleteMessage({ messageId: deleted.id });

    await expect(wait(10)).rejects.toThrow("qa-bus wait timeout after 10ms");
    const pending = wait(100);
    const replacement = outbound("dm:alice", marker);

    await expect(pending).resolves.toMatchObject({ id: replacement.id, direction: "outbound" });
  });

  it("keeps account-scoped cursor waits blocked on unrelated account traffic", async () => {
    const pending = state.waitForCursorAdvance(0, 500, (snapshot) => {
      return snapshot.events.some((event) => event.accountId === "acct-a" && event.cursor > 0);
    });

    inbound({ accountId: "acct-b" });

    const beforeMatch = await Promise.race([
      pending.then(() => "resolved"),
      new Promise((resolve) => {
        setTimeout(() => resolve("still-waiting"), 20);
      }),
    ]);
    expect(beforeMatch).toBe("still-waiting");

    inbound({ accountId: "acct-a" });

    await expect(pending).resolves.toBeUndefined();
  });

  it("wakes default-account cursor waits when accountId is omitted", async () => {
    const pending = state.waitForCursorAdvance(0, 500, (snapshot) => {
      return snapshot.events.some((event) => event.accountId === "default" && event.cursor > 0);
    });

    inbound({
      conversation: { id: "target", kind: "direct" },
      senderId: "default-user",
      text: "matched",
    });

    await expect(pending).resolves.toBeUndefined();
  });

  it("preserves inline attachments and lets search match attachment metadata", () => {
    const attachment = {
      id: "image-1",
      kind: "image" as const,
      mimeType: "image/png",
      fileName: "qa-screenshot.png",
      altText: "QA dashboard screenshot",
      contentBase64: "aGVsbG8=",
    };
    const message = state.addOutboundMessage({
      to: "dm:alice",
      text: "artifact attached",
      attachments: [attachment],
    });

    expect(read(message.id).attachments).toEqual([attachment]);
    for (const query of ["screenshot", "dashboard"]) {
      expect(state.searchMessages({ query }).map((entry) => entry.id)).toContain(message.id);
    }
  });

  it("preserves tool-call argument text and returns isolated copies", () => {
    const args = { command: "pwd", apiToken: "secret-token" };
    const message = state.addOutboundMessage({
      to: "dm:alice",
      text: "used a tool",
      toolCalls: [{ name: " exec ", arguments: { ...args, omitted: undefined } }],
    });

    const readback = read(message.id);
    // Payload text stays intact; secret masking belongs to diagnostic output.
    expect(readback.toolCalls).toEqual([{ name: "exec", arguments: args }]);
    expect(state.searchMessages({ query: "exec" }).map((entry) => entry.id)).toContain(message.id);

    const readbackArguments = readback.toolCalls?.[0]?.arguments;
    if (!readbackArguments) {
      throw new Error("expected tool-call arguments");
    }
    readbackArguments.command = "mutated";
    expect(read(message.id).toolCalls?.[0]?.arguments?.command).toBe("pwd");
  });
});
