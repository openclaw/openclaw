// Confirmed final replies end the turn; progress and unconfirmed delivery keep it open.
import type { Agent, AfterToolCallContext } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  commitInternalToolTurnInput,
  getInternalToolTurnCompletion,
  getInternalToolTurnInputScope,
} from "../../../../packages/agent-core/src/internal-hooks.js";
import { captureAgentToolInputScope } from "../../../../packages/agent-core/src/tool-execution-context.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { installMessageToolTerminalHook } from "./message-tool-terminal.js";

type Route = Omit<
  Parameters<typeof installMessageToolTerminalHook>[0],
  "agent" | "onDeliveredSourceReply"
>;
type HookResult = Awaited<ReturnType<NonNullable<Agent["afterToolCall"]>>>;
type CallInput = {
  toolName?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  result?: AfterToolCallContext["result"];
};

function fixture(
  route: Route = { sourceReplyDeliveryMode: "message_tool_only" },
  previous?: HookResult | NonNullable<Agent["afterToolCall"]>,
) {
  const previousAfterToolCall = previous
    ? vi.fn(typeof previous === "function" ? previous : async () => structuredClone(previous))
    : undefined;
  const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
  const onDeliveredSourceReply = vi.fn();
  installMessageToolTerminalHook({ agent, ...route, onDeliveredSourceReply });
  return {
    agent,
    previousAfterToolCall,
    onDeliveredSourceReply,
    invoke: (input: CallInput = {}) => agent.afterToolCall?.(createAfterToolCallContext(input)),
  };
}

function settledResult(sourceReplyDelivered?: boolean): AfterToolCallContext["result"] {
  return {
    content: [],
    details: {
      messageDelivery: {
        status: "settled",
        partialDelivery: false,
        createdThreadIds: [],
        ...(sourceReplyDelivered === undefined ? {} : { sourceReplyDelivered }),
      },
    },
  };
}

