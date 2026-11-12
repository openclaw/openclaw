import type * as Loopback from "../../gateway/mcp-http.loopback-runtime.js";
import { resolveQuestionTimeoutMs } from "../tools/ask-user-tool-normalization.js";

type McpTerminalOutcome = Loopback.McpLoopbackToolCallTerminalOutcome;
export type CliToolTerminalOutcome = McpTerminalOutcome | { outcome: "completed" };
export type CliLoopbackCall = {
  admitted: Loopback.McpLoopbackToolCallStart;
  current: Loopback.McpLoopbackToolCallStart;
  boundToolCallId?: string;
  outcome?: CliToolTerminalOutcome;
  browserTab?: unknown;
  ambiguous: boolean;
  ambiguityGroup?: CliLoopbackAmbiguityGroup;
};
export type CliLoopbackAmbiguityGroup = Set<CliLoopbackCall>;
export type ActiveCliTool = Loopback.McpLoopbackToolCallStart & {
  loopbackCall?: CliLoopbackCall;
  loopbackAmbiguous: boolean;
  ambiguityGroup?: CliLoopbackAmbiguityGroup;
};

export function createAskUserDeadlineTracking(
  activeTools: ReadonlyMap<string, ActiveCliTool>,
  isOverflowed: () => boolean,
) {
  const deadlines = new WeakMap<CliLoopbackCall, number>();
  let onChange: (() => void) | undefined;
  let selected: number | undefined;
  const selectDeadline = () => {
    if (isOverflowed()) {
      return undefined;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const { loopbackCall: call, loopbackAmbiguous } of activeTools.values()) {
      if (!call || loopbackAmbiguous || call.ambiguous) {
        continue;
      }
      earliest = Math.min(earliest, deadlines.get(call) ?? Number.POSITIVE_INFINITY);
    }
    return Number.isFinite(earliest) ? earliest : undefined;
  };
  const refresh = () => {
    const nextDeadline = selectDeadline();
    if (nextDeadline === selected) {
      return;
    }
    selected = nextDeadline;
    onChange?.();
  };
  const clear = (call: CliLoopbackCall) => {
    deadlines.delete(call);
    refresh();
  };
  const update = (call: CliLoopbackCall, toolName: string, args: Record<string, unknown>) => {
    deadlines.delete(call);
    if (toolName === "ask_user") {
      try {
        deadlines.set(call, Date.now() + resolveQuestionTimeoutMs(args.timeoutSeconds));
      } catch {
        // Invalid timeout input must not arm a watchdog deadline.
      }
    }
    refresh();
  };
  return {
    clear,
    update,
    refresh,
    get: () => selected,
    setOnChange: (listener: (() => void) | undefined) => {
      onChange = listener;
    },
  };
}
