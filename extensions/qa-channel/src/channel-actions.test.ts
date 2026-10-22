import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { extractToolPayload } from "openclaw/plugin-sdk/tool-payload";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { qaChannelPlugin } from "../api.js";
import type { QaBusThread } from "./bus-client.js";

type ThreadResult = { thread: QaBusThread; target: string; threadId: string };

let state: ReturnType<typeof createQaBusState>;
let bus: Awaited<ReturnType<typeof startQaBusServer>>;
let cfg: ReturnType<typeof config>;

function config(baseUrl: string) {
  return {
    channels: {
      "qa-channel": {
        baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        accounts: { other: { baseUrl } },
      },
    },
  };
}

beforeEach(async () => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
  state = createQaBusState();
  bus = await startQaBusServer({ state });
  cfg = config(bus.baseUrl);
});
afterEach(async () => {
  try {
    await bus?.stop();
  } finally {
    resetPluginRuntimeStateForTest();
  }
});

async function act(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  accountId = "default",
) {
  const handleAction = qaChannelPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("expected qa-channel action handler");
  }
  return extractToolPayload(
    await handleAction({ channel: "qa-channel", action, cfg, accountId, params }),
  );
}

async function createThread(params: Record<string, unknown>) {
  return (await act("thread-create", params)) as ThreadResult;
}

function boundThread(thread: ThreadResult) {
  return { target: thread.target, threadId: thread.threadId };
}

function search(params: Record<string, unknown>, accountId = "default") {
  return act("search", { query: "needle", ...params }, accountId).then((payload) =>
    (payload as { messages: Array<{ id: string }> }).messages.map((message) => message.id),
  );
}

