import type { CliBackendTurnInterrupt } from "../../plugins/cli-backend.types.js";
import { isResumingAlreadyPendingSessionsYieldResult } from "../tools/sessions-yield-tool.js";
import { stripOpenClawMcpToolPrefix } from "./tool-policy.js";

/** Own yield interruption and delivered-reply state for each accepted native input. */
export function createCliYieldTurnEnd() {
  let yielded = false;
  let deliveredForInput = false;
  let pendingAfterSourceReply = false;
  let turnInterrupt: CliBackendTurnInterrupt | undefined;
  let supportsTurnInterrupt = false;
  let yieldToolResultObserved = false;
  let yieldInterrupt: Promise<void> | undefined;
  const requestYieldInterrupt = () => {
    if (
      (!yielded && !pendingAfterSourceReply) ||
      !yieldToolResultObserved ||
      !turnInterrupt ||
      yieldInterrupt
    ) {
      return;
    }
    const interrupt = turnInterrupt;
    yieldInterrupt = Promise.resolve().then(() => interrupt.interrupt("yield"));
    // The execution owner joins this promise and cancels the transport on failure.
    void yieldInterrupt.catch(() => {});
  };
  const shouldSuppressAssistantOutput = () =>
    (yielded || pendingAfterSourceReply) && supportsTurnInterrupt;

  return {
    markYielded() {
      yielded = true;
    },
    markDelivered(delivered: boolean) {
      deliveredForInput ||= delivered;
    },
    observe(toolName: string, call: { outcome: string; result?: unknown }) {
      if (
        call.outcome === "completed" &&
        deliveredForInput &&
        isResumingAlreadyPendingSessionsYieldResult(toolName, call.result)
      ) {
        pendingAfterSourceReply = true;
      }
    },
    onToolResult(toolName: string, isError: boolean) {
      if (
        (yielded || pendingAfterSourceReply) &&
        !isError &&
        stripOpenClawMcpToolPrefix(toolName) === "sessions_yield"
      ) {
        // Native observed the tool response before we interrupt its next model step.
        yieldToolResultObserved = true;
        requestYieldInterrupt();
      }
    },
    register(interrupt: CliBackendTurnInterrupt | undefined) {
      turnInterrupt = interrupt;
      supportsTurnInterrupt ||= interrupt !== undefined;
      requestYieldInterrupt();
    },
    async wait() {
      await yieldInterrupt;
    },
    beginInput() {
      deliveredForInput = false;
      pendingAfterSourceReply = false;
    },
    yielded: () => yielded,
    suppressesAssistantOutput: shouldSuppressAssistantOutput,
  };
}
