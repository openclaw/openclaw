import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMessagingToolPayloadDedupe } from "../auto-reply/reply/reply-payloads-dedupe.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSendResult,
} from "./embedded-agent-messaging-extraction.js";

type ExtractionPlugin = Omit<ChannelPlugin, "actions"> & {
  actions?: Pick<
    NonNullable<ChannelPlugin["actions"]>,
    "extractToolSend" | "extractToolSendResult" | "messageActionTargetAliases"
  >;
};

const plugins: ExtractionPlugin[] = [
  {
    ...createChannelTestPluginBase({ id: "partialthreadprovider" }),
    actions: {
      extractToolSend: ({ args }) =>
        args.action === "send" && typeof args.to === "string"
          ? { to: args.to, threadImplicit: true }
          : null,
      extractToolSendResult: ({ result }) => {
        const send = (result as { details?: { toolSend?: Record<string, unknown> } })?.details
          ?.toolSend;
        if (typeof send?.to !== "string" || !send.to) {
          return null;
        }
        const threadId = typeof send.threadId === "string" ? send.threadId : undefined;
        return {
          to: send.to,
          ...(threadId ? { threadId } : {}),
          ...(send.threadImplicit === true ? { threadImplicit: true } : {}),
          ...(send.threadSuppressed === true ? { threadSuppressed: true } : {}),
        };
      },
    },
    threading: { resolveAutoThreadId: ({ toolContext }) => toolContext?.currentThreadTs },
  },
  {
    ...createChannelTestPluginBase({ id: "telegram" }),
    messaging: { normalizeTarget: (raw) => (raw.trim() ? "telegram:" + raw.trim() : undefined) },
    actions: {
      extractToolSend: ({ args }) =>
        args.action === "sendMessage" && typeof args.to === "string" ? { to: args.to } : null,
    },
    threading: {
      resolveAutoThreadId: ({ to, toolContext }) =>
        to.includes(":topic:") ? undefined : toolContext?.currentThreadTs,
    },
  },
  {
    ...createChannelTestPluginBase({ id: "slack" }),
    messaging: { normalizeTarget: (raw) => raw.trim().toLowerCase() },
    actions: {
      messageActionTargetAliases: {
        reply: { aliases: ["chatGuid", "messageId"], deliveryTargetAliases: ["chatGuid"] },
      },
      extractToolSend: ({ args }) => {
        if (
          (args.action !== "sendMessage" &&
            args.action !== "uploadFile" &&
            args.action !== "send" &&
            args.action !== "upload-file") ||
          typeof args.to !== "string"
        ) {
          return null;
        }
        const nativeThreadId =
          typeof args.threadTs === "string"
            ? args.threadTs
            : typeof args.threadId === "string"
              ? args.threadId
              : undefined;
        const replyTo = typeof args.replyTo === "string" ? args.replyTo : undefined;
        const threadId =
          args.action === "send"
            ? (replyTo ?? nativeThreadId)
            : args.action === "upload-file"
              ? (nativeThreadId ?? replyTo)
              : nativeThreadId;
        const threadSuppressed =
          args.topLevel === true || args.threadTs === null || args.threadId === null;
        return {
          to: args.to,
          accountId: typeof args.accountId === "string" ? args.accountId : undefined,
          threadId,
          threadSuppressed,
          threadImplicit: !threadId && !threadSuppressed,
        };
      },
    },
    threading: {
      resolveAutoThreadId: ({ to, toolContext, replyToId }) => {
        if (
          replyToId ||
          (to !== toolContext?.currentMessagingTarget && to !== toolContext?.currentChannelId) ||
          toolContext.replyToMode === "off" ||
          ((toolContext.replyToMode === "first" || toolContext.replyToMode === "batched") &&
            toolContext.hasRepliedRef?.value)
        ) {
          return undefined;
        }
        return toolContext.currentThreadTs;
      },
      resolveReplyTransport: ({ replyToId }) => ({ replyToId, threadId: null }),
    },
  },
  {
    ...createChannelTestPluginBase({ id: "canonical-target" }),
    messaging: { normalizeTarget: (raw) => raw.trim().toLowerCase() },
    actions: {
      extractToolSend: ({ args }) => {
        if (
          args.action !== "thread-reply" ||
          typeof args.channelId !== "string" ||
          typeof args.threadId !== "string"
        ) {
          return null;
        }
        return { to: "thread:" + args.channelId + "/" + args.threadId };
      },
    },
  },
  {
    ...createChannelTestPluginBase({ id: "numeric-thread" }),
    threading: { resolveReplyTransport: () => ({ threadId: 42 }) },
  },
];

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" }))),
  );
});
afterEach(() => setActivePluginRegistry(createTestRegistry()));

