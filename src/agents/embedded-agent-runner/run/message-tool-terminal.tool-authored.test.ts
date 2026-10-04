// A `canDeliverSourceReply` tool that authored a final reply ends the tool batch;
// progress replies and ordinary tools keep the model turn going.
import type { AfterToolCallContext } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentTool } from "../../runtime/index.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { installToolAuthoredSourceReplyTerminalHook } from "./message-tool-terminal.js";

function createContext(params: {
  toolName: string;
  result: unknown;
  isError?: boolean;
  siblingToolNames?: string[];
}): AfterToolCallContext {
  const toolCall = { type: "toolCall", id: "call-1", name: params.toolName, arguments: {} };
  const siblings = (params.siblingToolNames ?? []).map((name, index) => ({
    type: "toolCall",
    id: `sibling-${index}`,
    name,
    arguments: {},
  }));
  return {
    assistantMessage: { role: "assistant", content: [toolCall, ...siblings] },
    toolCall,
    args: {},
    result: params.result,
    isError: params.isError ?? false,
  } as unknown as AfterToolCallContext;
}

async function runHook(params: {
  capableToolNames?: ReadonlySet<string>;
  context: AfterToolCallContext;
  previousHookResult?: Record<string, unknown>;
}) {
  const previous = params.previousHookResult
    ? vi.fn(async () => params.previousHookResult)
    : undefined;
  const agent = (previous ? { afterToolCall: previous } : {}) as unknown as Agent;
  installToolAuthoredSourceReplyTerminalHook({
    agent,
    sourceReplyCapableToolNames: params.capableToolNames,
  });
  return { hookResult: await agent.afterToolCall?.(params.context), previous };
}

const finalReply = { content: [], details: { sourceReply: { text: "Pedido creado." } } };

describe("tool-authored source reply terminal hook", () => {
  it("terminates the batch after a capable tool authors a final reply", async () => {
    const { hookResult } = await runHook({
      capableToolNames: new Set(["vinalia_order_confirm"]),
      context: createContext({ toolName: "vinalia_order_confirm", result: finalReply }),
    });

    expect(hookResult).toEqual({ terminate: true });
  });

  it("still terminates when the session's own hook returns only an error flag", async () => {
    // The base agent session always answers afterToolCall with `{ isError }`;
    // that partial override must not hide the executed result's details.
    const { hookResult } = await runHook({
      capableToolNames: new Set(["vinalia_order_confirm"]),
      context: createContext({ toolName: "vinalia_order_confirm", result: finalReply }),
      previousHookResult: { isError: false },
    });

    expect(hookResult).toEqual({ isError: false, terminate: true });
  });

  it("evaluates the result an earlier hook rewrote, not the original", async () => {
    const kept = await runHook({
      capableToolNames: new Set(["vinalia_order_confirm"]),
      context: createContext({ toolName: "vinalia_order_confirm", result: finalReply }),
      previousHookResult: { details: { ...finalReply.details, kept: true } },
    });
    expect(kept.hookResult).toEqual({
      details: { ...finalReply.details, kept: true },
      terminate: true,
    });
    expect(kept.previous).toHaveBeenCalledTimes(1);

    // A hook that replaced the details without a source reply withdraws the delivery.
    const replaced = await runHook({
      capableToolNames: new Set(["vinalia_order_confirm"]),
      context: createContext({ toolName: "vinalia_order_confirm", result: finalReply }),
      previousHookResult: { details: { redacted: true } },
    });
    expect(replaced.hookResult).toEqual({ details: { redacted: true } });
  });

  it.each([
    {
      label: "the tool is not capable",
      capableToolNames: new Set(["other_tool"]),
      context: createContext({ toolName: "vinalia_order_confirm", result: finalReply }),
    },
    {
      label: "the reply is progress",
      capableToolNames: new Set(["vinalia_order_confirm"]),
      context: createContext({
        toolName: "vinalia_order_confirm",
        result: { content: [], details: { sourceReply: { text: "Comprobando…", final: false } } },
      }),
    },
    {
      label: "the result is an error",
      capableToolNames: new Set(["vinalia_order_confirm"]),
      context: createContext({
        toolName: "vinalia_order_confirm",
        result: finalReply,
        isError: true,
      }),
    },
    {
      label: "the result has no source reply",
      capableToolNames: new Set(["vinalia_order_confirm"]),
      context: createContext({
        toolName: "vinalia_order_confirm",
        result: { content: [{ type: "text", text: "plain" }], details: { ok: true } },
      }),
    },
  ])("leaves the batch running when $label", async ({ capableToolNames, context }) => {
    const { hookResult } = await runHook({ capableToolNames, context });
    expect(hookResult).toBeUndefined();
  });

  it("matches a capable tool by its policy-normalized name", async () => {
    const { hookResult } = await runHook({
      capableToolNames: new Set(["order_status"]),
      context: createContext({ toolName: "Order_Status", result: finalReply }),
    });

    expect(hookResult).toEqual({ terminate: true });
  });

  it("marks other calls in a batch with a capable call terminal, keeping their hook result", async () => {
    const { hookResult } = await runHook({
      capableToolNames: new Set(["vinalia_order_confirm"]),
      context: createContext({
        toolName: "crm_note",
        result: { content: [{ type: "text", text: "saved" }], details: { ok: true } },
        siblingToolNames: ["vinalia_order_confirm"],
      }),
      previousHookResult: { isError: false },
    });

    expect(hookResult).toEqual({ isError: false, terminate: true });
  });

  it("respects an explicit non-terminal hint on another call in the batch", async () => {
    const { hookResult } = await runHook({
      capableToolNames: new Set(["vinalia_order_confirm"]),
      context: createContext({
        toolName: "crm_note",
        result: { content: [], details: {} },
        siblingToolNames: ["vinalia_order_confirm"],
      }),
      previousHookResult: { terminate: false },
    });

    expect(hookResult).toEqual({ terminate: false });
  });

  it("installs nothing when no tool is capable", () => {
    const agent = {} as unknown as Agent;
    installToolAuthoredSourceReplyTerminalHook({ agent, sourceReplyCapableToolNames: new Set() });
    expect(agent.afterToolCall).toBeUndefined();
  });
});

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    stopReason: content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function delayedTool(name: string, delayMs: number, details: unknown, executed: string[]) {
  const tool: AgentTool = {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
      executed.push(name);
      return { content: [{ type: "text", text: `${name} done` }], details };
    },
  };
  return tool;
}

