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
let cfg: {
  channels: { "qa-channel": { baseUrl: string; botUserId: string; botDisplayName: string } };
};

beforeEach(async () => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
  state = createQaBusState();
  bus = await startQaBusServer({ state });
  cfg = {
    channels: {
      "qa-channel": {
        baseUrl: bus.baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
      },
    },
  };
});
afterEach(async () => {
  try {
    await bus?.stop();
  } finally {
    resetPluginRuntimeStateForTest();
  }
});

function act(action: ChannelMessageActionName, params: Record<string, unknown>) {
  const handleAction = qaChannelPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("expected qa-channel action handler");
  }
  return handleAction({ channel: "qa-channel", action, cfg, accountId: "default", params });
}

describe("qa-channel direct message actions", () => {
  it("exposes thread and message actions against the qa bus", async () => {
    const discovery = qaChannelPlugin.actions?.describeMessageTool?.({
      cfg,
      accountId: "default",
    });
    const schema = discovery?.schema;
    const contributions = Array.isArray(schema) ? schema : schema ? [schema] : [];
    const titleSchema = contributions.find((entry) => "title" in entry.properties)?.properties
      .title;
    expect(titleSchema).toMatchObject({
      description: "Deprecated alias for threadName.",
    });

    const threadResult = await act("thread-create", {
      target: "channel:qa-room",
      threadName: "QA thread",
      title: "ignored legacy title",
    });
    const threadPayload = extractToolPayload(threadResult) as ThreadResult;
    expect(threadPayload).toMatchObject({
      thread: { id: expect.stringMatching(/^thread-/), title: "QA thread" },
      target: "channel:qa-room",
      threadId: threadPayload.thread.id,
    });

    const replyResult = await act("thread-reply", {
      target: threadPayload.target,
      threadId: threadPayload.threadId,
      message: "thread reply",
      text: "ignored legacy reply",
    });
    expect(extractToolPayload(replyResult)).toMatchObject({
      message: { text: "thread reply", threadId: threadPayload.thread.id },
    });

    const outbound = state.addOutboundMessage({
      to: threadPayload.target,
      text: "message",
      threadId: threadPayload.thread.id,
    });

    const boundMessage = {
      to: threadPayload.target,
      threadId: threadPayload.threadId,
      messageId: outbound.id,
    };
    await act("react", { ...boundMessage, emoji: "white_check_mark" });

    await act("edit", {
      target: threadPayload.target,
      threadId: threadPayload.threadId,
      messageId: outbound.id,
      message: "message (edited)",
      text: "ignored legacy edit",
    });

    expect(extractToolPayload(await act("read", boundMessage))).toMatchObject({
      message: { text: expect.stringContaining("(edited)") },
    });

    const searchResult = await act("search", {
      query: "edited",
      channelId: "qa-room",
      threadId: threadPayload.thread.id,
    });
    const searchPayload = extractToolPayload(searchResult) as {
      messages: Array<{ id: string }>;
    };
    expect(searchPayload.messages.map((message) => message.id)).toContain(outbound.id);

    await act("delete", boundMessage);
    expect(state.readMessage({ messageId: outbound.id }).deleted).toBe(true);
  });

  it("prefers canonical targets over conflicting direct-adapter aliases", async () => {
    const threadResult = await act("thread-create", {
      target: "channel:canonical/room",
      to: "channel:legacy-to-room",
      channelId: "legacy-channel-id-room",
      threadName: "Canonical target thread",
    });
    const threadPayload = extractToolPayload(threadResult) as ThreadResult;

    expect(threadPayload).toMatchObject({
      thread: { conversationId: "canonical/room" },
      target: "channel:canonical/room",
      threadId: threadPayload.thread.id,
    });

    const replyResult = await act("thread-reply", {
      target: threadPayload.target,
      threadId: threadPayload.threadId,
      channelId: "legacy-reply-room",
      message: "canonical target reply",
    });
    expect(extractToolPayload(replyResult)).toMatchObject({
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
      expect(extractToolPayload(result)).toMatchObject({
        message: {
          conversation: testCase.conversation,
          text: "versioned target",
          threadId: testCase.threadId,
        },
      });
    }
  });

  it("keeps the shipped thread and edit aliases for direct API callers", async () => {
    const threadResult = await act("thread-create", {
      channelId: "qa-room",
      title: "Legacy thread",
    });
    const threadPayload = extractToolPayload(threadResult) as ThreadResult;
    expect(threadPayload.thread.title).toBe("Legacy thread");

    const replyResult = await act("thread-reply", {
      channelId: "qa-room",
      threadId: threadPayload.thread.id,
      text: "legacy reply",
    });
    expect(extractToolPayload(replyResult)).toMatchObject({
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
      text: "legacy edit",
    });
    expect(extractToolPayload(editResult)).toMatchObject({
      message: { text: "legacy edit" },
    });
    expect(state.readMessage({ messageId: outbound.id }).text).toBe("legacy edit");
  });
});
