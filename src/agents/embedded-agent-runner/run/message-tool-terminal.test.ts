// Message-tool delivery tests cover message_tool_only delivery, where a
// successful terminal source sends end the run after the current tool batch;
// only explicit `final: false` remains non-terminal progress.
import type { Agent, AgentTool, AfterToolCallContext } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { installMessageToolOnlyTerminalHook } from "./message-tool-terminal.js";

async function recordsDeliveredSourceReply(params: {
  sourceReplyDeliveryMode?: Parameters<
    typeof installMessageToolOnlyTerminalHook
  >[0]["sourceReplyDeliveryMode"];
  context: AfterToolCallContext;
  hookResult?: Awaited<ReturnType<NonNullable<Agent["afterToolCall"]>>>;
}): Promise<boolean> {
  const agent = (params.hookResult
    ? { afterToolCall: vi.fn(async () => params.hookResult) }
    : {}) as unknown as Agent;
  const onDeliveredSourceReply = vi.fn();
  installMessageToolOnlyTerminalHook({
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
    typeof installMessageToolOnlyTerminalHook
  >[0]["sourceReplyDeliveryMode"];
  context: AfterToolCallContext;
  hookResult?: Awaited<ReturnType<NonNullable<Agent["afterToolCall"]>>>;
  expected: boolean;
};

describe("message-tool-only source replies", () => {
  it.each([
    {
      label: "implicit successful send with omitted finality",
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
        args: { action: "send", message: "visible reply", final: true },
        result: createDirectSendResult({ messageId: "discord-message-1" }),
      }),
      expected: true,
    },
    {
      label: "gateway plugin send result",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "visible reply", final: true },
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
        args: { action: "send", message: "visible reply", final: true },
        result: createSuppressedSendResult(),
      }),
      hookResult: { details: { result: { messageId: "discord-message-2" } } },
      expected: true,
    },
    {
      label: "automatic delivery mode",
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
      label: "dry-run hook result",
      context: createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "preview reply" },
      }),
      hookResult: { details: { deliveryStatus: "dry_run" } },
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
          args: { action: "send", message: "visible reply", final: true },
        }),
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "rewritten" }],
      details: { rewritten: true },
      terminate: true,
    });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
  });

  it("treats omitted source-reply finality as terminal", async () => {
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
    ).resolves.toEqual({ terminate: true });
    await expect(
      agent.shouldStopAfterTurn?.({} as Parameters<NonNullable<Agent["shouldStopAfterTurn"]>>[0]),
    ).resolves.toBe(true);
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
  });

  it("honors producer-owned progress evidence over omitted call arguments", async () => {
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
          result: {
            content: [{ type: "text", text: '{"deliveryStatus":"sent"}' }],
            details: { deliveryStatus: "sent", sourceReplyFinal: false },
          },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      agent.shouldStopAfterTurn?.({} as Parameters<NonNullable<Agent["shouldStopAfterTurn"]>>[0]),
    ).resolves.toBe(false);
    expect(onDeliveredSourceReply).not.toHaveBeenCalled();
  });

  it("allows progress before a terminal source reply and terminates only the final send", async () => {
    const messageExecute = vi.fn(async (_toolCallId: string, args: unknown) => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: readMessageText(args) } },
    }));
    const agent = createAgentWithTools([createAgentTool("message", messageExecute)]);
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });
    const messageTool = agent.state.tools[0];
    const progressArgs = { action: "send", message: "working", final: false };
    const finalArgs = { action: "send", message: "done", final: true };

    const progressResult = await messageTool?.execute("progress", progressArgs);
    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: progressArgs,
          result: progressResult,
        }),
      ),
    ).resolves.toBeUndefined();

    const finalResult = await messageTool?.execute("final", finalArgs);
    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({ toolName: "message", args: finalArgs, result: finalResult }),
      ),
    ).resolves.toEqual({ terminate: true });
    await expect(
      agent.shouldStopAfterTurn?.({} as Parameters<NonNullable<Agent["shouldStopAfterTurn"]>>[0]),
    ).resolves.toBe(true);

    const repeatedResult = await messageTool?.execute("repeat", {
      action: "send",
      message: "duplicate",
    });
    expect(messageExecute).toHaveBeenCalledTimes(2);
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
    expect(repeatedResult).toMatchObject({
      details: {
        status: "suppressed",
        reason: "message_tool_only_terminal_source_reply_already_sent",
      },
      terminate: true,
    });
  });

  it("reserves the terminal slot before parallel source sends execute", async () => {
    let releaseTerminal!: (result: Awaited<ReturnType<AgentTool["execute"]>>) => void;
    const terminalResult = new Promise<Awaited<ReturnType<AgentTool["execute"]>>>((resolve) => {
      releaseTerminal = resolve;
    });
    const messageExecute = vi.fn(async () => await terminalResult);
    const agent = createAgentWithTools([createAgentTool("message", messageExecute)]);
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const messageTool = agent.state.tools[0];

    const inFlight = messageTool?.execute("terminal", {
      action: "send",
      message: "done",
      final: true,
    });
    const racedProgressPromise = messageTool?.execute("late-progress", {
      action: "send",
      message: "too late",
      final: false,
    });
    releaseTerminal({
      content: [{ type: "text", text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: "done" } },
    });

    const deliveredResult = await inFlight;
    expect(deliveredResult).toMatchObject({
      details: { sourceReply: { text: "done" } },
    });
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolCallId: "terminal",
        toolName: "message",
        args: { action: "send", message: "done", final: true },
        result: deliveredResult,
      }),
    );
    const racedProgress = await racedProgressPromise;
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolCallId: "late-progress",
        toolName: "message",
        args: { action: "send", message: "too late", final: false },
        result: racedProgress,
      }),
    );
    const thirdResult = await messageTool?.execute("third", {
      action: "send",
      message: "still duplicate",
    });
    expect(messageExecute).toHaveBeenCalledTimes(1);
    expect(racedProgress).toMatchObject({
      details: { status: "suppressed" },
      terminate: true,
    });
    expect(thirdResult).toMatchObject({
      details: { status: "suppressed" },
      terminate: true,
    });
  });

  it("waits for in-flight progress before starting the terminal send", async () => {
    let releaseProgress!: (result: Awaited<ReturnType<AgentTool["execute"]>>) => void;
    const progressResult = new Promise<Awaited<ReturnType<AgentTool["execute"]>>>((resolve) => {
      releaseProgress = resolve;
    });
    const messageExecute = vi
      .fn<AgentTool["execute"]>()
      .mockImplementationOnce(async () => await progressResult)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"deliveryStatus":"sent"}' }],
        details: { deliveryStatus: "sent", sourceReply: { text: "done" } },
      });
    const agent = createAgentWithTools([createAgentTool("message", messageExecute)]);
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const messageTool = agent.state.tools[0];

    const progress = messageTool?.execute("progress", {
      action: "send",
      message: "working",
      final: false,
    });
    const terminal = messageTool?.execute("terminal", {
      action: "send",
      message: "done",
      final: true,
    });
    await Promise.resolve();
    expect(messageExecute).toHaveBeenCalledTimes(1);
    releaseProgress({
      content: [{ type: "text", text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: "working" } },
    });

    await expect(progress).resolves.toMatchObject({
      details: { sourceReply: { text: "working" } },
    });
    await expect(terminal).resolves.toMatchObject({
      details: { sourceReply: { text: "done" } },
    });
    expect(messageExecute).toHaveBeenCalledTimes(2);
  });

  it("releases a failed terminal reservation so the model can retry", async () => {
    const messageExecute = vi.fn(async (_toolCallId: string, args: unknown) => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: readMessageText(args) } },
    }));
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"failed"}' }],
      details: { deliveryStatus: "failed" },
      isError: true,
    }));
    const agent = createAgentWithTools([createAgentTool("message", messageExecute)]);
    agent.afterToolCall = previousAfterToolCall;
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const messageTool = agent.state.tools[0];
    const failedArgs = { action: "send", message: "first attempt", final: true };
    const failedResult = await messageTool?.execute("failed", failedArgs);
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolCallId: "failed",
        toolName: "message",
        args: failedArgs,
        result: failedResult,
      }),
    );

    const retryResult = await messageTool?.execute("retry", {
      action: "send",
      message: "second attempt",
      final: true,
    });
    expect(messageExecute).toHaveBeenCalledTimes(2);
    expect(retryResult).toMatchObject({
      details: { sourceReply: { text: "second attempt" } },
    });
  });

  it("releases the terminal reservation when message execution rejects", async () => {
    const messageExecute = vi
      .fn<AgentTool["execute"]>()
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"deliveryStatus":"sent"}' }],
        details: { deliveryStatus: "sent", sourceReply: { text: "retry" } },
      });
    const agent = createAgentWithTools([createAgentTool("message", messageExecute)]);
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const messageTool = agent.state.tools[0];

    const failedArgs = { action: "send", message: "first attempt", final: true };
    await expect(messageTool?.execute("failed", failedArgs)).rejects.toThrow("gateway timeout");
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolCallId: "failed",
        toolName: "message",
        args: failedArgs,
        isError: true,
        result: {
          content: [{ type: "text", text: "gateway timeout" }],
          details: { deliveryStatus: "failed" },
        },
      }),
    );
    await expect(
      messageTool?.execute("retry", { action: "send", message: "retry", final: true }),
    ).resolves.toMatchObject({
      details: { sourceReply: { text: "retry" } },
    });
    expect(messageExecute).toHaveBeenCalledTimes(2);
  });

  it("waits for rejected terminal delivery evidence before resolving a queued send", async () => {
    const messageExecute = vi
      .fn<AgentTool["execute"]>()
      .mockRejectedValueOnce(new Error("gateway timeout"));
    const previousAfterToolCall = vi.fn(async () => ({
      details: { result: { messageId: "delivered-before-timeout" } },
      isError: false,
    }));
    const agent = createAgentWithTools([createAgentTool("message", messageExecute)]);
    agent.afterToolCall = previousAfterToolCall;
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const messageTool = agent.state.tools[0];
    const failedArgs = { action: "send", message: "first attempt", final: true };

    await expect(messageTool?.execute("failed", failedArgs)).rejects.toThrow("gateway timeout");
    const queuedSend = messageTool?.execute("queued", {
      action: "send",
      message: "duplicate",
      final: true,
    });
    await Promise.resolve();
    expect(messageExecute).toHaveBeenCalledTimes(1);

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolCallId: "failed",
          toolName: "message",
          args: failedArgs,
          isError: true,
          result: {
            content: [{ type: "text", text: "gateway timeout" }],
            details: { deliveryStatus: "failed" },
          },
        }),
      ),
    ).resolves.toMatchObject({ terminate: true });
    await expect(queuedSend).resolves.toMatchObject({
      details: { status: "suppressed" },
      terminate: true,
    });
    expect(messageExecute).toHaveBeenCalledTimes(1);
  });

  it("keeps delivered terminal state when an earlier after-tool hook throws", async () => {
    const messageExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: "done" } },
    }));
    const agent = createAgentWithTools([createAgentTool("message", messageExecute)]);
    agent.afterToolCall = vi.fn(async () => {
      throw new Error("hook failed");
    });
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });
    const messageTool = agent.state.tools[0];
    const finalArgs = { action: "send", message: "done", final: true };
    const finalResult = await messageTool?.execute("final", finalArgs);

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolCallId: "final",
          toolName: "message",
          args: finalArgs,
          result: finalResult,
        }),
      ),
    ).rejects.toThrow("hook failed");
    const repeatedResult = await messageTool?.execute("repeat", {
      action: "send",
      message: "duplicate",
    });
    expect(messageExecute).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
    expect(repeatedResult).toMatchObject({
      details: { status: "suppressed" },
      terminate: true,
    });
  });

  it("guards deferred message tools after terminal source delivery", async () => {
    const messageExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent" },
    }));
    const agent = createAgentWithTools([]);
    agent.resolveDeferredTool = vi.fn(async () => createAgentTool("message", messageExecute));
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "done", final: true },
      }),
    );

    const deferredMessageTool = await agent.resolveDeferredTool?.({
      assistantMessage: createToolCallAssistant("message", {
        action: "send",
        message: "duplicate",
        final: true,
      }),
      toolCall: {
        type: "toolCall",
        id: "deferred-message",
        name: "message",
        arguments: { action: "send", message: "duplicate", final: true },
      },
      context: { systemPrompt: "", messages: [], tools: [] },
    });
    const repeatedResult = await deferredMessageTool?.execute("repeat", {
      action: "send",
      message: "duplicate",
      final: true,
    });

    expect(messageExecute).not.toHaveBeenCalled();
    expect(repeatedResult).toMatchObject({
      details: { status: "suppressed" },
      terminate: true,
    });
  });

  it("keeps the guard on message tools rebuilt by the session owner", async () => {
    const messageExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: "done" } },
    }));
    const rawMessageTool = createAgentTool("message", messageExecute);
    const agent = createAgentWithTools([rawMessageTool]);
    let activeToolTransform: ((tools: AgentTool[]) => AgentTool[]) | undefined;
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      setActiveToolTransform: (transform) => {
        activeToolTransform = transform;
        agent.state.tools = transform(agent.state.tools);
      },
    });

    const rebuiltMessageTool = activeToolTransform?.([rawMessageTool])[0];
    const firstSend = rebuiltMessageTool?.execute("first", {
      action: "send",
      message: "done",
      final: true,
    });
    const secondSend = rebuiltMessageTool?.execute("second", {
      action: "send",
      message: "duplicate",
      final: true,
    });
    const firstResult = await firstSend;
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolCallId: "first",
        toolName: "message",
        args: { action: "send", message: "done", final: true },
        result: firstResult,
      }),
    );

    await expect(secondSend).resolves.toMatchObject({
      details: { status: "suppressed" },
      terminate: true,
    });
    expect(messageExecute).toHaveBeenCalledTimes(1);
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
  toolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  isError?: boolean;
  result?: AfterToolCallContext["result"];
}): AfterToolCallContext {
  return {
    assistantMessage: createToolCallAssistant(params.toolName, params.args, params.toolCallId),
    toolCall: {
      type: "toolCall",
      id: params.toolCallId ?? "call_message",
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

function createAgentWithTools(tools: AgentTool[]): Agent {
  return { state: { tools } } as unknown as Agent;
}

function createAgentTool(name: string, execute: AgentTool["execute"]): AgentTool {
  return {
    label: name,
    name,
    description: `${name} tool.`,
    parameters: {} as AgentTool["parameters"],
    execute,
  };
}

function readMessageText(args: unknown): unknown {
  return argsRecord(args).message;
}

function argsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  toolCallId = "call_message",
): AfterToolCallContext["assistantMessage"] {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
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