describe("message-tool-only source replies", () => {
  it.each<[string, CallInput, boolean, HookResult?, Route["sourceReplyDeliveryMode"]?]>([
    ["implicit successful send", {}, true],
    ["direct send result", { result: createChannelSendResult("discord-message-1") }, true],
    [
      "gateway plugin send result",
      {
        result: {
          content: [{ type: "text", text: '{"message":{"id":"qa-message-1"}}' }],
          details: { message: { id: "qa-message-1" } },
        },
      },
      true,
    ],
    [
      "hook result delivery evidence",
      { result: { content: [], details: {} } },
      true,
      { details: { result: { messageId: "discord-message-2" } } },
    ],
    ["unconfirmed automatic delivery", {}, false, undefined, "automatic"],
    ["non-send action", { args: { action: "reaction", emoji: "thumbsup" } }, false],
    [
      "explicit route",
      { args: { action: "send", target: "channel:other", message: "cross-channel" } },
      false,
    ],
    [
      "different tool",
      { toolName: "sessions_send", args: { message: "internal delegation" } },
      false,
    ],
    ["failed send", { args: { action: "send", message: "failed reply" }, isError: true }, false],
    [
      "partial send",
      {
        args: { action: "send", message: "incomplete reply" },
        result: {
          content: [],
          details: {
            messageDelivery: { status: "settled", partialDelivery: true, createdThreadIds: [] },
          },
        },
      },
      false,
    ],
    [
      "dry-run argument",
      { args: { action: "send", message: "preview reply", dryRun: true } },
      false,
    ],
    [
      "dry-run result payload",
      {
        args: { action: "send", message: "preview reply" },
        result: {
          content: [{ type: "text", text: '{"ok":true}' }],
          details: { payload: { deliveryStatus: "dry_run", dryRun: true } },
        },
      },
      false,
    ],
    [
      "dry-run serialized result",
      {
        args: { action: "send", message: "preview reply" },
        result: {
          content: [{ type: "text", text: '{"deliveryStatus":"dry_run","dryRun":true}' }],
          details: { ok: true },
        },
      },
      false,
    ],
    [
      "suppressed send",
      { args: { action: "send", message: "suppressed reply" }, result: createChannelSendResult() },
      false,
    ],
  ])(
    "records %s through the installed hook",
    async (_label, input, expected, hookResult, mode = "message_tool_only") => {
      const f = fixture({ sourceReplyDeliveryMode: mode }, hookResult);
      await f.invoke(input);
      expect(f.onDeliveredSourceReply.mock.calls.length > 0).toBe(expected);
    },
  );

  it.each(
    (["automatic", "message_tool_only"] as const).flatMap((sourceReplyDeliveryMode) =>
      ["send", "reply", "thread-reply", "poll", "react"].map((action) => ({
        sourceReplyDeliveryMode,
        action,
      })),
    ),
  )(
    "preserves rewritten output while terminating after a recorded source $action ($sourceReplyDeliveryMode)",
    async ({ action, sourceReplyDeliveryMode }) => {
      const rewritten = {
        ...settledResult(),
        content: [{ type: "text" as const, text: "rewritten" }],
      };
      const f = fixture({ sourceReplyDeliveryMode }, rewritten);
      await expect(
        f.invoke({
          args: { action, target: "channel:source", message: "visible reply", final: true },
          result: settledResult(true),
        }),
      ).resolves.toEqual({ ...rewritten, terminate: true });
      expect(f.previousAfterToolCall).toHaveBeenCalledTimes(1);
      expect(f.onDeliveredSourceReply).toHaveBeenCalledTimes(1);
    },
  );

  const sendFailure = {
    content: [{ type: "text" as const, text: "failed" }],
    details: { ok: false },
    isError: true,
  };
  it.each<[string, CallInput, HookResult, HookResult, number, Route["sourceReplyDeliveryMode"]?]>([
    ["terminates after a delivered completed source reply", {}, undefined, { terminate: true }, 1],
    [
      "continues after delivered progress",
      { args: { action: "send", message: "still working", final: false } },
      undefined,
      undefined,
      1,
    ],
    [
      "leaves existing after-tool-call output alone when the send failed",
      { args: { action: "send", message: "failed reply" }, isError: true },
      sendFailure,
      sendFailure,
      0,
    ],
    [
      "preserves existing output for unconfirmed automatic delivery",
      { args: { action: "send", target: "elsewhere", message: "reply" } },
      { details: { untouched: true } },
      { details: { untouched: true } },
      0,
      "automatic",
    ],
  ])("%s", async (_label, input, previous, expected, delivered, mode = "message_tool_only") => {
    const f = fixture({ sourceReplyDeliveryMode: mode }, previous);
    await expect(f.invoke(input)).resolves.toEqual(expected);
    if (previous) {
      expect(f.previousAfterToolCall).toHaveBeenCalledTimes(1);
    }
    expect(f.onDeliveredSourceReply).toHaveBeenCalledTimes(delivered);
  });

  it.each([
    { finalByDefault: false, final: undefined, terminates: false },
    { finalByDefault: false, final: false, terminates: false },
    { finalByDefault: false, final: true, terminates: true },
    { finalByDefault: undefined, final: undefined, terminates: true },
  ])(
    "ends a delivered send to a configured target only when final resolves true (default $finalByDefault, final $final)",
    async ({ finalByDefault, final, terminates }) => {
      // Cron supplies an explicit target and confirmed delivery, but no delivery-mode override.
      const f = fixture({
        currentProvider: "telegram",
        currentChannelId: "-1001234567890",
        ...(finalByDefault === undefined ? {} : { messageToolFinalByDefault: finalByDefault }),
      });
      await expect(
        f.invoke({
          args: {
            action: "send",
            channel: "telegram",
            target: "-1001234567890",
            message: "daily drop",
            ...(final === undefined ? {} : { final }),
          },
          result: {
            content: [{ type: "text", text: '{"ok":true,"messageId":"4242"}' }],
            details: {
              ok: true,
              messageId: "4242",
              messageDelivery: {
                status: "settled",
                primaryPlatformMessageId: "4242",
                partialDelivery: false,
                createdThreadIds: [],
                sourceReplyDelivered: true,
              },
            },
          },
        }),
      ).resolves.toEqual(terminates ? { terminate: true } : undefined);
      expect(f.onDeliveredSourceReply).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["the exact source route", {}, true],
    ["the same target in another account", { accountId: "account-2" }, false],
    ["the same target in another thread", { threadId: "thread-2" }, false],
    ["another target", { target: "chat456" }, false],
  ])("records explicit sends only for %s", async (_label, route, expected) => {
    const f = fixture({
      sourceReplyDeliveryMode: "message_tool_only",
      config: {},
      currentProvider: "test-channel",
      currentAccountId: "account-1",
      currentChannelId: "chat123",
      currentThreadId: "thread-1",
      sessionKey: "agent:main:test-channel:chat123",
    });
    await f.invoke({
      args: {
        action: "send",
        channel: "test-channel",
        accountId: "account-1",
        target: "chat123",
        threadId: "thread-1",
        message: "explicit reply",
        ...route,
      },
    });
    expect(f.onDeliveredSourceReply.mock.calls.length > 0).toBe(expected);
  });

  it("preserves a committed final source reply when later presentation fails", async () => {
    const failure = { details: { error: "presentation failed" }, isError: true };
    const f = fixture({ sourceReplyDeliveryMode: "automatic" }, failure);
    await expect(
      f.invoke({
        args: { action: "send", message: "Delivered once." },
        result: settledResult(true),
      }),
    ).resolves.toEqual({ ...failure, terminate: true });
  });

  it.each([false, true])(
    "retains the direct invocation's input through late presentation (new input=%s)",
    async (newInput) => {
      const context = createAfterToolCallContext({
        args: { action: "send", message: "Delivered once.", final: true },
      });
      const publicationError = new Error("presentation failed");
      const f = fixture(undefined, async () => {
        if (newInput) {
          commitInternalToolTurnInput(completion);
        }
        throw publicationError;
      });
      const completion = getInternalToolTurnCompletion(f.agent);
      if (!completion) {
        throw new Error("Message completion owner was not installed");
      }
      captureAgentToolInputScope(context, getInternalToolTurnInputScope(completion));
      await expect(f.agent.afterToolCall?.(context)).rejects.toBe(publicationError);
      expect(f.onDeliveredSourceReply).toHaveBeenCalledOnce();
      expect(
        completion({
          message: context.assistantMessage,
          toolResults: [],
          terminalToolCallIds: new Set(),
          inputScope: getInternalToolTurnInputScope(completion),
        }),
      ).toBe(!newInput);
    },
  );
});

