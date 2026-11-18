/**
 * Arguments-only repeat guard. It compares each model tool call with the call
 * before it: name plus canonical arguments, never the outcome. The third
 * identical call gets one redirect note; the twentieth ends the turn with
 * `tool_repeat_limit`. Tools that poll by design declare `repeatable` and
 * skip the check. Committed user input resets the streak.
 */
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { copyInternalToolResultState } from "./internal-hooks.js";
import type { AgentTool, AgentToolCall, AgentToolResult } from "./types.js";

export const TOOL_REPEAT_LIMIT_CODE = "tool_repeat_limit";
export const TOOL_REPEAT_NOTE_AT = 3;
export const TOOL_REPEAT_STOP_AT = 20;

/** @internal Streak for one accepted user input, kept across Agent.continue() retries. */
export type ToolRepeatState = { key?: string; count: number };

export type ToolRepeatVerdict = {
  kind: "note" | "stop";
  toolCallId: string;
  toolName: string;
  count: number;
};

export function createToolRepeatState(): ToolRepeatState {
  return { count: 0 };
}

export function resetToolRepeatState(state: ToolRepeatState): void {
  state.key = undefined;
  state.count = 0;
}

function isRepeatable(tool: AgentTool, args: unknown): boolean {
  const { repeatable } = tool;
  if (repeatable === true) {
    return true;
  }
  const action =
    typeof args === "object" && args !== null && "action" in args ? args.action : undefined;
  return typeof action === "string" && repeatable?.actions.includes(action) === true;
}

/** Record one call in assistant order; returns the note or stop it earns, if any. */
export function observeToolRepeat(
  state: ToolRepeatState,
  toolCall: AgentToolCall,
  tool: AgentTool | undefined,
): ToolRepeatVerdict | undefined {
  if (tool && isRepeatable(tool, toolCall.arguments)) {
    resetToolRepeatState(state);
    return undefined;
  }
  // An unknown tool has no argument contract, so churned arguments still repeat the name.
  const key = tool
    ? `${toolCall.name}\0${stableStringify(toolCall.arguments ?? {})}`
    : `${toolCall.name}\0unknown`;
  state.count = state.key === key ? state.count + 1 : 1;
  state.key = key;
  const kind =
    state.count >= TOOL_REPEAT_STOP_AT
      ? "stop"
      : state.count === TOOL_REPEAT_NOTE_AT
        ? "note"
        : undefined;
  return kind
    ? { kind, toolCallId: toolCall.id, toolName: toolCall.name, count: state.count }
    : undefined;
}

function toolLabel(toolName: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(toolName) ? toolName : "a tool";
}

/** Model-facing redirect appended to the third identical call's result. */
export function appendToolRepeatNote<T extends AgentToolResult<unknown>>(
  result: T,
  verdict: ToolRepeatVerdict,
): T {
  const text =
    `[System note: You called ${toolLabel(verdict.toolName)} with the same arguments ` +
    `${verdict.count} times in a row. Repeating it is unlikely to help. Change your approach: ` +
    `use different arguments or another tool, ask the user, or answer with what you have. ` +
    `After ${TOOL_REPEAT_STOP_AT} identical calls OpenClaw ends the turn.]`;
  return copyInternalToolResultState(result, {
    ...result,
    // Match transcript normalization for tools that omit display content.
    content: [...(result.content ?? []), { type: "text", text }],
  });
}

/** Result for every call in the batch that reached the cap; none of them runs. */
export function createToolRepeatStopResult(verdict: ToolRepeatVerdict): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: `Not executed: ${toolLabel(verdict.toolName)} was called with the same arguments ${verdict.count} times in a row. The turn is ending.`,
      },
    ],
    details: { status: "blocked", deniedReason: TOOL_REPEAT_LIMIT_CODE, count: verdict.count },
    terminate: true,
  };
}

/** User-visible reason for the terminal assistant message. */
export function formatToolRepeatStopMessage(verdict: ToolRepeatVerdict): string {
  return `OpenClaw stopped this turn: the model called ${toolLabel(verdict.toolName)} with the same arguments ${verdict.count} times in a row. Send a new message to continue.`;
}