// Drives the real agent loop: one model turn calls a capable tool and an ordinary
// tool together; a second model turn would answer with "restated".
async function runMixedBatch(params: { capableDelayMs: number; capableDetails: unknown }) {
  const executed: string[] = [];
  const turns: AssistantMessage["content"][] = [
    [
      { type: "toolCall", id: "call-reply", name: "vinalia_order_confirm", arguments: {} },
      { type: "toolCall", id: "call-note", name: "crm_note", arguments: {} },
    ],
    [{ type: "text", text: "restated" }],
  ];
  let requests = 0;
  const agent = new Agent({
    initialState: {
      model,
      tools: [
        delayedTool(
          "vinalia_order_confirm",
          params.capableDelayMs,
          params.capableDetails,
          executed,
        ),
        delayedTool("crm_note", 5, { ok: true }, executed),
      ],
    },
    streamFn: () => {
      const content = turns[requests];
      requests += 1;
      if (!content) {
        throw new Error(`unexpected provider request ${requests}`);
      }
      const stream = createAssistantMessageEventStream();
      const message = assistant(content);
      queueMicrotask(() => {
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  installToolAuthoredSourceReplyTerminalHook({
    agent,
    sourceReplyCapableToolNames: new Set(["vinalia_order_confirm"]),
  });
  await agent.prompt("confirm the order and note it");
  const toolResults = agent.state.messages.filter((message) => message.role === "toolResult");
  return { requests, executed, toolResults };
}

describe("tool-authored source reply in a mixed tool batch", () => {
  it.each([
    { order: "the capable tool finishes first", capableDelayMs: 1 },
    { order: "the ordinary tool finishes first", capableDelayMs: 20 },
  ])("ends the turn after every call settles when $order", async ({ capableDelayMs }) => {
    const run = await runMixedBatch({ capableDelayMs, capableDetails: finalReply.details });

    expect(run.requests).toBe(1);
    expect(run.executed.toSorted()).toEqual(["crm_note", "vinalia_order_confirm"]);
    expect(run.toolResults.map((message) => message.toolCallId).toSorted()).toEqual([
      "call-note",
      "call-reply",
    ]);
  });

  it("lets the model continue when the capable tool authored no final reply", async () => {
    const run = await runMixedBatch({
      capableDelayMs: 1,
      capableDetails: { sourceReply: { text: "Comprobando…", final: false } },
    });

    expect(run.requests).toBe(2);
    expect(run.executed.toSorted()).toEqual(["crm_note", "vinalia_order_confirm"]);
  });
});