describe("extractMessagingToolSend", () => {
  it.each(["conversations_send", "conversations_turn"])("records opaque targets for %s", (tool) => {
    expect(
      extractMessagingToolSend(tool, {
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        message: "hello",
      }),
    ).toEqual({ tool, provider: "conversation", to: "conv_0123456789abcdef0123456789abcdef" });
  });

  it("uses the provider-canonical target for shared message actions", () => {
    expect(
      extractMessagingToolSend("message", {
        action: "thread-reply",
        provider: "canonical-target",
        channelId: "Room-A",
        threadId: "Thread-1",
      }),
    ).toMatchObject({
      tool: "message",
      provider: "canonical-target",
      to: "thread:room-a/thread-1",
      threadId: "Thread-1",
    });
  });

  it("accepts channelId when earlier aliases are blank", () => {
    expect(
      extractMessagingToolSend("message", {
        action: "send",
        channel: "telegram",
        target: " ",
        to: "",
        channelId: "123",
      }),
    ).toMatchObject({
      tool: "message",
      provider: "telegram",
      to: "telegram:123",
      threadImplicit: true,
    });
  });

  it("extracts provider-declared delivery aliases", () => {
    expect(
      extractMessagingToolSend("message", {
        action: "reply",
        provider: "slack",
        chatGuid: "Channel:C1",
      }),
    ).toMatchObject({ tool: "message", provider: "slack", to: "channel:c1" });
  });

  it("does not treat message-id aliases as delivery targets", () => {
    const args = { action: "reply", provider: "slack", messageId: "message-1" };
    expect(
      extractMessagingToolSend("message", args, { currentMessagingTarget: "user:u123" }),
    ).toMatchObject({ tool: "message", provider: "slack", to: "user:u123" });
    expect(extractMessagingToolSend("message", args)).toBeUndefined();
  });

  it("keeps explicit thread evidence with an implicit provider", () => {
    expect(
      extractMessagingToolSend("message", {
        action: "send",
        to: "channel:123",
        threadId: "456",
      }),
    ).toMatchObject({ provider: "message", threadId: "456" });
  });

  it("captures the active Slack DM thread through its routable target", () => {
    expect(
      extractMessagingToolSend(
        "message",
        {
          action: "send",
          provider: "slack",
          to: "user:U123",
        },
        {
          currentChannelId: "D123",
          currentMessagingTarget: "user:u123",
          currentThreadId: "171.222",
        },
      ),
    ).toMatchObject({
      provider: "slack",
      to: "user:u123",
      threadId: "171.222",
      threadImplicit: true,
    });
  });

  it.each([
    ["send", "999.000"],
    ["upload-file", "111.000"],
  ])("uses %s transport thread precedence", (action, threadId) => {
    const result = extractMessagingToolSend("message", {
      action,
      provider: "slack",
      target: "channel:C1",
      threadId: "111.000",
      replyTo: "999.000",
    });
    expect(result?.to).toBe("channel:c1");
    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBe(threadId);
  });

  it("preserves numeric provider transport thread ids", () => {
    expect(
      extractMessagingToolSend("message", {
        action: "send",
        provider: "numeric-thread",
        to: "channel:123",
        replyTo: "post-1",
      })?.threadId,
    ).toBe("42");
  });

  it("keeps native provider thread and account evidence", () => {
    expect(
      extractMessagingToolSend("slack", {
        action: "sendMessage",
        to: " Channel:C1 ",
        threadTs: "171.222",
        accountId: "bot-a",
      }),
    ).toMatchObject({
      tool: "slack",
      provider: "slack",
      accountId: "bot-a",
      to: "channel:c1",
      threadId: "171.222",
    });
  });

  it.each([
    { name: "missing reply mode", options: {} },
    { name: "first mode without reply state", options: { replyToMode: "first" as const } },
  ])("does not infer native threads with $name", ({ options }) => {
    const result = extractMessagingToolSend(
      "slack",
      { action: "sendMessage", to: "Channel:C1" },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
        ...options,
      },
    );
    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBeUndefined();
  });

  it("infers a native first-mode thread without consuming reply state", () => {
    const hasRepliedRef = { value: false };
    const result = extractMessagingToolSend(
      "slack",
      { action: "sendMessage", to: "Channel:C1" },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
        replyToMode: "first",
        hasRepliedRef,
      },
    );
    expect(result?.threadImplicit).toBe(true);
    expect(result?.threadId).toBe("171.222");
    expect(hasRepliedRef.value).toBe(false);
  });

  it("records native provider sends that suppress ambient threading", () => {
    const result = extractMessagingToolSend(
      "slack",
      {
        action: "sendMessage",
        to: "Channel:C1",
        topLevel: true,
      },
      { currentChannelId: "channel:c1", currentThreadId: "171.222", replyToMode: "all" },
    );
    expect(result?.threadSuppressed).toBe(true);
    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBeUndefined();
  });

  it("records explicit suppression of implicit message threading", () => {
    const topLevel = extractMessagingToolSend("message", {
      action: "send",
      provider: "telegram",
      to: "123",
      topLevel: true,
    });
    const nullThread = extractMessagingToolSend("message", {
      action: "send",
      provider: "telegram",
      to: "123",
      threadId: null,
    });
    expect(topLevel?.threadSuppressed).toBe(true);
    expect(topLevel?.threadImplicit).toBeUndefined();
    expect(nullThread?.threadSuppressed).toBe(true);
    expect(nullThread?.threadImplicit).toBeUndefined();
  });
});