function createAfterToolCallContext({
  toolName = "message",
  args = { action: "send", message: "visible reply" },
  isError = false,
  result,
}: CallInput = {}): AfterToolCallContext {
  const toolCall = {
    type: "toolCall" as const,
    id: "call_message",
    name: toolName,
    arguments: args,
  };
  return {
    assistantMessage: {
      role: "assistant",
      content: [toolCall],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: createZeroUsageFixture(),
      stopReason: "toolUse",
      timestamp: 0,
    },
    toolCall,
    args,
    result: result ?? {
      content: [
        {
          type: "text",
          text: '{"status":"ok","deliveryStatus":"sent","sourceReplySink":"internal-ui"}',
        },
      ],
      details: {
        status: "ok",
        deliveryStatus: "sent",
        messageDelivery: {
          status: args.dryRun ? "dryRun" : isError ? "failed" : "settled",
          partialDelivery: false,
          createdThreadIds: [],
        },
        sourceReplySink: "internal-ui",
        sourceReply: { text: args.message },
      },
    },
    isError,
    context: { systemPrompt: "", messages: [], tools: [] },
  };
}

function createChannelSendResult(messageId?: string): AfterToolCallContext["result"] {
  // Delivered replies carry both the adapter's nested ID and the durable receipt;
  // suppressed replies carry neither, despite otherwise identical channel routing.
  const payload = {
    channel: "discord",
    to: "channel:source",
    via: "direct",
    mediaUrl: null,
    ...(messageId ? { result: { channel: "discord", messageId } } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: {
      ...payload,
      messageDelivery: {
        status: messageId ? "settled" : "suppressed",
        ...(messageId ? { primaryPlatformMessageId: messageId } : {}),
        partialDelivery: false,
        createdThreadIds: [],
      },
    },
  };
}
