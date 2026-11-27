/**
 * Arguments-only repeat guard. It compares each model tool call with the call
 * before it: name plus canonical arguments, never the outcome. The third
 * identical call gets one redirect note; the twentieth ends the turn with
 * `tool_repeat_limit`. Tools that poll by design declare `repeatable` and
 * skip the check. Committed user input resets the streak.
 *
 * Because the streak is consecutive-only and outcome-blind, a loop that
 * alternates two call signatures (e.g. a wrapper tool plus its dispatch
 * control) resets the count on every switch and can never be capped — even
 * when each round trip completes successfully with an external side effect.
 * The completed-effect budget below complements the streak: tools that opt in
 * via `sideEffect` count *successful completions* (never arguments), survive
 * intervening calls, and stop further invocations once the budget is spent.
 */
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { copyInternalToolResultState } from "./internal-hooks.js";
import type { AgentTool, AgentToolCall, AgentToolResult } from "./types.js";

export const TOOL_REPEAT_LIMIT_CODE = "tool_repeat_limit";
export const TOOL_REPEAT_NOTE_AT = 3;
export const TOOL_REPEAT_STOP_AT = 20;
export const SIDE_EFFECT_BUDGET_CODE = "side_effect_budget";

/** @internal Streak for one accepted user input, kept across Agent.continue() retries. */
export type ToolRepeatState = { key?: string; count: number };

/**
 * Successful side-effecting completions per opted-in tool name, for one
 * accepted user input. Keyed by tool name only (not arguments) so distinct
 * payloads cannot evade the budget, and independent of the consecutive streak
 * so alternating call signatures cannot reset it.
 */
export type SideEffectBudgetState = { counts: Map<string, number> };

export type SideEffectVerdict = {
  kind: "stop";
  toolCallId: string;
  toolName: string;
  completedCount: number;
};

/** Default successful side-effecting completions allowed per tool per user input. */
export const DEFAULT_SIDE_EFFECT_BUDGET = 1;

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

export function createSideEffectBudgetState(): SideEffectBudgetState {
  return { counts: new Map() };
}

export function resetSideEffectBudgetState(state: SideEffectBudgetState): void {
  state.counts.clear();
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

/**
 * Decide whether an opted-in tool may run again in this user input. A tool
 * opts in by declaring `sideEffect` (optionally with a per-tool budget).
 * Calls that have not yet completed are never counted here; the budget is
 * spent only when `observeSideEffectCompletion` sees a successful result.
 */
export function observeSideEffectBudget(
  state: SideEffectBudgetState,
  toolCall: AgentToolCall,
  tool: AgentTool | undefined,
): SideEffectVerdict | undefined {
  if (!tool || (tool.sideEffect !== true && typeof tool.sideEffect !== "number")) {
    return undefined;
  }
  const completed = state.counts.get(toolCall.name) ?? 0;
  const budget = typeof tool.sideEffect === "number" ? tool.sideEffect : DEFAULT_SIDE_EFFECT_BUDGET;
  if (completed < budget) {
    return undefined;
  }
  return { kind: "stop", toolCallId: toolCall.id, toolName: toolCall.name, completedCount: completed };
}

/**
 * Spend one unit of budget when a call to an opted-in tool completes
 * successfully. Success is read from the transport error flag plus the
 * structured result details when present (`ok`/`status`), so a workflow that
 * reports its own failure does not spend the budget and a legitimate retry
 * remains allowed.
 */
export function observeSideEffectCompletion(
  state: SideEffectBudgetState,
  toolName: string,
  tool: AgentTool | undefined,
  result: { details?: unknown },
  isError: boolean,
): void {
  if (!tool || (tool.sideEffect !== true && typeof tool.sideEffect !== "number")) {
    return;
  }
  if (isError || declaresFailure(result)) {
    return;
  }
  state.counts.set(toolName, (state.counts.get(toolName) ?? 0) + 1);
}

function declaresFailure(result: { details?: unknown }): boolean {
  const details = result.details;
  if (typeof details !== "object" || details === null) {
    return false;
  }
  const record = details as Record<string, unknown>;
  if (record.ok === false) {
    return true;
  }
  // `cancelled` is a definitive terminal failure: the action ran and did not
  // deliver, so it must spend budget considerations as a non-success. Interim
  // checkpoint statuses (needs_approval/needs_input) are neither success nor
  // failure; they do not spend the budget but also never count as delivered.
  const status = typeof record.status === "string" ? record.status : undefined;
  if (status === undefined) {
    return false;
  }
  if (/^(needs_|pending|running)/i.test(status)) {
    // Not a completion: treat as neither success nor failure.
    return true;
  }
  return !/^(ok|complete|success)/i.test(status);
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

/** Result for an opted-in tool whose completed-effect budget is already spent; it does not run. */
export function createSideEffectBudgetStopResult(verdict: SideEffectVerdict): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text:
          `Not executed: ${toolLabel(verdict.toolName)} already completed successfully ` +
          `${verdict.completedCount} time(s) this run and its side-effect budget is spent. ` +
          `Report the completed result to the user instead of invoking it again.`,
      },
    ],
    details: { status: "blocked", deniedReason: SIDE_EFFECT_BUDGET_CODE, count: verdict.completedCount },
    terminate: true,
  };
}

/** User-visible reason for the terminal assistant message after a budget stop. */
export function formatSideEffectBudgetStopMessage(verdict: SideEffectVerdict): string {
  return `OpenClaw stopped this turn: ${toolLabel(verdict.toolName)} already completed successfully ${verdict.completedCount} time(s) this run, and further side-effecting invocations are not allowed.`;
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
