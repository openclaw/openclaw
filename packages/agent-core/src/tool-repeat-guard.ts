/**
 * The consecutive guard compares each model tool call with the call
 * before it: name plus canonical arguments, never the outcome. The third
 * identical call gets one redirect note; the twentieth ends the turn with
 * `tool_repeat_limit`. Tools that poll by design declare `repeatable` and
 * skip the check. A bounded completed-outcome history also catches stable
 * cross-tool rotations. Committed user input resets both histories.
 */
import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  stableStringify,
  writeStableStringify,
} from "@openclaw/normalization-core/stable-stringify";
import { copyInternalToolResultState, getInternalToolResultProgress } from "./internal-hooks.js";
import type { AgentTool, AgentToolCall, AgentToolResult } from "./types.js";

export const TOOL_REPEAT_LIMIT_CODE = "tool_repeat_limit";
export const TOOL_REPEAT_NOTE_AT = 3;
export const TOOL_REPEAT_STOP_AT = 20;

/** @internal Streak for one accepted user input, kept across Agent.continue() retries. */
export type ToolRepeatState = { key?: string; count: number; noProgress?: ToolNoProgressState };

export type ToolProgressCall = { id: string; name: string; arguments: unknown };

export type ToolNoProgressState = {
  history: { key: string; toolName: string; outcome: string }[];
  recoveryUsed: boolean;
  blocked?: { batch: object | string; verdict: ToolRepeatVerdict };
};

export type ToolProgressObserver = {
  before: (
    call: ToolProgressCall,
    tool: Pick<AgentTool, "name" | "repeatable">,
  ) => ToolRepeatVerdict | undefined;
  completed: (call: ToolProgressCall, outcome: unknown) => void;
};

export type ToolRepeatVerdict = {
  kind: "note" | "stop";
  toolCallId: string;
  toolName: string;
  count: number;
  noProgress?: true;
};

export function createToolRepeatState(): ToolRepeatState {
  return { count: 0 };
}

export function resetToolRepeatState(state: ToolRepeatState): void {
  state.key = undefined;
  state.count = 0;
  state.noProgress = undefined;
}

function progressHash(value: unknown): string {
  const hash = createHash("sha256");
  writeStableStringify(value, (chunk) => {
    hash.update(chunk);
  });
  return hash.digest("hex");
}

export function recordToolProgress(
  state: ToolNoProgressState,
  call: ToolProgressCall,
  outcome: unknown,
): void {
  if (outcome === undefined) {
    state.history.length = 0;
    return;
  }
  state.history.push({
    key: progressHash([call.name, call.arguments]),
    toolName: call.name,
    outcome: progressHash(outcome),
  });
  if (state.history.length > 30) {
    state.history.shift();
  }
}

export function toolProgressOutcome(
  result: AgentToolResult<unknown>,
  isError: boolean,
  visibleValue: unknown = result.content,
): unknown {
  const status = isRecord(result.details) ? result.details.status : undefined;
  const value = getInternalToolResultProgress(result) ?? visibleValue;
  return value === undefined ||
    status === "running" ||
    status === "waiting" ||
    status === "pending" ||
    status === "approval-pending"
    ? undefined
    : { isError, value };
}

/** Completed results establish repetition; a novel action remains available for recovery. */
export function observeToolNoProgress(
  state: ToolNoProgressState,
  call: ToolProgressCall,
  tool: Pick<AgentTool, "name" | "repeatable">,
  batch: object | string,
): ToolRepeatVerdict | undefined {
  if (state.blocked?.batch === batch) {
    return state.blocked.verdict;
  }
  if (isRepeatable(tool, call.arguments)) {
    state.history.length = 0;
    return undefined;
  }
  const outcomes = new Map<string, { toolName: string; outcome: string; count: number }>();
  for (const entry of state.history.toReversed()) {
    const previous = outcomes.get(entry.key);
    if (previous && previous.outcome !== entry.outcome) {
      break;
    }
    outcomes.set(entry.key, {
      toolName: entry.toolName,
      outcome: entry.outcome,
      count: (previous?.count ?? 0) + 1,
    });
  }
  const repeated = [...outcomes.values()].filter((entry) => entry.count >= 2);
  const participant = outcomes.get(progressHash([call.name, call.arguments]));
  const count = repeated.reduce((total, entry) => total + entry.count, 0);
  if (
    (participant?.count ?? 0) < 2 ||
    new Set(repeated.map((entry) => entry.toolName)).size < 2 ||
    count < 30
  ) {
    return undefined;
  }
  const verdict: ToolRepeatVerdict = {
    kind: state.recoveryUsed ? "stop" : "note",
    toolCallId: call.id,
    toolName: call.name,
    count,
    noProgress: true,
  };
  state.recoveryUsed = true;
  state.blocked = { batch, verdict };
  return verdict;
}

export function createToolNoProgressResult(verdict: ToolRepeatVerdict): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text:
          verdict.kind === "stop"
            ? "Tool-loop recovery failed: another stable loop was detected. This turn is stopping."
            : "Tool loop detected: this batch was not executed after 30 stable outcomes. Change the tool or arguments, ask the user, or answer without tools. Another critical loop ends this turn.",
      },
    ],
    details: { status: "blocked", deniedReason: TOOL_REPEAT_LIMIT_CODE, count: verdict.count },
    terminate: verdict.kind === "stop",
  };
}

function isRepeatable(tool: Pick<AgentTool, "repeatable">, args: unknown): boolean {
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
  if (verdict.noProgress) {
    return "OpenClaw stopped this turn because tool-loop recovery encountered another stable loop. No blocked tool action was executed.";
  }
  return `OpenClaw stopped this turn: the model called ${toolLabel(verdict.toolName)} with the same arguments ${verdict.count} times in a row. Send a new message to continue.`;
}
