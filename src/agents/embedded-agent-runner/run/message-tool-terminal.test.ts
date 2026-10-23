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

async function recordsDeliveredSourceReply(params: {
  sourceReplyDeliveryMode?: Parameters<
    typeof installMessageToolTerminalHook
  >[0]["sourceReplyDeliveryMode"];
  context: AfterToolCallContext;
  hookResult?: Awaited<ReturnType<NonNullable<Agent["afterToolCall"]>>>;
}): Promise<boolean> {
  const agent = (params.hookResult
    ? { afterToolCall: vi.fn(async () => params.hookResult) }
    : {}) as unknown as Agent;
  const onDeliveredSourceReply = vi.fn();
  installMessageToolTerminalHook({
    agent,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    onDeliveredSourceReply,
  });
  await agent.afterToolCall?.(params.context);
  return onDeliveredSourceReply.mock.calls.length > 0;
}

type TerminalHookCase = {
  label: string;
  sourceReplyDeliveryMode?: Parameters<
    typeof installMessageToolTerminalHook
  >[0]["sourceReplyDeliveryMode"];
  context: AfterToolCallContext;
  hookResult?: Awaited<ReturnType<NonNullable<Agent["afterToolCall"]>>>;
  expected: boolean;
};

describe("message-tool-only source replies", () => {
  it.each([
    {
      label: "implicit successful send",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply" },
      }),
      expected: true,
    },
    {
      label: "direct send result",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply" },
        result: createDirectSendResult({ messageId: "discord-message-1" }),
      }),
      expected: true,
    },
    {
      label: "gateway plugin send result",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply" },
        result: {
          content: [{ type: "text", text: '{"message":{"id":"qa-message-1"}}' }],
          details: { message: { id: "qa-message-1" } },
        },
      }),
      expected: true,
    },
    {
      label: "hook result delivery evidence",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply" },
        result: { content: [], details: {} },
      }),
      hookResult: { details: { result: { messageId: "discord-message-2" } } },
      expected: true,
    },
    {
      label: "unconfirmed automatic delivery",
      sourceReplyDeliveryMode: "automatic",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply" },
      }),
      expected: false,
    },
    {
      label: "non-send action",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "reaction", emoji: "thumbsup" },
      }),
      expected: false,
    },
    {
      label: "explicit route",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", target: "channel:other", message: "cross-channel" },
      }),
      expected: false,
    },
    {
      label: "different tool",
      context: createAfterToolCallContext({
        toolName: "sessions_send",
        args: { message: "internal delegation" },
      }),
      expected: false,
    },
    {
      label: "failed send",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "failed reply" },
        isError: true,
      }),
      expected: false,
    },
    {
      label: "partial send",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "incomplete reply" },
        result: {
          content: [],
          details: {
            messageDelivery: {
              status: "settled",
              partialDelivery: true,
              createdThreadIds: [],
            },
          },
        },
      }),
      expected: false,
    },
    {
      label: "dry-run argument",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "preview reply", dryRun: true },
      }),
      expected: false,
    },
    {
      label: "dry-run result payload",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "preview reply" },
        result: {
          content: [{ type: "text", text: '{"ok":true}' }],
          details: { payload: { deliveryStatus: "dry_run", dryRun: true } },
        },
      }),
      expected: false,
    },
    {
      label: "dry-run serialized result",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "preview reply" },
        result: {
          content: [{ type: "text", text: '{"deliveryStatus":"dry_run","dryRun":true}' }],
          details: { ok: true },
        },
      }),
      expected: false,
    },
    {
      label: "suppressed send",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "suppressed reply" },
        result: createSuppressedSendResult(),
      }),
      expected: false,
    },
  ] satisfies TerminalHookCase[])(
    "records $label through the installed hook",
    async ({ sourceReplyDeliveryMode, context, hookResult, expected }) => {
      await expect(
        recordsDeliveredSourceReply({
          sourceReplyDeliveryMode: sourceReplyDeliveryMode ?? "message_tool_only",
          context,
          hookResult,
        }),
      ).resolves.toBe(expected);
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
        content: [{ type: "text" as const, text: "rewritten" }],
        details: {
          messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [] },
        },
      };
      const previousAfterToolCall = vi.fn(async () => rewritten);
      const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
      const onDeliveredSourceReply = vi.fn();
      installMessageToolTerminalHook({
        agent,
        sourceReplyDeliveryMode,
        onDeliveredSourceReply,
      });

      await expect(
        agent.afterToolCall?.(
          createAfterToolCallContext({
            toolName: "message",
            args: { action, target: "channel:source", message: "visible reply", final: true },
            result: {
              content: [],
              details: {
                messageDelivery: {
                  status: "settled",
                  partialDelivery: false,
                  createdThreadIds: [],
                  sourceReplyDelivered: true,
                },
              },
            },
          }),
        ),
      ).resolves.toEqual({
        ...rewritten,
        terminate: true,
      });
      expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
      expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
    },
  );

  it("terminates after a delivered completed source reply", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    const onCompletedSourceReply = vi.fn();
    installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
      onCompletedSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
          result: {
            content: [],
            details: {
              messageDelivery: {
                status: "settled",
                partialDelivery: false,
                createdThreadIds: [],
                sourceReplyDelivered: true,
              },
            },
          },
        }),
      ),
    ).resolves.toEqual({ terminate: true });
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
    expect(onCompletedSourceReply).toHaveBeenCalledTimes(1);
  });

  it.each([
    { finalByDefault: false, final: undefined, terminates: false },
    { finalByDefault: false, final: false, terminates: false },
    { finalByDefault: false, final: true, terminates: true },
    { finalByDefault: undefined, final: undefined, terminates: true },
  ])(
    "ends a delivered send to a configured target only when final resolves true (default $finalByDefault, final $final)",
    async ({ finalByDefault, final, terminates }) => {
      // Shape of a cron send: automatic mode, explicit target, confirmed source delivery.
      const agent = {} as unknown as Agent;
      const onDeliveredSourceReply = vi.fn();
      const onCompletedSourceReply = vi.fn();
      installMessageToolTerminalHook({
        agent,
        currentProvider: "telegram",
        currentChannelId: "-1001234567890",
        ...(finalByDefault === undefined ? {} : { messageToolFinalByDefault: finalByDefault }),
        onDeliveredSourceReply,
        onCompletedSourceReply,
      });
      const args = {
        action: "send",
        channel: "telegram",
        target: "-1001234567890",
        message: "daily drop",
        ...(final === undefined ? {} : { final }),
      };

      await expect(
        agent.afterToolCall?.(
          createAfterToolCallContext({
            toolName: "message",
            args,
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
        ),
      ).resolves.toEqual(terminates ? { terminate: true } : undefined);
      // The send is still recorded as delivered whether or not the turn ends.
      expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
      expect(onCompletedSourceReply).toHaveBeenCalledTimes(terminates ? 1 : 0);
    },
  );

  it("does not report a legacy send without canonical completion as completed", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    const onCompletedSourceReply = vi.fn();
    installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
      onCompletedSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "legacy success" },
        }),
      ),
    ).resolves.toEqual({ terminate: true });
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
    expect(onCompletedSourceReply).not.toHaveBeenCalled();
  });

  it("continues after delivered progress", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    const onCompletedSourceReply = vi.fn();
    installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
      onCompletedSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "still working", final: false },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
    expect(onCompletedSourceReply).not.toHaveBeenCalled();
  });

  it("does not report partial delivery as a completed source reply", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    const onCompletedSourceReply = vi.fn();
    installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
      onCompletedSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "partially delivered" },
          isError: true,
          result: {
            content: [],
            details: {
              messageDelivery: {
                status: "settled",
                partialDelivery: true,
                createdThreadIds: [],
                sourceReplyDelivered: true,
              },
            },
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(onDeliveredSourceReply).not.toHaveBeenCalled();
    expect(onCompletedSourceReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "the exact source route",
      accountId: "account-1",
      target: "chat123",
      threadId: "thread-1",
      expected: true,
    },
    {
      label: "the same target in another account",
      accountId: "account-2",
      target: "chat123",
      threadId: "thread-1",
      expected: false,
    },
    {
      label: "the same target in another thread",
      accountId: "account-1",
      target: "chat123",
      threadId: "thread-2",
      expected: false,
    },
    {
      label: "another target",
      accountId: "account-1",
      target: "chat456",
      threadId: "thread-1",
      expected: false,
    },
  ])("records explicit sends only for $label", async (testCase) => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
      config: {},
      currentProvider: "test-channel",
      currentAccountId: "account-1",
      currentChannelId: "chat123",
      currentThreadId: "thread-1",
      sessionKey: "agent:main:test-channel:chat123",
    } as Parameters<typeof installMessageToolTerminalHook>[0] & {
      config: object;
      currentProvider: string;
      currentAccountId: string;
      currentChannelId: string;
      currentThreadId: string;
      sessionKey: string;
    });

    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: {
          action: "send",
          channel: "test-channel",
          accountId: testCase.accountId,
          target: testCase.target,
          threadId: testCase.threadId,
          message: "explicit reply",
        },
      }),
    );

    expect(onDeliveredSourceReply.mock.calls.length > 0).toBe(testCase.expected);
  });

  it("leaves existing after-tool-call output alone when the send failed", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "failed" }],
      details: { ok: false },
      isError: true,
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "failed reply" },
          isError: true,
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

  it("preserves a committed final source reply when later presentation fails", async () => {
    const failure = { details: { error: "presentation failed" }, isError: true };
    const agent = { afterToolCall: async () => failure } as unknown as Agent;
    const onCompletedSourceReply = vi.fn();
    installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "automatic",
      onCompletedSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "Delivered once." },
          result: {
            content: [],
            details: {
              messageDelivery: {
                status: "settled",
                partialDelivery: false,
                sourceReplyDelivered: true,
                createdThreadIds: [],
              },
            },
          },
        }),
      ),
    ).resolves.toEqual({ ...failure, terminate: true });
    expect(onCompletedSourceReply).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "retains the direct invocation's input through late presentation (new input=%s)",
    async (newInput) => {
      const context = createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "Delivered once.", final: true },
      });
      const publicationError = new Error("presentation failed");
      const agent = {
        afterToolCall: async () => {
          if (newInput) {
            commitInternalToolTurnInput(completion);
          }
          throw publicationError;
        },
      } as unknown as Agent;
      const onDeliveredSourceReply = vi.fn();
      installMessageToolTerminalHook({
        agent,
        sourceReplyDeliveryMode: "message_tool_only",
        onDeliveredSourceReply,
      });
      const completion = getInternalToolTurnCompletion(agent);
      if (!completion) {
        throw new Error("Message completion owner was not installed");
      }
      captureAgentToolInputScope(context, getInternalToolTurnInputScope(completion));

      await expect(agent.afterToolCall?.(context)).rejects.toBe(publicationError);

      expect(onDeliveredSourceReply).toHaveBeenCalledOnce();
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

  it("preserves existing output for unconfirmed automatic delivery", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      details: { untouched: true },
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    installMessageToolTerminalHook({
      agent,
      sourceReplyDeliveryMode: "automatic",
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", target: "elsewhere", message: "reply" },
        }),
      ),
    ).resolves.toEqual({ details: { untouched: true } });
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
        messageDelivery: {
          status: params.args.dryRun ? "dryRun" : params.isError ? "failed" : "settled",
          partialDelivery: false,
          createdThreadIds: [],
        },
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
    details: {
      ...payload,
      messageDelivery: {
        status: "settled",
        primaryPlatformMessageId: params.messageId,
        partialDelivery: false,
        createdThreadIds: [],
      },
    },
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
    details: {
      ...payload,
      messageDelivery: {
        status: "suppressed",
        partialDelivery: false,
        createdThreadIds: [],
      },
    },
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
    usage: createZeroUsageFixture(),
    stopReason: "toolUse",
    timestamp: 0,
  };
}
