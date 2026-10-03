// A `canDeliverSourceReply` tool that authored a final reply ends the tool batch;
// progress replies and ordinary tools keep the model turn going.
import type { Agent, AfterToolCallContext } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { installToolAuthoredSourceReplyTerminalHook } from "./message-tool-terminal.js";

function createContext(params: {
  toolName: string;
  result: unknown;
  isError?: boolean;
}): AfterToolCallContext {
  return {
    toolCall: { id: "call-1", name: params.toolName, arguments: {} },
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

  it("installs nothing when no tool is capable", () => {
    const agent = {} as unknown as Agent;
    installToolAuthoredSourceReplyTerminalHook({ agent, sourceReplyCapableToolNames: new Set() });
    expect(agent.afterToolCall).toBeUndefined();
  });
});
