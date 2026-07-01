// Message-tool delivery tests cover message_tool_only delivery, where a
// successful source message send records source reply evidence without ending
// the run before the model can observe the tool result.
import { agentLoop } from "openclaw/plugin-sdk/agent-core";
import type {
  Agent,
  AfterToolCallContext,
  AgentEvent,
  AgentLoopConfig,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
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

  it("prevents repeated message_tool_only send cascade by terminating on subsequent deliveries", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    // First delivery: records evidence, no terminate
    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "first reply" },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);

    // Second delivery: records evidence + terminate
    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "second reply" },
        }),
      ),
    ).resolves.toEqual({ terminate: true });
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(2);
  });

  it("full lifecycle: 5-turn cascade stops at second send, upstream hook output preserved", async () => {
    // Simulate the full embedded-run lifecycle as attempt.ts:2530 does:
    // installMessageToolOnlyTerminalHook wraps a pre-existing afterToolCall
    // chain, and the model cascades 5 message.send calls in sequence.
    // Without the fix, all 5 would return no terminate (infinite loop).
    // With the fix, call 1 returns no terminate (#92343), calls 2+ terminate.
    const upstreamHook = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "routed" }],
      details: { upstream: "ok" },
    }));
    const agent = { afterToolCall: upstreamHook } as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();

    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    // Hook wraps, does not replace
    expect(agent.afterToolCall).not.toBe(upstreamHook);

    // Simulate the observed 7+ cascade — 5 consecutive message.send turns.
    // Real agent-loop stops after first terminate:true; we exercise all 5
    // to prove the flag stays set.
    const results: Array<Record<string, unknown> | undefined> = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        (await agent.afterToolCall!(
          createAfterToolCallContext({
            toolName: "message",
            args: { action: "send", message: `cascade turn ${i + 1}` },
          }),
        )) as Record<string, unknown> | undefined,
      );
    }

    // Turn 1: upstream output preserved, no terminate (#92343 Slack follow-up).
    expect(results[0]).toEqual({
      content: [{ type: "text", text: "routed" }],
      details: { upstream: "ok" },
    });
    // Turns 2-5: upstream output + terminate:true (cascade stopped).
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual({
        content: [{ type: "text", text: "routed" }],
        details: { upstream: "ok" },
        terminate: true,
      });
    }
    // Upstream hook called for every turn.
    expect(upstreamHook).toHaveBeenCalledTimes(5);
    // onDeliveredSourceReply fired for every delivery.
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(5);
  });

  it("full lifecycle: error recovery does not advance hasDelivered, subsequent success terminates", async () => {
    // Proves the hook handles error recovery correctly across multiple turns.
    // hasDelivered is only set when a message.send actually delivers.
    // Errors are not deliveries — they skip the guard entirely.
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();

    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    // Turn 1: successful delivery — sets hasDelivered.
    const r1 = await agent.afterToolCall!(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "first reply" },
      }),
    );
    expect(r1).toBeUndefined();
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1);

    // Turn 2: error — not a source reply, hasDelivered stays true.
    const r2 = await agent.afterToolCall!(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "failed reply" },
        isError: true,
      }),
    );
    // Error: isDeliveredMessageToolOnlySourceReply returns false,
    // so the hook falls through to `return hookResult` without
    // calling onDeliveredSourceReply or advancing hasDelivered.
    expect(r2).toBeUndefined();
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(1); // unchanged

    // Turn 3: error recovery — first successful send after the error.
    // hasDelivered was already set in turn 1, so this terminates.
    const r3 = await agent.afterToolCall!(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "recovered reply" },
      }),
    );
    expect(r3).toEqual({ terminate: true });
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(2);

    // Turn 4: another success — still terminates.
    const r4 = await agent.afterToolCall!(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "another reply" },
      }),
    );
    expect(r4).toEqual({ terminate: true });
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(3);

    // Turn 5: another error — does not fire delivery callback.
    const r5 = await agent.afterToolCall!(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "another error" },
        isError: true,
      }),
    );
    expect(r5).toBeUndefined();
    expect(onDeliveredSourceReply).toHaveBeenCalledTimes(3); // unchanged
  });

  it("full embedded-run proof: real hook + agentLoop stops cascade at 2 turns", async () => {
    // ClawSweeper-requested proof (96887): installMessageToolOnlyTerminalHook
    // wired through the real agentLoop(), not called directly. This verifies
    // the hook is set up exactly as attempt.ts:2530 does, and that the
    // afterToolCall → finalizeExecutedToolCall merge + shouldTerminateToolBatch
    // every() contract all work together to stop the cascade.
    const agent = {} as unknown as Agent;
    const delivered: string[] = [];
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply: () => delivered.push("d"),
    });

    const executed: string[] = [];
    const messageTool = {
      name: "message",
      label: "message",
      description: "Send a message",
      parameters: {
        type: "object",
        properties: { action: { type: "string" }, message: { type: "string" } },
        required: ["action"],
      },
      execute: async (_id: string, raw: unknown) => {
        const args = (raw ?? {}) as Record<string, unknown>;
        executed.push(typeof args.action === "string" ? args.action : "unknown");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                deliveryStatus: "sent",
                sourceReplySink: "internal-ui",
              }),
            },
          ],
          details: {
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: { text: args.message },
          },
        };
      },
    } satisfies Partial<AgentTool> as AgentTool;

    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn <= 2
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: `call-msg-${turn}`,
                    name: "message",
                    arguments: { action: "send", message: `cascade ${turn}` },
                  },
                ],
                api: "test",
                provider: "test",
                model: "test-model",
                usage: {
                  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "should not reach" }],
                api: "test",
                provider: "test",
                model: "test-model",
                usage: {
                  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
        stream.push({
          type: "done",
          reason: message.stopReason as never,
          message: message as never,
        });
        stream.end();
      });
      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [messageTool] },
      {
        model: {
          id: "proof-model", name: "Proof", api: "proof", provider: "proof",
          baseUrl: "https://example.test", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000, maxTokens: 1000,
        },
        convertToLlm: (messages) => messages as never,
        afterToolCall: agent.afterToolCall,
      } as AgentLoopConfig,
      undefined,
      streamFn,
    );

    const events: AgentEvent[] = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    // Cascade stops at 2 turns — not 7+.
    expect(turn).toBe(2);
    expect(delivered).toHaveLength(2);
    expect(executed).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });

    // Turn 1: no terminate (#92343 Slack follow-up preserved)
    const toolEnds = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        e.type === "tool_execution_end",
    );
    expect(
      (toolEnds[0]?.result as AgentToolResult<unknown> | undefined)?.terminate,
    ).toBeUndefined();
    // Turn 2: terminate: true (cascade broken)
    expect(
      (toolEnds[1]?.result as AgentToolResult<unknown> | undefined)?.terminate,
    ).toBe(true);
  });

  it("full embedded-run proof: first message.send allows Slack follow-up exec tool", async () => {
    // Complements the cascade test: proves the hook preserves the #92343
    // contract — first message.send does NOT terminate, so follow-up tools
    // (e.g. Slack exec) still execute in subsequent turns.
    const agent = {} as unknown as Agent;
    const delivered: string[] = [];
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply: () => delivered.push("d"),
    });

    const executed: string[] = [];
    const msgTool = {
      name: "message",
      label: "message",
      description: "Send",
      parameters: {
        type: "object",
        properties: { action: { type: "string" }, message: { type: "string" } },
        required: ["action"],
      },
      execute: async () => {
        executed.push("message");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                deliveryStatus: "sent",
                sourceReplySink: "internal-ui",
              }),
            },
          ],
          details: { deliveryStatus: "sent", sourceReplySink: "internal-ui" },
        };
      },
    } satisfies Partial<AgentTool> as AgentTool;
    const execTool = {
      name: "exec",
      label: "exec",
      description: "Run",
      parameters: { type: "object" as const, properties: {}, required: [] },
      execute: async () => {
        executed.push("exec");
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    } satisfies Partial<AgentTool> as AgentTool;

    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content =
          turn === 1
            ? [{ type: "toolCall" as const, id: "call-msg", name: "message", arguments: { action: "send", message: "reply" } }]
            : turn === 2
              ? [{ type: "toolCall" as const, id: "call-exec", name: "exec", arguments: { cmd: "done" } }]
              : [{ type: "text" as const, text: "all done" }];
        const message = {
          role: "assistant" as const,
          content,
          api: "test", provider: "test", model: "test-model",
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: turn <= 2 ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        stream.push({
          type: "done",
          reason: message.stopReason as never,
          message: message as never,
        });
        stream.end();
      });
      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "reply and run", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [msgTool, execTool] },
      {
        model: {
          id: "proof-model", name: "Proof", api: "proof", provider: "proof",
          baseUrl: "https://example.test", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000, maxTokens: 1000,
        },
        convertToLlm: (messages) => messages as never,
        afterToolCall: agent.afterToolCall,
      } as AgentLoopConfig,
      undefined,
      streamFn,
    );

    const events: AgentEvent[] = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    // All 3 turns: message → exec → text (#92343 preserved)
    expect(turn).toBe(3);
    expect(executed).toEqual(["message", "exec"]);
    expect(delivered).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_execution_start")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
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
