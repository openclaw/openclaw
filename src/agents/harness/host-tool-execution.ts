import { emitTrustedToolExecutionEvent } from "../../infra/diagnostic-events.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

type Binder = NonNullable<AgentHarnessHostCapabilities["bindToolExecution"]>;

/** Only the admitted host supplies identity and the live action-admission guard. */
export function bindHarnessToolExecution(
  host: Readonly<{
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    runId: string;
    toolOwner: string;
  }>,
  assertCurrent: () => void,
  { toolName, toolCallId }: Parameters<Binder>[0],
): ReturnType<Binder> {
  assertCurrent();
  // Copies fix identity once; a replacement host cannot redirect settlement.
  const identity = { ...host, toolName, toolCallId, toolSource: "plugin" as const };
  let state: "accepted" | "started" | "finished" = "accepted";
  return Object.freeze({
    started: (sourceTimestampMs) => {
      assertCurrent();
      if (state !== "accepted") {
        throw new Error("native action already started or settled");
      }
      state = "started";
      emitTrustedToolExecutionEvent({
        type: "tool.execution.started",
        ...identity,
        sourceTimestampMs,
      });
    },
    finished: (outcome) => {
      if (state === "finished") {
        throw new Error("native action already settled");
      }
      if (
        !["tool.execution.completed", "tool.execution.error", "tool.execution.blocked"].includes(
          outcome.type,
        )
      ) {
        throw new Error("invalid native action terminal outcome");
      }
      // Settlement retains no execution permission. Pick fields rather than spread
      // untyped input: identity and private diagnostic content are not reportable.
      const terminal =
        outcome.type === "tool.execution.completed"
          ? { type: outcome.type, durationMs: outcome.durationMs }
          : outcome.type === "tool.execution.error"
            ? {
                type: outcome.type,
                durationMs: outcome.durationMs,
                errorCategory: outcome.errorCategory,
                errorCode: outcome.errorCode,
                terminalReason: outcome.terminalReason,
              }
            : { type: outcome.type, deniedReason: outcome.deniedReason, reason: outcome.reason };
      state = "finished";
      emitTrustedToolExecutionEvent({
        ...terminal,
        ...identity,
        sourceTimestampMs: outcome.sourceTimestampMs,
      });
    },
  });
}
