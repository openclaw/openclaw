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
        const toolSend = (result as { details?: { toolSend?: Record<string, unknown> } })?.details
          ?.toolSend;
        if (typeof toolSend?.to !== "string" || !toolSend.to) {
          return null;
        }
        return {
          to: toolSend.to,
          ...(toolSend.threadSuppressed === true ? { threadSuppressed: true } : {}),
        };
      },
    },
    threading: { resolveAutoThreadId: ({ toolContext }) => toolContext?.currentThreadTs },
  },
  {
    ...createChannelTestPluginBase({ id: "telegram" }),
    threading: { resolveAutoThreadId: () => undefined },
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
          (args.action !== "sendMessage" && args.action !== "send") ||
          typeof args.to !== "string"
        ) {
          return null;
        }
        const threadId = [
          args.action === "send" ? args.replyTo : undefined,
          args.threadTs,
          args.threadId,
        ].find((value): value is string => typeof value === "string");
        const threadSuppressed =
          args.topLevel === true || args.threadTs === null || args.threadId === null;
        return {
          to: args.to,
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
];

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" }))),
  );
});
afterEach(() => setActivePluginRegistry(createTestRegistry()));

function send(
  args: Record<string, unknown>,
  options?: Parameters<typeof extractMessagingToolSend>[2],
) {
  return extractMessagingToolSend("message", { action: "send", ...args }, options);
}

describe("extractMessagingToolSend", () => {
  it("records opaque conversation targets", () => {
    expect(
      extractMessagingToolSend("conversations_send", {
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        message: "hello",
      }),
    ).toEqual({
      tool: "conversations_send",
      provider: "conversation",
      to: "conv_0123456789abcdef0123456789abcdef",
    });
  });

  it("extracts provider-declared delivery aliases", () => {
    expect(
      send({
        action: "reply",
        provider: "slack",
        chatGuid: "Channel:C1",
      }),
    ).toMatchObject({ tool: "message", provider: "slack", to: "channel:c1" });
  });

  it("does not treat message-id aliases as delivery targets", () => {
    const args = { action: "reply", provider: "slack", messageId: "message-1" };
    expect(send(args, { currentMessagingTarget: "user:u123" })).toMatchObject({
      tool: "message",
      provider: "slack",
      to: "user:u123",
    });
    expect(send(args)).toBeUndefined();
  });

  it("keeps explicit thread evidence with an implicit provider", () => {
    expect(
      send({
        to: "channel:123",
        threadId: "456",
      }),
    ).toMatchObject({ provider: "message", threadId: "456" });
  });

  it("uses send transport thread precedence", () => {
    const result = send({
      provider: "slack",
      target: "channel:C1",
      threadId: "111.000",
      replyTo: "999.000",
    });
    expect(result?.to).toBe("channel:c1");
    expect(result?.threadId).toBe("999.000");
    expect(result?.threadImplicit).toBeUndefined();
  });

  it.each([false, true])("infers a native thread only with reply mode (first=%s)", (first) => {
    const hasRepliedRef = { value: false };
    const result = extractMessagingToolSend(
      "slack",
      { action: "sendMessage", to: "Channel:C1" },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
        ...(first ? { replyToMode: "first" as const, hasRepliedRef } : {}),
      },
    );
    expect({ threadId: result?.threadId, threadImplicit: result?.threadImplicit }).toMatchObject({
      threadId: first ? "171.222" : undefined,
      threadImplicit: first ? true : undefined,
    });
    expect(hasRepliedRef.value).toBe(false);
  });

  it("records explicit suppression of implicit message threading", () => {
    for (const override of [{ topLevel: true }, { threadId: null }]) {
      const result = send({ provider: "telegram", to: "123", ...override });
      expect(result?.threadSuppressed).toBe(true);
      expect(result?.threadImplicit).toBeUndefined();
    }
  });
});

describe("extractMessagingToolSendResult thread evidence", () => {
  it("preserves implicit thread evidence and reply dedupe when the result omits it", () => {
    const pending = send(
      {
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
    expect(pending?.threadId).toBe("root-1");
    expect(pending?.threadImplicit).toBe(true);
    const confirmed = extractMessagingToolSendResult(pending!, {
      details: { toolSend: { to: "channel:abc" } },
    });
    expect(confirmed.threadId).toBe("root-1");
    expect(confirmed.threadImplicit).toBe(true);
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "partialthreadprovider",
        originatingTo: "channel:abc",
        originatingThreadId: "root-1",
        messagingToolSentTargets: [confirmed],
      }).matchingRoute,
    ).toBe(true);
  });

  it("provider suppression replaces pending implicit evidence", () => {
    const confirmed = extractMessagingToolSendResult(
      {
        tool: "message",
        provider: "partialthreadprovider",
        to: "channel:abc",
        threadId: "root-1",
        threadImplicit: true,
      },
      { details: { toolSend: { to: "channel:abc", threadSuppressed: true } } },
    );
    expect({
      threadId: confirmed.threadId,
      threadImplicit: confirmed.threadImplicit,
      threadSuppressed: confirmed.threadSuppressed,
    }).toEqual({
      threadId: undefined,
      threadImplicit: undefined,
      threadSuppressed: true,
    });
  });
});
