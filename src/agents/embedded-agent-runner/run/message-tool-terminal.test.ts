// Message-tool delivery tests cover message_tool_only delivery, where a
// successful source message send records source reply evidence without ending
// the run before the model can observe the tool result.
import type { Agent, AfterToolCallContext } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  installMessageToolOnlyTerminalHook,
  isDeliveredMessageToolOnlySourceReply,
} from "./message-tool-terminal.js";

describe("message-tool-only source replies", () => {
  it("marks successful message-tool-only sends as delivered source replies", () => {
    // Direct send evidence can come from the tool result or hook result; either
    // path means the source reply was delivered and no automatic reply is needed.
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      }),
    ).toBe(true);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
          result: createDirectSendResult({ messageId: "discord-message-1" }),
        }),
      }),
    ).toBe(true);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
          result: createSuppressedSendResult(),
        }),
        hookResult: { details: { result: { messageId: "discord-message-2" } } },
      }),
    ).toBe(true);
  });

  it("ignores automatic delivery, non-send actions, explicit routes, or failed sends", () => {
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "automatic",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "reaction", emoji: "thumbsup" },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", target: "channel:other", message: "cross-channel" },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "sessions_send",
          args: { message: "internal delegation" },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "failed reply" },
          isError: true,
        }),
      }),
    ).toBe(false);
  });

  it("ignores dry-run or non-delivered sends", () => {
    // Dry runs and suppressed sends are observable tool activity, not delivered
    // replies, so they cannot close the turn.
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply", dryRun: true },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply" },
          result: {
            content: [{ type: "text", text: '{"ok":true}' }],
            details: {
              payload: {
                deliveryStatus: "dry_run",
                dryRun: true,
              },
            },
          },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply" },
        }),
        hookResult: { details: { deliveryStatus: "dry_run" } },
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply" },
          result: {
            content: [{ type: "text", text: '{"deliveryStatus":"dry_run","dryRun":true}' }],
            details: { ok: true },
          },
        }),
      }),
    ).toBe(false);
  });

  it("ignores suppressed sends without delivery evidence", () => {
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "suppressed reply" },
          result: createSuppressedSendResult(),
        }),
      }),
    ).toBe(false);
  });

  it("preserves existing after-tool-call output while recording delivered source replies", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "rewritten" }],
      details: { rewritten: true },
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "rewritten" }],
      details: { rewritten: true },
    });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
  });

  it("records delivery evidence without rewriting the default result", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
  });

  it("leaves existing after-tool-call output alone when the send failed", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "failed" }],
      details: { ok: false },
      isError: true,
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "failed reply" },
        }),
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "failed" }],
      details: { ok: false },
      isError: true,
    });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).not.toHaveBeenCalled();
  });

  it("does not install a wrapper for non-message-tool-only delivery", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      details: { untouched: true },
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "automatic",
    });

    expect(agent.afterToolCall).toBe(previousAfterToolCall);
  });
});

function createAfterToolCallContext(params: {
  toolName: string;
  args: Record<string, unknown>;
  isError?: boolean;
  result?: AfterToolCallContext["result"];
}): AfterToolCallContext {
  return {
    assistantMessage: createToolCallAssistant(params.toolName, params.args),
    toolCall: {
      type: "toolCall",
      id: "call_message",
      name: params.toolName,
      arguments: params.args,
    },
    args: params.args,
    result: params.result ?? {
      content: [
        {
          type: "text",
          text: '{"status":"ok","deliveryStatus":"sent","sourceReplySink":"internal-ui"}',
        },
      ],
      details: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        sourceReply: { text: params.args.message },
      },
    },
    isError: params.isError ?? false,
    context: {
      systemPrompt: "",
      messages: [],
      tools: [],
    },
  };
}

function createDirectSendResult(params: { messageId: string }): AfterToolCallContext["result"] {
  // A nested message id is the durable delivery proof used by the terminal
  // decision helper when the channel adapter wraps its result.
  const payload = {
    channel: "discord",
    to: "channel:source",
    via: "direct",
    mediaUrl: null,
    result: {
      channel: "discord",
      messageId: params.messageId,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

function createSuppressedSendResult(): AfterToolCallContext["result"] {
  // Same channel shape without message id: useful to prove suppression is not
  // mistaken for delivery.
  const payload = {
    channel: "discord",
    to: "channel:source",
    via: "direct",
    mediaUrl: null,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

function createToolCallAssistant(
  toolName: string,
  args: Record<string, unknown>,
): AfterToolCallContext["assistantMessage"] {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_message",
        name: toolName,
        arguments: args,
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}