describe("extractMessagingToolSendResult thread evidence", () => {
  it("preserves implicit thread evidence and reply dedupe when the result omits it", () => {
    const pending = extractMessagingToolSend(
      "message",
      {
        action: "send",
        provider: "partialthreadprovider",
        to: "channel:abc",
        message: "answer",
      },
      {
        currentChannelId: "channel:abc",
        currentMessagingTarget: "channel:abc",
        currentThreadId: "root-1",
        replyToMode: "all",
      },
    );
    expect(pending?.threadImplicit).toBe(true);
    expect(pending?.threadId).toBe("root-1");
    const confirmed = extractMessagingToolSendResult(pending!, {
      details: { toolSend: { to: "channel:abc" } },
    });
    expect(confirmed.threadImplicit).toBe(true);
    expect(confirmed.threadId).toBe("root-1");
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "partialthreadprovider",
        originatingTo: "channel:abc",
        originatingThreadId: "root-1",
        messagingToolSentTargets: [confirmed],
      }).matchingRoute,
    ).toBe(true);
  });

  it.each([
    {
      name: "explicit result replaces pending implicit evidence",
      pending: { threadImplicit: true },
      result: { threadId: "root-9" },
      expected: { threadId: "root-9" },
    },
    {
      name: "provider suppression replaces pending implicit evidence",
      pending: { threadId: "root-1", threadImplicit: true },
      result: { threadSuppressed: true },
      expected: { threadSuppressed: true },
    },
    {
      name: "provider implicit evidence replaces pending suppression",
      pending: { threadSuppressed: true },
      result: { threadImplicit: true },
      expected: { threadImplicit: true },
    },
    {
      name: "a partial result preserves pending suppression",
      pending: { threadSuppressed: true },
      result: {},
      expected: { threadSuppressed: true },
    },
  ])("$name", ({ pending, result, expected }) => {
    const confirmed = extractMessagingToolSendResult(
      {
        tool: "message",
        provider: "partialthreadprovider",
        to: "channel:abc",
        ...pending,
      },
      { details: { toolSend: { to: "channel:abc", ...result } } },
    );
    expect({
      threadId: confirmed.threadId,
      threadImplicit: confirmed.threadImplicit,
      threadSuppressed: confirmed.threadSuppressed,
    }).toEqual({
      threadId: undefined,
      threadImplicit: undefined,
      threadSuppressed: undefined,
      ...expected,
    });
  });
});
