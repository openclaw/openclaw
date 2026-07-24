// Message-tool delivery tests cover message_tool_only delivery, where a
// successful source message send records source reply evidence without ending
// the run before the model can observe the tool result.
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
    const agent = createAgentWithTools([]);
    agent.afterToolCall = previousAfterToolCall;
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
    const agent = createAgentWithTools([]);
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

  it("suppresses repeated implicit source replies after the first delivery", async () => {
    const messageExecute = vi.fn(async (_toolCallId: string, args: unknown) => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: readMessageText(args) } },
    }));
    const messageTool = createMessageAgentTool(messageExecute);
    const agent = createAgentWithTools([messageTool]);
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    const wrappedMessageTool = agent.state.tools[0];
    const firstResult = await wrappedMessageTool?.execute("call-1", {
      action: "send",
      message: "first visible reply",
    });
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "first visible reply" },
        result: firstResult,
      }),
    );

    const repeatedResult = await wrappedMessageTool?.execute("call-2", {
      action: "send",
      message: "second visible reply",
    });

    expect(messageExecute).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);
    expect(repeatedResult).toMatchObject({
      details: {
        status: "suppressed",
        deliveryStatus: "suppressed",
        reason: "message_tool_only_source_reply_already_delivered",
      },
      terminate: true,
    });
  });

  it("reserves the source reply slot before executing parallel message sends", async () => {
    let releaseFirstSend: ((value: Awaited<ReturnType<AgentTool["execute"]>>) => void) | undefined;
    const firstSend = new Promise<Awaited<ReturnType<AgentTool["execute"]>>>((resolve) => {
      releaseFirstSend = resolve;
    });
    const messageExecute = vi.fn(async () => await firstSend);
    const messageTool = createMessageAgentTool(messageExecute);
    const agent = createAgentWithTools([messageTool]);
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    const wrappedMessageTool = agent.state.tools[0];
    const inFlightResult = wrappedMessageTool?.execute("call-1", {
      action: "send",
      message: "first visible reply",
    });
    const repeatedResult = await wrappedMessageTool?.execute("call-2", {
      action: "send",
      message: "parallel visible reply",
    });
    releaseFirstSend?.({
      content: [{ type: "text", text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: "first visible reply" } },
    });

    await expect(inFlightResult).resolves.toMatchObject({
      details: { sourceReply: { text: "first visible reply" } },
    });
    expect(messageExecute).toHaveBeenCalledTimes(1);
    expect(repeatedResult).toMatchObject({
      details: {
        status: "suppressed",
        reason: "message_tool_only_source_reply_already_delivered",
      },
      terminate: true,
    });
  });

  it("releases the source reply slot when after-tool-call rewrites delivery as failed", async () => {
    const messageExecute = vi.fn(async (_toolCallId: string, args: unknown) => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: readMessageText(args) } },
    }));
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"failed"}' }],
      details: { deliveryStatus: "failed" },
      isError: true,
    }));
    const messageTool = createMessageAgentTool(messageExecute);
    const agent = createAgentWithTools([messageTool]);
    agent.afterToolCall = previousAfterToolCall;
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    const wrappedMessageTool = agent.state.tools[0];
    const failedResult = await wrappedMessageTool?.execute("call-1", {
      action: "send",
      message: "hook-failed reply",
    });
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "hook-failed reply" },
        result: failedResult,
      }),
    );

    const retryResult = await wrappedMessageTool?.execute("call-2", {
      action: "send",
      message: "successful retry",
    });

    expect(messageExecute).toHaveBeenCalledTimes(2);
    expect(retryResult).toMatchObject({
      details: { sourceReply: { text: "successful retry" } },
    });
  });

  it("keeps the source reply slot reserved when a suppressed parallel send finalizes first", async () => {
    let releaseFirstSend: ((value: Awaited<ReturnType<AgentTool["execute"]>>) => void) | undefined;
    const firstSend = new Promise<Awaited<ReturnType<AgentTool["execute"]>>>((resolve) => {
      releaseFirstSend = resolve;
    });
    const messageExecute = vi.fn(async () => await firstSend);
    const messageTool = createMessageAgentTool(messageExecute);
    const agent = createAgentWithTools([messageTool]);
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    const wrappedMessageTool = agent.state.tools[0];
    const inFlightResult = wrappedMessageTool?.execute("call-1", {
      action: "send",
      message: "first visible reply",
    });
    const suppressedParallelResult = await wrappedMessageTool?.execute("call-2", {
      action: "send",
      message: "parallel visible reply",
    });
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "parallel visible reply" },
        result: suppressedParallelResult,
      }),
    );

    const thirdResult = await wrappedMessageTool?.execute("call-3", {
      action: "send",
      message: "third visible reply",
    });
    releaseFirstSend?.({
      content: [{ type: "text", text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: "first visible reply" } },
    });

    await expect(inFlightResult).resolves.toMatchObject({
      details: { sourceReply: { text: "first visible reply" } },
    });
    expect(messageExecute).toHaveBeenCalledTimes(1);
    expect(thirdResult).toMatchObject({
      details: {
        status: "suppressed",
        reason: "message_tool_only_source_reply_already_delivered",
      },
      terminate: true,
    });
  });

  it("keeps explicit message routes available after source reply delivery", async () => {
    const messageExecute = vi.fn(async (_toolCallId: string, args: unknown) => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: readMessageText(args) } },
    }));
    const messageTool = createMessageAgentTool(messageExecute);
    const agent = createAgentWithTools([messageTool]);
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    const wrappedMessageTool = agent.state.tools[0];
    const firstResult = await wrappedMessageTool?.execute("call-1", {
      action: "send",
      message: "source visible reply",
    });
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "source visible reply" },
        result: firstResult,
      }),
    );

    const routedResult = await wrappedMessageTool?.execute("call-2", {
      action: "send",
      target: "channel:other",
      message: "cross-channel follow-up",
    });

    expect(messageExecute).toHaveBeenCalledTimes(2);
    expect(routedResult).toMatchObject({
      details: { sourceReply: { text: "cross-channel follow-up" } },
    });
  });

  it("keeps non-message follow-up tools available after source reply delivery", async () => {
    const messageExecute = vi.fn(async (_toolCallId: string, args: unknown) => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: readMessageText(args) } },
    }));
    const readExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "read result" }],
      details: { ok: true },
    }));
    const messageTool = createMessageAgentTool(messageExecute);
    const readTool = createAgentTool("read", readExecute);
    const agent = createAgentWithTools([messageTool, readTool]);
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    const wrappedMessageTool = agent.state.tools[0];
    const firstResult = await wrappedMessageTool?.execute("call-1", {
      action: "send",
      message: "source visible reply",
    });
    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "source visible reply" },
        result: firstResult,
      }),
    );

    const followUpReadTool = agent.state.tools.find((tool) => tool.name === "read");
    const readResult = await followUpReadTool?.execute("call-2", { path: "QA_KICKOFF_TASK.md" });

    expect(followUpReadTool).toBeDefined();
    expect(readExecute).toHaveBeenCalledTimes(1);
    expect(readResult).toMatchObject({
      details: { ok: true },
    });
  });

  it("guards deferred message tools after source reply delivery", async () => {
    const messageExecute = vi.fn(async (_toolCallId: string, args: unknown) => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: readMessageText(args) } },
    }));
    const messageTool = createMessageAgentTool(messageExecute);
    const agent = createAgentWithTools([]);
    agent.resolveDeferredTool = vi.fn(async () => messageTool);
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "source visible reply" },
      }),
    );
    const deferredMessageTool = await agent.resolveDeferredTool?.({
      assistantMessage: createToolCallAssistant("message", {
        action: "send",
        message: "repeat visible reply",
      }),
      toolCall: {
        type: "toolCall",
        id: "call-message",
        name: "message",
        arguments: { action: "send", message: "repeat visible reply" },
      },
      context: { systemPrompt: "", messages: [], tools: [] },
    });

    const repeatedResult = await deferredMessageTool?.execute("call-2", {
      action: "send",
      message: "repeat visible reply",
    });

    expect(messageExecute).not.toHaveBeenCalled();
    expect(repeatedResult).toMatchObject({
      details: { status: "suppressed" },
      terminate: true,
    });
  });

  it("supports deferred-only agents without eager tools", async () => {
    const messageExecute = vi.fn(async (_toolCallId: string, args: unknown) => ({
      content: [{ type: "text" as const, text: '{"deliveryStatus":"sent"}' }],
      details: { deliveryStatus: "sent", sourceReply: { text: readMessageText(args) } },
    }));
    const messageTool = createMessageAgentTool(messageExecute);
    const agent = {
      state: {},
      resolveDeferredTool: vi.fn(async () => messageTool),
    } as unknown as Agent;

    expect(() =>
      installMessageToolOnlyTerminalHook({
        agent,
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    ).not.toThrow();

    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "source visible reply" },
      }),
    );
    const deferredMessageTool = await agent.resolveDeferredTool?.({
      assistantMessage: createToolCallAssistant("message", {
        action: "send",
        message: "repeat visible reply",
      }),
      toolCall: {
        type: "toolCall",
        id: "call-message",
        name: "message",
        arguments: { action: "send", message: "repeat visible reply" },
      },
      context: { systemPrompt: "", messages: [], tools: [] },
    });

    const repeatedResult = await deferredMessageTool?.execute("call-2", {
      action: "send",
      message: "repeat visible reply",
    });

    expect(messageExecute).not.toHaveBeenCalled();
    expect(repeatedResult).toMatchObject({
      details: { status: "suppressed" },
      terminate: true,
    });
  });

  it("leaves existing after-tool-call output alone when the send failed", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "failed" }],
      details: { ok: false },
      isError: true,
    }));
    const agent = createAgentWithTools([]);
    agent.afterToolCall = previousAfterToolCall;
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

function createAgentWithTools(tools: AgentTool[]): Agent {
  return { state: { tools } } as unknown as Agent;
}

function createMessageAgentTool(execute: AgentTool["execute"]): AgentTool {
  return createAgentTool("message", execute);
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
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>).message
    : undefined;
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