describe("qa-channel direct message actions", () => {
  it("describes the legacy title alias", () => {
    const schema = qaChannelPlugin.actions?.describeMessageTool?.({
      cfg,
      accountId: "default",
    })?.schema;
    const contributions = Array.isArray(schema) ? schema : schema ? [schema] : [];
    expect(
      contributions.find((entry) => "title" in entry.properties)?.properties.title,
    ).toMatchObject({
      description: "Deprecated alias for threadName.",
    });
  });

  it("prefers canonical targets over conflicting direct-adapter aliases", async () => {
    const threadPayload = await createThread({
      target: "channel:canonical/room",
      to: "channel:legacy-to-room",
      channelId: "legacy-channel-id-room",
      threadName: "Canonical target thread",
      title: "ignored legacy title",
    });

    expect(threadPayload).toMatchObject({
      thread: {
        id: expect.stringMatching(/^thread-/),
        conversationId: "canonical/room",
        title: "Canonical target thread",
      },
      target: "channel:canonical/room",
      threadId: threadPayload.thread.id,
    });

    const replyResult = await act("thread-reply", {
      ...boundThread(threadPayload),
      channelId: "legacy-reply-room",
      message: "canonical target reply",
      text: "ignored legacy reply",
    });
    expect(replyResult).toMatchObject({
      message: {
        conversation: { id: "canonical/room", kind: "channel" },
        text: "canonical target reply",
        threadId: threadPayload.thread.id,
      },
    });
  });

  it("preserves versioned direct and escaped group targets through message actions", async () => {
    const cases = [
      {
        target: "thread:/v1/dm/Alice/Topic",
        conversation: { id: "Alice", kind: "direct" },
        threadId: "Topic",
      },
      {
        target: "thread:/v1/group/Room%2FOne/Topic%2FTwo",
        conversation: { id: "Room/One", kind: "group" },
        threadId: "Topic/Two",
      },
    ] as const;

    for (const testCase of cases) {
      const result = await act("send", {
        target: testCase.target,
        message: "versioned target",
      });
      expect(result).toMatchObject({
        message: {
          conversation: testCase.conversation,
          text: "versioned target",
          threadId: testCase.threadId,
        },
      });
    }
  });

  it.each([
    [{ text: "legacy edit" }, "legacy edit"],
    [{ text: "ignored legacy edit", message: "canonical edit" }, "canonical edit"],
  ] as const)(
    "keeps direct API aliases and prefers canonical edit fields: %j",
    async (edit, text) => {
      const threadPayload = await createThread({
        channelId: "qa-room",
        title: "Legacy thread",
      });
      expect(threadPayload.thread.title).toBe("Legacy thread");

      const replyResult = await act("thread-reply", {
        channelId: "qa-room",
        threadId: threadPayload.thread.id,
        text: "legacy reply",
      });
      expect(replyResult).toMatchObject({
        message: {
          text: "legacy reply",
          threadId: threadPayload.thread.id,
        },
      });

      const outbound = state.addOutboundMessage({
        to: threadPayload.target,
        text: "before legacy edit",
        threadId: threadPayload.thread.id,
      });
      const editResult = await act("edit", {
        to: threadPayload.target,
        threadId: threadPayload.threadId,
        messageId: outbound.id,
        ...edit,
      });
      expect(editResult).toMatchObject({
        message: { text },
      });
      expect(state.readMessage({ messageId: outbound.id }).text).toBe(text);
      expect(
        await act("read", {
          to: threadPayload.target,
          threadId: threadPayload.threadId,
          messageId: outbound.id,
        }),
      ).toMatchObject({ message: { text } });
      expect(
        await search({ query: "edit", channelId: "qa-room", threadId: threadPayload.threadId }),
      ).toContain(outbound.id);
    },
  );
  it("keeps deleted messages out of channel actions and makes reactions idempotent", async () => {
    const live = state.addOutboundMessage({ to: "channel:qa-room", text: "needle live" });
    const deleted = state.addOutboundMessage({ to: "channel:qa-room", text: "needle deleted" });
    const reactionParams = {
      to: "channel:qa-room",
      messageId: deleted.id,
      emoji: "eyes",
    };

    await act("react", reactionParams);
    const cursorAfterReaction = state.getSnapshot().cursor;
    await act("react", reactionParams);
    expect(state.getSnapshot().cursor).toBe(cursorAfterReaction);
    expect(state.readMessage({ messageId: deleted.id }).reactions).toHaveLength(1);

    await act("delete", { to: "channel:qa-room", messageId: deleted.id });

    for (const action of ["read", "reactions", "react", "edit", "delete"] as const) {
      await expect(
        act(action, {
          to: "channel:qa-room",
          messageId: deleted.id,
          ...(action === "react" ? { emoji: "eyes" } : {}),
          ...(action === "edit" ? { text: "edited after deletion" } : {}),
        }),
      ).rejects.toThrow("qa-channel message was deleted");
    }

    expect(await search({ channelId: "qa-room" })).toEqual([live.id]);
    expect(state.readMessage({ messageId: deleted.id }).deleted).toBe(true);
  });

  it("rejects thread replies outside the owning account and conversation", async () => {
    const thread = state.createThread({ conversationId: "qa-room", title: "Owned thread" });

    for (const attempt of [
      { accountId: "other", channelId: "qa-room" },
      { accountId: "default", channelId: "other-room" },
    ]) {
      await expect(
        act(
          "thread-reply",
          {
            channelId: attempt.channelId,
            threadId: thread.id,
            text: "foreign reply",
          },
          attempt.accountId,
        ),
      ).rejects.toThrow("qa-bus thread not found in selected account and conversation");
    }
    expect(state.getSnapshot().messages).toEqual([]);
    expect(state.getSnapshot().conversations).toEqual([
      { accountId: "default", id: "qa-room", kind: "channel" },
    ]);

    const result = await act("thread-reply", {
      to: "channel:qa-room",
      threadId: thread.id,
      message: "owned reply",
    });
    const payload = result as {
      message: { id: string; threadId: string };
      receipt: {
        primaryPlatformMessageId?: string;
        threadId?: string;
        parts: Array<{ threadId?: string }>;
      };
    };
    expect(payload.message.threadId).toBe(thread.id);
    expect(payload.receipt).toMatchObject({
      primaryPlatformMessageId: payload.message.id,
      threadId: thread.id,
      parts: [{ threadId: thread.id }],
    });
  });

  it("binds message-id actions and searches to the selected account and conversation", async () => {
    const addMessage = (
      to: string,
      text: string,
      extra: Partial<Parameters<typeof state.addOutboundMessage>[0]> = {},
    ) => state.addOutboundMessage({ accountId: "default", to, text, ...extra });
    const allowedRoot = addMessage("channel:allowed", "needle allowed root");
    const foreignRoot = addMessage("channel:other", "needle foreign root");
    const allowedThread = addMessage("thread:allowed/thread-1", "needle allowed thread", {
      threadId: "thread-1",
    });
    const foreignAccount = addMessage("channel:allowed", "needle foreign account", {
      accountId: "other",
    });

    const crossedActions: Array<{
      action: ChannelMessageActionName;
      params: Record<string, unknown>;
    }> = [
      { action: "read", params: {} },
      { action: "reactions", params: {} },
      { action: "react", params: { emoji: "eyes" } },
      { action: "edit", params: { message: "foreign edit" } },
      { action: "delete", params: {} },
    ];
    for (const testCase of crossedActions) {
      await expect(
        act(testCase.action, {
          to: "channel:allowed",
          messageId: foreignRoot.id,
          ...testCase.params,
        }),
      ).rejects.toThrow("qa-channel message is not in the selected conversation");
    }

    await expect(
      act("read", { to: "channel:allowed", messageId: allowedRoot.id }, "other"),
    ).rejects.toThrow("qa-bus message not found");
    for (const [to, messageId] of [
      ["dm:allowed", allowedRoot.id],
      ["channel:allowed", allowedThread.id],
      ["thread:allowed/thread-2", allowedThread.id],
    ]) {
      await expect(act("read", { to, messageId })).rejects.toThrow(
        "qa-channel message is not in the selected conversation",
      );
    }

    await expect(
      act("read", { to: "thread:allowed/thread-1", messageId: allowedThread.id }),
    ).resolves.toBeDefined();

    await expect(search({ channelId: "allowed" })).resolves.toEqual([allowedRoot.id]);
    await expect(search({ channelId: "CHANNEL:allowed" })).rejects.toThrow(
      "qa-channel target prefixes must be lowercase",
    );
    await expect(search({ channelId: "thread:allowed/thread-1" })).resolves.toEqual([
      allowedThread.id,
    ]);
    await expect(search({ channelId: "dm:allowed" })).resolves.toEqual([]);
    await expect(search({ channelId: "allowed" }, "other")).resolves.toEqual([foreignAccount.id]);
    await expect(search({})).resolves.toEqual([allowedRoot.id, foreignRoot.id, allowedThread.id]);
    await expect(search({ threadId: "thread-1" })).rejects.toThrow(
      "qa-channel search requires channelId when threadId is provided",
    );
    await expect(search({ channelId: "channel:" })).rejects.toThrow(
      "invalid qa-channel channel target",
    );

    const unchanged = state.readMessage({ accountId: "default", messageId: foreignRoot.id });
    expect(unchanged.text).toBe("needle foreign root");
    expect(unchanged.deleted).not.toBe(true);
    expect(unchanged.reactions).toEqual([]);
  });

  it("routes the advertised send action to the qa bus", async () => {
    expect(
      qaChannelPlugin.actions?.extractToolSend?.({
        args: { action: "send", target: "qa-room", message: "hello" },
      }),
    ).toEqual({ to: "channel:qa-room", threadId: undefined });

    expect(
      qaChannelPlugin.actions?.extractToolSend?.({
        args: { action: "thread-reply", channelId: "canonical/room", threadId: "thread-1" },
      }),
    ).toEqual({
      to: "channel:canonical/room",
      threadId: "thread-1",
    });

    const result = await act("send", {
      target: "qa-room",
      message: "hello from action",
    });
    const payload = result as { message: { text: string } };
    expect(payload.message.text).toBe("hello from action");

    await expect(
      act("send", {
        to: "thread:qa-room/thread-1",
        threadId: "thread-2",
        message: "conflicting thread",
      }),
    ).rejects.toThrow("qa-channel target conflicts with the explicit threadId");

    const outbound = await state.waitFor({
      kind: "message-text",
      direction: "outbound",
      textIncludes: "hello from action",
      timeoutMs: 5_000,
    });
    expect(outbound).toMatchObject({ conversation: { id: "qa-room", kind: "channel" } });
  });
});
