import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
};

type HookOutcome =
  | { blocked: true; reason: string }
  | { blocked: false; result: AgentToolResult<unknown> };

/**
 * Run the before_tool_result hook to allow plugins to modify or block tool results
 * before they are passed to the LLM.
 */
export async function runBeforeToolResultHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  result: AgentToolResult<unknown>;
  isError: boolean;
  durationMs: number;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_result")) {
    return { blocked: false, result: args.result };
  }

  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;

  try {
    const normalizedParams = params && typeof params === "object" ? params : {};
    const hookResult = await hookRunner.runBeforeToolResult(
      {
        toolName,
        toolCallId: args.toolCallId ?? "",
        params: normalizedParams as Record<string, unknown>,
        content: args.result,
        isError: args.isError,
        durationMs: args.durationMs,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool result blocked by plugin hook",
      };
    }

    if (hookResult?.content !== undefined) {
      return { blocked: false, result: hookResult.content as AgentToolResult<unknown> };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    console.warn(
      `[hooks] before_tool_result hook failed: tool=${toolName}${toolCallId} error=${String(err)}`,
    );
  }

  return { blocked: false, result: args.result };
}

export const __testing = {
  runBeforeToolResultHook,
};
